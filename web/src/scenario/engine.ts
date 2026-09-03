import type { Corridor, ScenarioModel, BusRoute } from "../geo/types";
import type { RainBand } from "../state/store";

/**
 * A transparent comparative model, not a prediction. Every coefficient it uses comes from
 * `scenario-model-0.1.json`, which is loaded at runtime and displayed in the UI — changing a weight
 * is a data change plus a version bump, never a silent code edit.
 *
 * Nothing here says "will". Outputs are proxies and indices, labelled as such.
 */

export interface SegmentState { i: number; ratio: number; speedKmh: number }

export interface CorridorMetrics {
  corridorId: string;
  label: string;
  timeMin: number;
  rain: RainBand;
  freeFlowKmh: number;
  meanSpeedKmh: number;
  /** 0 = at free flow, 1 = stopped */
  speedPenalty: number;
  travelTimeMin: number;
  weatherImpact: number;
  /** null when the corridor has no transit layer at all — Kartavya Path */
  transitPressure: number | null;
  msi: number;
  msiWeightsRenormalised: boolean;
  segments: SegmentState[];
  headwayMin: number | null;
  busesPerHour: number | null;
  waitProxyMin: number | null;
  stopsServed: number;
  routesServing: string[];
}

/** Deterministic, reproducible per-segment variation. Same segment, same value, forever. */
function hash01(a: string, b: number): number {
  let h = 2166136261;
  for (let i = 0; i < a.length; i++) { h ^= a.charCodeAt(i); h = Math.imul(h, 16777619); }
  h ^= b + 0x9e3779b9; h = Math.imul(h, 16777619);
  return ((h >>> 0) % 10000) / 10000;
}

function roadClassOf(c: Corridor): "primary" | "secondary" | "tertiary" {
  if (c.role === "orientation-spine") return "primary";
  return "secondary";
}

export interface TrafficInputs {
  corridor: Corridor;
  timeMin: number;
  rain: RainBand;
  model: ScenarioModel;
  /** declared diurnal profile, 24 hourly values 0..1 */
  diurnal: number[];
  corridorBase: Record<string, number>;
}

export function corridorTraffic(inp: TrafficInputs) {
  const { corridor, timeMin, rain, model, diurnal, corridorBase } = inp;
  const cls = roadClassOf(corridor);
  const freeFlow = model.free_flow_kmh[cls === "primary" ? "primary" : "secondary"] ?? 35;
  const rainMult = model.rain_speed_multiplier[rain]?.[cls] ?? 1;

  // hourly profile with linear interpolation, so the time slider is smooth rather than steppy
  const h = Math.floor(timeMin / 60) % 24;
  const frac = (timeMin % 60) / 60;
  const d = diurnal[h] * (1 - frac) + diurnal[(h + 1) % 24] * frac;
  const base = d * (corridorBase[corridor.id] ?? 1);

  const segments: SegmentState[] = corridor.segments.map((s) => {
    // +/-18% deterministic spread so a corridor is not one flat colour
    const jitter = 0.82 + hash01(corridor.id, s.i) * 0.36;
    const congestion = Math.min(Math.max(base * jitter, 0), 1);
    const speed = Math.max(freeFlow * (1 - congestion * 0.78) * rainMult, 3);
    return { i: s.i, ratio: Math.min(Math.max(1 - speed / freeFlow, 0), 1), speedKmh: speed };
  });

  let timeMinutes = 0, weighted = 0, totalLen = 0;
  corridor.segments.forEach((s, k) => {
    const sp = segments[k].speedKmh;
    timeMinutes += (s.len / 1000) / sp * 60;
    weighted += sp * s.len; totalLen += s.len;
  });
  const meanSpeed = totalLen > 0 ? weighted / totalLen : freeFlow;

  return {
    cls, freeFlow, rainMult, segments,
    travelTimeMin: timeMinutes,
    meanSpeedKmh: meanSpeed,
    speedPenalty: Math.min(Math.max(1 - meanSpeed / freeFlow, 0), 1),
    weatherImpact: Math.min(Math.max(1 - rainMult, 0), 1),
  };
}

export interface MetricsInputs extends TrafficInputs {
  routes: BusRoute[];
  /** 1 = baseline. 2 = twice as frequent, so headway halves. */
  busFreqMultiplier: number;
}

