import * as THREE from "three";
import type { Layer, LayerReport } from "./registry";
import { ribbons, repaint, type XZ } from "./geom";
import { PALETTE, trafficColor } from "./palette";
import * as load from "../geo/load";
import type { Corridor } from "../geo/types";

/** The three hero corridors get their own overlay so traffic state has a surface to live on that
 *  is independent of the base road layer — and so one corridor can be highlighted without
 *  repainting 1,800 roads. */
export class CorridorLayer implements Layer {
  id = "corridors"; label = "Corridor traffic";
  group = new THREE.Group();
  corridors: Corridor[] = [];
  private segRef: { c: number; s: number }[] = [];
  private mesh?: THREE.Mesh;
  private vfeat: Uint32Array = new Uint32Array(0);

  async build(): Promise<LayerReport> {
    const base: LayerReport = { id: this.id, label: this.label, status: "pending",
      provenance: null, features: 0, bytes: 0, ms: 0, drawCalls: 0, triangles: 0 };
    const res = await load.corridors();
    if (!res.ok) return { ...base, status: "unavailable", error: res.error };

    this.corridors = res.data.features;
    const lines: { p: XZ[]; width: number; y: number; color: THREE.Color }[] = [];
    this.corridors.forEach((c, ci) => {
      c.segments.forEach((s, si) => {
        lines.push({ p: [s.a, s.b], width: 19, y: 0.55, color: PALETTE.corridorIdle });
        this.segRef.push({ c: ci, s: si });
      });
    });
    const built = ribbons(lines);
    this.vfeat = built.vertexFeature;
    this.mesh = new THREE.Mesh(built.geometry, new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 0.66, metalness: 0,
    }));
    this.mesh.name = "corridors";
    this.group.add(this.mesh);

    return { ...base, status: "ready", provenance: res.data.provenance,
             features: this.segRef.length, bytes: res.bytes, ms: res.ms,
             drawCalls: 1, triangles: built.triangles };
  }

  /** ratioFor returns 0..1 congestion for a corridor segment, or null to leave it neutral. */
  paint(ratioFor: (corridorId: string, segIndex: number) => number | null) {
    if (!this.mesh) return;
    repaint(this.mesh.geometry, this.vfeat, (fi) => {
      const ref = this.segRef[fi];
      if (!ref) return null;
      const r = ratioFor(this.corridors[ref.c].id, ref.s);
      return r === null ? PALETTE.corridorIdle : trafficColor(r);
    });
  }

  byId(id: string): Corridor | undefined { return this.corridors.find((c) => c.id === id); }

  segmentAtVertex(v: number) {
    const ref = this.segRef[this.vfeat[v]];
    return ref ? { corridor: this.corridors[ref.c], segIndex: ref.s } : null;
  }

  get mesh3(): THREE.Mesh | undefined { return this.mesh; }
  setVisible(v: boolean) { this.group.visible = v; }
  dispose() { this.mesh?.geometry.dispose(); }
}
