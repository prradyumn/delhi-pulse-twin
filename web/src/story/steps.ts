import type { RainBand } from "../state/store";

export interface StoryStep {
  title: string;
  body: string;
  camera?: { pos: [number, number, number]; target: [number, number, number] };
  timeMin?: number;
  rain?: RainBand;
  corridor?: string;
  scenario?: null | "bus_frequency" | "rainfall";
  freq?: number;
  layers?: Record<string, boolean>;
  reveal?: boolean;
  run?: boolean;
}

/** Local metres, origin at the centre of the locked box. Derived from the study-area transform,
 *  not eyeballed: Connaught Place (137, -1216), India Gate (1124, 1006). */
const CP: [number, number, number] = [137, 0, -1216];
const INDIA_GATE: [number, number, number] = [1124, 0, 1006];
const KARTAVYA_MID: [number, number, number] = [-342, 0, 940];
const BARAKHAMBA_MID: [number, number, number] = [1055, 0, -619];
const BKS_MID: [number, number, number] = [-782, 0, -553];

const near = (t: [number, number, number], d = 620, h = 380): StoryStep["camera"] =>
  ({ pos: [t[0] + d * 0.55, h, t[2] + d], target: t });

/** Completable in about four minutes without free exploration. Every step names what kind of
 *  number the user is looking at, because comprehension of observed vs simulated is the
 *  headline success metric. */
export const STORY: StoryStep[] = [
  {
    title: "One locked box, not a whole city",
    body: "Roughly 4 × 4 km of Central Delhi — Connaught Place at the north edge, India Gate and Kartavya Path across the south. The bounds are frozen so every number stays reproducible. All of this runs from bundled data with no live feed.",
    camera: { pos: [1500, 1400, 2000], target: [0, 0, 0] },
    timeMin: 8 * 60 + 30, rain: "none", scenario: null,
    layers: { ground: true, water: true, roads: true, buildings: true, rail: true, transit: true, corridors: true, buses: true },
    reveal: false,
  },
  {
    title: "The ground carries this city",
    body: "Lutyens' Delhi is sparse and green: measured coverage is 13.7% buildings against 58.5% parks, lawns and estates. That is why the ground plane is a first-class layer here — a building-only render of this box would look empty, and would be wrong about the place.",
    camera: { pos: [700, 620, 1500], target: [200, 0, 300] },
  },
  {
    title: "Most of these heights are guessed",
    body: "Only 8.2% of buildings in this box carry a real height or storey tag in OpenStreetMap. Amber marks every height assigned by rule v0.1 instead of measured. The product says so out loud rather than presenting a confident skyline.",
    camera: near(CP, 780, 420),
    reveal: true,
  },
  {
    title: "Connaught Place, 09:00",
    body: "Move the clock and the corridor colour, the light and the bus replay all move with it. Corridor colour is estimated from a declared time-of-day profile — it is not an observed speed, and no open dataset of Delhi speeds was available to calibrate it.",
    camera: near(CP, 700, 380),
    timeMin: 9 * 60, reveal: false, corridor: "barakhamba-road",
  },
  {
    title: "Barakhamba Road — the congestion corridor",
    body: "Fifteen bus routes and the densest office frontage in the box. Click any corridor segment to see its estimated speed, the free-flow speed it is measured against, and the provenance of both.",
    camera: near(BARAKHAMBA_MID, 520, 300),
    corridor: "barakhamba-road", timeMin: 9 * 60 + 30,
  },
  {
    title: "Baba Kharak Singh Marg — 75 bus routes",
    body: "The heaviest bus corridor in the study area by a wide margin. This is where a frequency change has the most to work with, so it is where the bus-frequency scenario is worth running.",
    camera: near(BKS_MID, 560, 320),
    corridor: "baba-kharak-singh-marg",
  },
  {
    title: "Test one change: more buses",
    body: "Frequency is raised to 2×, so the assumed combined headway halves and the wait-time proxy halves with it. Watch the bus count on the road change too. These are estimates under stated assumptions — the panel lists every one.",
    corridor: "baba-kharak-singh-marg",
    scenario: "bus_frequency", freq: 2, run: true,
  },
  {
    title: "Now add heavy rain",
    body: "A declared speed penalty by road class, keyed to IMD rainfall bands. It models mobility stress, not flooding: there is no water depth, no drainage and no claim about either.",
    camera: near(BARAKHAMBA_MID, 620, 340),
    corridor: "barakhamba-road", scenario: "rainfall", rain: "heavy", run: true,
  },
  {
    title: "Kartavya Path — where the tool says no",
    body: "Geometrically the cleanest corridor in the box: one unbroken 2.3 km chain. It also carries zero of the 210 bus routes here, because it is a ceremonial boulevard. So the bus-frequency scenario disables itself and tells you why, instead of quietly returning zero.",
    camera: near(KARTAVYA_MID, 880, 470),
    corridor: "kartavya-path", scenario: null, rain: "none",
  },
  {
    title: "India Gate, and what to take away",
    body: "You located a hotspot, inspected the evidence behind it, and compared two bounded interventions against a baseline. Every layer told you whether it was observed, estimated, simulated or replay. Export carries those labels with it.",
    camera: near(INDIA_GATE, 620, 300),
    timeMin: 18 * 60, rain: "none", scenario: null,
  },
];
