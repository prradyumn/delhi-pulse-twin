/** Minimal observable store. The app is small enough that a framework would be overhead. */
type Listener<S> = (s: S, changed: (keyof S)[]) => void;

export function createStore<S extends object>(initial: S) {
  let state = { ...initial };
  const listeners = new Set<Listener<S>>();
  return {
    get: () => state,
    set(patch: Partial<S>) {
      const changed = (Object.keys(patch) as (keyof S)[]).filter((k) => state[k] !== patch[k]);
      if (!changed.length) return;
      state = { ...state, ...patch };
      listeners.forEach((l) => l(state, changed));
    },
    on(l: Listener<S>) { listeners.add(l); return () => listeners.delete(l); },
  };
}

export type RainBand = "none" | "light" | "moderate" | "heavy" | "very_heavy";

export interface AppState {
  /** minutes since midnight, drives every time-dependent layer */
  timeMin: number;
  playing: boolean;
  layers: Record<string, boolean>;
  /** show which building heights are estimated rather than measured */
  revealEstimated: boolean;
  selectedId: string | null;
  activeCorridor: string | null;
  rain: RainBand;
  /** scenario parameters; null scenario means baseline */
  scenario: null | "bus_frequency" | "rainfall";
  busFreqMultiplier: number;
  scenarioRunId: number;
  compare: boolean;
  storyStep: number | null;
  fps: number;
  /** ms spent in our own step+render — the number the budget is about */
  frameMs: number;
  /** GPU ms, the number screen-space effects actually spend */
  gpuMs: number;
  /** live instanced counts, shown in the masthead */
  vehicles: number;
  busesOnRoad: number;
  trains: number;
  /** live vehicles placed from the OTD feed; 0 when unconfigured */
  liveBuses: number;
  /** true while the street-level camera has control */
  walking: boolean;
  walkers: number;
}

export const initialState: AppState = {
  timeMin: 8 * 60 + 30,
  playing: false,
  layers: { ground: true, water: true, streetscape: true, roads: true, corridors: true,
            buildings: true, buildingparts: true, roofdetail: true, landmarks: true,
            trees: true, rail: true, transit: true, traffic: true, buses: true,
            metro: true, pedestrians: true, livebuses: true, furniture: true,
            reach: false, routes: false },
  revealEstimated: false,
  selectedId: null,
  activeCorridor: null,
  rain: "none",
  scenario: null,
  busFreqMultiplier: 1,
  scenarioRunId: 0,
  compare: false,
  storyStep: null,
  fps: 0,
  frameMs: 0,
  gpuMs: 0,
  vehicles: 0,
  busesOnRoad: 0,
  trains: 0,
  liveBuses: 0,
  walking: false,
  walkers: 0,
};

export const store = createStore<AppState>(initialState);
