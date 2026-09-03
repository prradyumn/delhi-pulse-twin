import * as THREE from "three";
import type { Layer, LayerReport } from "./registry";
import { PALETTE } from "./palette";
import { mergeBoxes } from "./geom";
import type { BusRoute, Provenance } from "../geo/types";

const REPLAY_PROVENANCE: Provenance = {
  provider: "Derived (this prototype)",
  dataset: "Deterministic bus replay along OSM route ways",
  license: "Derived from OSM route relations, ODbL 1.0",
  attribution: "© OpenStreetMap contributors — route and stop geometry",
  retrieved_at: "2026-09-03",
  source_time: null,
  refresh_cadence: "none — a deterministic function of clock time",
  bounds: [77.1975, 28.6039, 77.2385, 28.6401],
  crs: "EPSG:32643 + local origin",
  mode: "replay",
  transform_version: "0.1.0",
  limitations: [
    "Not live positions. A deterministic function of clock time, reproducible offline and identical on every reload.",
    "Buses follow the actual OSM ways of their route relation, and pause at each mapped stop for a declared 18 second dwell.",
    "No schedule exists in the source data: spacing derives from an ASSUMED 12 minute baseline headway per route, and cruise speed from an assumed 22 km/h, neither observed nor scheduled.",
    "Where a route relation is discontinuous inside the study box, the longest continuous piece is used, so a bus may appear to terminate short of its real route.",
  ],
};

interface Runner {
  route: BusRoute;
  pts: THREE.Vector2[];
  cum: number[];
  len: number;
  /** distance along the path of each mapped stop, ascending */
  stopAt: number[];
  /** cumulative time (s) at each path vertex, including dwell already served */
  time: number[];
  total: number;
}

const DWELL_SEC = 18;
const CRUISE_KMH = 22;

/**
 * Replay, never a live feed — but it should at least behave like a bus. Two things changed here
 * from the first version: the path is the route's real OSM ways instead of straight lines between
 * stops (which cut corners through buildings), and buses actually stop, because the position comes
 * from inverting a cumulative time profile that includes dwell at every mapped stop.
 */
export class BusLayer implements Layer {
  id = "buses"; label = "Bus replay";
  group = new THREE.Group();
  private runners: Runner[] = [];
  private inst?: THREE.InstancedMesh;
  private capacity = 0;
  private headwayScale = 1;
  private speedScale = 1;
  private live = 0;

  constructor(private routes: BusRoute[]) {}

  async build(): Promise<LayerReport> {
    const base: LayerReport = { id: this.id, label: this.label, status: "pending",
      provenance: REPLAY_PROVENANCE, features: 0, bytes: 0, ms: 0, drawCalls: 0, triangles: 0 };

    for (const r of this.routes) {
      const raw = (r as BusRoute & { path?: [number, number][] }).path;
      // fall back to the stop sequence only if the road path is missing, and say so in the report
      const src = raw && raw.length > 3 ? raw : r.stops.map((s) => [s.x, s.z] as [number, number]);
      if (src.length < 2) continue;
      const pts = src.map(([x, z]) => new THREE.Vector2(x, z));
      const cum = [0];
      for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + pts[i].distanceTo(pts[i - 1]));
      const len = cum[cum.length - 1];
      if (len < 200) continue;

      // project each stop onto the path so dwell happens where the stop actually is
      const stopAt: number[] = [];
      for (const s of r.stops) {
        let bestD = Infinity, bestAt = 0;
        const sp = new THREE.Vector2(s.x, s.z);
        for (let i = 1; i < pts.length; i++) {
          const seg = new THREE.Vector2().subVectors(pts[i], pts[i - 1]);
          const segLen = seg.length() || 1;
          const t = Math.max(0, Math.min(1,
            new THREE.Vector2().subVectors(sp, pts[i - 1]).dot(seg) / (segLen * segLen)));
          const proj = new THREE.Vector2().addVectors(pts[i - 1], seg.multiplyScalar(t));
          const d = proj.distanceTo(sp);
          if (d < bestD) { bestD = d; bestAt = cum[i - 1] + segLen * t; }
        }
        if (bestD < 70) stopAt.push(bestAt);     // ignore stops that are not really on this path
      }
      stopAt.sort((a, b) => a - b);
      this.runners.push({ route: r, pts, cum, len, stopAt, time: [], total: 0 });
    }
    if (!this.runners.length) return { ...base, status: "empty" };

    this.rebuildTimeline();
    this.capacity = Math.min(
      this.runners.reduce((a, r) => a + Math.ceil(r.total / 60), 0) * 3 + 24, 240);

    // A bus is a body, a lighter window band and a roof line — three boxes, one instanced draw.
    const body = new THREE.BoxGeometry(11.2, 2.2, 2.9);
    body.translate(0, 1.3, 0);
    const glazing = new THREE.BoxGeometry(9.6, 0.95, 2.98);
    glazing.translate(-0.2, 2.25, 0);
    const roof = new THREE.BoxGeometry(10.2, 0.35, 2.6);
    roof.translate(0, 2.95, 0);
    const geo = mergeBoxes([body, glazing, roof]);

