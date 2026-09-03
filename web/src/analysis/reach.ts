import type { Graph, Raster } from "./network";
import { walkField, rasterise, detourRatio, route, WALK_M_PER_MIN } from "./network";
import type { Route } from "./network";
import { BANDS } from "../layers/reach";
import type { Station, Stop } from "../geo/types";

/**
 * The four questions the reach field answers, and the summary each one produces.
 *
 * `walk` and `stepFree` are origin-based: you pick a point and ask what is within reach. The other
 * two are network-wide and origin-free — "how far is the nearest metro station from wherever you
 * happen to be" is a property of the city, not of a journey, and it is the one that produces a
 * quotable civic statistic.
 *
 * Every summary is reported against the **served area** — the part of the box within 70 m of any
 * mapped way — and not against the box area. Roughly a third of this box is lawn, carriageway
 * island and walled compound interior that no pedestrian network reaches at all, and dividing by
 * the box would quietly under-state every share by that third.
 */

export type ReachMode = "walk" | "stepfree" | "metro" | "busstop" | "route";

export interface Place { id: string; name: string; cat: string; x: number; z: number }

export interface ReachResult {
  mode: ReachMode;
  origin: { x: number; z: number } | null;
  raster: Raster;
  /** the step-free field, when the mode is a comparison */
  compare: Raster | null;
  /** km² inside each cumulative band of BANDS */
  areasKm2: number[];
  compareAreasKm2: number[] | null;
  servedKm2: number;
  detour: { median: number; p90: number; worst: { ratio: number; walkM: number; lineM: number } | null };
  reached: {
    places: number; placesTotal: number;
    markets: number; worship: number; government: number;
    metro: number; metroTotal: number;
    busStops: number; busStopsTotal: number;
  };
  /** for the step-free comparison: share of the 15-minute area that needs steps to get to */
  stepLossPct: number | null;
  /** minutes to the nearest source at the origin, for the origin-free modes */
  atOrigin: number | null;
  /** set when the starting point sits on a small, disconnected fragment of the mapped network.
   *  The answer is then a property of the data, not of the city, and must be labelled that way. */
  fragment: { nodes: number; ofLargest: number } | null;
}

/** Below this many nodes, a component is an artefact of incomplete mapping rather than a
 *  genuinely isolated pocket of the city. 250 nodes is roughly 5 km of ways. */
const MIN_COMPONENT = 250;

export interface ReachContext {
  graph: Graph;
  extent: { x: [number, number]; z: [number, number] };
  places: Place[];
  stations: Station[];
  stops: Stop[];
  /** raster of the served area, computed once */
  served: Raster;
  servedKm2: number;
  /** node index per feature, resolved once */
  stationNodes: number[];
  stopNodes: number[];
  placeNodes: number[];
}

const CELL = 20;
const TAIL = 70;
const HORIZON = 30;

export function reachContext(
  graph: Graph, extent: { x: [number, number]; z: [number, number] },
  places: Place[], stations: Station[], stops: Stop[],
): ReachContext {
  // every node at zero cost: the resulting raster is exactly the area the network can serve, which
  // is the only defensible denominator for a share
  const zero = new Float32Array(graph.n);
  const served = rasterise(graph, zero, extent, CELL, TAIL);
  let cells = 0;
  for (let i = 0; i < served.min.length; i++) if (Number.isFinite(served.min[i])) cells++;

  return {
    graph, extent, places, stations, stops,
    served, servedKm2: cells * (CELL * CELL) / 1e6,
    stationNodes: stations.map((s) => graph.nearest(s.x, s.z, 120)),
    stopNodes: stops.map((s) => graph.nearest(s.x, s.z, 90)),
    placeNodes: places.map((p) => graph.nearest(p.x, p.z, 120)),
  };
}

function summarise(
  ctx: ReachContext, minutes: Float32Array, within: number,
): ReachResult["reached"] {
  const ok = (n: number) => n >= 0 && Number.isFinite(minutes[n]) && minutes[n] <= within;
  let places = 0, markets = 0, worship = 0, government = 0;
  ctx.placeNodes.forEach((n, i) => {
    if (!ok(n)) return;
    places++;
    const c = ctx.places[i].cat;
    if (c === "market") markets++;
    else if (c === "worship") worship++;
    else if (c === "government") government++;
  });
  return {
    places, placesTotal: ctx.places.length,
    markets, worship, government,
    metro: ctx.stationNodes.filter(ok).length, metroTotal: ctx.stations.length,
    busStops: ctx.stopNodes.filter(ok).length, busStopsTotal: ctx.stops.length,
  };
}

function areas(r: Raster): number[] {
  const cellKm2 = (r.cell * r.cell) / 1e6;
  const out = BANDS.map(() => 0);
  for (let i = 0; i < r.min.length; i++) {
    const v = r.min[i];
    if (!Number.isFinite(v)) continue;
    for (let b = 0; b < BANDS.length; b++) if (v <= BANDS[b]) out[b] += cellKm2;
  }
  return out;
}

