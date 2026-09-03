import * as THREE from "three";
import type { Layer, LayerReport } from "./registry";
import { fills, type XZ } from "./geom";
import { PALETTE } from "./palette";
import { applyGroundVariation } from "./facade";
import * as load from "../geo/load";
import type { GroundPoly } from "../geo/types";

/**
 * Spike-0 measured 58.5% landuse coverage against 13.7% building coverage. In this box the ground
 * plane, not the buildings, is what makes the city read — so this layer is P0, not decoration.
 */
export class GroundLayer implements Layer {
  id = "ground"; label = "Ground & parks";
  group = new THREE.Group();
  polys: GroundPoly[] = [];
  private mesh?: THREE.Mesh;

  async build(): Promise<LayerReport> {
    const base: LayerReport = { id: this.id, label: this.label, status: "pending",
      provenance: null, features: 0, bytes: 0, ms: 0, drawCalls: 0, triangles: 0 };
    const res = await load.ground();
    if (!res.ok) return { ...base, status: "unavailable", error: res.error };

    // A base plate under everything so gaps in OSM landuse read as ground, not as void.
    const extent = 4400;
    const plate = new THREE.Mesh(
      new THREE.PlaneGeometry(extent, extent),
      new THREE.MeshStandardMaterial({ color: PALETTE.bare, roughness: 0.95 }),
    );
    plate.rotation.x = -Math.PI / 2;
    plate.position.y = -0.35;
    plate.receiveShadow = true;
    this.group.add(plate);

    this.polys = res.data.features;
    const colorOf: Record<string, THREE.Color> = {
      green: PALETTE.green, pitch: PALETTE.pitch, urban: PALETTE.urban, bare: PALETTE.bare,
    };
    // Largest first, each nudged up a hair, so a small garden inside a big estate still shows.
    // The step is normalised by the polygon count rather than fixed: clipping splits polygons into
    // parts, so the count is not knowable ahead of time, and a fixed step would let a large enough
    // dataset climb out of the ground band and punch through water and roads.
    // See docs/07-RENDER-CORRECTNESS.md, rule 5, for the full y budget.
    const n = Math.max(this.polys.length, 1);
    const BAND_LOW = -0.3, BAND_HIGH = -0.14;
    const built = fills(this.polys.map((p, i) => ({
      r: p.r as XZ[],
      y: BAND_LOW + (i / n) * (BAND_HIGH - BAND_LOW),
      color: colorOf[p.cat] ?? PALETTE.bare,
    })));

    this.mesh = new THREE.Mesh(built.geometry, applyGroundVariation(
      new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.92, metalness: 0 })));
    this.mesh.receiveShadow = true;
    this.mesh.name = "ground";
    this.group.add(this.mesh);

    return { ...base, status: "ready", provenance: res.data.provenance,
             features: this.polys.length, bytes: res.bytes, ms: res.ms,
             drawCalls: 2, triangles: built.triangles + 2 };
  }

  setVisible(v: boolean) { this.group.visible = v; }
  dispose() { this.mesh?.geometry.dispose(); }
}
