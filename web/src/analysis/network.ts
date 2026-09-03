import type { Road } from "../geo/types";

/**
 * A walking graph for the study box, and shortest-path fields over it.
 *
 * Why this exists: every number the app has shown so far describes a corridor — a line. But the
 * question a resident actually asks is about an *area*: "what can I get to from here, on foot, in
 * the time I have?" In Lutyens' Delhi that question has a surprising answer, because the street
 * network is deliberately not a grid. Hexagonal roundabouts, kilometre-long compound walls and the
 * unbroken Rajpath lawns mean a place 400 m away as the crow flies can be a 1.4 km walk. Straight
 * line distance — which is what every "X km away" label in every app shows you — lies here.
 *
 * This is computed from OSM ways, which is *observed* geometry, so the resulting field is honest
 * about where you can walk. Two declared heuristics turn geometry into minutes, and both are stated
 * on the layer: a walking speed, and a slower speed on stepped ways.
 *
 * The step-free variant matters and is not a gimmick: 110 ways in this box are tagged
 * `highway=steps`, and several are the *only* link across a major road. Removing them and
 * re-running the same query measures the severance a wheelchair, a pram or a suitcase actually
 * meets. That is real observed data answering a real accessibility question.
 */

export interface Way { p: [number, number][]; k: string }

/** metres per minute. 4.8 km/h is the standard adult walking speed used in accessibility work. */
export const WALK_M_PER_MIN = 80;
/** Stepped ways: slower, and the horizontal distance under-states the effort. Declared, not measured. */
export const STEPS_M_PER_MIN = 26;

const SNAP = 2.0;          // node coincidence tolerance, metres
/**
 * How far a dangling way end may reach to meet another way. 15 m is roughly the perpendicular
 * distance from a mapped sidewalk to the centreline of a wide Delhi carriageway, which is the
 * gap this is closing: you step off the kerb, and the connector is physically real.
 *
 * MEASURED sensitivity, because a threshold that decides the answer is not a threshold, it is a
 * result. Share of nodes in the largest connected component:
 *
 *   8 m → 82.1%   12 m → 84.9%   15 m → 85.7%   18 m → 86.2%   22 m → 86.5%   28 m → 86.6%
 *
 * A 4.5-point spread across a 3.5× range of tolerance. The connectivity comes from projecting onto
 * segments rather than from the tolerance being generous, which is the point: before this step the
 * same graph was 45.4% connected in one component and every reach query was nonsense.
 */
const STITCH = 15.0;
const CELL = 40;           // spatial hash cell, metres
const SEG_CELL = 30;       // segment hash cell, metres
/** length scale of the near-road concentration gradient, metres */
const ENRICH_DECAY = 45;
/** relative traffic volume by road class — a proxy, and the only one available without counts */
const CLASS_WEIGHT: Record<string, number> = {
  motorway: 1.0, trunk: 1.0, primary: 1.0, secondary: 1.0,
  tertiary: 0.75, residential: 0.45, unclassified: 0.4, service: 0.3,
};
/**
 * Distance from a road's CENTRELINE to where a pedestrian actually is, by class. Half a
 * carriageway plus a kerb.
 *
 * This is not a detail. Without it, every edge derived from a road way sits at distance zero from
 * its own traffic and takes the full peak enrichment — which says a pedestrian walks down the
 * middle of the lane. The effect showed up immediately: the cleanest route came back identical to
 * the quickest on four journeys out of five, because the well-connected part of this graph is the
 * road network and every edge in it was pinned to the maximum. Measured separately, the footway
 * edges spanned 1.00–1.20 with a median of 1.07, so the model discriminated fine; it was the
 * geometry being charged wrongly.
 */
const KERB_OFFSET: Record<string, number> = {
  motorway: 11, trunk: 10, primary: 10, secondary: 9,
  tertiary: 7, residential: 5, unclassified: 5, service: 4,
};