export function computeReach(
  ctx: ReachContext, mode: ReachMode, origin: { x: number; z: number } | null,
): ReachResult | { error: string } {
  const g = ctx.graph;

  if (mode === "walk" || mode === "stepfree") {
    if (!origin) return { error: "Pick a starting point on the map." };
    const s = g.nearest(origin.x, origin.z, 140);
    if (s < 0) {
      return { error: "No mapped footway or road within 140 m of that point, so there is nowhere to start walking from. Try a point nearer a street." };
    }
    // charge the walk from the chosen point out to the network, so a start deep inside a
    // compound does not get its first 100 m free
    const lead = Math.hypot(g.x[s] - origin.x, g.z[s] - origin.z) / WALK_M_PER_MIN;
    const full = walkField(g, [s], { maxMinutes: HORIZON, offset: () => lead });
    const free = walkField(g, [s], { maxMinutes: HORIZON, offset: () => lead, stepFree: true });

    const rMain = rasterise(g, full, ctx.extent, CELL, TAIL);
    const rFree = rasterise(g, free, ctx.extent, CELL, TAIL);
    const aMain = areas(rMain), aFree = areas(rFree);
    const i15 = BANDS.indexOf(15);
    const lossPct = aMain[i15] > 0 ? ((aMain[i15] - aFree[i15]) / aMain[i15]) * 100 : 0;

    const comparing = mode === "stepfree";
    const compId = g.comp[s];
    const compNodes = g.compSize[compId] ?? 0;
    const largest = g.compSize.length ? Math.max(...g.compSize) : 0;
    return {
      mode, origin,
      fragment: compNodes < MIN_COMPONENT ? { nodes: compNodes, ofLargest: largest } : null,
      raster: rMain, compare: comparing ? rFree : null,
      areasKm2: aMain, compareAreasKm2: aFree,
      servedKm2: ctx.servedKm2,
      detour: detourRatio(g, full, origin),
      reached: summarise(ctx, comparing ? free : full, 15),
      stepLossPct: lossPct,
      atOrigin: 0,
    };
  }

  // ---- origin-free: distance to the nearest station or stop
  const sources = (mode === "metro" ? ctx.stationNodes : ctx.stopNodes).filter((n) => n >= 0);
  if (!sources.length) {
    return { error: mode === "metro"
      ? "No metro station in this box could be attached to the walking network."
      : "No bus stop in this box could be attached to the walking network." };
  }
  const f = walkField(g, sources, { maxMinutes: HORIZON });
  const r = rasterise(g, f, ctx.extent, CELL, TAIL);
  return {
    mode, origin,
    raster: r, compare: null,
    areasKm2: areas(r), compareAreasKm2: null,
    servedKm2: ctx.servedKm2,
    detour: { median: 1, p90: 1, worst: null },
    reached: summarise(ctx, f, 10),
    stepLossPct: null,
    atOrigin: origin ? r.at(origin.x, origin.z) : null,
    fragment: null,
  };
}


/* ------------------------------------------------------------------ route comparison */

export interface RoutePair {
  fastest: Route;
  cleanest: Route;
  /** true when the two objectives picked the same path — the common case, and the honest headline */
  identical: boolean;
  /** extra minutes the cleaner route costs */
  extraMinutes: number;
  /** proportional reduction in inhaled dose, 0..1 */
  doseSavedFrac: number;
  /** absolute inhaled PM2.5 in µg, when an air reading is available */
  ug: { fastest: number; cleanest: number } | null;
}

export interface RouteInputs {
  /** observed PM2.5 in µg/m³, or null when no reading is available */
  pm2_5: number | null;
  /** m³ per minute while walking, from the versioned exposure model */
  ventilation: number;
}

export function routeBetween(
  ctx: ReachContext, from: { x: number; z: number }, to: { x: number; z: number },
  inp: RouteInputs,
): RoutePair | { error: string } {
  const g = ctx.graph;
  const a = g.nearest(from.x, from.z, 140);
  const b = g.nearest(to.x, to.z, 140);
  if (a < 0) return { error: "No mapped way within 140 m of the starting point." };
  if (b < 0) return { error: "No mapped way within 140 m of the destination." };
  if (a === b) return { error: "The two points are on the same piece of street — pick a destination further away." };
  if (g.comp[a] !== g.comp[b]) {
    return { error: "These two points are on separate fragments of the mapped network, so no route between them exists in this data. On the ground you could very likely walk it." };
  }
  const fastest = route(g, a, b, "time");
  const cleanest = route(g, a, b, "dose");
  if (!fastest || !cleanest) return { error: "No walking route found between those points." };

  const same = fastest.nodes.length === cleanest.nodes.length
    && fastest.nodes.every((n, i) => n === cleanest.nodes[i]);
  // dose ∝ concentration × ventilation × Σ(minutes × enrichment)
  const ug = inp.pm2_5 !== null && inp.pm2_5 > 0
    ? { fastest: inp.pm2_5 * inp.ventilation * fastest.doseMinutes,
        cleanest: inp.pm2_5 * inp.ventilation * cleanest.doseMinutes }
    : null;
  return {
    fastest, cleanest, identical: same,
    extraMinutes: cleanest.minutes - fastest.minutes,
    doseSavedFrac: fastest.doseMinutes > 0
      ? (fastest.doseMinutes - cleanest.doseMinutes) / fastest.doseMinutes : 0,
    ug,
  };
}
