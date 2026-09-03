import * as THREE from "three";
import "./style.css";

import { probe } from "./core/capability";
import { Stage } from "./core/stage";
import { startLoop } from "./core/loop";
import { WalkMode } from "./core/walkMode";
import { LayerRegistry, type LayerReport } from "./layers/registry";
import { GroundLayer } from "./layers/ground";
import { WaterLayer } from "./layers/water";
import { RoadsLayer } from "./layers/roads";
import { BuildingsLayer } from "./layers/buildings";
import { RailLayer } from "./layers/rail";
import { TransitLayer } from "./layers/transit";
import { CorridorLayer } from "./layers/corridors";
import { LandmarkLayer } from "./layers/landmarks";
import { TreesLayer } from "./layers/trees";
import { TrafficLayer } from "./layers/traffic";
import { MetroLayer } from "./layers/metro";
import { PedestrianLayer } from "./layers/pedestrians";
import { RoofDetailLayer, StreetscapeLayer, BuildingPartsLayer } from "./layers/detail";
import { FurnitureLayer } from "./layers/furniture";
import { ReachLayer } from "./layers/reach";
import { RouteLayer } from "./layers/routes";
import { buildWalkGraph } from "./analysis/network";
import { reachContext, computeReach, routeBetween,
         type ReachMode, type ReachContext, type ReachResult } from "./analysis/reach";
import { reachPanel } from "./ui/reachPanel";
import type { FacadeMaps } from "./layers/facade";
import { BusLayer } from "./layers/buses";
import { placePicker, type Place } from "./ui/places";
import { exposureLab, type ExposureState } from "./ui/exposureLab";
import { fetchLive, bandFromRain, type AirReading } from "./data/adapters/openMeteo";
import { LiveBusLayer } from "./layers/liveBuses";
import * as load from "./geo/load";
import { store, type RainBand } from "./state/store";
import { corridorMetrics, type CorridorMetrics } from "./scenario/engine";
import { el } from "./ui/dom";
import { masthead, layerRail, legend, timeBar, dataStatus, onboarding } from "./ui/panels";
import { drawer, type Selection } from "./ui/drawer";
import { scenarioLab, exportPanel } from "./ui/scenarioLab";
import { STORY } from "./story/steps";
import type { Manifest, ScenarioModel, WeatherData } from "./geo/types";

const LAYER_ORDER = [
  "ground", "water", "streetscape", "roads", "corridors",
  "buildings", "buildingparts", "roofdetail", "landmarks",
  "trees", "furniture", "rail", "transit", "traffic", "buses", "livebuses",
  "metro", "pedestrians", "reach", "routes",
];

/** The reach overlay is driven by its own panel — it needs a starting point before it means
 *  anything — so it is reported in Data status but not offered as a bare on/off in the rail. */
const RAIL_ORDER = LAYER_ORDER.filter((id) => id !== "reach" && id !== "routes");

function fatal(title: string, detail: string) {
  document.body.append(el("div", { class: "fallback" },
    el("h1", { text: title }), el("p", { text: detail })));
}