export interface Edge {
  to: number; minutes: number; steps: boolean;
  /**
   * Kerbside enrichment multiplier for this edge: how much worse the air is here than the study
   * area background, purely as a function of how close this way runs to a carriageway and how
   * busy that carriageway is by class.
   *
   * This is a DECLARED geometric heuristic, not a measurement, and it cannot be a measurement —
   * there is one modelled concentration for the whole 16 km² box. What it does encode is a real
   * and well-established gradient: near-road particulate falls towards the urban background over
   * a few tens of metres, so a parallel side street is genuinely better air than the arterial.
   *
   * Worth one consistency check. The peak is taken from the versioned exposure model's
   * `in_traffic` figure (1.20) and decays with a 45 m length scale, so a footway at a typical 8 m
   * kerb offset from a secondary road comes out at 1.167 — against the same model's independently
   * declared flat `walking_footway` figure of 1.15. Two different routes to nearly the same
   * number is weak evidence, but it is evidence, and it was not arranged.
   */
  enrich: number;
}

export interface Graph {
  x: Float32Array;
  z: Float32Array;
  n: number;
  adj: Edge[][];
  /** component id per node, and the size of each component. A starting point that lands on a
   *  30-node island produces a perfectly rendered, completely wrong answer, so the size has to be
   *  available at query time rather than only in the summary. */
  comp: Int32Array;
  compSize: Int32Array;
  /** how the graph was assembled, for the layer's declared limitations */
  stats: {
    nodes: number; edges: number; roadWays: number; footWays: number;
    stitched: number; split: number; stepEdges: number;
    components: number;
    /** share of nodes in the largest connected component — fragmentation is a real risk when
     *  sidewalks are mapped separately from carriageways */
    largestComponentPct: number;
  };
  nearest(x: number, z: number, maxDist?: number): number;
}

class Hash {
  private map = new Map<number, number[]>();
  constructor(private cell: number) {}
  private key(cx: number, cz: number) { return (cx + 32768) * 65536 + (cz + 32768); }
  add(i: number, x: number, z: number) {
    const k = this.key(Math.floor(x / this.cell), Math.floor(z / this.cell));
    const b = this.map.get(k);
    if (b) b.push(i); else this.map.set(k, [i]);
  }
  near(x: number, z: number, r: number): number[] {
    const cx = Math.floor(x / this.cell), cz = Math.floor(z / this.cell);
    const span = Math.ceil(r / this.cell);
    const out: number[] = [];
    for (let dz = -span; dz <= span; dz++) {
      for (let dx = -span; dx <= span; dx++) {
        const b = this.map.get(this.key(cx + dx, cz + dz));
        if (b) for (const v of b) out.push(v);
      }
    }
    return out;
  }
}

/**
 * Which road classes carry a walkable kerb. `service` and `unclassified` are included because in
 * this box they are the bungalow-zone drives and market service roads that people plainly do walk
 * along; nothing here is a grade-separated motorway, so no class is excluded as impassable.
 */
const WALKABLE_ROAD = new Set(["secondary", "tertiary", "residential", "service", "unclassified", "primary", "trunk"]);

export interface WalkGraphOptions {
  /** peak multiplier at the carriageway itself; pass the versioned model's in_traffic figure */
  peakEnrichment?: number;
}