    this.inst = new THREE.InstancedMesh(geo, new THREE.MeshStandardMaterial({
      color: PALETTE.bus, roughness: 0.46, metalness: 0.08, flatShading: true,
    }), this.capacity);
    this.inst.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.inst.frustumCulled = false;
    // see traffic.ts: moving casters would defeat the on-demand shadow map
    this.inst.castShadow = false;
    this.inst.count = 0;
    this.inst.name = "buses";
    this.group.add(this.inst);

    const onRoadPath = this.routes.filter(
      (r) => ((r as BusRoute & { path?: unknown[] }).path ?? []).length > 3).length;
    return {
      ...base, status: "ready", features: this.runners.length,
      drawCalls: 1, triangles: this.capacity * 36,
      provenance: {
        ...REPLAY_PROVENANCE,
        limitations: [
          ...REPLAY_PROVENANCE.limitations,
          `${onRoadPath} of ${this.routes.length} routes follow their real OSM way geometry; any remainder falls back to interpolation between stops.`,
        ],
      },
    };
  }

  /** Cumulative time along each path: cruise between stops, plus a dwell at every stop. */
  private rebuildTimeline() {
    const cruise = Math.max(CRUISE_KMH * this.speedScale, 4) * 1000 / 3600;
    for (const r of this.runners) {
      r.time = [0];
      let si = 0;
      for (let i = 1; i < r.pts.length; i++) {
        const d0 = r.cum[i - 1], d1 = r.cum[i];
        let dt = (d1 - d0) / cruise;
        while (si < r.stopAt.length && r.stopAt[si] <= d1) { dt += DWELL_SEC; si++; }
        r.time.push(r.time[i - 1] + dt);
      }
      r.total = r.time[r.time.length - 1];
    }
  }

  setHeadwayScale(scale: number) {
    if (this.headwayScale === scale) return;
    this.headwayScale = scale;
  }

  /** Rain and congestion slow the buses too, which is what makes the scenario legible. */
  setSpeedScale(scale: number) {
    const s = Math.max(Math.min(scale, 1.4), 0.25);
    if (Math.abs(this.speedScale - s) < 0.01) return;
    this.speedScale = s;
    this.rebuildTimeline();
  }

  private distanceAtTime(r: Runner, t: number): number {
    let lo = 0, hi = r.time.length - 1;
    while (lo + 1 < hi) {
      const mid = (lo + hi) >> 1;
      if (r.time[mid] <= t) lo = mid; else hi = mid;
    }
    const span = r.time[hi] - r.time[lo];
    const f = span > 1e-6 ? (t - r.time[lo]) / span : 0;
    return r.cum[lo] + (r.cum[hi] - r.cum[lo]) * f;
  }

  update(timeMin: number) {
    if (!this.inst) return;
    const timeSec = timeMin * 60;
    const m = new THREE.Matrix4();
    const up = new THREE.Vector3(0, 1, 0);
    const fwd = new THREE.Vector3();
    const side = new THREE.Vector3();
    let n = 0;

    for (const r of this.runners) {
      if (r.total <= 0) continue;
      const headwaySec = Math.max(r.route.assumed_headway_min * this.headwayScale, 1) * 60;
      const slots = Math.max(1, Math.min(Math.ceil(r.total / headwaySec), 40));
      for (let s = 0; s < slots && n < this.capacity; s++) {
        for (const dir of [1, -1] as const) {
          if (n >= this.capacity) break;
          let t = (timeSec + s * headwaySec + (dir === 1 ? 0 : r.total / 2)) % r.total;
          if (t < 0) t += r.total;
          const d0 = this.distanceAtTime(r, t);
          const d = dir === 1 ? d0 : r.len - d0;

          let lo = 0, hi = r.cum.length - 1;
          while (lo + 1 < hi) {
            const mid = (lo + hi) >> 1;
            if (r.cum[mid] <= d) lo = mid; else hi = mid;
          }
          const span = r.cum[hi] - r.cum[lo];
          const f = span > 1e-6 ? (d - r.cum[lo]) / span : 0;
          const px = r.pts[lo].x + (r.pts[hi].x - r.pts[lo].x) * f;
          const pz = r.pts[lo].y + (r.pts[hi].y - r.pts[lo].y) * f;
          let tx = r.pts[hi].x - r.pts[lo].x, tz = r.pts[hi].y - r.pts[lo].y;
          const L = Math.hypot(tx, tz) || 1;
          tx /= L; tz /= L;

          fwd.set(tx * dir, 0, tz * dir);
          side.crossVectors(fwd, up);
          m.makeBasis(fwd, up, side);
          // opposite direction sits on the other side of the centreline
          m.setPosition(px + side.x * 4.9 * dir, 0, pz + side.z * 4.9 * dir);
          this.inst.setMatrixAt(n++, m);
        }
      }
    }
    this.inst.count = n;
    this.inst.instanceMatrix.needsUpdate = true;
    this.live = n;
  }

  busCount() { return this.live; }
  setVisible(v: boolean) { this.group.visible = v; }
  dispose() { this.inst?.geometry.dispose(); }
}
