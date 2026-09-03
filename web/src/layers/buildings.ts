import * as THREE from "three";
import type { Layer, LayerReport } from "./registry";
import { extrudeFootprints, repaint, type XZ } from "./geom";
import { PALETTE } from "./palette";
import { applyFacadeDetail } from "./facade";
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
      { colorFor: (f, i) => this.colorOf(f.m, f.h, i) },
    );
    this.vfeat = built.vertexFeature;
    this.mesh = new THREE.Mesh(built.geometry, applyFacadeDetail(
      new THREE.MeshStandardMaterial({
        vertexColors: true, roughness: 0.72, metalness: 0, flatShading: true,
      })));
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.name = "buildings";
    this.group.add(this.mesh);

    return { ...base, status: "ready", provenance: res.data.provenance,
             features: this.buildings.length, bytes: res.bytes, ms: res.ms,
             drawCalls: 1, triangles: built.triangles };
  }

  /** Deterministic per-building tone spread. Real streets are not one colour, and a uniform
   *  palette is the main reason procedural city massing looks synthetic. Same index, same tint,
   *  every reload — it is a hash, not a random. */
  private static jitter(i: number): number {
    let h = 2166136261 ^ i;
    h = Math.imul(h, 16777619); h ^= h >>> 13; h = Math.imul(h, 16777619);
    return ((h >>> 0) % 1000) / 1000;
  }

  private colorOf(m: 0 | 1, h: number, i = 0): THREE.Color {
    const c = this.reveal
      ? (m === 0 ? PALETTE.revealObserved : PALETTE.revealEstimated)
      : (m === 0 ? PALETTE.buildingObserved : PALETTE.buildingEstimated);
    // taller stock reads slightly lighter, which gives the skyline depth without a texture
    const lift = 1 + Math.min(h / 90, 1) * 0.14;
    const out = c.clone().multiplyScalar(lift);
    // ±7% value and a slight hue drift; kept small enough that the reveal's amber-vs-sage
    // distinction stays unambiguous
    const j = BuildingsLayer.jitter(i);
    const k = BuildingsLayer.jitter(i * 2654435761);   // second, decorrelated draw
    const hsl = { h: 0, s: 0, l: 0 };
    out.getHSL(hsl);
    // Two families rather than one smear: roughly a third of the stock reads cooler and greyer
    // (concrete, glass-fronted offices), the rest warmer (plaster and sandstone). Real streets
    // are mixed, and a single hue is the tell that massing was generated.
    const cool = k < 0.34;
    const hue = cool ? hsl.h + 0.055 + (j - 0.5) * 0.02 : hsl.h + (j - 0.5) * 0.03;
    const sat = cool ? hsl.s * (0.34 + j * 0.26) : hsl.s * (0.80 + j * 0.45);
    const lum = hsl.l * (0.86 + j * 0.30);
    out.setHSL(hue, sat, Math.min(lum, 0.86));
    return out;
  }

  /** Re-tint in place. The reveal is a trust feature: 91.8% of this box has a guessed height. */
  setReveal(on: boolean) {
    if (!this.mesh || this.reveal === on) return;
    this.reveal = on;
    repaint(this.mesh.geometry, this.vfeat, (fi) => {
      const b = this.buildings[fi];
      return b ? this.colorOf(b.m, b.h, fi) : null;
    });
  }

  highlight(id: string | null) {
    if (!this.mesh) return;
    repaint(this.mesh.geometry, this.vfeat, (fi) => {
      const b = this.buildings[fi];
      if (!b) return null;
      return b.id === id ? new THREE.Color(0xf6d98a) : this.colorOf(b.m, b.h, fi);
    });
  }

  buildingAtVertex(v: number): Building | null { return this.buildings[this.vfeat[v]] ?? null; }
  get mesh3(): THREE.Mesh | undefined { return this.mesh; }
  setVisible(v: boolean) { this.group.visible = v; }
  dispose() { this.mesh?.geometry.dispose(); }
}