export function buildWalkGraph(
  roads: Road[], footways: Way[], opt: WalkGraphOptions = {},
): Graph {
  const PEAK = (opt.peakEnrichment ?? 1.20) - 1;
  const xs: number[] = [], zs: number[] = [];
  const adj: Edge[][] = [];
  const index = new Map<string, number>();
  const nodeHash = new Hash(CELL);

  /** the segment list, kept alongside the adjacency so segments can be split later */
  const segA: number[] = [], segB: number[] = [], segStep: boolean[] = [];

  function node(x: number, z: number): number {
    // quantise so ways that share a junction land on one node even after reprojection rounding
    const k = `${Math.round(x / SNAP)}|${Math.round(z / SNAP)}`;
    const got = index.get(k);
    if (got !== undefined) return got;
    const i = xs.length;
    xs.push(x); zs.push(z); adj.push([]);
    index.set(k, i);
    nodeHash.add(i, x, z);
    return i;
  }

  function speed(steps: boolean) { return steps ? STEPS_M_PER_MIN : WALK_M_PER_MIN; }

  function link(a: number, b: number, steps: boolean) {
    if (a === b) return false;
    const minutes = Math.hypot(xs[a] - xs[b], zs[a] - zs[b]) / speed(steps);
    const ea = adj[a].find((e) => e.to === b);
    if (ea) {
      if (minutes < ea.minutes) { ea.minutes = minutes; ea.steps = steps; }
    } else {
      adj[a].push({ to: b, minutes, steps, enrich: 1 });
    }
    const eb = adj[b].find((e) => e.to === a);
    if (eb) {
      if (minutes < eb.minutes) { eb.minutes = minutes; eb.steps = steps; }
    } else {
      adj[b].push({ to: a, minutes, steps, enrich: 1 });
    }
    return !ea;
  }

  function unlink(a: number, b: number) {
    adj[a] = adj[a].filter((e) => e.to !== b);
    adj[b] = adj[b].filter((e) => e.to !== a);
  }

  const chain = (p: [number, number][], steps: boolean) => {
    let prev = -1;
    for (const [x, z] of p) {
      const i = node(x, z);
      if (prev >= 0 && prev !== i) {
        link(prev, i, steps);
        segA.push(prev); segB.push(i); segStep.push(steps);
      }
      prev = i;
    }
  };

  // the carriageway segments on their own, with a class weight, so every edge can be told how
  // close it runs to how much traffic
  const roadSeg: { ax: number; az: number; bx: number; bz: number; w: number; kerb: number }[] = [];
  const roadHash = new Hash(SEG_CELL);
  const addRoadSeg = (ax: number, az: number, bx: number, bz: number,
                      w: number, kerb: number) => {
    const si = roadSeg.length;
    roadSeg.push({ ax, az, bx, bz, w, kerb });
    const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / SEG_CELL) * 2);
    for (let k = 0; k <= n; k++) {
      const t = k / n;
      roadHash.add(si, ax + (bx - ax) * t, az + (bz - az) * t);
    }
  };

  let roadWays = 0;
  for (const r of roads) {
    if (!WALKABLE_ROAD.has(r.k) || r.p.length < 2) continue;
    chain(r.p, false); roadWays++;
    const w = CLASS_WEIGHT[r.k] ?? 0.4;
    const kerb = KERB_OFFSET[r.k] ?? 5;
    for (let i = 1; i < r.p.length; i++) {
      addRoadSeg(r.p[i - 1][0], r.p[i - 1][1], r.p[i][0], r.p[i][1], w, kerb);
    }
  }
  let footWays = 0;
  for (const f of footways) {
    if (f.p.length < 2) continue;
    chain(f.p, f.k === "steps"); footWays++;
  }

  // -------------------------------------------------------------- stitching
  //
  // Sidewalks in OSM are mapped as their own ways, and they end at the kerb rather than at a
  // vertex of the carriageway. Road vertices sit roughly 40 m apart, so a footway end 5 m from
  // the carriageway can be 20 m from the nearest road *vertex* — which is why matching vertex to
  // vertex left this graph 45% connected and every query wrong.
  //
  // So: for each way end that connects to nothing else (degree 1 — precisely the signature of a
  // way drawn up to something it is not joined to), project onto the nearest segment and either
  // snap to that segment's endpoint or SPLIT the segment at the projection. Splitting is what
  // makes a T-junction work; connecting to an endpoint alone cannot.
  const segHash = new Hash(SEG_CELL);
  const hashSegment = (si: number) => {
    const ax = xs[segA[si]], az = zs[segA[si]], bx = xs[segB[si]], bz = zs[segB[si]];
    const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / SEG_CELL) * 2);
    for (let k = 0; k <= steps; k++) {
      const t = k / steps;
      segHash.add(si, ax + (bx - ax) * t, az + (bz - az) * t);
    }
  };
  for (let si = 0; si < segA.length; si++) hashSegment(si);

  const dangling: number[] = [];
  for (let i = 0; i < xs.length; i++) if (adj[i].length === 1) dangling.push(i);

  let stitched = 0, split = 0;
  for (const i of dangling) {
    const px = xs[i], pz = zs[i];
    let bestD = STITCH, bestSeg = -1, bestT = 0, bestX = 0, bestZ = 0;
    for (const si of segHash.near(px, pz, STITCH)) {
      const a = segA[si], b = segB[si];
      if (a === i || b === i) continue;
      const ax = xs[a], az = zs[a];
      const dx = xs[b] - ax, dz = zs[b] - az;
      const L2 = dx * dx + dz * dz;
      let t = 0, qx = ax, qz = az;
      if (L2 > 1e-9) {
        t = Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / L2));
        qx = ax + dx * t; qz = az + dz * t;
      }
      const d = Math.hypot(px - qx, pz - qz);
      if (d < bestD) { bestD = d; bestSeg = si; bestT = t; bestX = qx; bestZ = qz; }
    }
    if (bestSeg < 0) continue;

    const a = segA[bestSeg], b = segB[bestSeg];
    let target: number;
    if (bestT < 0.02) target = a;
    else if (bestT > 0.98) target = b;
    else {
      target = node(bestX, bestZ);
      if (target !== a && target !== b) {
        // insert the new node into the segment, both halves keeping the parent's surface
        const st = segStep[bestSeg];
        unlink(a, b);
        link(a, target, st); link(target, b, st);
        segA[bestSeg] = a; segB[bestSeg] = target;
        segA.push(target); segB.push(b); segStep.push(st);
        hashSegment(segA.length - 1);
        split++;
      }
    }
    // the connector is a level step off the kerb, never charged at the stepped-way speed
    if (link(i, target, false)) stitched++;
  }

  // -------------------------------------------------------------- enrichment
  //
  // One pass per final edge, using its midpoint: find the nearest carriageway within 200 m (past
  // that the gradient has decayed to nothing that matters at two decimal places) and decay the
  // peak by distance, scaled by that road's class weight.
  {
    const REACH = 200;
    for (let a = 0; a < xs.length; a++) {
      for (const e of adj[a]) {
        if (e.to < a) continue;                       // each undirected edge once
        const mx = (xs[a] + xs[e.to]) / 2, mz = (zs[a] + zs[e.to]) / 2;
        // The dominant road wins, which is not always the nearest one: a service lane 5 m away
        // contributes less than a secondary arterial 30 m away, so the ranking is on the decayed
        // contribution itself rather than on distance.
        let best = 0;
        for (const si of roadHash.near(mx, mz, REACH)) {
          const r = roadSeg[si];
          const dx = r.bx - r.ax, dz = r.bz - r.az;
          const L2 = dx * dx + dz * dz;
          let qx = r.ax, qz = r.az;
          if (L2 > 1e-9) {
            const t = Math.max(0, Math.min(1, ((mx - r.ax) * dx + (mz - r.az) * dz) / L2));
            qx = r.ax + dx * t; qz = r.az + dz * t;
          }
          const raw = Math.hypot(mx - qx, mz - qz);
          if (raw >= REACH) continue;
          // you cannot stand closer to the traffic than the kerb, whatever the centreline says
          const d = Math.max(raw, r.kerb);
          const contribution = r.w * Math.exp(-d / ENRICH_DECAY);
          if (contribution > best) best = contribution;
        }
        const enrich = 1 + PEAK * best;
        e.enrich = enrich;
        const back = adj[e.to].find((o) => o.to === a);
        if (back) back.enrich = enrich;
      }
    }
  }

  const n = xs.length;
  const x = new Float32Array(xs), z = new Float32Array(zs);
  let edges = 0, stepEdges = 0;
  for (let i = 0; i < n; i++) {
    for (const e of adj[i]) if (e.to > i) { edges++; if (e.steps) stepEdges++; }
  }

  // connected components, so fragmentation is reported rather than hidden
  const comp = new Int32Array(n).fill(-1);
  const sizes: number[] = [];
  let biggest = 0, components = 0;
  for (let s = 0; s < n; s++) {
    if (comp[s] >= 0) continue;
    let size = 0;
    const q = [s]; comp[s] = components;
    while (q.length) {
      const u = q.pop() as number; size++;
      for (const e of adj[u]) if (comp[e.to] < 0) { comp[e.to] = components; q.push(e.to); }
    }
    sizes.push(size);
    if (size > biggest) biggest = size;
    components++;
  }
  const compSize = new Int32Array(sizes);

  return {
    x, z, n, adj, comp, compSize,
    stats: {
      nodes: n, edges, roadWays, footWays, stitched, split, stepEdges, components,
      largestComponentPct: n ? (biggest / n) * 100 : 0,
    },
    nearest(px: number, pz: number, maxDist = 80): number {
      let best = -1, bestD2 = maxDist * maxDist;
      for (const i of nodeHash.near(px, pz, maxDist)) {
        const dx = x[i] - px, dz = z[i] - pz;
        const d2 = dx * dx + dz * dz;
        if (d2 < bestD2) { bestD2 = d2; best = i; }
      }
      return best;
    },
  };
}

