import * as THREE from "three";
import { AltitudeGate, type Layer, type LayerReport } from "./registry";
import { mergeBoxes, bucketByTile, type XZ } from "./geom";
import type { Road, Stop, Provenance } from "../geo/types";

/**
 * Street furniture: lamp posts, bus shelters, signal masts, kerbside bollards.
 *
 * The thing that makes a street read as a street rather than as a corridor between extruded
 * blocks — and now worth building, because the street-level camera means anyone can actually see
 * it. Before that it was detail nobody would ever get close enough to notice.
 *
 * Generated from geometry already in memory: lamps spaced along the road centrelines, shelters at
 * the mapped bus stops, signals near the junctions of main roads. **No new data file**, and no new
 * fetch — OSM has 14 mapped street lamps in this entire 16 km² box, so a survey was never on the
 * table. Declared `simulated` for that reason.
 *
 * Bucketed per tile like the trees, so the frustum can reject what is behind you.
 */
function hash01(i: number, salt = 0): number {
  let h = (2166136261 ^ i ^ (salt * 40503)) >>> 0;
  h = Math.imul(h, 16777619); h ^= h >>> 13; h = Math.imul(h, 16777619);
  return ((h >>> 0) % 100000) / 100000;
}

const LAMP_SPACING: Record<string, number> = {
  motorway: 42, trunk: 40, primary: 34, secondary: 32, tertiary: 36,
};
const LAMP_OFFSET: Record<string, number> = {
  motorway: 13, trunk: 12, primary: 10, secondary: 8.5, tertiary: 7,
};

export class FurnitureLayer implements Layer {
  id = "furniture"; label = "Street furniture";
  group = new THREE.Group();
  private meshes: THREE.InstancedMesh[] = [];
  private counts = { lamps: 0, shelters: 0, signals: 0 };

  constructor(
    private roads: Road[],
    private stops: Stop[],
    private extent: { x: [number, number]; z: [number, number] },
    private grid: [number, number],
  ) {}

