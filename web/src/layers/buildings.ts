import * as THREE from "three";
import type { Layer, LayerReport } from "./registry";
import { extrudeFootprints, repaint, type XZ } from "./geom";
import { PALETTE } from "./palette";
import * as load from "../geo/load";
import type { Building } from "../geo/types";

export class BuildingsLayer implements Layer {
  id = "buildings"; label = "Buildings";
  group = new THREE.Group();
  buildings: Building[] = [];
  heightRuleVersion = "?";
  estimatedCount = 0;
  private mesh?: THREE.Mesh;
  private vfeat: Uint32Array = new Uint32Array(0);
  private reveal = false;

  async build(): Promise<LayerReport> {
    const base: LayerReport = { id: this.id, label: this.label, status: "pending",
      provenance: null, features: 0, bytes: 0, ms: 0, drawCalls: 0, triangles: 0 };
    const res = await load.buildings();
    if (!res.ok) return { ...base, status: "unavailable", error: res.error };

    this.buildings = res.data.features;
    this.heightRuleVersion = res.data.height_rule_version;
    this.estimatedCount = this.buildings.filter((b) => b.m === 1).length;

    const built = extrudeFootprints(
      this.buildings as { r: XZ[]; h: number; m: 0 | 1 }[],
      { colorFor: (f) => this.colorOf(f.m, f.h) },
    );
    this.vfeat = built.vertexFeature;
    this.mesh = new THREE.Mesh(built.geometry, new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 0.8, metalness: 0, flatShading: true,
    }));
    this.mesh.name = "buildings";
    this.group.add(this.mesh);

    return { ...base, status: "ready", provenance: res.data.provenance,
             features: this.buildings.length, bytes: res.bytes, ms: res.ms,
             drawCalls: 1, triangles: built.triangles };
  }

  private colorOf(m: 0 | 1, h: number): THREE.Color {
    const c = this.reveal
      ? (m === 0 ? PALETTE.revealObserved : PALETTE.revealEstimated)
      : (m === 0 ? PALETTE.buildingObserved : PALETTE.buildingEstimated);
    // taller stock reads slightly lighter, which gives the skyline depth without a texture
    const lift = 1 + Math.min(h / 90, 1) * 0.14;
    return c.clone().multiplyScalar(lift);
  }

  /** Re-tint in place. The reveal is a trust feature: 91.8% of this box has a guessed height. */
  setReveal(on: boolean) {
    if (!this.mesh || this.reveal === on) return;
    this.reveal = on;
    repaint(this.mesh.geometry, this.vfeat, (fi) => {
      const b = this.buildings[fi];
      return b ? this.colorOf(b.m, b.h) : null;
    });
  }

  highlight(id: string | null) {
    if (!this.mesh) return;
    repaint(this.mesh.geometry, this.vfeat, (fi) => {
      const b = this.buildings[fi];
      if (!b) return null;
      return b.id === id ? new THREE.Color(0xf6d98a) : this.colorOf(b.m, b.h);
    });
  }

  buildingAtVertex(v: number): Building | null { return this.buildings[this.vfeat[v]] ?? null; }
  get mesh3(): THREE.Mesh | undefined { return this.mesh; }
  setVisible(v: boolean) { this.group.visible = v; }
  dispose() { this.mesh?.geometry.dispose(); }
}