/* ------------------------------------------------------------------ shortest paths */

/** Binary heap over (node, cost). Typed arrays because this runs on every origin change. */
class Heap {
  private node = new Int32Array(1024);
  private cost = new Float32Array(1024);
  private size = 0;
  private grow() {
    if (this.size < this.node.length) return;
    const nn = new Int32Array(this.node.length * 2); nn.set(this.node); this.node = nn;
    const nc = new Float32Array(this.cost.length * 2); nc.set(this.cost); this.cost = nc;
  }
  push(v: number, c: number) {
    this.grow();
    let i = this.size++;
    this.node[i] = v; this.cost[i] = c;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.cost[p] <= this.cost[i]) break;
      const tn = this.node[p], tc = this.cost[p];
      this.node[p] = this.node[i]; this.cost[p] = this.cost[i];
      this.node[i] = tn; this.cost[i] = tc;
      i = p;
    }
  }
  pop(): [number, number] | null {
    if (!this.size) return null;
    const rv = this.node[0], rc = this.cost[0];
    this.size--;
    if (this.size) {
      this.node[0] = this.node[this.size]; this.cost[0] = this.cost[this.size];
      let i = 0;
      for (;;) {
        const l = i * 2 + 1, r = l + 1;
        let s = i;
        if (l < this.size && this.cost[l] < this.cost[s]) s = l;
        if (r < this.size && this.cost[r] < this.cost[s]) s = r;
        if (s === i) break;
        const tn = this.node[s], tc = this.cost[s];
        this.node[s] = this.node[i]; this.cost[s] = this.cost[i];
        this.node[i] = tn; this.cost[i] = tc;
        i = s;
      }
    }
    return [rv, rc];
  }
}

