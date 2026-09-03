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
}

export const initialState: AppState = {
  timeMin: 8 * 60 + 30,
  playing: false,
  layers: { ground: true, water: true, roads: true, buildings: true, rail: true,
            transit: true, corridors: true, buses: true, landmarks: true },
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
};

export const store = createStore<AppState>(initialState);
