import * as THREE from "three";
import type { Layer, LayerReport } from "./registry";
import { PALETTE } from "./palette";
import type { BusRoute, Provenance } from "../geo/types";

const REPLAY_PROVENANCE: Provenance = {
  provider: "Derived (this prototype)",
  dataset: "Deterministic bus replay from OSM route stop sequences",
  license: "Derived from OSM route relations, ODbL 1.0",
  attribution: "© OpenStreetMap contributors — route geometry",
  retrieved_at: "2026-09-03",
  source_time: null,
  refresh_cadence: "none — deterministic",
  bounds: [77.1975, 28.6039, 77.2385, 28.6401],
  crs: "EPSG:32643 + local origin",
  mode: "replay",
  transform_version: "0.1.0",
  limitations: [
    "Not live positions. A deterministic function of clock time, reproducible offline.",
    "No schedule exists in the source data: spacing derives from an ASSUMED 12 minute baseline headway, not an observed or scheduled one.",
    "Paths interpolate between consecutive stops and do not follow road centrelines exactly.",
    "Mean speed of 18 km/h including dwell is a declared assumption.",
  ],
};

/**
 * Deterministic replay, never a live position. Buses advance along a curve through their route's
 * ordered stop sequence, so the same clock time always produces the same picture — offline, forever.
 */
export class BusLayer implements Layer {
  id = "buses"; label = "Bus replay";
  group = new THREE.Group();
  private curves: { route: BusRoute; curve: THREE.CatmullRomCurve3; len: number }[] = [];
  private inst?: THREE.InstancedMesh;
  private slots: { ci: number; offset: number }[] = [];
  private headwayScale = 1;

  constructor(private routes: BusRoute[]) {}

  async build(): Promise<LayerReport> {
    const base: LayerReport = { id: this.id, label: this.label, status: "pending",
      provenance: REPLAY_PROVENANCE, features: 0, bytes: 0, ms: 0, drawCalls: 0, triangles: 0 };
    if (!this.routes.length) return { ...base, status: "empty" };

    for (const r of this.routes) {
      if (r.stops.length < 2) continue;
      const pts = r.stops.map((s) => new THREE.Vector3(s.x, 2.4, s.z));
      const curve = new THREE.CatmullRomCurve3(pts, false, "catmullrom", 0.25);
      this.curves.push({ route: r, curve, len: Math.max(curve.getLength(), 1) });
    }
    if (!this.curves.length) return { ...base, status: "empty" };
    this.rebuildSlots();

    const geo = new THREE.BoxGeometry(11, 3.4, 2.9);
    this.inst = new THREE.InstancedMesh(geo, new THREE.MeshStandardMaterial({
      color: PALETTE.bus, roughness: 0.5, metalness: 0.05,
    }), 160);
    this.inst.count = this.slots.length;
    this.inst.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.inst.frustumCulled = false;
    this.inst.name = "buses";
    this.group.add(this.inst);

    return { ...base, status: "ready", features: this.slots.length,
             drawCalls: 1, triangles: 12 * this.slots.length };
  }

  private rebuildSlots() {
    this.slots = [];
    this.curves.forEach((c, ci) => {
      const headway = Math.max(c.route.assumed_headway_min * this.headwayScale, 1);
      // one bus per headway across a nominal 35-minute end-to-end run, both directions
      const n = Math.max(1, Math.min(Math.round((35 / headway) * 2), 26));
      for (let i = 0; i < n; i++) this.slots.push({ ci, offset: i / n });
    });
    if (this.inst) this.inst.count = this.slots.length;
  }

  /** A frequency scenario changes how many buses are actually on the road. */
  setHeadwayScale(scale: number) {
    if (this.headwayScale === scale) return;
    this.headwayScale = scale;
    this.rebuildSlots();
  }

  update(timeMin: number) {
    if (!this.inst) return;
    const m = new THREE.Matrix4();
    const up = new THREE.Vector3(0, 1, 0);
    const tan = new THREE.Vector3();
    const side = new THREE.Vector3();
    for (let i = 0; i < this.slots.length; i++) {
      const slot = this.slots[i];
      const c = this.curves[slot.ci];
      const cycleMin = c.len / (18000 / 60);          // 18 km/h mean, metres per minute
      let t = (timeMin / cycleMin + slot.offset) % 1;
      if (t < 0) t += 1;
      const p = c.curve.getPointAt(t);
      tan.copy(c.curve.getTangentAt(t)).setY(0);
      if (tan.lengthSq() < 1e-6) tan.set(1, 0, 0);
      tan.normalize();
      // The box is 11 m along its own X, so travel direction must map to X. Matrix4.lookAt aligns
      // -Z instead, which would drive every bus sideways; makeBasis puts the axes where we want
      // them (z = x × y keeps the basis right-handed).
      side.crossVectors(tan, up);
      m.makeBasis(tan, up, side);
      m.setPosition(p);
      this.inst.setMatrixAt(i, m);
    }
    this.inst.instanceMatrix.needsUpdate = true;
  }

  busCount() { return this.slots.length; }
  setVisible(v: boolean) { this.group.visible = v; }
  dispose() { this.inst?.geometry.dispose(); }
}
