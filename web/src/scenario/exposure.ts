import type { CorridorMetrics } from "./engine";

/**
 * How much PM2.5 you actually breathe getting along a corridor, and whether a different mode or a
 * different hour would be better.
 *
 * This is the part of the product that answers a question a Delhi resident actually has. It is also
 * the first place the app uses an **observed live measurement**: the concentration comes off a real
 * feed. Everything that turns that concentration into a dose is a declared heuristic, versioned in
 * `scenario-model-0.1.json:exposure_model` and displayed next to the numbers it produces.
 *
 *     dose (µg) = concentration (µg/m³) × ventilation (m³/min) × minutes × penetration × enrichment
 *
 * The non-obvious result it exists to show: on a bus journey the *waiting* usually dominates, not
 * the riding — you stand at the kerb, breathing harder than you would sitting, in air enriched by
 * the traffic beside you. Which means bus frequency is an air-quality intervention, not only a
 * wait-time one.
 */

export interface ExposureModel {
  version: string;
  ventilation_m3_per_min: Record<string, number>;
  penetration: Record<string, number>;
  roadside_enrichment: Record<string, number>;
  who_guideline_ug_m3: Record<string, number>;
  reference: Record<string, number | string>;
}

export type Mode = "walk" | "cycle" | "bus" | "car";
export type Activity = "sitting" | "standing" | "walking" | "cycling";
export type Setting = "outdoor" | "bus" | "car_recirculating" | "metro_underground";

export interface Leg {
  what: string;
  minutes: number;
  activity: Activity;
  setting: Setting;
  enrichment: number;
  enrichmentWhy: string;
  dose_ug: number;
}

export interface JourneyExposure {
  mode: Mode;
  label: string;
  available: boolean;
  unavailableReason?: string;
  totalMinutes: number;
  dose_ug: number;
  legs: Leg[];
  /** share of a WHO 24-hour guideline day this single journey accounts for */
  whoDayFraction: number;
  cigarettes: number;
}

const WALK_KMH = 4.8;
const CYCLE_KMH = 15.0;

const MODE_LABEL: Record<Mode, string> = {
  walk: "Walk", cycle: "Cycle", bus: "Bus", car: "Car",
};

function leg(
  what: string, minutes: number, activity: Activity, setting: Setting,
  enrichment: number, enrichmentWhy: string, conc: number, m: ExposureModel,
): Leg {
  const v = m.ventilation_m3_per_min[activity] ?? 0.013;
  const p = m.penetration[setting] ?? 1;
  return {
    what, minutes, activity, setting, enrichment, enrichmentWhy,
    dose_ug: conc * v * minutes * p * enrichment,
  };
}

function finish(mode: Mode, legs: Leg[], m: ExposureModel): JourneyExposure {
  const dose = legs.reduce((a, l) => a + l.dose_ug, 0);
  const minutes = legs.reduce((a, l) => a + l.minutes, 0);
  // a whole day at this concentration, breathing at the resting rate, against the WHO 24h figure
  const whoDayDose = (m.who_guideline_ug_m3.pm2_5_24h ?? 15)
    * (m.ventilation_m3_per_min.sitting ?? 0.011) * 1440;
  const cig = Number(m.reference.cigarette_equivalent_ug) || 12000;
  return {
    mode, label: MODE_LABEL[mode], available: true,
    totalMinutes: minutes, dose_ug: dose, legs,
    whoDayFraction: whoDayDose > 0 ? dose / whoDayDose : 0,
    cigarettes: dose / cig,
  };
}

export interface ExposureInputs {
  /** observed PM2.5 in µg/m³ */
  pm2_5: number;
  metrics: CorridorMetrics;
  corridorLengthM: number;
  model: ExposureModel;
  /** true when the corridor carries no bus route at all */
  transitAvailable: boolean;
}

