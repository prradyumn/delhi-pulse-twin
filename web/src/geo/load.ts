import type {
  Manifest, Building, Road, GroundPoly, WaterFeature, RailLine, Station, Stop,
  BusRoute, Corridor, ScenarioModel, WeatherData, Payload, Provenance,
} from "./types";

export const DATA = "data/@v1";

/** A layer's data either arrives or it doesn't. One failure must not reject the scene, so every
 *  fetch resolves to a discriminated result the layer registry can render an honest state from. */
export type Fetched<T> =
  | { ok: true; data: T; bytes: number; ms: number }
  | { ok: false; error: string; status?: number };

const encoder = new TextEncoder();

export async function grab<T>(rel: string): Promise<Fetched<T>> {
  const t0 = performance.now();
  try {
    // Data is versioned by path (@v1), so force-cache is right in production — but it would serve
    // a stale payload after every `make data`, which is exactly the confusion to avoid while
    // iterating. Dev revalidates.
    const res = await fetch(`${DATA}/${rel}`, {
      cache: import.meta.env.DEV ? "no-cache" : "force-cache",
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status} on ${rel}`, status: res.status };
    const text = await res.text();
    // Byte length of the decoded payload, not `text.length` (characters) and not the compressed
    // size on the wire. The UI has to name which of those it is showing.
    return {
      ok: true, data: JSON.parse(text) as T,
      bytes: encoder.encode(text).length,
      ms: performance.now() - t0,
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export const manifest = () => grab<Manifest>("manifest.json");
export const buildings = () => grab<Payload<Building[]> & { height_rule_version: string; count: number }>("buildings.json");
export const roads = () => grab<Payload<Road[]>>("roads.json");
export const ground = () => grab<Payload<GroundPoly[]>>("ground.json");
export const water = () => grab<Payload<WaterFeature[]>>("water.json");
export const rail = () => grab<Payload<{ lines: RailLine[]; stations: Station[] }>>("rail.json");
export const transit = () => grab<Payload<{ stops: Stop[]; routes: BusRoute[] }>>("transit.json");
export const corridors = () => grab<Payload<Corridor[]>>("corridors.json");
export const scenarioModel = () => grab<ScenarioModel>("scenario-model-0.1.json");
export const weather = () => grab<WeatherData>("weather/baseline.json");

export function modeLabel(m: Provenance["mode"]): string {
  return { observed: "Observed", estimated: "Estimated", simulated: "Simulated", replay: "Replay" }[m];
}
