import * as THREE from "three";
import type { Layer, LayerReport } from "./registry";
import { ribbons, mergeBoxes, type XZ } from "./geom";
import * as load from "../geo/load";
import type { Payload, Provenance } from "../geo/types";

export interface MetroLine {
  id: string; name: string; colour: string; osm: string;
  path: XZ[]; path_len: number; station_at: number[]; stations: number;
}

interface Runner {
  line: MetroLine;
  pts: THREE.Vector2[];
  cum: number[];
  len: number;
  time: number[];
  total: number;
  colour: THREE.Color;
}

const DWELL_SEC = 25;
const CRUISE_KMH = 42;
const HEADWAY_SEC = 210;          // ~3.5 min, a declared assumption
const CARS = 6;
const CAR_LEN = 21;
/** Tunnel depth. Rajiv Chowk's interchange is deeper than this; one figure is used for all. */
const DEPTH = -11;

/**
 * The metro, drawn where it actually is: underground.
 *
 * 13 of the 19 subway ways inside this box are tagged `tunnel=yes`, 4 are bridge and 2 surface —
 * so the lines here are overwhelmingly in tunnel, and rendering trains on the pavement would be a
 * plain factual error. Instead the trace and its trains sit at −11 m and are drawn as an X-ray
 * over the city: the established map idiom for something beneath the surface, at low opacity so it
 * reads as subsurface rather than as an object on the ground.
 *
 * Colours are DMRC's own, from the OSM route relations.
 */
export class MetroLayer implements Layer {
  id = "metro"; label = "Metro trains";
  group = new THREE.Group();
  lines: MetroLine[] = [];
  private runners: Runner[] = [];
  private trains?: THREE.InstancedMesh;
  private trace?: THREE.Mesh;
  private capacity = 0;
  private live = 0;

  async build(): Promise<LayerReport> {
    const base: LayerReport = { id: this.id, label: this.label, status: "pending",
      provenance: null, features: 0, bytes: 0, ms: 0, drawCalls: 0, triangles: 0 };
    const res = await load.grab<Payload<MetroLine[]> & { count: number }>("metro.json");
    if (!res.ok) return { ...base, status: "unavailable", error: res.error };
    this.lines = res.data.features;
    if (!this.lines.length) return { ...base, status: "empty", provenance: res.data.provenance, bytes: res.bytes };

    for (const l of this.lines) {
      if (l.path.length < 2 || l.path_len < 300) continue;
      const pts = l.path.map(([x, z]) => new THREE.Vector2(x, z));
      const cum = [0];
      for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + pts[i].distanceTo(pts[i - 1]));
      const colour = new THREE.Color(l.colour);
      const r: Runner = { line: l, pts, cum, len: cum[cum.length - 1],
                          time: [], total: 0, colour };
      // cumulative time with a dwell added as each station is passed
      r.time = [0];
      let si = 0;
      const cruise = CRUISE_KMH * 1000 / 3600;
      for (let i = 1; i < pts.length; i++) {
        let dt = (cum[i] - cum[i - 1]) / cruise;
        while (si < l.station_at.length && l.station_at[si] <= cum[i]) { dt += DWELL_SEC; si++; }
        r.time.push(r.time[i - 1] + dt);
      }
      r.total = r.time[r.time.length - 1];
      this.runners.push(r);
    }
    if (!this.runners.length) return { ...base, status: "empty", provenance: res.data.provenance, bytes: res.bytes };

    // ---- the subsurface trace
    const built = ribbons(this.runners.map((r) => ({
      p: r.line.path, width: 7, y: DEPTH - 1.2, color: r.colour,
    })));
    this.trace = new THREE.Mesh(built.geometry, new THREE.MeshBasicMaterial({
      vertexColors: true, transparent: true, opacity: 0.20,
      depthTest: false, depthWrite: false, side: THREE.DoubleSide,
    }));
    this.trace.renderOrder = 3;
    this.trace.name = "metro_trace";
    this.group.add(this.trace);

    // ---- trains: six cars, articulated, so a train reads as a train and not a long slab
    const boxes: THREE.BufferGeometry[] = [];
    for (let c = 0; c < CARS; c++) {
      const b = new THREE.BoxGeometry(CAR_LEN - 2.5, 3.1, 3.0);
      b.translate((c - (CARS - 1) / 2) * CAR_LEN, 0, 0);
      boxes.push(b);
    }
    const trainGeo = mergeBoxes(boxes);

