import * as THREE from "three";
import type { Layer, LayerReport } from "./registry";
import { fills, ribbons, type XZ } from "./geom";
import { PALETTE } from "./palette";
import * as load from "../geo/load";

export class WaterLayer implements Layer {
  id = "water"; label = "Water";
  group = new THREE.Group();

  /** `env` is the sky cube from the stage. Water is the only reflective surface in the box — the
   *  channels flanking Kartavya Path and the Bangla Sahib sarovar — so a real reflection here is a
   *  tiny, targeted spend rather than a scene-wide effect. */
  constructor(private env: THREE.Texture | null = null) {}

  async build(): Promise<LayerReport> {
    const base: LayerReport = { id: this.id, label: this.label, status: "pending",
      provenance: null, features: 0, bytes: 0, ms: 0, drawCalls: 0, triangles: 0 };
    const res = await load.water();
    if (!res.ok) return { ...base, status: "unavailable", error: res.error };
    const f = res.data.features;
    if (!f.length) return { ...base, status: "empty", provenance: res.data.provenance, bytes: res.bytes };

    const mat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      // low roughness plus a genuine environment map is what makes water read as water rather
      // than as blue paint; metalness carries the fresnel falloff at grazing angles
      roughness: 0.08, metalness: 0.55,
      envMap: this.env ?? null,
      envMapIntensity: 1.15,
    });
    let tris = 0, dc = 0;
    // Ground cover occupies y −0.30 … −0.11 (largest polygon first, stacked by a hair). Water has
    // to clear the top of that stack or a lawn polygon paints over the lake, so it sits at −0.08 —
    // still below the road surface at +0.02.
    const areas = f.filter((x) => x.kind === "area" && x.r);
    if (areas.length) {
      const g = fills(areas.map((a) => ({ r: a.r as XZ[], y: -0.08, color: PALETTE.water })));
      this.group.add(new THREE.Mesh(g.geometry, mat)); tris += g.triangles; dc++;
    }
    const lines = f.filter((x) => x.kind === "line" && x.p);
    if (lines.length) {
      const g = ribbons(lines.map((l) => ({ p: l.p as XZ[], width: 8, y: -0.06, color: PALETTE.water })));
      this.group.add(new THREE.Mesh(g.geometry, mat)); tris += g.triangles; dc++;
    }
    return { ...base, status: "ready", provenance: res.data.provenance,
             features: f.length, bytes: res.bytes, ms: res.ms, drawCalls: dc, triangles: tris };
  }
  setVisible(v: boolean) { this.group.visible = v; }
  dispose() { this.group.traverse((o) => (o as THREE.Mesh).geometry?.dispose?.()); }
}