export function journeys(inp: ExposureInputs): JourneyExposure[] {
  const { pm2_5: c, metrics, corridorLengthM: L, model: m } = inp;
  const km = L / 1000;
  const E = m.roadside_enrichment;
  const out: JourneyExposure[] = [];

  out.push(finish("walk", [
    leg(`Walking ${km.toFixed(1)} km of footway`, (km / WALK_KMH) * 60,
        "walking", "outdoor", E.walking_footway ?? 1.15,
        "Footways run alongside the carriageway, so kerbside air is enriched above the city background.",
        c, m),
  ], m));

  out.push(finish("cycle", [
    leg(`Cycling ${km.toFixed(1)} km in traffic`, (km / CYCLE_KMH) * 60,
        "cycling", "outdoor", E.in_traffic ?? 1.20,
        "Cycling in the traffic stream, breathing roughly four times as hard as sitting.",
        c, m),
  ], m));

  if (inp.transitAvailable && metrics.waitProxyMin !== null) {
    out.push(finish("bus", [
      leg(`Waiting ${metrics.waitProxyMin.toFixed(1)} min at a roadside stop`,
          metrics.waitProxyMin, "standing", "outdoor", E.waiting_at_stop ?? 1.25,
          "Standing at the kerb, next to the traffic you are waiting to join.", c, m),
      leg(`Riding ${metrics.travelTimeMin.toFixed(1)} min on the bus`,
          metrics.travelTimeMin, "sitting", "bus", 1.0,
          "Inside a bus, windows typically open, so little is filtered out.", c, m),
    ], m));
  } else {
    out.push({
      mode: "bus", label: MODE_LABEL.bus, available: false,
      unavailableReason: "No bus route runs on this corridor, so there is no bus journey to compare.",
      totalMinutes: 0, dose_ug: 0, legs: [], whoDayFraction: 0, cigarettes: 0,
    });
  }

  out.push(finish("car", [
    leg(`Driving ${metrics.travelTimeMin.toFixed(1)} min`, metrics.travelTimeMin,
        "sitting", "car_recirculating", E.in_traffic ?? 1.20,
        "Sitting in the traffic stream; a cabin on recirculation filters roughly half the PM2.5.",
        c, m),
  ], m));

  return out;
}

export interface BetterHour {
  time: string;
  pm2_5: number;
  /** relative to the concentration right now */
  reductionPct: number;
  hoursAway: number;
}

/**
 * The cheapest intervention available to anyone is going at a different hour. Scans the forecast
 * for the lowest concentration within the window and reports it only when the improvement is
 * material — a 4% dip is noise, not advice.
 */
export function betterTimeToTravel(
  nowPm: number,
  forecast: { time: string; pm2_5: number }[],
  withinHours = 14,
  minReductionPct = 15,
): BetterHour | null {
  if (!forecast.length || !(nowPm > 0)) return null;
  const now = Date.now();
  const candidates = forecast
    .map((h) => {
      const t = Date.parse(/[Z+]/.test(h.time) ? h.time : `${h.time}+05:30`);
      return { ...h, t, hoursAway: (t - now) / 3600000 };
    })
    .filter((h) => Number.isFinite(h.t) && h.hoursAway > 0.5 && h.hoursAway <= withinHours);
  if (!candidates.length) return null;

  const best = candidates.reduce((a, b) => (b.pm2_5 < a.pm2_5 ? b : a));
  const reduction = ((nowPm - best.pm2_5) / nowPm) * 100;
  if (reduction < minReductionPct) return null;
  return {
    time: best.time, pm2_5: best.pm2_5,
    reductionPct: reduction, hoursAway: best.hoursAway,
  };
}

export interface WhoContext {
  multipleOfGuideline: number;
  band: "within guideline" | "1–2×" | "2–4×" | "4–8×" | "over 8×";
  plain: string;
}

/** WHO's 24-hour PM2.5 guideline is 15 µg/m³. Saying "71" means nothing without that anchor. */
export function whoContext(pm2_5: number, model: ExposureModel): WhoContext {
  const g = model.who_guideline_ug_m3.pm2_5_24h ?? 15;
  const x = pm2_5 / g;
  const band: WhoContext["band"] =
    x <= 1 ? "within guideline" : x <= 2 ? "1–2×" : x <= 4 ? "2–4×" : x <= 8 ? "4–8×" : "over 8×";
  const plain =
    x <= 1 ? `At or below the WHO 24-hour guideline of ${g} µg/m³.`
           : `${x.toFixed(1)}× the WHO 24-hour guideline of ${g} µg/m³.`;
  return { multipleOfGuideline: x, band, plain };
}

/** Colour ramp for concentration. Sequential in lightness so it survives greyscale and CVD
 *  review, matching the rule the traffic ramp already follows. */
export function pmColour(pm2_5: number): string {
  const stops: [number, string][] = [
    [0, "#e8efe6"], [15, "#cfe0b8"], [35, "#f0dc9a"],
    [60, "#e2a453"], [110, "#c4562f"], [200, "#8a2c26"], [400, "#54171a"],
  ];
  for (let i = 1; i < stops.length; i++) {
    if (pm2_5 <= stops[i][0]) return stops[i - 1][1];
  }
  return stops[stops.length - 1][1];
}