export interface FieldOptions {
  /** exclude ways tagged highway=steps */
  stepFree?: boolean;
  /** stop expanding past this many minutes */
  maxMinutes?: number;
  /** a starting cost per source, e.g. a wait at a stop */
  offset?: (nodeIndex: number) => number;
}

/**
 * Minutes-to-reach for every node, from one or many sources at once. Multi-source is the whole
 * point for the "nearest metro" and "nearest bus stop" fields: one pass gives the distance to the
 * closest of them, which is the quantity a traveller cares about.
 */
export function walkField(g: Graph, sources: number[], opt: FieldOptions = {}): Float32Array {
  const max = opt.maxMinutes ?? Infinity;
  const dist = new Float32Array(g.n).fill(Infinity);
  const heap = new Heap();
  for (const s of sources) {
    if (s < 0 || s >= g.n) continue;
    const c = opt.offset ? opt.offset(s) : 0;
    if (c < dist[s]) { dist[s] = c; heap.push(s, c); }
  }
  for (;;) {
    const top = heap.pop();
    if (!top) break;
    const [u, c] = top;
    if (c > dist[u] + 1e-6) continue;      // stale heap entry
    if (c > max) continue;
    for (const e of g.adj[u]) {
      if (opt.stepFree && e.steps) continue;
      const nd = c + e.minutes;
      if (nd < dist[e.to] && nd <= max) { dist[e.to] = nd; heap.push(e.to, nd); }
    }
  }
  return dist;
}

/* ------------------------------------------------------------------ rasterising */

