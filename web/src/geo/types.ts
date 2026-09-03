/** Data-mode is a type, not a caption. Nothing analytical renders without a Provenance. */
export type DataMode = "observed" | "estimated" | "simulated" | "replay";

export interface Provenance {
  provider: string; dataset: string; license: string; attribution: string;
  retrieved_at: string; source_time: string | null; refresh_cadence: string | null;
  bounds: [number, number, number, number]; crs: string;
  mode: DataMode; transform_version: string; limitations: string[];
}

export interface Manifest {
  dataset_version: string; transform_version: string; built_at: string;
  study_area: {
    id: string; status: string; bbox_wgs84: [number, number, number, number];
    measured_extent_m: [number, number]; measured_area_km2: number;
    crs_projected: string;
    local_origin_utm: { easting: number; northing: number; note: string };
    runtime_extent: { x: [number, number]; z: [number, number] };
    axis_mapping: string; clip: string;
  };
  tiles: { size_m: number; grid: [number, number]; role: string };
  corridors: CorridorMeta[];
  landmarks: { required: LandmarkMeta[]; optional: LandmarkMeta[] };
  height_rule: HeightRule;
  budgets: Record<string, number | { target: number; hard_gate: number; note?: string }>;
  assets: Record<string, { path: string; bytes: number; sha256: string }>;
  total_uncompressed_bytes: number;
  attribution: string[];
  health: { live_adapters: string[]; note: string };
}

export interface CorridorMeta {
  id: string; label: string; role: string; layers: string[];
  no_transit_reason?: string | null;
}
export interface LandmarkMeta {
  id: string; osm: string; lonlat: [number, number];
  osm_height_m: number | null; serves?: string; note?: string;
}
export interface HeightRule {
  version: string; storey_m: number; order: string[];
  class_levels: Record<string, number>;
  area_overrides: unknown[]; disclosure: string;
}

export interface Building { id: string; r: [number, number][]; h: number; m: 0 | 1; c: string; n: string | null }
export interface Road {
  id: string; p: [number, number][]; k: string; n: string | null;
  corridor: string | null; lanes: number | null; oneway: boolean; len: number;
}
export interface GroundPoly { id: string; r: [number, number][]; cat: string; k: string; n: string | null; area: number }
export interface WaterFeature { id: string; kind: "area" | "line"; r?: [number, number][]; p?: [number, number][]; n: string | null }
export interface RailLine { id: string; k: string; p: [number, number][] }
export interface Station { id: string; x: number; z: number; n: string; sub: boolean }
export interface Stop { id: string; x: number; z: number; n: string; osm: string }
export interface BusRoute {
  id: string; ref: string; name: string; operator: string; osm: string;
  corridors: string[]; assumed_headway_min: number;
  stops: { id: string; n: string; x: number; z: number }[];
}
export interface CorridorSegment { i: number; a: [number, number]; b: [number, number]; len: number }
export interface Corridor extends CorridorMeta {
  spine: [number, number][]; spine_len: number; chains: number; ways: number;
  segments: CorridorSegment[]; evidence: Record<string, number>;
}

export interface ScenarioModel {
  version: string;
  free_flow_kmh: Record<string, number>;
  diurnal_congestion: { _note: string; profile: number[] };
  corridor_base: Record<string, number>;
  rain_speed_multiplier: Record<string, Record<string, number>>;
  msi_weights: { speed_penalty: number; transit_pressure: number; weather_impact: number };
  wait_proxy: string;
  transit_pressure_normalisation: string;
  definitions: Record<string, string>;
}
export interface WeatherData {
  provenance: Provenance;
  baseline: { temp_c: number; rh_pct: number; wind_ms: number; rain_mm_h: number; band: string; label: string };
  rain_bands: { id: string; label: string; mm_h: number; imd?: string }[];
}
export interface Payload<T> { kind: string; provenance: Provenance; features: T }
