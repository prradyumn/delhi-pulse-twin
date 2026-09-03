import * as THREE from "three";
import type { Layer, LayerReport } from "./registry";
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
  private trunks?: THREE.InstancedMesh;
  private canopies?: THREE.InstancedMesh;

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

    this.trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, total);
    this.canopies = new THREE.InstancedMesh(canopyGeo, canopyMat, total);
    // Canopy colour varies per instance: a monochrome tree line is as synthetic as monochrome
    // buildings, and Delhi's canopy runs from dusty olive to deep neem green.
    const colors = new Float32Array(total * 3);
    this.canopies.instanceColor = new THREE.InstancedBufferAttribute(colors, 3);

    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const pos = new THREE.Vector3();
    const scale = new THREE.Vector3();
    const tint = new THREE.Color();

    const place = (i: number, x0: number, z0: number, taggedHeight: number, big: boolean) => {
      const a = hash01(i), b = hash01(i, 7), c = hash01(i, 13);
      // generated rows are spaced on a fixed pitch; a small deterministic nudge stops them
      // reading as a fence. Observed trees keep their surveyed position exactly.
      const jx = big ? 0 : (hash01(i, 31) - 0.5) * 2.6;
      const jz = big ? 0 : (hash01(i, 37) - 0.5) * 2.6;
      const x = x0 + jx, z = z0 + jz;
      // observed trees with a real height tag use it; everything else is stylised
      const h = taggedHeight > 1.5 ? taggedHeight : (big ? 9 + a * 7 : 6.5 + a * 5.5);
      const trunkH = h * (0.40 + b * 0.10);
      const crown = h - trunkH;
      const spread = crown * (0.62 + c * 0.34);

      scale.set(1 + b * 0.5, trunkH, 1 + b * 0.5);
      q.identity();
      pos.set(x, 0, z);
      m.compose(pos, q, scale);
      this.trunks!.setMatrixAt(i, m);

      // a slight lean and squash so no two canopies are the same blob
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), a * Math.PI * 2);
      scale.set(spread, crown * (0.52 + b * 0.22), spread * (0.86 + c * 0.28));
      pos.set(x, trunkH + crown * 0.42, z);
      m.compose(pos, q, scale);
      this.canopies!.setMatrixAt(i, m);

      tint.setHSL(0.23 + c * 0.055, 0.26 + a * 0.20, 0.34 + b * 0.16, THREE.SRGBColorSpace);
      colors[i * 3] = tint.r; colors[i * 3 + 1] = tint.g; colors[i * 3 + 2] = tint.b;
    };

    let i = 0;
    for (const [x, z, h] of obs) place(i++, x, z, h, true);
    for (const [x, z] of gen) place(i++, x, z, 0, false);

    this.trunks.instanceMatrix.needsUpdate = true;
    this.canopies.instanceMatrix.needsUpdate = true;
    this.canopies.instanceColor.needsUpdate = true;
    // Trees cast as well as receive. 17k instances in the shadow pass is the one place this
    // scene could plausibly have run out of frame time, so it was measured rather than assumed —
    // dappled avenue shade is what actually grounds them, and without it they look pasted on.
    this.trunks.receiveShadow = true;
    this.canopies.receiveShadow = true;
    this.canopies.castShadow = true;
    this.trunks.name = "tree_trunks";
    this.canopies.name = "tree_canopies";
    this.group.add(this.trunks, this.canopies);

    return { ...base, status: "ready", provenance: res.data.provenance,
             features: total, bytes: res.bytes, ms: res.ms, drawCalls: 2,
             triangles: total * (10 + 20) };
  }

  setVisible(v: boolean) { this.group.visible = v; }
  dispose() { this.trunks?.geometry.dispose(); this.canopies?.geometry.dispose(); }
}
