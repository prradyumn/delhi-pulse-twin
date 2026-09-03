import * as THREE from "three";
import type { Layer, LayerReport } from "./registry";
import type { Corridor, Provenance } from "../geo/types";
import { mergeBoxes } from "./geom";

const TRAFFIC_PROVENANCE: Provenance = {
  provider: "Derived (this prototype)",
  dataset: "Illustrative vehicle flow on the three hero corridors",
  license: "Derived from OSM corridor geometry, ODbL 1.0",
  attribution: "© OpenStreetMap contributors — corridor geometry",
  retrieved_at: "2026-09-03",
  source_time: null,
  refresh_cadence: "none — a deterministic function of clock time",
  bounds: [77.1975, 28.6039, 77.2385, 28.6401],
  crs: "EPSG:32643 + local origin",
  mode: "simulated",
  transform_version: "0.1.0",
  limitations: [
    "These vehicles are NOT observed traffic and not a vehicle count. They visualise the same estimated corridor speed the traffic colour shows, in a second form.",
    "Vehicles are released at a fixed time headway and positioned by inverting cumulative travel time, so they bunch where the estimate says the corridor is slow. The number on screen therefore rises with congestion — that is the estimate being drawn, not a measurement of demand.",
    "Vehicle mix (cars and auto-rickshaws) is illustrative. No modal-share data was used.",
    "Only the three hero corridors carry vehicles. Every other road is empty, which is a rendering choice, not a claim about those roads.",
  ],
};

interface Lane {
  corridorId: string;
  pts: THREE.Vector2[];
  cum: number[];        // cumulative distance at each vertex
  len: number;
  dir: 1 | -1;
  offset: number;
  /** cumulative traversal time (s) at each vertex, rebuilt when speeds change */
  time: number[];
  total: number;
}

/**
 * A second reading of the same estimate. The corridor ribbon says "slow" with colour; this says it
 * with density and speed, which is the form people actually recognise as congestion.
 *
 * Deterministic by construction: distance is obtained by inverting cumulative travel time for a
 * given release phase, so the same clock always yields the same picture — no frame integration.
 */
export class TrafficLayer implements Layer {
  id = "traffic"; label = "Corridor vehicles";
  group = new THREE.Group();
  private lanes: Lane[] = [];
  private cars?: THREE.InstancedMesh;
  private autos?: THREE.InstancedMesh;
  private headwaySec = 3.4;
  private capacity = 0;
  private liveCount = 0;

  constructor(private corridors: Corridor[]) {}

  async build(): Promise<LayerReport> {
    const base: LayerReport = { id: this.id, label: this.label, status: "pending",
      provenance: TRAFFIC_PROVENANCE, features: 0, bytes: 0, ms: 0, drawCalls: 0, triangles: 0 };
    if (!this.corridors.length) return { ...base, status: "empty" };

    for (const c of this.corridors) {
      if (c.spine.length < 2) continue;
      const pts = c.spine.map(([x, z]) => new THREE.Vector2(x, z));
      const cum = [0];
      for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + pts[i].distanceTo(pts[i - 1]));
      const len = cum[cum.length - 1];
      if (len < 60) continue;
      for (const dir of [1, -1] as const) {
        this.lanes.push({ corridorId: c.id, pts, cum, len, dir,
                          offset: dir === 1 ? 4.6 : -4.6,
                          time: [], total: 0 });
      }
    }
    if (!this.lanes.length) return { ...base, status: "empty" };

    // capacity sized for the worst case: every lane crawling, so slots never run out mid-scenario
    this.capacity = Math.min(
      this.lanes.reduce((a, l) => a + Math.ceil(l.len / 9), 0), 1400);

    const carGeo = new THREE.BoxGeometry(4.3, 1.5, 1.85);
    const cabin = new THREE.BoxGeometry(2.1, 0.8, 1.68);
    cabin.translate(-0.15, 1.05, 0);
    const merged = mergeBoxes([carGeo, cabin]);

    const autoGeo = new THREE.CylinderGeometry(1.0, 1.15, 1.9, 6, 1, false);
    autoGeo.rotateZ(Math.PI / 2);
    autoGeo.scale(1.0, 1.0, 0.86);

    // instanceColor alone: do NOT also set vertexColors here. Three defines USE_COLOR from
    // vertexColors and multiplies vColor by the geometry's `color` attribute — which this
    // geometry does not have, so WebGL supplies (0,0,0) and every instance renders black.
    this.cars = new THREE.InstancedMesh(merged, new THREE.MeshStandardMaterial({
      roughness: 0.42, metalness: 0.18, flatShading: true,
    }), this.capacity);
    this.autos = new THREE.InstancedMesh(autoGeo, new THREE.MeshStandardMaterial({
      color: 0xcfd23a, roughness: 0.55, metalness: 0.05, flatShading: true,
    }), Math.ceil(this.capacity * 0.3));