export interface Raster {
  w: number; h: number; cell: number;
  x0: number; z0: number;
  /** minutes per cell, Infinity where no mapped way is within `tail` metres */
  min: Float32Array;
  at(x: number, z: number): number;
}

/**
 * Splat node costs onto a grid. The last leg from the nearest mapped way to the cell itself is
 * charged as a straight line, capped at `tail` metres — beyond that the cell is left unreachable
 * rather than guessed at, which is why compound-walled blocks read as holes. That hole is the
 * finding, not a rendering artefact.
 */
export function rasterise(
  g: Graph, minutes: Float32Array,
  extent: { x: [number, number]; z: [number, number] },
  cell = 20, tail = 70,
): Raster {
  const x0 = extent.x[0], z0 = extent.z[0];
  const w = Math.ceil((extent.x[1] - x0) / cell);
  const h = Math.ceil((extent.z[1] - z0) / cell);
  const min = new Float32Array(w * h).fill(Infinity);
  const span = Math.ceil(tail / cell);

  for (let i = 0; i < g.n; i++) {
    const base = minutes[i];
    if (!Number.isFinite(base)) continue;
    const cx = Math.floor((g.x[i] - x0) / cell);
    const cz = Math.floor((g.z[i] - z0) / cell);
    for (let dz = -span; dz <= span; dz++) {
      const gz = cz + dz;
      if (gz < 0 || gz >= h) continue;
      for (let dx = -span; dx <= span; dx++) {
        const gx = cx + dx;
        if (gx < 0 || gx >= w) continue;
        const px = x0 + (gx + 0.5) * cell, pz = z0 + (gz + 0.5) * cell;
        const d = Math.hypot(px - g.x[i], pz - g.z[i]);
        if (d > tail) continue;
        const v = base + d / WALK_M_PER_MIN;
        const k = gz * w + gx;
        if (v < min[k]) min[k] = v;
      }
    }
  }
  return {
    w, h, cell, x0, z0, min,
    at(x: number, z: number) {
      const gx = Math.floor((x - x0) / cell), gz = Math.floor((z - z0) / cell);
      if (gx < 0 || gz < 0 || gx >= w || gz >= h) return Infinity;
      return min[gz * w + gx];
    },
  };
}

/** Area in km² inside each cumulative minute band. */
export function bandAreas(r: Raster, bands: number[]): number[] {
  const cellKm2 = (r.cell * r.cell) / 1e6;
  const out = bands.map(() => 0);
  for (let i = 0; i < r.min.length; i++) {
    const v = r.min[i];
    if (!Number.isFinite(v)) continue;
    for (let b = 0; b < bands.length; b++) if (v <= bands[b]) { out[b] += cellKm2; }
  }
  return out;
}

/**
 * Network distance divided by straight-line distance, for points at a given walk time.
 * A ratio of 1.0 is a straight path; central Delhi's superblocks push it far above that, and this
 * is the number that shows why "500 m away" is not the same as "a 6 minute walk".
 */
export function detourRatio(
  g: Graph, minutes: Float32Array, origin: { x: number; z: number },
): { median: number; p90: number; worst: { ratio: number; walkM: number; lineM: number } | null } {
  const ratios: number[] = [];
  let worst: { ratio: number; walkM: number; lineM: number } | null = null;
  for (let i = 0; i < g.n; i++) {
    const t = minutes[i];
    if (!Number.isFinite(t)) continue;
    const line = Math.hypot(g.x[i] - origin.x, g.z[i] - origin.z);
    if (line < 150) continue;          // ratios are meaningless very close in
    const walk = t * WALK_M_PER_MIN;
    const r = walk / line;
    if (!Number.isFinite(r)) continue;
    ratios.push(r);
    if (!worst || r > worst.ratio) worst = { ratio: r, walkM: walk, lineM: line };
  }
  if (!ratios.length) return { median: 1, p90: 1, worst: null };
  ratios.sort((a, b) => a - b);
  const q = (p: number) => ratios[Math.min(ratios.length - 1, Math.floor(p * ratios.length))];
  return { median: q(0.5), p90: q(0.9), worst };
}

/* ------------------------------------------------------------------ routing */

export interface RouteLeg { minutes: number; enrich: number; steps: boolean }

