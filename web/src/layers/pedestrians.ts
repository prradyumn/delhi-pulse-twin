import * as THREE from "three";
import type { Layer, LayerReport } from "./registry";
import { mergeBoxes, type XZ } from "./geom";
import * as load from "../geo/load";
import type { Provenance } from "../geo/types";

interface StreetscapePayload {
  footways: number; walls: number;
  provenance: Provenance;
  features: { footways: { p: XZ[]; k: string }[]; walls: unknown[] };
}

interface Walk {
  pts: THREE.Vector2[];
  cum: number[];
  len: number;
  /** metres per second for each walker released on this path */
  speed: number;
}

const MAX_WALKERS = 2200;
/** one walker per this many metres of footway — a density choice, not a measurement */
const METRES_PER_WALKER = 26;

function hash01(i: number, salt = 0): number {
  let h = (2166136261 ^ i ^ (salt * 668265263)) >>> 0;
  h = Math.imul(h, 16777619); h ^= h >>> 13; h = Math.imul(h, 16777619);
  return ((h >>> 0) % 100000) / 100000;
}

/**
 * People on the 926 mapped footways.
 *
 * The paths are observed OSM geometry; the people are not. Nobody is counted here and no
 * pedestrian-volume data was used — this is a density assumption of one walker per 26 m of path,
 * declared, so the parks and plazas read as places people are in rather than empty polygons.
 *
 * Walkers reverse at the end of a path instead of teleporting, and the whole thing is a pure
 * function of the clock, so scrubbing time stays reproducible.
 */
export class PedestrianLayer implements Layer {
  id = "pedestrians"; label = "People on paths";
  group = new THREE.Group();
  private walks: Walk[] = [];
  private slots: { w: number; phase: number }[] = [];
  private inst?: THREE.InstancedMesh;
  private live = 0;

  async build(): Promise<LayerReport> {
    const base: LayerReport = { id: this.id, label: this.label, status: "pending",
      provenance: null, features: 0, bytes: 0, ms: 0, drawCalls: 0, triangles: 0 };
    const res = await load.grab<StreetscapePayload>("streetscape.json");
    if (!res.ok) return { ...base, status: "unavailable", error: res.error };

    const ways = res.data.features.footways ?? [];
    if (!ways.length) return { ...base, status: "empty", bytes: res.bytes };

    ways.forEach((f, wi) => {
      if (f.p.length < 2) return;
      const pts = f.p.map(([x, z]) => new THREE.Vector2(x, z));
      const cum = [0];
      for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + pts[i].distanceTo(pts[i - 1]));
      const len = cum[cum.length - 1];
      if (len < 22) return;
      // 1.1–1.6 m/s, the ordinary range of a walking pace
      this.walks.push({ pts, cum, len, speed: 1.1 + hash01(wi, 5) * 0.5 });
    });
    if (!this.walks.length) return { ...base, status: "empty", bytes: res.bytes };

    let budget = MAX_WALKERS;
    this.walks.forEach((w, wi) => {
      const want = Math.max(1, Math.round(w.len / METRES_PER_WALKER));
      const take = Math.min(want, budget);
      for (let k = 0; k < take; k++) this.slots.push({ w: wi, phase: hash01(wi * 131 + k, 9) });
      budget -= take;
    });

    // body plus a head: two boxes, and at 1.7 m nothing finer would be visible anyway
    const body = new THREE.BoxGeometry(0.42, 1.15, 0.30);
    body.translate(0, 0.58, 0);
    const head = new THREE.BoxGeometry(0.26, 0.26, 0.26);
    head.translate(0, 1.31, 0);
    const geo = mergeBoxes([body, head]);