    const cc = new Float32Array(this.capacity * 3);
    this.cars.instanceColor = new THREE.InstancedBufferAttribute(cc, 3);
    // Delhi's car mix skews hard to white and silver, with black and the occasional red
    const palette = [0xe9e9e6, 0xe9e9e6, 0xe9e9e6, 0xc3c7ca, 0xc3c7ca, 0x8d9296,
                     0x2f3438, 0x2f3438, 0x7c2f24, 0x24405c];
    const tint = new THREE.Color();
    for (let i = 0; i < this.capacity; i++) {
      tint.set(palette[i % palette.length]);
      cc[i * 3] = tint.r; cc[i * 3 + 1] = tint.g; cc[i * 3 + 2] = tint.b;
    }
    this.cars.instanceColor.needsUpdate = true;

    for (const m of [this.cars, this.autos]) {
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.frustumCulled = false;
      // Deliberately NOT casting: a 4 m vehicle's shadow is invisible at city scale,
      // and moving casters are the only thing that would force the shadow map to
      // re-render every frame — which measured at 10 ms of a 14 ms GPU budget.
      m.castShadow = false;
      m.count = 0;
    }
    this.cars.name = "traffic_cars";
    this.autos.name = "traffic_autos";
    this.group.add(this.cars, this.autos);

    return { ...base, status: "ready", features: this.lanes.length,
             drawCalls: 2, triangles: this.capacity * 12 };
  }

  /**
   * Rebuild the cumulative travel-time table from the current estimate. Called whenever the clock,
   * the rain band or a scenario changes the corridor speeds.
   */
  setSpeeds(speedFor: (corridorId: string, fractionAlong: number) => number) {
    for (const l of this.lanes) {
      l.time = [0];
      for (let i = 1; i < l.pts.length; i++) {
        const mid = (l.cum[i] + l.cum[i - 1]) / 2 / l.len;
        const kmh = Math.max(speedFor(l.corridorId, mid), 3);
        const dt = (l.cum[i] - l.cum[i - 1]) / (kmh * 1000 / 3600);
        l.time.push(l.time[i - 1] + dt);
      }
      l.total = l.time[l.time.length - 1];
    }
  }

  /** distance along the lane for a given elapsed traversal time */
  private distanceAtTime(l: Lane, t: number): number {
    if (l.total <= 0) return 0;
    let lo = 0, hi = l.time.length - 1;
    while (lo + 1 < hi) {
      const mid = (lo + hi) >> 1;
      if (l.time[mid] <= t) lo = mid; else hi = mid;
    }
    const span = l.time[hi] - l.time[lo];
    const f = span > 1e-6 ? (t - l.time[lo]) / span : 0;
    return l.cum[lo] + (l.cum[hi] - l.cum[lo]) * f;
  }

  private pointAt(l: Lane, d: number, out: THREE.Vector2, tangent: THREE.Vector2) {
    let lo = 0, hi = l.cum.length - 1;
    while (lo + 1 < hi) {
      const mid = (lo + hi) >> 1;
      if (l.cum[mid] <= d) lo = mid; else hi = mid;
    }
    const span = l.cum[hi] - l.cum[lo];
    const f = span > 1e-6 ? (d - l.cum[lo]) / span : 0;
    out.lerpVectors(l.pts[lo], l.pts[hi], f);
    tangent.subVectors(l.pts[hi], l.pts[lo]);
    if (tangent.lengthSq() < 1e-9) tangent.set(1, 0);
    tangent.normalize();
  }

  /** timeSec is clock-derived; the picture is a pure function of it. */
  update(timeSec: number) {
    if (!this.cars || !this.autos) return;
    const m = new THREE.Matrix4();
    const up = new THREE.Vector3(0, 1, 0);
    const fwd = new THREE.Vector3();
    const side = new THREE.Vector3();
    const p = new THREE.Vector2();
    const tan = new THREE.Vector2();

    let ci = 0, ai = 0;
    for (const l of this.lanes) {
      if (l.total <= 0) continue;
      const slots = Math.min(Math.floor(l.total / this.headwaySec), 420);
      for (let s = 0; s < slots; s++) {
        // release phase: evenly spaced in TIME, which is what produces spatial bunching
        let t = (timeSec + s * this.headwaySec) % l.total;
        if (t < 0) t += l.total;
        const d0 = this.distanceAtTime(l, t);
        const d = l.dir === 1 ? d0 : l.len - d0;
        this.pointAt(l, d, p, tan);

        const isAuto = ((s * 7 + (l.dir === 1 ? 0 : 3)) % 10) < 3;
        fwd.set(tan.x * l.dir, 0, tan.y * l.dir);
        side.crossVectors(fwd, up);
        const px = p.x + side.x * l.offset;
        const pz = p.y + side.z * l.offset;
        m.makeBasis(fwd, up, side);
        m.setPosition(px, isAuto ? 1.0 : 0.78, pz);

        if (isAuto) {
          if (ai < this.autos.count || ai < this.autos.instanceMatrix.count) this.autos.setMatrixAt(ai++, m);
        } else if (ci < this.capacity) {
          this.cars.setMatrixAt(ci++, m);
        }
      }
    }
    this.cars.count = ci;
    this.autos.count = Math.min(ai, this.autos.instanceMatrix.count);
    this.cars.instanceMatrix.needsUpdate = true;
    this.autos.instanceMatrix.needsUpdate = true;
    this.liveCount = ci + this.autos.count;
  }

  vehicleCount() { return this.liveCount; }
  setVisible(v: boolean) { this.group.visible = v; }
  dispose() { this.cars?.geometry.dispose(); this.autos?.geometry.dispose(); }
}