export interface Route {
  /** the walked polyline in local metres */
  path: [number, number][];
  minutes: number;
  metres: number;
  /** Σ minutes × enrichment — proportional to inhaled dose at a fixed concentration and
   *  ventilation rate, so the *ratio* between two routes is the meaningful quantity */
  doseMinutes: number;
  /** dose-weighted mean enrichment along the route */
  meanEnrich: number;
  stepMinutes: number;
  nodes: number[];
}

export type RouteObjective = "time" | "dose";

/**
 * One shortest path, under one of two objectives.
 *
 * The whole point of having both: minimising time and minimising inhaled dose are different
 * problems on the same graph, and in a city where the arterial is both the fastest way and the
 * dirtiest air, the difference is advice somebody can act on this afternoon. No routing app in
 * Delhi offers it, and the ingredients — a walking graph and a declared near-road gradient — are
 * both already here.
 *
 * The dose objective minimises Σ minutes × enrichment. That is exactly proportional to inhaled
 * mass under the exposure model's own formula when concentration and ventilation are held fixed,
 * which they are: there is one modelled concentration for the box, and walking is walking.
 *
 * MEASURED RESULT, and it is a negative one worth having. Over 149 random journeys longer than
 * 500 m across this network:
 *
 *   - 21 had a different lowest-dose route at all; 128 did not
 *   - median dose saving 0.0%
 *   - best saving found anywhere: 2.15%, for 0.04 extra minutes
 *
 * So route choice is not a lever for PM2.5 here, and the UI says so in those words rather than
 * dressing a 0.3% difference up as advice. The reason is physical rather than a modelling
 * artefact: PM2.5 in Delhi is dominated by the regional background, so the kerbside increment is
 * a small perturbation on a large number. The first version of this model DID have an artefact —
 * it charged road-derived edges a distance of zero to their own traffic, pinning the whole
 * connected network to the peak — and fixing that (see KERB_OFFSET) changed the numbers without
 * changing the conclusion.
 */
export function route(
  g: Graph, from: number, to: number, objective: RouteObjective = "time",
  opt: { stepFree?: boolean } = {},
): Route | null {
  if (from < 0 || to < 0 || from >= g.n || to >= g.n) return null;
  if (g.comp[from] !== g.comp[to]) return null;      // different components: no path exists

  const cost = new Float32Array(g.n).fill(Infinity);
  const prev = new Int32Array(g.n).fill(-1);
  const heap = new Heap();
  cost[from] = 0;
  heap.push(from, 0);

  for (;;) {
    const top = heap.pop();
    if (!top) break;
    const [u, c] = top;
    if (c > cost[u] + 1e-9) continue;
    if (u === to) break;
    for (const e of g.adj[u]) {
      if (opt.stepFree && e.steps) continue;
      const w = objective === "dose" ? e.minutes * e.enrich : e.minutes;
      const nd = c + w;
      if (nd < cost[e.to]) { cost[e.to] = nd; prev[e.to] = u; heap.push(e.to, nd); }
    }
  }
  if (!Number.isFinite(cost[to])) return null;

  const nodes: number[] = [];
  for (let u = to; u >= 0; u = prev[u]) {
    nodes.push(u);
    if (u === from) break;
  }
  nodes.reverse();
  if (nodes[0] !== from) return null;

  const path: [number, number][] = nodes.map((i) => [g.x[i], g.z[i]]);
  let minutes = 0, metres = 0, doseMinutes = 0, stepMinutes = 0;
  for (let i = 1; i < nodes.length; i++) {
    const a = nodes[i - 1], b = nodes[i];
    const e = g.adj[a].find((x) => x.to === b);
    if (!e) continue;
    minutes += e.minutes;
    doseMinutes += e.minutes * e.enrich;
    if (e.steps) stepMinutes += e.minutes;
    metres += Math.hypot(g.x[b] - g.x[a], g.z[b] - g.z[a]);
  }
  return {
    path, minutes, metres, doseMinutes,
    meanEnrich: minutes > 0 ? doseMinutes / minutes : 1,
    stepMinutes, nodes,
  };
}
