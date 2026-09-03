import * as THREE from "three";
import type { Layer, LayerReport } from "./registry";
import { bucketByTile } from "./geom";
import * as load from "../geo/load";
import type { Provenance } from "../geo/types";

interface TreePayload {
  kind: string; observed: number; generated: number;
  provenance: Provenance;
  observed_trees: [number, number, number][];
  generated_trees: [number, number][];
}

/** Deterministic per-tree variation — same index, same tree, every reload. */
function hash01(i: number, salt = 0): number {
  let h = (2166136261 ^ i ^ (salt * 374761393)) >>> 0;
  h = Math.imul(h, 16777619); h ^= h >>> 13; h = Math.imul(h, 16777619);
  return ((h >>> 0) % 100000) / 100000;
}

/**
 * Lutyens' Delhi is its avenues. A render of this box without street trees cannot read as the
 * place, whatever else is right — which is why this layer exists even though only 1,171 of the
 * 17,360 trees here are individually surveyed. The other 16,189 are generated along main-road
 * edges, counted separately, and the layer reports itself as `simulated` because of them.
 *
 * Two instanced meshes total: one trunk, one canopy. Roughly 30 triangles a tree.
 */
export class TreesLayer implements Layer {
  id = "trees"; label = "Trees";
  group = new THREE.Group();
  observedCount = 0;
  generatedCount = 0;
  /** One pair of instanced meshes per spatial tile. A single 17,360-instance mesh spanning the
   *  whole box can never be frustum-culled — measured: submitted triangles barely moved between a
   *  2 km overview and a street-level view, because the trees were always all submitted. Per-tile
   *  meshes each get a real bounding sphere, so the frustum can reject them. */
  private tiles: { trunks: THREE.InstancedMesh; canopies: THREE.InstancedMesh }[] = [];

  constructor(
    private extent: { x: [number, number]; z: [number, number] },
    private grid: [number, number],
  ) {}

  async build(): Promise<LayerReport> {
    const base: LayerReport = { id: this.id, label: this.label, status: "pending",
      provenance: null, features: 0, bytes: 0, ms: 0, drawCalls: 0, triangles: 0 };
    const res = await load.grab<TreePayload>("trees.json");
    if (!res.ok) return { ...base, status: "unavailable", error: res.error };

    const obs = res.data.observed_trees ?? [];
    const gen = res.data.generated_trees ?? [];
    this.observedCount = obs.length;
    this.generatedCount = gen.length;
    const total = obs.length + gen.length;
    if (!total) return { ...base, status: "empty", provenance: res.data.provenance, bytes: res.bytes };

    // 5-sided trunk with no caps and a detail-0 icosahedron canopy: the cheapest shapes that
    // still read as a tree from street level, which is the only place they are seen up close.
    const trunkGeo = new THREE.CylinderGeometry(0.24, 0.40, 1, 5, 1, true);
    trunkGeo.translate(0, 0.5, 0);                       // pivot at the base
    const canopyGeo = new THREE.IcosahedronGeometry(1, 0);

    const trunkMat = new THREE.MeshStandardMaterial({ color: 0x6b5844, roughness: 0.95 });
    // instanceColor alone: do NOT also set vertexColors here. Three defines USE_COLOR from
    // vertexColors and multiplies vColor by the geometry's `color` attribute — which this
    // geometry does not have, so WebGL supplies (0,0,0) and every instance renders black.
    const canopyMat = new THREE.MeshStandardMaterial({
      color: 0xffffff, roughness: 0.88, metalness: 0, flatShading: true,
    });

    // every tree carries its global index so the deterministic per-tree variation survives
    // bucketing — the same tree must look the same however the meshes are partitioned
    type T = { x: number; z: number; h: number; big: boolean; gi: number };
    const all: T[] = [];
    obs.forEach(([x, z, h], i) => all.push({ x, z, h, big: true, gi: i }));
    gen.forEach(([x, z], i) => all.push({ x, z, h: 0, big: false, gi: obs.length + i }));

    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const pos = new THREE.Vector3();
    const scale = new THREE.Vector3();
    const tint = new THREE.Color();
    const axis = new THREE.Vector3(0, 1, 0);

    const buckets = bucketByTile(all, (t) => [t.x, t.z], this.extent, this.grid);
    for (const bucket of buckets) {
      const n = bucket.items.length;
      const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, n);
      const canopies = new THREE.InstancedMesh(canopyGeo, canopyMat, n);
      const colors = new Float32Array(n * 3);
      canopies.instanceColor = new THREE.InstancedBufferAttribute(colors, 3);

      bucket.items.forEach((t, k) => {
        const i = t.gi;
        const a = hash01(i), b = hash01(i, 7), c = hash01(i, 13);
        // generated rows are spaced on a fixed pitch; a small deterministic nudge stops them
        // reading as a fence. Observed trees keep their surveyed position exactly.
        const jx = t.big ? 0 : (hash01(i, 31) - 0.5) * 2.6;
        const jz = t.big ? 0 : (hash01(i, 37) - 0.5) * 2.6;
        const x = t.x + jx, z = t.z + jz;
        // observed trees with a real height tag use it; everything else is stylised
        const h = t.h > 1.5 ? t.h : (t.big ? 9 + a * 7 : 6.5 + a * 5.5);
        const trunkH = h * (0.40 + b * 0.10);
        const crown = h - trunkH;
        const spread = crown * (0.62 + c * 0.34);

        scale.set(1 + b * 0.5, trunkH, 1 + b * 0.5);
        q.identity();
        pos.set(x, 0, z);
        m.compose(pos, q, scale);
        trunks.setMatrixAt(k, m);

        q.setFromAxisAngle(axis, a * Math.PI * 2);
        scale.set(spread, crown * (0.52 + b * 0.22), spread * (0.86 + c * 0.28));
        pos.set(x, trunkH + crown * 0.42, z);
        m.compose(pos, q, scale);
        canopies.setMatrixAt(k, m);

        tint.setHSL(0.23 + c * 0.055, 0.26 + a * 0.20, 0.34 + b * 0.16, THREE.SRGBColorSpace);
        colors[k * 3] = tint.r; colors[k * 3 + 1] = tint.g; colors[k * 3 + 2] = tint.b;
      });

      trunks.instanceMatrix.needsUpdate = true;
      canopies.instanceMatrix.needsUpdate = true;
      canopies.instanceColor.needsUpdate = true;
      // computed from the instances, which is what lets the frustum reject the whole tile
      trunks.computeBoundingSphere();
      canopies.computeBoundingSphere();
      trunks.receiveShadow = true;
      canopies.receiveShadow = true;
      canopies.castShadow = true;
      trunks.name = "tree_trunks";
      canopies.name = "tree_canopies";
      trunks.userData.tile = bucket.key;
      canopies.userData.tile = bucket.key;
      this.group.add(trunks, canopies);
      this.tiles.push({ trunks, canopies });
    }

    return { ...base, status: "ready", provenance: res.data.provenance,
             features: total, bytes: res.bytes, ms: res.ms,
             drawCalls: this.tiles.length * 2,
             triangles: total * (10 + 20) };
  }

  setVisible(v: boolean) { this.group.visible = v; }
  dispose() {
    for (const t of this.tiles) { t.trunks.geometry.dispose(); t.canopies.geometry.dispose(); }
  }
}
