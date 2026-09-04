import * as THREE from "three";
import type { Layer, LayerReport } from "./registry";
import { extrudeFootprints, repaint, bucketByTile, ringCentre, type XZ } from "./geom";
import { PALETTE } from "./palette";
import { applyFacadeDetail, applyFacadeTextures, atlasCellFor, type FacadeMaps } from "./facade";
import * as load from "../geo/load";
import type { Building } from "../geo/types";

export class BuildingsLayer implements Layer {
  id = "buildings"; label = "Buildings";
  group = new THREE.Group();
  buildings: Building[] = [];
  heightRuleVersion = "?";
  estimatedCount = 0;
  remoteCount = 0;
  /** one mesh per spatial tile; `feats` maps that mesh's vertex-feature indices back to buildings */
  private tiles: { mesh: THREE.Mesh; vfeat: Uint32Array; feats: Building[] }[] = [];
  private reveal = false;

  constructor(
    private extent: { x: [number, number]; z: [number, number] },
    private grid: [number, number],
    private facade: FacadeMaps | null = null,
  ) {}

  async build(): Promise<LayerReport> {
    const base: LayerReport = { id: this.id, label: this.label, status: "pending",
      provenance: null, features: 0, bytes: 0, ms: 0, drawCalls: 0, triangles: 0 };
    const res = await load.buildings();
    if (!res.ok) return { ...base, status: "unavailable", error: res.error };

    this.buildings = res.data.features;
    this.heightRuleVersion = res.data.height_rule_version;
    this.estimatedCount = this.buildings.filter((b) => b.m === 1).length;
    this.remoteCount = this.buildings.filter((b) => b.m === 2).length;

    // One material, shared across every tile: per-tile meshes cost draw calls, not shader
    // programs. The building class travels as a vertex attribute precisely so this stays ONE
    // material — a material per class would have multiplied the draw calls just reclaimed.
    //
    // flatShading is dropped when textures are on: it discards the interpolated normal the
    // normal map needs, so the window recesses would not light.
    let material = new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 0.72, metalness: 0,
      flatShading: this.facade === null,
    });
    material = applyFacadeDetail(material,
      // with real texture detail the procedural window pattern becomes double-printing, so it
      // drops back to just the storey banding and the ground-floor plinth
      this.facade ? { strength: 0.28 } : {});
    if (this.facade) material = applyFacadeTextures(material, this.facade);

    const buckets = bucketByTile(
      this.buildings, (b) => ringCentre(b.r as XZ[]), this.extent, this.grid);
    let tris = 0;
    for (const bucket of buckets) {
      // colour index is global, so the reveal and the highlight stay stable across tiles
      const globalIndex = new Map(bucket.items.map((b, i) => [i, this.buildings.indexOf(b)]));
      const built = extrudeFootprints(
        bucket.items as { r: XZ[]; h: number; m: 0 | 1 }[],
        {
          colorFor: (f, i) => this.colorOf(f.m, f.h, globalIndex.get(i) ?? i),
          classOf: (_f, i) => atlasCellFor(bucket.items[i]?.c ?? "yes"),
          // a per-building phase offset, or every window grid on the street lines up
          phaseOf: (_f, i) => BuildingsLayer.jitter((globalIndex.get(i) ?? i) * 7 + 3),
        },
      );
      const mesh = new THREE.Mesh(built.geometry, material);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.name = "buildings";
      mesh.userData.tile = bucket.key;
      this.group.add(mesh);
      this.tiles.push({ mesh, vfeat: built.vertexFeature, feats: bucket.items });
      tris += built.triangles;
    }

    return { ...base, status: "ready", provenance: res.data.provenance,
             features: this.buildings.length, bytes: res.bytes, ms: res.ms,
             drawCalls: this.tiles.length, triangles: tris };
  }

  /** Deterministic per-building tone spread. Real streets are not one colour, and a uniform
   *  palette is the main reason procedural city massing looks synthetic. Same index, same tint,
   *  every reload — it is a hash, not a random. */
  private static jitter(i: number): number {
    let h = 2166136261 ^ i;
    h = Math.imul(h, 16777619); h ^= h >>> 13; h = Math.imul(h, 16777619);
    return ((h >>> 0) % 1000) / 1000;
  }

  private colorOf(m: 0 | 1 | 2, h: number, i = 0): THREE.Color {
    const c = this.reveal
      ? (m === 0 ? PALETTE.revealObserved
         : m === 2 ? PALETTE.revealRemote : PALETTE.revealEstimated)
      // outside reveal mode a satellite height is treated as measured, because it is one
      : (m === 1 ? PALETTE.buildingEstimated : PALETTE.buildingObserved);
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
    // In reveal mode the only thing that may vary is brightness. The warm/cool families exist to
    // make the ordinary view look like a real street; letting them run while the user is asking
    // "which of these heights did you guess?" would blur the one distinction that has to be exact.
    if (this.reveal) {
      out.setHSL(hsl.h, hsl.s, Math.min(hsl.l * (0.92 + j * 0.16), 0.86));
      return out;
    }
    const cool = k < 0.34;
    const hue = cool ? hsl.h + 0.055 + (j - 0.5) * 0.02 : hsl.h + (j - 0.5) * 0.03;
    const sat = cool ? hsl.s * (0.34 + j * 0.26) : hsl.s * (0.80 + j * 0.45);
    const lum = hsl.l * (0.86 + j * 0.30);
    out.setHSL(hue, sat, Math.min(lum, 0.86));
    return out;
  }

  /** Re-tint in place. The reveal is a trust feature: 91.8% of this box has a guessed height. */
  private repaintAll(colorFor: (b: Building, globalIndex: number) => THREE.Color | null) {
    for (const t of this.tiles) {
      repaint(t.mesh.geometry, t.vfeat, (fi) => {
        const b = t.feats[fi];
        return b ? colorFor(b, this.buildings.indexOf(b)) : null;
      });
    }
  }

  setReveal(on: boolean) {
    if (this.reveal === on) return;
    this.reveal = on;
    this.repaintAll((b, gi) => this.colorOf(b.m, b.h, gi));
  }

  highlight(id: string | null) {
    this.repaintAll((b, gi) =>
      b.id === id ? new THREE.Color(0xf6d98a) : this.colorOf(b.m, b.h, gi));
  }

  /** Resolve a raycast hit back to a building, given which tile mesh was struck. */
  buildingAt(mesh: THREE.Object3D, vertexIndex: number): Building | null {
    const t = this.tiles.find((x) => x.mesh === mesh);
    return t ? t.feats[t.vfeat[vertexIndex]] ?? null : null;
  }

  get meshes(): THREE.Mesh[] { return this.tiles.map((t) => t.mesh); }
  setVisible(v: boolean) { this.group.visible = v; }
  dispose() { for (const t of this.tiles) t.mesh.geometry.dispose(); }
}