    this.capacity = this.runners.reduce(
      (a, r) => a + Math.max(2, Math.ceil(r.total / HEADWAY_SEC)) * 2, 0);
    this.trains = new THREE.InstancedMesh(trainGeo, new THREE.MeshBasicMaterial({
      transparent: true, opacity: 0.62, depthTest: false, depthWrite: false,
    }), this.capacity);
    const colors = new Float32Array(this.capacity * 3);
    this.trains.instanceColor = new THREE.InstancedBufferAttribute(colors, 3);
    this.trains.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.trains.frustumCulled = false;
    this.trains.renderOrder = 4;
    this.trains.count = 0;
    this.trains.name = "metro_trains";
    this.group.add(this.trains);

    return {
      ...base, status: "ready", features: this.runners.length,
      bytes: res.bytes, ms: res.ms, drawCalls: 2,
      triangles: built.triangles + this.capacity * CARS * 12,
      provenance: {
        ...(res.data.provenance as Provenance),
        limitations: [
          ...res.data.provenance.limitations,
          `Trains are REPLAY, not live positions: a declared ${HEADWAY_SEC / 60} minute headway, ${CRUISE_KMH} km/h cruise and ${DWELL_SEC} s station dwell, all assumed.`,
          "Drawn at −11 m and rendered over the city as an X-ray, because 13 of 19 subway ways here are tunnel. One tunnel depth is used for every line; real depths vary and Rajiv Chowk is deeper.",
        ],
      },
    };
  }

  update(timeMin: number) {
    if (!this.trains) return;
    const timeSec = timeMin * 60;
    const m = new THREE.Matrix4();
    const up = new THREE.Vector3(0, 1, 0);
    const fwd = new THREE.Vector3();
    const side = new THREE.Vector3();
    const colors = this.trains.instanceColor!;
    let n = 0;

    for (const r of this.runners) {
      if (r.total <= 0) continue;
      const slots = Math.max(2, Math.ceil(r.total / HEADWAY_SEC));
      for (let s = 0; s < slots; s++) {
        for (const dir of [1, -1] as const) {
          if (n >= this.capacity) break;
          let t = (timeSec + s * HEADWAY_SEC + (dir === 1 ? 0 : r.total / 2)) % r.total;
          if (t < 0) t += r.total;

          // invert the time table to a distance, exactly as the buses do
          let lo = 0, hi = r.time.length - 1;
          while (lo + 1 < hi) {
            const mid = (lo + hi) >> 1;
            if (r.time[mid] <= t) lo = mid; else hi = mid;
          }
          const span = r.time[hi] - r.time[lo];
          const f = span > 1e-6 ? (t - r.time[lo]) / span : 0;
          const d0 = r.cum[lo] + (r.cum[hi] - r.cum[lo]) * f;
          const d = dir === 1 ? d0 : r.len - d0;

          let a = 0, b = r.cum.length - 1;
          while (a + 1 < b) {
            const mid = (a + b) >> 1;
            if (r.cum[mid] <= d) a = mid; else b = mid;
          }
          const sp = r.cum[b] - r.cum[a];
          const ff = sp > 1e-6 ? (d - r.cum[a]) / sp : 0;
          const px = r.pts[a].x + (r.pts[b].x - r.pts[a].x) * ff;
          const pz = r.pts[a].y + (r.pts[b].y - r.pts[a].y) * ff;
          let tx = r.pts[b].x - r.pts[a].x, tz = r.pts[b].y - r.pts[a].y;
          const L = Math.hypot(tx, tz) || 1;
          tx /= L; tz /= L;

          fwd.set(tx * dir, 0, tz * dir);
          side.crossVectors(fwd, up);
          m.makeBasis(fwd, up, side);
          m.setPosition(px + side.x * 3.4 * dir, DEPTH, pz + side.z * 3.4 * dir);
          this.trains.setMatrixAt(n, m);
          colors.setXYZ(n, r.colour.r, r.colour.g, r.colour.b);
          n++;
        }
      }
    }
    this.trains.count = n;
    this.trains.instanceMatrix.needsUpdate = true;
    colors.needsUpdate = true;
    this.live = n;
  }

  trainCount() { return this.live; }
  setVisible(v: boolean) { this.group.visible = v; }
  dispose() { this.trains?.geometry.dispose(); this.trace?.geometry.dispose(); }
}