async function boot() {
  const cap = probe();
  if (!cap.webgl) {
    fatal("This view needs WebGL",
      "Your browser or graphics driver did not provide a WebGL context, so the 3D city cannot render. The underlying data is still available as versioned JSON under data/@v1/.");
    return;
  }

  const man = await load.manifest();
  if (!man.ok) {
    fatal("The dataset manifest did not load", `${man.error}. Without the manifest there is no study area, transform version or provenance, so nothing is rendered rather than rendering something unlabelled.`);
    return;
  }
  const m: Manifest = man.data;

  const [modelRes, weatherRes] = await Promise.all([load.scenarioModel(), load.weather()]);
  const model: ScenarioModel | null = modelRes.ok ? modelRes.data : null;
  const weather: WeatherData | null = weatherRes.ok ? weatherRes.data : null;

  // ---------------------------------------------------------------- scene
  const canvas = el("canvas", { id: "view" });
  document.body.append(canvas);
  const stage = new Stage(canvas, m.study_area.runtime_extent);
  const root = new THREE.Group();
  stage.scene.add(root);

  // the tile grid the culling uses; it was already in config as a lookup key
  const EXTENT = m.study_area.runtime_extent;
  const GRID = m.tiles.grid;

  // The baked city AO, loaded once and shared. If it is missing the layers simply do not apply
  // it — no error, and the scene is only flatter, which is the honest degradation.
  const ORTHO = Math.max(EXTENT.x[1] - EXTENT.x[0], EXTENT.z[1] - EXTENT.z[0]);
  let cityAO: THREE.Texture | null = null;
  try {
    cityAO = await new THREE.TextureLoader().loadAsync(`${load.DATA}/bake/city-ao.png`);
    cityAO.colorSpace = THREE.NoColorSpace;      // it is a mask, not a colour
    cityAO.wrapS = cityAO.wrapT = THREE.ClampToEdgeWrapping;
    cityAO.minFilter = THREE.LinearMipmapLinearFilter;
    cityAO.generateMipmaps = true;
    cityAO.anisotropy = Math.min(8, stage.renderer.capabilities.getMaxAnisotropy());
  } catch {
    cityAO = null;
  }

  // The generated facade atlas. Same contract as the AO bake: if it is missing the buildings
  // simply keep their procedural pattern, which is a visual downgrade and not a failure.
  const loader = new THREE.TextureLoader();
  async function tex(path: string, data: boolean) {
    const t = await loader.loadAsync(`${load.DATA}/${path}`);
    t.colorSpace = data ? THREE.NoColorSpace : THREE.SRGBColorSpace;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.generateMipmaps = true;
    t.anisotropy = Math.min(8, stage.renderer.capabilities.getMaxAnisotropy());
    return t;
  }
  let facadeMaps: FacadeMaps | null = null;
  try {
    const [alb, nrm, rgh] = await Promise.all([
      tex("bake/facade-albedo.png", false),
      tex("bake/facade-normal.png", true),
      tex("bake/facade-rough.png", true),
    ]);
    facadeMaps = { albedo: alb, normal: nrm, roughness: rgh, cells: 4 };
  } catch {
    facadeMaps = null;
  }

  const registry = new LayerRegistry(root);
  const ground = new GroundLayer(EXTENT, GRID, cityAO, ORTHO);
  const water = new WaterLayer(stage.environment());
  const roads = new RoadsLayer(cityAO, ORTHO);
  const buildings = new BuildingsLayer(EXTENT, GRID, facadeMaps);
  const rail = new RailLayer();
  const transit = new TransitLayer();
  const corridors = new CorridorLayer();
  const landmarks = new LandmarkLayer();
  const trees = new TreesLayer(EXTENT, GRID);
  const streetscape = new StreetscapeLayer(cityAO, ORTHO);
  const buildingParts = new BuildingPartsLayer();
  const metro = new MetroLayer();
  const pedestrians = new PedestrianLayer();
  registry.add(ground).add(water).add(streetscape).add(roads).add(buildings)
          .add(buildingParts).add(landmarks).add(trees).add(rail).add(transit)
          .add(corridors).add(metro).add(pedestrians);

  await registry.buildAll();

  // Second wave: layers built from another layer's resolved data. Each is wrapped the way
  // buildAll wraps the others, so a failure here degrades to a reported status rather than a
  // dead scene (FR-01).
  const buses = new BusLayer(transit.routes);
  const traffic = new TrafficLayer(corridors.corridors);
  const roofDetail = new RoofDetailLayer(buildings.buildings);
  const liveBuses = new LiveBusLayer(m);
  const furniture = new FurnitureLayer(roads.roads, transit.stops, EXTENT, GRID);
  const reachLayer = new ReachLayer(EXTENT, 30);
  const routeLayer = new RouteLayer();
  for (const l of [roofDetail, furniture, traffic, buses, liveBuses, reachLayer, routeLayer]) {
    registry.add(l);
    try {
      registry.reports.set(l.id, await l.build());
    } catch (e) {
      registry.reports.set(l.id, {
        id: l.id, label: l.label, status: "unavailable", provenance: null,
        features: 0, bytes: 0, ms: 0, drawCalls: 0, triangles: 0,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
  const reports: LayerReport[] = LAYER_ORDER
    .map((id) => registry.reports.get(id))
    .filter((r): r is LayerReport => Boolean(r));

  stage.resize();
  stage.setTime(store.get().timeMin);

  // ---------------------------------------------------------------- metrics
  const provFor = (id: string) => registry.reports.get(id)?.provenance ?? null;
  let baseline: CorridorMetrics | null = null;
  let frozenScenario: CorridorMetrics | null = null;

  function activeCorridorId(): string | null {
    const s = store.get();
    return s.activeCorridor ?? corridors.corridors[0]?.id ?? null;
  }

  function metricsFor(rain: RainBand, freq: number): CorridorMetrics | null {
    const id = activeCorridorId();
    const c = id ? corridors.byId(id) : undefined;
    if (!c || !model) return null;
    return corridorMetrics({
      corridor: c, timeMin: store.get().timeMin, rain, model,
      diurnal: model.diurnal_congestion.profile, corridorBase: model.corridor_base,
      routes: transit.routes, busFreqMultiplier: freq,
    });
  }

  /** Paint every corridor for the current view state, so the map reflects what the clock and the
   *  rain control actually say. */
  function paintCorridors() {
    if (!model) return;
    const s = store.get();
    const cache = new Map<string, number[]>();
    for (const c of corridors.corridors) {
      const mm = corridorMetrics({
        corridor: c, timeMin: s.timeMin, rain: s.rain, model,
        diurnal: model.diurnal_congestion.profile, corridorBase: model.corridor_base,
        routes: transit.routes, busFreqMultiplier: s.busFreqMultiplier,
      });
      cache.set(c.id, mm.segments.map((x) => x.ratio));
    }
    corridors.paint((cid, si) => cache.get(cid)?.[si] ?? null);
  }

  /** The vehicles read the same estimate the corridor colour does, so they are refreshed from
   *  the same place — one source of truth for "how fast is this corridor right now". */
  function refreshMotion() {
    if (!model) return;
    const s = store.get();
    const segsFor = new Map<string, number[]>();
    for (const c of corridors.corridors) {
      const mm = corridorMetrics({
        corridor: c, timeMin: s.timeMin, rain: s.rain, model,
        diurnal: model.diurnal_congestion.profile, corridorBase: model.corridor_base,
        routes: transit.routes, busFreqMultiplier: s.busFreqMultiplier,
      });
      segsFor.set(c.id, mm.segments.map((x) => x.speedKmh));
    }
    traffic.setSpeeds((cid, frac) => {
      const arr = segsFor.get(cid);
      if (!arr || !arr.length) return 25;
      return arr[Math.min(Math.floor(frac * arr.length), arr.length - 1)];
    });
    // buses slow with the weather too, or the rainfall scenario only changes numbers
    const rainMult = model.rain_speed_multiplier[s.rain]?.secondary ?? 1;
    buses.setSpeedScale(rainMult);
  }

  function recompute() {
    baseline = metricsFor("none", 1);
    lab.setMetrics(baseline, frozenScenario);
    // the exposure panel reads the same metrics: wait and travel time are what set the dose
    exposure.setMetrics(frozenScenario ?? baseline);
    paintCorridors();
    refreshMotion();
  }

  /** Playback moves the clock roughly every 60 ms. Repainting corridor vertices at that rate is
   *  cheap; rebuilding the Scenario Lab's DOM is not, so the panel is throttled while the numbers
   *  on screen still track the clock closely enough to read. */
  let lastMetricsAt = 0;
  function onClockMoved() {
    stage.setTime(store.get().timeMin);
    paintCorridors();
    refreshMotion();
    const now = performance.now();
    if (now - lastMetricsAt > 400) {
      lastMetricsAt = now;
      baseline = metricsFor("none", 1);
      lab.setMetrics(baseline, frozenScenario);
    }
  }

  // ---------------------------------------------------------------- UI
  const mast = masthead(m);
  const rail0 = layerRail(RAIL_ORDER,
    (id, on) => { registry.setVisible(id, on); store.set({ layers: { ...store.get().layers, [id]: on } }); rail0.refresh(); },
    (on) => { buildings.setReveal(on); store.set({ revealEstimated: on }); rail0.refresh(); });
  const leg = legend(metro.lines);
  const det = drawer(() => { det.hide(); buildings.highlight(null); store.set({ selectedId: null }); });

  const lab = scenarioLab(corridors.corridors, model ?? ({
    version: "0.1", free_flow_kmh: {}, diurnal_congestion: { _note: "", profile: new Array(24).fill(0.4) },
    corridor_base: {}, rain_speed_multiplier: {},
    msi_weights: { speed_penalty: 0.45, transit_pressure: 0.3, weather_impact: 0.25 },
    wait_proxy: "half the headway", transit_pressure_normalisation: "", definitions: {},
  } as ScenarioModel), {
    onCorridor(id) { store.set({ activeCorridor: id, scenario: null }); frozenScenario = null; recompute(); flyToCorridor(id); },
    onScenario(sc) { store.set({ scenario: sc }); frozenScenario = null; lab.refresh(); },
    onFreq(f) { store.set({ busFreqMultiplier: f }); lab.refresh(); },
    onRun() {
      const s = store.get();
      if (!s.scenario) return;
      frozenScenario = metricsFor(s.rain, s.busFreqMultiplier);
      if (s.scenario === "bus_frequency") buses.setHeadwayScale(1 / Math.max(s.busFreqMultiplier, 0.1));
      store.set({ scenarioRunId: s.scenarioRunId + 1 });
      recompute();
    },
    onReset() {
      frozenScenario = null;
      buses.setHeadwayScale(1);
      store.set({ scenario: null, busFreqMultiplier: 1, rain: "none" });
      recompute();
    },
    onExport() {
      if (!model) return;
      stage.render();   // ensure the framebuffer holds the current frame before we read it
      document.body.append(exportPanel(m, model, baseline, frozenScenario, canvas));
    },
  });

  const exposure = exposureLab(
    corridors.corridors,
    model?.exposure_model ?? null,
    (id) => { store.set({ activeCorridor: id }); recompute(); flyToCorridor(id); });
  mast.airBtn.addEventListener("click", () => {
    exposure.toggle();
    if (exposure.isOpen()) exposure.setMetrics(baseline);
  });

  const tbar = timeBar(weather,
    (min) => { store.set({ timeMin: min }); },
    (playing) => { store.set({ playing }); },
    (b) => { store.set({ rain: b }); });

  document.body.append(mast.node, rail0.node, leg.node, det.node, lab.node,
                       exposure.node, tbar.node);
  rail0.update(reports);
  recompute();

  mast.statusBtn.addEventListener("click", () =>
    document.body.append(dataStatus(m, reports)));

  // ---------------------------------------------------------------- places to jump to
  const placesRes = await load.grab<{ features: Place[] }>("places.json");
  const picker = placePicker(placesRes.ok ? placesRes.data.features : [], (pl) => {
    // frame from the south-east at a height proportional to the framing distance, so a district
    // reads as a district and a monument fills the view
    if (walk.active) {
      // already at street level: put the walker at the place rather than yanking them upstairs
      stage.camera.position.set(pl.x, walk.eyeHeight, pl.z + 40);
    } else {
      flyTo([pl.x + pl.dist * 0.55, pl.dist * 0.62, pl.z + pl.dist], [pl.x, 0, pl.z]);
    }
    picker.hide();
  });
  document.body.append(picker.node);
  mast.placesBtn.addEventListener("click", () => picker.toggle());

  // ---------------------------------------------------------------- reach on foot
  //
  // The walking graph is assembled from geometry the scene has already loaded — 684 road ways and
  // 926 footway ways — so this costs one pass over arrays in memory and no new download. Built
  // lazily on first use: most sessions never open the panel, and there is no reason to make them
  // pay for it during startup.
  /** the most recent air reading, live or pinned. The route comparison needs it as much as the
   *  exposure panel does, and they must never disagree about which number they used. */
  let latestAir: AirReading | null = null;
  let reachCtx: ReachContext | null = null;
  let reachOrigin: { x: number; z: number } | null = null;
  let lastReach: ReachResult | null = null;
  let lastRoute: ReturnType<typeof routeBetween> | null = null;
  const originPin = new THREE.Group();
  {
    const pinMat = new THREE.MeshBasicMaterial({ color: 0xffd166, toneMapped: false });
    const glow = new THREE.MeshBasicMaterial({
      color: 0xffd166, transparent: true, opacity: 0.55, side: THREE.DoubleSide, toneMapped: false,
      depthWrite: false,
    });
    // two rings at the scale of the 5-minute band, so the origin is findable from 2 km up as well
    // as from the pavement
    for (const [ri, ro, mat] of [[7, 10, pinMat], [26, 30, glow]] as [number, number, THREE.Material][]) {
      const g = new THREE.RingGeometry(ri, ro, 56);
      g.rotateX(-Math.PI / 2);
      const mesh = new THREE.Mesh(g, mat);
      mesh.position.y = 0.14;
      originPin.add(mesh);
    }
    const stemGeo = new THREE.CylinderGeometry(0.7, 0.7, 90, 8);
    stemGeo.translate(0, 45, 0);
    originPin.add(new THREE.Mesh(stemGeo, glow));
    const capGeo = new THREE.SphereGeometry(3.2, 16, 12);
    capGeo.translate(0, 92, 0);
    originPin.add(new THREE.Mesh(capGeo, pinMat));
    originPin.visible = false;
    originPin.renderOrder = 4;
    root.add(originPin);
  }

  function ensureReachCtx(): ReachContext | null {
    if (reachCtx) return reachCtx;
    if (!roads.roads.length) return null;
    const t0 = performance.now();
    const g = buildWalkGraph(roads.roads, streetscape.footways, {
      // taken from the versioned exposure model rather than invented here, so there is exactly one
      // declared kerbside figure in the project
      peakEnrichment: model?.exposure_model?.roadside_enrichment?.in_traffic ?? 1.20,
    });
    // metro station points only: the two mainline halts are not what "walk to the metro" means
    const stations = rail.stations.filter((st) => st.sub);
    reachCtx = reachContext(
      g, EXTENT,
      placesRes.ok ? placesRes.data.features : [],
      stations, transit.stops,
    );
    reachRail.setGraph(g);
    console.info(`[reach] graph ${g.stats.nodes} nodes / ${g.stats.edges} edges in `
                 + `${(performance.now() - t0).toFixed(0)} ms, `
                 + `largest component ${g.stats.largestComponentPct.toFixed(1)}%`);
    return reachCtx;
  }

  let routeFrom: { x: number; z: number } | null = null;
  const destPin = originPin.clone();
  destPin.visible = false;
  destPin.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (mesh.material) {
      mesh.material = (mesh.material as THREE.Material).clone();
      (mesh.material as THREE.MeshBasicMaterial).color = new THREE.Color(0x5fce8a);
    }
  });
  root.add(destPin);

  function runRoute(to: { x: number; z: number }) {
    const ctx = ensureReachCtx();
    if (!ctx || !routeFrom) return;
    const vent = model?.exposure_model?.ventilation_m3_per_min?.walking ?? 0.026;
    const res = routeBetween(ctx, routeFrom, to, {
      pm2_5: latestAir?.pm2_5 ?? null, ventilation: vent,
    });
    if ("error" in res) {
      // same trap as the reach field: a stale success left in place makes a failure read as one
      lastRoute = null;
      routeLayer.clear();
      reachRail.setRoutePair(res);
      return;
    }
    routeLayer.setRoutes([
      { route: res.cleanest, kind: "dose" },
      { route: res.fastest, kind: "time" },
    ]);
    lastRoute = res;
    reachRail.setRoutePair(res);
  }

  function runReach(mode: ReachMode) {
    if (mode === "route") {
      // a different question with a different interaction: clear the field and ask for two clicks
      reachLayer.setVisible(false);
      routeLayer.clear();
      routeFrom = null;
      originPin.visible = false; destPin.visible = false;
      reachRail.setRoutePrompt("start");
      return;
    }
    routeLayer.clear();
    destPin.visible = false;
    const ctx = ensureReachCtx();
    if (!ctx) {
      reachRail.setResult({ error: "The road layer did not load, so no walking network can be built." });
      return;
    }
    const t0 = performance.now();
    const res = computeReach(ctx, mode, reachOrigin);
    if ("error" in res) {
      // clearing this matters: leaving the previous result in place makes a failed query look
      // like a successful one to anything reading the test surface
      lastReach = null;
      reachLayer.setVisible(false);
      reachRail.setResult(res);
      return;
    }
    lastReach = res;
    reachLayer.setField(res.raster, res.compare);
    reachLayer.setVisible(true);
    store.set({ layers: { ...store.get().layers, reach: true } });
    reachRail.setResult(res);
    console.info(`[reach] ${mode} in ${(performance.now() - t0).toFixed(0)} ms`);
  }

  const reachRail = reachPanel(
    (mode) => runReach(mode),
    () => {
      reachOrigin = null; routeFrom = null;
      originPin.visible = false; destPin.visible = false;
      reachLayer.setVisible(false); routeLayer.clear();
    },
    (v) => reachLayer.setOpacity(v),
  );
  document.body.append(reachRail.node);
  mast.reachBtn.addEventListener("click", () => {
    reachRail.toggle();
    mast.reachBtn.classList.toggle("on", reachRail.isOpen());
    if (!reachRail.isOpen()) {
      reachLayer.setVisible(false);
      routeLayer.setVisible(false);
      originPin.visible = false; destPin.visible = false;
    } else {
      routeLayer.setVisible(true);
      if (reachRail.mode === "route") reachRail.setRoutePrompt(routeFrom ? "destination" : "start");
      else if (reachOrigin || reachRail.mode === "metro" || reachRail.mode === "busstop") {
        runReach(reachRail.mode);
      }
    }
  });

  /** true when the click was consumed as a reach origin rather than as a selection */
  function reachClick(r: THREE.Ray): boolean {
    if (!reachRail.isOpen()) return false;
    const mode = reachRail.mode;
    if (mode !== "walk" && mode !== "stepfree" && mode !== "route") return false;
    // intersect the ground plane directly: picking against a mesh would miss the lawns, and
    // clicking a rooftop should still mean "the ground under that roof"
    const hit = new THREE.Vector3();
    if (!r.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), hit)) return false;
    if (hit.x < EXTENT.x[0] || hit.x > EXTENT.x[1] || hit.z < EXTENT.z[0] || hit.z > EXTENT.z[1]) {
      return false;
    }
    const at = { x: hit.x, z: hit.z };

    if (mode === "route") {
      if (!routeFrom) {
        routeFrom = at;
        originPin.position.set(at.x, 0, at.z); originPin.visible = true;
        destPin.visible = false;
        routeLayer.clear();
        reachRail.setRoutePrompt("destination");
      } else {
        destPin.position.set(at.x, 0, at.z); destPin.visible = true;
        requestAnimationFrame(() => runRoute(at));
      }
      return true;
    }

    reachOrigin = at;
    originPin.position.set(at.x, 0, at.z);
    originPin.visible = true;
    reachRail.setBusy(true);
    // one frame of "computing", so a 40 ms Dijkstra does not look like a dropped click
    requestAnimationFrame(() => runReach(mode));
    return true;
  }

  // ---------------------------------------------------------------- camera moves
  let flight: { from: THREE.Vector3; to: THREE.Vector3; tFrom: THREE.Vector3; tTo: THREE.Vector3; t: number } | null = null;

  function flyTo(pos: [number, number, number], target: [number, number, number]) {
    if (cap.reducedMotion) {
      stage.camera.position.set(...pos);
      stage.controls.target.set(...target);
      return;
    }
    flight = {
      from: stage.camera.position.clone(), to: new THREE.Vector3(...pos),
      tFrom: stage.controls.target.clone(), tTo: new THREE.Vector3(...target), t: 0,
    };
  }

  function flyToCorridor(id: string) {
    const c = corridors.byId(id);
    if (!c || !c.spine.length) return;
    const mid = c.spine[Math.floor(c.spine.length / 2)];
    flyTo([mid[0] + 380, 330, mid[1] + 640], [mid[0], 0, mid[1]]);
  }

  // ---------------------------------------------------------------- street level
  const walkHint = el("div", { class: "panel hidden", id: "walkhint" },
    el("div", { class: "pbody" },
      el("strong", { text: "Street level" }),
      el("p", { class: "note",
        text: "Drag to look, W A S D or the arrow keys to walk, Shift to hurry. Esc to come back up." }),
      el("p", { class: "note", style: "margin:0",
        text: "Eye height 1.7 m. This is the scale the facades, kerbs, rooftop tanks and walkers were built for — and the scale the exposure figures describe." })));
  document.body.append(walkHint);

  const walk = new WalkMode(stage.camera, stage.controls, canvas, EXTENT, (on) => {
    walkHint.classList.toggle("hidden", !on);
    store.set({ walking: on });
    // A pedestrian sees far less than a helicopter, so the fog can close in — which also buys
    // back the fill rate the near detail wants.
    (stage.scene.fog as THREE.Fog).near = on ? 120 : 3060;
    (stage.scene.fog as THREE.Fog).far = on ? 1400 : 11000;
    // an isochrone reads as a map from above and as paint on the pavement from eye height
    reachLayer.setMapMode(!on);
  });
  mast.walkBtn.addEventListener("click", () => walk.toggle());

  // ---------------------------------------------------------------- picking
  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  let downAt = { x: 0, y: 0 };

  canvas.addEventListener("pointerdown", (e) => { downAt = { x: e.clientX, y: e.clientY }; });
  canvas.addEventListener("pointerup", (e) => {
    if (Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > 5) return;  // that was an orbit
    const r = canvas.getBoundingClientRect();
    ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, stage.camera);

    // the reach panel claims the click while it is open and asking for a starting point
    if (reachClick(ray.ray)) return;

    const targets: THREE.Object3D[] = [];
    const push = (o?: THREE.Object3D | null) => { if (o && o.visible && o.parent?.visible) targets.push(o); };
    push(corridors.mesh3);
    transit.group.children.forEach(push);
    rail.group.children.forEach((c) => { if (c.name === "stations") push(c); });
    for (const bm of buildings.meshes) push(bm);
    roads.group.children.forEach(push);

    const hits = ray.intersectObjects(targets, false);
    if (!hits.length) return;
    const hit = hits[0];
    const name = hit.object.name;

    let sel: Selection | null = null;
    if (name === "corridors" && hit.face) {
      const s = corridors.segmentAtVertex(hit.face.a);
      if (s && model) {
        const mm = corridorMetrics({
          corridor: s.corridor, timeMin: store.get().timeMin, rain: store.get().rain, model,
          diurnal: model.diurnal_congestion.profile, corridorBase: model.corridor_base,
          routes: transit.routes, busFreqMultiplier: store.get().busFreqMultiplier,
        });
        sel = { kind: "corridor", c: s.corridor, segIndex: s.segIndex, metrics: mm, prov: provFor("corridors") };
        store.set({ activeCorridor: s.corridor.id });
        frozenScenario = null;
        recompute();
      }
    } else if (name === "stops" && hit.instanceId !== undefined) {
      const st = transit.stopAtInstance(hit.instanceId);
      if (st) {
        const routes = transit.routes.filter((r) => r.stops.some((x) => x.id === st.id)).map((r) => r.ref);
        sel = { kind: "stop", s: st, routes, prov: provFor("transit") };
      }
    } else if (name === "stations" && hit.instanceId !== undefined) {
      const st = rail.stations[hit.instanceId];
      if (st) sel = { kind: "station", s: st, prov: provFor("rail") };
    } else if (name === "buildings" && hit.face) {
      const b = buildings.buildingAt(hit.object, hit.face.a);
      if (b) {
        sel = { kind: "building", b, prov: provFor("buildings"), rule: m.height_rule };
        buildings.highlight(b.id);
      }
    } else if (name === "roads" && hit.face) {
      const rd = roads.roadAtVertex(hit.face.a);
      if (rd) sel = { kind: "road", r: rd, prov: provFor("roads") };
    }

    if (sel) {
      det.show(sel);
      store.set({ selectedId: sel.kind === "building" ? sel.b.id : null });
    }
  });

  // ---------------------------------------------------------------- guided story
  const storyNode = el("aside", { class: "panel hidden", id: "story" });
  document.body.append(storyNode);

  function renderStory() {
    const i = store.get().storyStep;
    storyNode.classList.toggle("hidden", i === null);
    if (i === null) return;
    const step = STORY[i];
    storyNode.replaceChildren(el("div", { class: "sbody" },
      el("h3", { text: step.title }),
      el("p", { text: step.body }),
      (() => {
        const prev = el("button", { class: "btn", text: "Back", disabled: i === 0 });
        const next = el("button", { class: "btn primary", text: i === STORY.length - 1 ? "Finish" : "Next" });
        const quit = el("button", { class: "chip", text: "Exit" });
        prev.addEventListener("click", () => applyStep(i - 1));
        next.addEventListener("click", () => i === STORY.length - 1 ? endStory() : applyStep(i + 1));
        quit.addEventListener("click", endStory);
        return el("div", { class: "snav" }, prev, next,
          el("span", { class: "prog", text: `${i + 1} / ${STORY.length}` }), quit);
      })()));
  }

  function applyStep(i: number) {
    const step = STORY[i];
    if (!step) return;
    if (step.layers) {
      for (const [id, on] of Object.entries(step.layers)) registry.setVisible(id, on);
      store.set({ layers: { ...store.get().layers, ...step.layers } });
    }
    if (step.reveal !== undefined) { buildings.setReveal(step.reveal); store.set({ revealEstimated: step.reveal }); }
    if (step.timeMin !== undefined) store.set({ timeMin: step.timeMin });
    if (step.rain !== undefined) store.set({ rain: step.rain });
    if (step.corridor !== undefined) store.set({ activeCorridor: step.corridor });
    if (step.freq !== undefined) store.set({ busFreqMultiplier: step.freq });
    if (step.scenario !== undefined) { store.set({ scenario: step.scenario }); frozenScenario = null; }
    store.set({ storyStep: i, playing: false });
    if (step.camera) flyTo(step.camera.pos, step.camera.target);
    else if (step.corridor) flyToCorridor(step.corridor);

    recompute();
    if (step.run) {
      const s = store.get();
      frozenScenario = metricsFor(s.rain, s.busFreqMultiplier);
      if (s.scenario === "bus_frequency") buses.setHeadwayScale(1 / Math.max(s.busFreqMultiplier, 0.1));
      else buses.setHeadwayScale(1);
      recompute();
    } else {
      buses.setHeadwayScale(1);
    }
    rail0.refresh();
    renderStory();
  }

  function endStory() { store.set({ storyStep: null }); renderStory(); }
  mast.storyBtn.addEventListener("click", () => applyStep(0));

  // ---------------------------------------------------------------- reactions
  store.on((_s, changed) => {
    if (changed.includes("timeMin")) onClockMoved();
    if (changed.includes("rain")) { recompute(); lab.refresh(); }
    if (changed.includes("activeCorridor")) lab.refresh();
  });

  // ---------------------------------------------------------------- loop
  window.addEventListener("resize", () => stage.resize());
  window.addEventListener("keydown", (e) => {
    if (e.key === " " && !(e.target instanceof HTMLInputElement)) {
      e.preventDefault(); store.set({ playing: !store.get().playing });
    }
    if (e.key === "Escape") { det.hide(); buildings.highlight(null); }
    if (e.key === "r" || e.key === "R") flyTo([1500, 1400, 2000], [0, 0, 0]);
    if ((e.key === "g" || e.key === "G") && !(e.target instanceof HTMLInputElement)) {
      e.preventDefault(); walk.toggle();
    }
    if ((e.key === "a" || e.key === "A") && !(e.target instanceof HTMLInputElement)) {
      e.preventDefault();
      exposure.toggle();
      if (exposure.isOpen()) exposure.setMetrics(frozenScenario ?? baseline);
    }
    if ((e.key === "p" || e.key === "P") && !(e.target instanceof HTMLInputElement)) {
      e.preventDefault(); picker.toggle();
    }
  });

  let acc = 0;
  let motionTick = 0;
  startLoop((dt) => {
    const s = store.get();
    if (s.playing) {
      acc += dt;
      if (acc > 60) {
        // wrap inside the time control's own 04:00-23:20 window rather than modulo 1440, so
        // playback never parks the clock at a position the slider cannot represent
        const next = s.timeMin + acc * 0.012;
        store.set({ timeMin: next > 1400 ? 240 : next });
        acc = 0;
      }
    }
    walk.update(dt);
    if (flight && !walk.active) {
      flight.t = Math.min(flight.t + dt / 900, 1);
      const e = 1 - Math.pow(1 - flight.t, 3);
      stage.camera.position.lerpVectors(flight.from, flight.to, e);
      stage.controls.target.lerpVectors(flight.tFrom, flight.tTo, e);
      if (flight.t >= 1) flight = null;
    }
    // sub-pixel detail is the most expensive geometry in the scene per pixel it contributes;
    // both of these declare the height below which they are worth drawing
    const camY = stage.camera.position.y;
    furniture.setCameraHeight(camY);
    roofDetail.setCameraHeight(camY);
    pedestrians.setCameraHeight(camY);
    buses.update(s.timeMin);
    traffic.update(s.timeMin * 60);
    metro.update(s.timeMin);
    pedestrians.update(s.timeMin);
    if (s.playing || motionTick++ % 30 === 0) {
      store.set({ vehicles: traffic.vehicleCount(), busesOnRoad: buses.busCount(),
                  trains: metro.trainCount(), walkers: pedestrians.walkerCount() });
    }
    stage.render();
  }, (fps, frameMs) => {
    const g = stage.gpu.sample();
    store.set({ fps, frameMs, gpuMs: g.ms ?? 0 });
  });

  // ---------------------------------------------------------------- live feed
  //
  // Started AFTER the scene is rendering and the loop is running. The scope lock says the demo
  // must work with every external provider disabled, so this can only ever add to a scene that
  // already stands on its own — it never gates boot, and a failure is a reported status.
  /** The manifest is the authority on what may be contacted. A build without a key must not fire
   *  a request that can only 404 — it logs a console error for every user and claims a capability
   *  the deployment does not have. */
  const allowed = (name: string) => m.health.live_adapters.includes(name);

  const snapshotAir: AirReading | null = weather?.air_baseline
    ? {
        pm2_5: weather.air_baseline.pm2_5, pm10: weather.air_baseline.pm10,
        no2: weather.air_baseline.no2, so2: weather.air_baseline.so2,
        o3: weather.air_baseline.o3, co: weather.air_baseline.co,
        source_time: weather.air_baseline.source_time,
        state: "fallback", provider: weather.air_baseline.provider,
      }
    : null;

  const snapshotState: ExposureState = {
    air: snapshotAir, forecast: [], fromSnapshot: true,
    snapshotNote: "The live Open-Meteo reading has not arrived, so this is the pinned figure from "
                  + "2026-09-03. Every number derived from it is as old as it is.",
  };
  latestAir = snapshotAir;
  exposure.setAir(snapshotState);
  mast.setFeed("fallback", "pinned snapshot",
    "No live provider contacted yet. Air quality is the pinned snapshot in weather/baseline.json.");

  /**
   * Real buses supersede replay: showing both would put invented vehicles next to real ones on the
   * same street, which is the one thing this product must not do.
   *
   * But "the feed is live" and "the feed has buses in it" are different facts, and conflating them
   * emptied the streets. Tested against the real OTD feed at 23:55 IST: a valid, 2-second-old
   * GTFS-Realtime response with a correct header and **zero vehicle entities** — DTC buses are off
   * the road at that hour, and the feed says so honestly. Superseding the replay on `state === live`
   * alone therefore removed every bus from the scene and replaced them with nothing.
   *
   * So replay is superseded only when there is actually something to supersede it WITH. When the
   * feed is live but reports nothing inside the study box, replay keeps running and the feed chip
   * says exactly that, rather than leaving the user to wonder where the buses went.
   */
  function reconcileBuses(state: string, count: number) {
    const connected = state === "live" || state === "stale";
    const live = connected && count > 0;
    buses.setVisible(!live && (store.get().layers.buses ?? true));
    liveBuses.setVisible(live);
    const rep = registry.reports.get("livebuses");
    if (rep) {
      rep.status = live ? "ready" : state === "unavailable" ? "unavailable" : "empty";
      rep.features = count;
      rep.provenance = liveBuses.provenance(liveBuses.feed!);
      rail0.update(LAYER_ORDER.map((id) => registry.reports.get(id))
        .filter((r): r is LayerReport => Boolean(r)));
    }
    store.set({ liveBuses: live ? count : 0 });
  }

  let liveTimer = 0;
  let busTimer = 0;
  async function pollBuses() {
    const f = await liveBuses.refresh();
    reconcileBuses(f.state, liveBuses.liveCount());
    if (f.state === "live" || f.state === "stale") {
      const n = liveBuses.liveCount();
      const age = Math.round(f.ageSeconds ?? 0);
      if (n > 0) {
        mast.setFeed(f.state, `${n} live buses`,
          `${f.provider} · feed ${age} s old · `
          + `${f.inBox} of ${f.vehicles.length} vehicles inside the study box`);
      } else {
        // connected and honest about being empty. Two different empties, and the chip names which.
        mast.setFeed("live-empty",
          f.vehicles.length === 0 ? "live feed · no buses reporting" : "live feed · none in box",
          `${f.provider} · feed ${age} s old · `
          + `${f.vehicles.length} vehicles in the whole feed, ${f.inBox} inside the study box. `
          + (f.vehicles.length === 0
              ? "The feed is connected and reporting no vehicles at all, which is what it does "
                + "outside service hours. "
              : "Buses are running elsewhere in Delhi but none are inside this 16 km² box right now. ")
          + "What you see on the streets is the deterministic replay layer, labelled as such.");
      }
    }
  }
  reconcileBuses(liveBuses.feed?.state ?? "unconfigured", liveBuses.liveCount());
  if (allowed("otd_vehicle_positions")) {
    void pollBuses();
    busTimer = window.setInterval(pollBuses, 20 * 1000);
  }

  async function pollLive() {
    const bundle = await fetchLive();
    if (bundle.air) {
      latestAir = bundle.air;
      exposure.setAir({
        air: bundle.air, forecast: bundle.forecast, fromSnapshot: false, snapshotNote: "",
      });
      const age = bundle.air.state;
      if (!liveBuses.hasLive()) mast.setFeed(age, age === "live" ? "air quality live" : "air quality stale",
        `${bundle.air.provider} · reading for ${bundle.air.source_time} · `
        + `one value for the whole study area (the source grid is ~11 km)`);
      registry.reports.set("airquality", {
        id: "airquality", label: "Air quality (live)", status: "ready",
        provenance: null, features: 1, bytes: 0, ms: 0, drawCalls: 0, triangles: 0,
      });
    } else {
      // stay on the snapshot and say so, rather than showing nothing
      latestAir = snapshotAir;
      exposure.setAir(snapshotState);
      mast.setFeed("unavailable", "live feed down",
        `Open-Meteo unavailable: ${bundle.errors.join("; ") || "unknown"}. `
        + "Showing the pinned snapshot. Nothing else in the app depends on it.");
    }
    // the observed rain rate can drive the same control the bundled scenario uses
    if (bundle.weather && store.get().scenario === null) {
      const band = bandFromRain(bundle.weather.rain_mm);
      if (band !== store.get().rain) store.set({ rain: band });
    }
  }
  if (allowed("open_meteo_air_quality") || allowed("open_meteo_weather")) {
    void pollLive();
    liveTimer = window.setInterval(pollLive, 10 * 60 * 1000);
  } else {
    mast.setFeed("idle", "offline build",
      "This build lists no live adapters, so no provider is contacted at all.");
  }
  window.addEventListener("beforeunload", () => {
    clearInterval(liveTimer);
    if (busTimer) clearInterval(busTimer);
  });

  // ---------------------------------------------------------------- onboarding
  document.body.append(onboarding(m, () => {}, () => applyStep(0)));

  // expose a tiny handle for the budget/QA harness
  (window as unknown as Record<string, unknown>).__twin = {
    reports, totals: () => registry.totals(), manifest: m,
    fps: () => store.get().fps,
    frameMs: () => store.get().frameMs,
    gpu: () => stage.gpu.sample(),
    /**
     * Benchmark one configuration honestly: park the camera, drop stale samples, collect a fixed
     * number of fresh ones, then report the median. Without the reset a rolling mean spans the
     * change being measured; without a fixed camera the frustum keeps changing what is submitted.
     */
    bench: async (opts: { pos: [number, number, number]; target: [number, number, number];
                          frames?: number }) => {
      stage.camera.position.set(...opts.pos);
      stage.controls.target.set(...opts.target);
      stage.controls.update();
      await new Promise((r) => setTimeout(r, 400));
      stage.gpu.reset();
      const want = opts.frames ?? 40;
      const deadline = Date.now() + 8000;
      while (stage.gpu.count() < want && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 60));
      }
      return {
        gpuMedianMs: stage.gpu.median(),
        gpuSamples: stage.gpu.count(),
        disjoint: stage.gpu.sample().disjoint,
        cpuMs: store.get().frameMs,
        submitted: stage.submitted(),
        pixels: stage.pixelLoad(),
      };
    },
    /** Toggle the shadow map, for isolating its cost. */
    setShadows: (on: boolean) => { stage.renderer.shadowMap.enabled = on; stage.forceShadowRefresh(); },
    setQuality: (q: "low" | "medium" | "high") => stage.setQuality(q),
    quality: () => stage.post.quality,
    renderScale: () => stage.post.scale,
    /** submitted after culling, vs declared — the gap is the culling */
    submitted: () => stage.submitted(),
    /** street furniture, whose whole point is that it is NOT drawn from altitude */
    furnitureState: () => ({
      visible: furniture.group.visible,
      cameraY: Math.round(stage.camera.position.y),
      gateM: FurnitureLayer.VISIBLE_BELOW_M,
      counts: furniture.breakdown(),
    }),
    /** the reach field, addressable without a synthetic pointer event */
    reach: {
      set(x: number, z: number, mode: ReachMode = "walk") {
        reachOrigin = { x, z };
        originPin.position.set(x, 0, z);
        originPin.visible = true;
        reachRail.show();
        runReach(mode);
        return true;
      },
      run(mode: ReachMode) { reachRail.show(); runReach(mode); },
      graph: () => ensureReachCtx()?.graph.stats ?? null,
      servedKm2: () => ensureReachCtx()?.servedKm2 ?? null,
      route(ax: number, az: number, bx: number, bz: number) {
        reachRail.setMode("route");
        reachRail.show();
        routeFrom = { x: ax, z: az };
        originPin.position.set(ax, 0, az); originPin.visible = true;
        destPin.position.set(bx, 0, bz); destPin.visible = true;
        runRoute({ x: bx, z: bz });
        // a failed query returns the error, not null: `null?.error` is undefined, and a caller
        // testing for a failure would read that as a success
        if (!lastRoute) return { error: "no route" };
        return !("error" in lastRoute) ? {
          identical: lastRoute.identical,
          extraMinutes: lastRoute.extraMinutes,
          doseSavedFrac: lastRoute.doseSavedFrac,
          fastest: { minutes: lastRoute.fastest.minutes, metres: lastRoute.fastest.metres,
                     doseMinutes: lastRoute.fastest.doseMinutes,
                     meanEnrich: lastRoute.fastest.meanEnrich, points: lastRoute.fastest.path.length },
          cleanest: { minutes: lastRoute.cleanest.minutes, metres: lastRoute.cleanest.metres,
                      doseMinutes: lastRoute.cleanest.doseMinutes,
                      meanEnrich: lastRoute.cleanest.meanEnrich, points: lastRoute.cleanest.path.length },
          ug: lastRoute.ug,
        } : lastRoute;
      },
      last: () => (lastReach ? {
        mode: lastReach.mode,
        areasKm2: lastReach.areasKm2,
        compareAreasKm2: lastReach.compareAreasKm2,
        servedKm2: lastReach.servedKm2,
        detour: lastReach.detour,
        reached: lastReach.reached,
        stepLossPct: lastReach.stepLossPct,
      } : null),
      visible: () => reachLayer.visible,
    },
    pixelLoad: () => stage.pixelLoad(),
    ready: true,
  };
}

boot().catch((e) => fatal("The application failed to start", String(e)));