  async build(): Promise<LayerReport> {
    const prov: Provenance = {
      provider: "Derived (this prototype)",
      dataset: "Generated street furniture along OSM road centrelines and at OSM bus stops",
      license: "Derived from OSM geometry, ODbL 1.0",
      attribution: "© OpenStreetMap contributors — road and stop geometry",
      retrieved_at: "2026-09-03", source_time: null, refresh_cadence: "none — deterministic",
      bounds: [77.1975, 28.6039, 77.2385, 28.6401], crs: "EPSG:32643 + local origin",
      mode: "simulated", transform_version: "0.1.0",
      limitations: [
        "GENERATED, not surveyed. OSM maps 14 street lamps in this entire 16 km² box, so no individual lamp, shelter or signal here corresponds to a real one.",
        "Lamps are spaced at 32–42 m by road class and offset by 7–13 m from the centreline; both are authored figures, not measurements.",
        "Shelters are placed at every mapped bus stop. Many real Delhi stops are a pole or nothing at all, so this over-states shelter provision.",
        "Signals are placed near main-road junctions inferred from centreline proximity, not from OSM traffic_signals nodes.",
      ],
    };
    const base: LayerReport = { id: this.id, label: this.label, status: "pending",
      provenance: prov, features: 0, bytes: 0, ms: 0, drawCalls: 0, triangles: 0 };
    if (!this.roads.length) return { ...base, status: "empty" };

    // ---------------- lamp posts
    type Item = { x: number; z: number; rot: number; kind: number };
    const lamps: Item[] = [];
    this.roads.forEach((r, ri) => {
      const step = LAMP_SPACING[r.k];
      if (!step || r.p.length < 2) return;
      const off = LAMP_OFFSET[r.k] ?? 8;
      let acc = hash01(ri, 3) * step;      // stagger the phase per road, not a global grid
      for (let i = 1; i < r.p.length; i++) {
        const [x0, z0] = r.p[i - 1], [x1, z1] = r.p[i];
        const dx = x1 - x0, dz = z1 - z0;
        const seg = Math.hypot(dx, dz);
        if (seg < 1e-3) continue;
        const nx = dz / seg, nz = -dx / seg;
        let d = acc;
        while (d < seg) {
          const t = d / seg;
          // alternate sides, which is how a lit street is actually arranged
          const side = ((lamps.length & 1) ? 1 : -1);
          lamps.push({
            x: x0 + dx * t + nx * off * side,
            z: z0 + dz * t + nz * off * side,
            rot: Math.atan2(dx, dz) + (side > 0 ? 0 : Math.PI),
            kind: 0,
          });
          d += step;
        }
        acc = d - seg;
      }
    });

    // ---------------- signals, near junctions of main roads
    const MAIN = new Set(["primary", "secondary", "trunk", "motorway"]);
    const ends: XZ[] = [];
    for (const r of this.roads) {
      if (!MAIN.has(r.k) || r.p.length < 2) continue;
      ends.push(r.p[0], r.p[r.p.length - 1]);
    }
    const signals: Item[] = [];
    const taken: XZ[] = [];
    for (const e of ends) {
      // a junction is where two main-road endpoints nearly coincide
      const near = ends.filter((o) => o !== e && Math.hypot(o[0] - e[0], o[1] - e[1]) < 26).length;
      if (near < 2) continue;
      if (taken.some((t) => Math.hypot(t[0] - e[0], t[1] - e[1]) < 55)) continue;
      taken.push(e);
      signals.push({ x: e[0], z: e[1], rot: hash01(signals.length, 11) * Math.PI * 2, kind: 2 });
    }

    // ---------------- shelters at bus stops
    const shelters: Item[] = this.stops.map((s, i) => ({
      x: s.x, z: s.z, rot: hash01(i, 17) * Math.PI * 2, kind: 1,
    }));

    this.counts = { lamps: lamps.length, shelters: shelters.length, signals: signals.length };

    // ---------------- geometry
    // A lamp is a post, a bracket arm and a luminaire head — three boxes, one instanced draw.
    const post = new THREE.BoxGeometry(0.22, 8.4, 0.22); post.translate(0, 4.2, 0);
    const arm = new THREE.BoxGeometry(0.16, 0.16, 1.7); arm.translate(0, 8.3, 0.85);
    const head = new THREE.BoxGeometry(0.5, 0.20, 1.0); head.translate(0, 8.15, 1.55);
    const lampGeo = mergeBoxes([post, arm, head]);

    const roof = new THREE.BoxGeometry(4.2, 0.16, 1.9); roof.translate(0, 2.5, 0);
    const backW = new THREE.BoxGeometry(4.2, 1.9, 0.10); backW.translate(0, 1.5, -0.9);
    const legA = new THREE.BoxGeometry(0.12, 2.5, 0.12); legA.translate(-2.0, 1.25, 0.85);
    const legB = new THREE.BoxGeometry(0.12, 2.5, 0.12); legB.translate(2.0, 1.25, 0.85);
    const bench = new THREE.BoxGeometry(3.6, 0.12, 0.45); bench.translate(0, 0.5, -0.55);
    const shelterGeo = mergeBoxes([roof, backW, legA, legB, bench]);

    const mast = new THREE.BoxGeometry(0.24, 6.2, 0.24); mast.translate(0, 3.1, 0);
    const boom = new THREE.BoxGeometry(0.16, 0.16, 3.4); boom.translate(0, 6.1, 1.7);
    const lights = new THREE.BoxGeometry(0.34, 1.0, 0.34); lights.translate(0, 5.55, 3.2);
    const signalGeo = mergeBoxes([mast, boom, lights]);

    const spec: { geo: THREE.BufferGeometry; items: Item[]; colour: number; name: string }[] = [
      { geo: lampGeo, items: lamps, colour: 0x4d5257, name: "lamps" },
      { geo: shelterGeo, items: shelters, colour: 0x6a6f6b, name: "shelters" },
      { geo: signalGeo, items: signals, colour: 0x3c4147, name: "signals" },
    ];

    let tris = 0, dc = 0;
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    const one = new THREE.Vector3(1, 1, 1);
    const pos = new THREE.Vector3();

    for (const sp of spec) {
      if (!sp.items.length) continue;
      const triPer = (sp.geo.getIndex()?.count ?? 0) / 3;
      const material = new THREE.MeshStandardMaterial({
        color: sp.colour, roughness: 0.62, metalness: 0.25, flatShading: true,
      });
      const buckets = bucketByTile(sp.items, (it) => [it.x, it.z], this.extent, this.grid);
      for (const b of buckets) {
        const inst = new THREE.InstancedMesh(sp.geo, material, b.items.length);
        b.items.forEach((it, i) => {
          q.setFromAxisAngle(up, it.rot);
          pos.set(it.x, 0, it.z);
          m.compose(pos, q, one);
          inst.setMatrixAt(i, m);
        });
        inst.instanceMatrix.needsUpdate = true;
        inst.computeBoundingSphere();
        // Neither casting nor receiving. Casting would cost a shadow-map redraw for thin
        // verticals nobody looks at. Receiving turned out to matter more than expected: 48
        // instanced meshes each sampling the 8192 shadow map, for objects one or two pixels tall
        // in a wide view, is a shader cost paid on geometry that contributes nothing. A shelter
        // roof is the only piece with a surface big enough to read a shadow on, and it does not
        // read one from 2 km up.
        inst.receiveShadow = sp.name === "shelters";
        inst.name = `furniture_${sp.name}`;
        this.group.add(inst);
        this.meshes.push(inst);
        tris += triPer * b.items.length;
        dc++;
      }
    }

    return { ...base, status: "ready",
             features: lamps.length + shelters.length + signals.length,
             drawCalls: dc, triangles: Math.round(tris) };
  }

  breakdown() { return { ...this.counts }; }

  /** Street furniture is street-level detail, so it is drawn at street level and not from a
   *  helicopter. See AltitudeGate for the measurement that forced this. */
  static readonly VISIBLE_BELOW_M = 420;
  private gate = new AltitudeGate(this.group, FurnitureLayer.VISIBLE_BELOW_M);

  setCameraHeight(y: number) { this.gate.setCameraHeight(y); }

  setVisible(v: boolean) { this.gate.setVisible(v); }
  get visible() { return this.gate.visible; }
  dispose() { for (const m of this.meshes) m.geometry.dispose(); }
}