export function corridorMetrics(inp: MetricsInputs): CorridorMetrics {
  const { corridor, routes, busFreqMultiplier, model } = inp;
  const t = corridorTraffic(inp);
  const hasTransit = corridor.layers.includes("transit");

  const serving = hasTransit ? routes.filter((r) => r.corridors.includes(corridor.id)) : [];
  let headway: number | null = null, bph: number | null = null, wait: number | null = null;
  let stops = 0;
  if (serving.length) {
    // combined headway across routes serving the corridor, then the frequency change applied
    const combinedBaseline = 1 / serving.reduce((acc, r) => acc + 1 / r.assumed_headway_min, 0);
    headway = combinedBaseline / Math.max(busFreqMultiplier, 0.1);
    bph = 60 / headway;
    wait = headway / 2;
    const seen = new Set<string>();
    for (const r of serving) for (const s of r.stops) seen.add(s.id);
    stops = seen.size;
  }

  // Pressure is the ABSENCE of service: 12 buses/hour is treated as comfortable, 0 as maximal
  // pressure. A declared normalisation, not an observed crowding measure.
  const transitPressure = bph === null ? null : Math.min(Math.max(1 - bph / 12, 0), 1);

  const w = model.msi_weights;
  const terms: [number, number][] = [
    [w.speed_penalty, t.speedPenalty],
    [w.weather_impact, t.weatherImpact],
  ];
  if (transitPressure !== null) terms.splice(1, 0, [w.transit_pressure, transitPressure]);
  const wsum = terms.reduce((a, [ww]) => a + ww, 0);
  const msi = wsum > 0 ? terms.reduce((a, [ww, v]) => a + ww * v, 0) / wsum : 0;

  return {
    corridorId: corridor.id, label: corridor.label,
    timeMin: inp.timeMin, rain: inp.rain,
    freeFlowKmh: t.freeFlow, meanSpeedKmh: t.meanSpeedKmh,
    speedPenalty: t.speedPenalty, travelTimeMin: t.travelTimeMin,
    weatherImpact: t.weatherImpact, transitPressure,
    msi, msiWeightsRenormalised: transitPressure === null,
    segments: t.segments,
    headwayMin: headway, busesPerHour: bph, waitProxyMin: wait,
    stopsServed: stops, routesServing: serving.map((r) => r.ref),
  };
}

export interface Delta {
  label: string;
  baseline: string;
  scenario: string;
  direction: "up" | "down" | "flat";
  /** true when a lower number is the better outcome */
  lowerIsBetter: boolean;
  note?: string;
}

const n1 = (v: number) => v.toFixed(1);

export function compare(a: CorridorMetrics, b: CorridorMetrics): Delta[] {
  const out: Delta[] = [];
  const dir = (x: number, y: number): Delta["direction"] =>
    Math.abs(y - x) < 0.05 ? "flat" : y > x ? "up" : "down";

  out.push({ label: "Travel-time index proxy", baseline: "1.00",
             scenario: (b.travelTimeMin / Math.max(a.travelTimeMin, 0.01)).toFixed(2),
             direction: dir(a.travelTimeMin, b.travelTimeMin), lowerIsBetter: true,
             note: "Scenario travel time divided by baseline, along the corridor spine." });
  out.push({ label: "Mean speed", baseline: `${n1(a.meanSpeedKmh)} km/h`,
             scenario: `${n1(b.meanSpeedKmh)} km/h`,
             direction: dir(a.meanSpeedKmh, b.meanSpeedKmh), lowerIsBetter: false });
  out.push({ label: "Mobility Stress Index", baseline: a.msi.toFixed(2), scenario: b.msi.toFixed(2),
             direction: dir(a.msi, b.msi), lowerIsBetter: true,
             note: b.msiWeightsRenormalised
               ? "No transit on this corridor, so the transit weight is redistributed across the remaining terms."
               : "Product-defined composite. Weights are shown in the assumptions panel." });
  if (a.headwayMin !== null && b.headwayMin !== null) {
    out.push({ label: "Headway (assumed)", baseline: `${n1(a.headwayMin)} min`,
               scenario: `${n1(b.headwayMin)} min`,
               direction: dir(a.headwayMin, b.headwayMin), lowerIsBetter: true,
               note: "Derived from an assumed 12-minute per-route baseline. No schedule data exists in the source." });
    out.push({ label: "Buses per hour", baseline: n1(a.busesPerHour!), scenario: n1(b.busesPerHour!),
               direction: dir(a.busesPerHour!, b.busesPerHour!), lowerIsBetter: false });
    out.push({ label: "Wait-time proxy", baseline: `${n1(a.waitProxyMin!)} min`,
               scenario: `${n1(b.waitProxyMin!)} min`,
               direction: dir(a.waitProxyMin!, b.waitProxyMin!), lowerIsBetter: true,
               note: "Half the headway, assuming evenly spaced arrivals. Not valid for irregular arrivals." });
  }
  return out;
}
