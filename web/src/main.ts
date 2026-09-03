import * as THREE from "three";
import "./style.css";

import { probe } from "./core/capability";
import { Stage } from "./core/stage";
import { startLoop } from "./core/loop";
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
import { RoofDetailLayer, StreetscapeLayer, BuildingPartsLayer } from "./layers/detail";
import { BusLayer } from "./layers/buses";
import { placePicker, type Place } from "./ui/places";
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
  "trees", "rail", "transit", "traffic", "buses",
];

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

  const registry = new LayerRegistry(root);
  const ground = new GroundLayer();
  const water = new WaterLayer();
  const roads = new RoadsLayer();
  const buildings = new BuildingsLayer();
  const rail = new RailLayer();
  const transit = new TransitLayer();
  const corridors = new CorridorLayer();
  const landmarks = new LandmarkLayer();
  const trees = new TreesLayer();
  const streetscape = new StreetscapeLayer();
  const buildingParts = new BuildingPartsLayer();
  registry.add(ground).add(water).add(streetscape).add(roads).add(buildings)
          .add(buildingParts).add(landmarks).add(trees).add(rail).add(transit).add(corridors);

  await registry.buildAll();

  // Second wave: layers built from another layer's resolved data. Each is wrapped the way
  // buildAll wraps the others, so a failure here degrades to a reported status rather than a
  // dead scene (FR-01).
  const buses = new BusLayer(transit.routes);
  const traffic = new TrafficLayer(corridors.corridors);
  const roofDetail = new RoofDetailLayer(buildings.buildings);
  for (const l of [roofDetail, traffic, buses]) {
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
  const rail0 = layerRail(LAYER_ORDER,
    (id, on) => { registry.setVisible(id, on); store.set({ layers: { ...store.get().layers, [id]: on } }); rail0.refresh(); },
    (on) => { buildings.setReveal(on); store.set({ revealEstimated: on }); rail0.refresh(); });
  const leg = legend();
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

  const tbar = timeBar(weather,
    (min) => { store.set({ timeMin: min }); },
    (playing) => { store.set({ playing }); },
    (b) => { store.set({ rain: b }); });

  document.body.append(mast.node, rail0.node, leg.node, det.node, lab.node, tbar.node);
  rail0.update(reports);
  recompute();

  mast.statusBtn.addEventListener("click", () =>
    document.body.append(dataStatus(m, reports)));

  // ---------------------------------------------------------------- places to jump to
  const placesRes = await load.grab<{ features: Place[] }>("places.json");
  const picker = placePicker(placesRes.ok ? placesRes.data.features : [], (pl) => {
    // frame from the south-east at a height proportional to the framing distance, so a district
    // reads as a district and a monument fills the view
    flyTo([pl.x + pl.dist * 0.55, pl.dist * 0.62, pl.z + pl.dist], [pl.x, 0, pl.z]);
    picker.hide();
  });
  document.body.append(picker.node);
  mast.placesBtn.addEventListener("click", () => picker.toggle());

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

    const targets: THREE.Object3D[] = [];
    const push = (o?: THREE.Object3D | null) => { if (o && o.visible && o.parent?.visible) targets.push(o); };
    push(corridors.mesh3);
    transit.group.children.forEach(push);
    rail.group.children.forEach((c) => { if (c.name === "stations") push(c); });
    push(buildings.mesh3);
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
      const b = buildings.buildingAtVertex(hit.face.a);
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
    if (flight) {
      flight.t = Math.min(flight.t + dt / 900, 1);
      const e = 1 - Math.pow(1 - flight.t, 3);
      stage.camera.position.lerpVectors(flight.from, flight.to, e);
      stage.controls.target.lerpVectors(flight.tFrom, flight.tTo, e);
      if (flight.t >= 1) flight = null;
    }
    buses.update(s.timeMin);
    traffic.update(s.timeMin * 60);
    if (s.playing || motionTick++ % 30 === 0) {
      store.set({ vehicles: traffic.vehicleCount(), busesOnRoad: buses.busCount() });
    }
    stage.render();
  }, (fps) => store.set({ fps }));

  // ---------------------------------------------------------------- onboarding
  document.body.append(onboarding(m, () => {}, () => applyStep(0)));

  // expose a tiny handle for the budget/QA harness
  (window as unknown as Record<string, unknown>).__twin = {
    reports, totals: () => registry.totals(), manifest: m,
    fps: () => store.get().fps, ready: true,
  };
}

boot().catch((e) => fatal("The application failed to start", String(e)));