    this.inst = new THREE.InstancedMesh(geo, new THREE.MeshStandardMaterial({
      roughness: 0.85, metalness: 0, flatShading: true,
    }), this.slots.length);
    const colors = new Float32Array(this.slots.length * 3);
    this.inst.instanceColor = new THREE.InstancedBufferAttribute(colors, 3);
    const tint = new THREE.Color();
    this.slots.forEach((_s, i) => {
      // a muted, mixed palette; nothing saturated enough to compete with the analytical layers
      const hue = hash01(i, 13);
      tint.setHSL(hue, 0.16 + hash01(i, 17) * 0.28, 0.30 + hash01(i, 19) * 0.30,
                  THREE.SRGBColorSpace);
      colors[i * 3] = tint.r; colors[i * 3 + 1] = tint.g; colors[i * 3 + 2] = tint.b;
    });
    this.inst.instanceColor.needsUpdate = true;
    this.inst.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    // Walkers stay on their own path, so a bounding sphere over the whole box is honest and lets
    // the frustum reject them when the camera is looking elsewhere. frustumCulled=false was
    // costing the full 2,200 every frame regardless of where the camera pointed.
    this.inst.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 1, 0), 2900);
    this.inst.name = "pedestrians";
    this.group.add(this.inst);

    const totalLen = this.walks.reduce((a, w) => a + w.len, 0);
    return {
      ...base, status: "ready", features: this.slots.length,
      bytes: res.bytes, ms: res.ms, drawCalls: 1, triangles: this.slots.length * 24,
      provenance: {
        provider: "Derived (this prototype)",
        dataset: "Walkers on OSM footways",
        license: "Derived from OSM footway geometry, ODbL 1.0",
        attribution: "© OpenStreetMap contributors — footway geometry",
        retrieved_at: "2026-09-03", source_time: null, refresh_cadence: "none — deterministic",
        bounds: [77.1975, 28.6039, 77.2385, 28.6401], crs: "EPSG:32643 + local origin",
        mode: "simulated", transform_version: "0.1.0",
        limitations: [
          "The paths are observed OSM footways. The people are NOT: no pedestrian count or footfall data was used anywhere in this product.",
          `Density is a declared assumption of one walker per ${METRES_PER_WALKER} m across ${(totalLen / 1000).toFixed(1)} km of mapped path, capped at ${MAX_WALKERS} walkers.`,
          "Walking pace is 1.1–1.6 m/s, assumed. Walkers reverse at the end of a path; they do not choose routes or destinations.",
          "Numbers do not vary with time of day. Nothing here should be read as when or where people actually walk.",
        ],
      },
    };
  }

  update(timeMin: number) {
    if (!this.inst) return;
    const t = timeMin * 60;
    const m = new THREE.Matrix4();
    const up = new THREE.Vector3(0, 1, 0);
    const fwd = new THREE.Vector3();
    const side = new THREE.Vector3();

    for (let i = 0; i < this.slots.length; i++) {
      const s = this.slots[i];
      const w = this.walks[s.w];
      // a full there-and-back cycle, so a walker turns round rather than jumping to the start
      const cycle = (2 * w.len) / w.speed;
      let u = ((t / cycle) + s.phase) % 1;
      if (u < 0) u += 1;
      const back = u > 0.5;
      const d = (back ? 1 - (u - 0.5) * 2 : u * 2) * w.len;

      let lo = 0, hi = w.cum.length - 1;
      while (lo + 1 < hi) {
        const mid = (lo + hi) >> 1;
        if (w.cum[mid] <= d) lo = mid; else hi = mid;
      }
      const span = w.cum[hi] - w.cum[lo];
      const f = span > 1e-6 ? (d - w.cum[lo]) / span : 0;
      const px = w.pts[lo].x + (w.pts[hi].x - w.pts[lo].x) * f;
      const pz = w.pts[lo].y + (w.pts[hi].y - w.pts[lo].y) * f;
      let tx = w.pts[hi].x - w.pts[lo].x, tz = w.pts[hi].y - w.pts[lo].y;
      const L = Math.hypot(tx, tz) || 1;
      tx /= L; tz /= L;
      const dir = back ? -1 : 1;

      fwd.set(tx * dir, 0, tz * dir);
      side.crossVectors(fwd, up);
      m.makeBasis(fwd, up, side);
      // keep to one side of the path so opposing walkers do not pass through each other
      m.setPosition(px + side.x * 0.55 * dir, 0, pz + side.z * 0.55 * dir);
      this.inst.setMatrixAt(i, m);
    }
    this.inst.count = this.slots.length;
    this.inst.instanceMatrix.needsUpdate = true;
    this.live = this.slots.length;
  }

  walkerCount() { return this.live; }
  setVisible(v: boolean) { this.group.visible = v; }
  dispose() { this.inst?.geometry.dispose(); }
}
