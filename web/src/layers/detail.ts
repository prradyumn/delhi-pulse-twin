import * as THREE from "three";
import type { Layer, LayerReport } from "./registry";
import { wallStrips, insetRing, ringPoint, extrudeFootprints, ribbons, type XZ } from "./geom";
import { applyFacadeDetail, applyBakedAO } from "./facade";
import * as load from "../geo/load";
import type { Building, Payload, Provenance } from "../geo/types";

function hash01(i: number, salt = 0): number {
  let h = (2166136261 ^ i ^ (salt * 2654435761)) >>> 0;
  h = Math.imul(h, 16777619); h ^= h >>> 13; h = Math.imul(h, 16777619);
  return ((h >>> 0) % 100000) / 100000;
}

/**
 * Rooftop detail: parapets and water tanks.
 *
 * A flat-topped extruded prism is the single thing that makes procedural massing look like a toy,
 * and OSM has almost nothing to fix it with — of 290 buildings with a `roof:shape` tag in this box,
 * 263 say `flat`. So this is **generated**, from the real footprints, deterministically. It is
 * declared `simulated` and the layer says plainly that no individual tank is a real tank.
 *
 * The choice of clutter is not arbitrary: parapets and black polymer water tanks are what is
 * actually on a Delhi roof, and their absence is more conspicuous than their approximation.
 */
export class RoofDetailLayer implements Layer {
  id = "roofdetail"; label = "Rooftop detail";
  group = new THREE.Group();
  private meshes: THREE.Mesh[] = [];
  private tanks?: THREE.InstancedMesh;

  constructor(private buildings: Building[]) {}

  async build(): Promise<LayerReport> {
    const prov: Provenance = {
      provider: "Derived (this prototype)",
      dataset: "Generated rooftop parapets and water tanks",
      license: "Derived from OSM building footprints, ODbL 1.0",
      attribution: "© OpenStreetMap contributors — footprints",
      retrieved_at: "2026-09-03", source_time: null, refresh_cadence: "none — deterministic",
      bounds: [77.1975, 28.6039, 77.2385, 28.6401], crs: "EPSG:32643 + local origin",
      mode: "simulated", transform_version: "0.1.0",
      limitations: [
        "Entirely GENERATED. No individual parapet or water tank here corresponds to a real one.",
        "OSM has no usable roof detail for this box: of 290 buildings carrying a roof:shape tag, 263 are tagged flat.",
        "Parapet height 0.9 m and tank sizes are authored. Placement is a hash of the building index, so it is identical on every reload but arbitrary.",
        "Applied only to buildings over 6 m tall with a footprint over 120 m². Smaller stock is left plain.",
      ],
    };
    const base: LayerReport = { id: this.id, label: this.label, status: "pending",
      provenance: prov, features: 0, bytes: 0, ms: 0, drawCalls: 0, triangles: 0 };
    if (!this.buildings.length) return { ...base, status: "empty" };

    const parapets: { p: XZ[]; base: number; top: number; color: THREE.Color; closed: boolean }[] = [];
    const tankAt: { x: number; y: number; z: number; s: number; kind: number }[] = [];
    const pcol = new THREE.Color(0xa79c8d);

    this.buildings.forEach((b, i) => {
      const ring = b.r as XZ[];
      if (ring.length < 3 || b.h < 6) return;
      // cheap footprint area via the shoelace, to skip small stock
      let a = 0;
      for (let k = 0; k < ring.length; k++) {
        const p0 = ring[k], p1 = ring[(k + 1) % ring.length];
        a += p0[0] * p1[1] - p1[0] * p0[1];
      }
      if (Math.abs(a / 2) < 120) return;

      const h = Math.max(b.h, 2);
      parapets.push({ p: insetRing(ring, 0.55), base: h, top: h + 0.75 + hash01(i, 3) * 0.35,
                      color: pcol, closed: true });

      // one or two tanks depending on roof size, placed at a hashed vertex direction
      const count = Math.abs(a / 2) > 900 ? 2 : 1;
      for (let t = 0; t < count; t++) {
        const [tx, tz] = ringPoint(ring, hash01(i, 11 + t));
        tankAt.push({ x: tx, y: h + 0.75, z: tz,
                      s: 0.85 + hash01(i, 17 + t) * 0.5,
                      kind: hash01(i, 23 + t) < 0.72 ? 0 : 1 });
      }
    });

    let tris = 0, dc = 0;
    if (parapets.length) {
      const built = wallStrips(parapets, false);
      const m = new THREE.Mesh(built.geometry, applyFacadeDetail(
        new THREE.MeshStandardMaterial({
          vertexColors: true, roughness: 0.86, metalness: 0, flatShading: true,
        }), { storeyM: 0.9, bayM: 3.0, strength: 0.35 }));
      m.castShadow = true; m.receiveShadow = true;
      m.name = "roof_parapets";
      this.group.add(m); this.meshes.push(m);
      tris += built.triangles; dc++;
    }

    if (tankAt.length) {
      // the ubiquitous black polymer tank, plus a squat grey one for variety
      const geo = new THREE.CylinderGeometry(1.0, 0.92, 1.5, 7, 1, false);
      // instanceColor alone: do NOT also set vertexColors here. Three defines USE_COLOR from
    // vertexColors and multiplies vColor by the geometry's `color` attribute — which this
    // geometry does not have, so WebGL supplies (0,0,0) and every instance renders black.
      this.tanks = new THREE.InstancedMesh(geo, new THREE.MeshStandardMaterial({
        roughness: 0.62, metalness: 0.02, flatShading: true,
      }), tankAt.length);
      const colors = new Float32Array(tankAt.length * 3);
      this.tanks.instanceColor = new THREE.InstancedBufferAttribute(colors, 3);
      const m4 = new THREE.Matrix4();
      const q = new THREE.Quaternion();
      const pos = new THREE.Vector3();
      const sc = new THREE.Vector3();
      const tint = new THREE.Color();
      tankAt.forEach((t, k) => {
        sc.set(t.s, t.s * (t.kind ? 0.7 : 1.05), t.s);
        pos.set(t.x, t.y + t.s * 0.7, t.z);
        m4.compose(pos, q, sc);
        this.tanks!.setMatrixAt(k, m4);
        tint.set(t.kind ? 0x8f9296 : 0x22262a);
        colors[k * 3] = tint.r; colors[k * 3 + 1] = tint.g; colors[k * 3 + 2] = tint.b;
      });
      this.tanks.instanceMatrix.needsUpdate = true;
      this.tanks.instanceColor.needsUpdate = true;
      this.tanks.castShadow = true;
      this.tanks.name = "roof_tanks";
      this.group.add(this.tanks);
      tris += tankAt.length * 28; dc++;
    }

    return { ...base, status: "ready", features: parapets.length + tankAt.length,
             drawCalls: dc, triangles: tris };
  }

  setVisible(v: boolean) { this.group.visible = v; }
  dispose() { this.meshes.forEach((m) => m.geometry.dispose()); this.tanks?.geometry.dispose(); }
}

/* ------------------------------------------------------------------ streetscape */
interface StreetscapePayload {
  footways: number; walls: number;
  provenance: Provenance;
  features: { footways: { p: XZ[]; k: string }[]; walls: { p: XZ[]; k: string; h: number }[] };
}

/** Footpaths and compound walls. The bungalow zone is defined by its boundary walls, and paths
 *  are how the parks actually read as parks rather than green polygons. */
export class StreetscapeLayer implements Layer {
  id = "streetscape"; label = "Paths & walls";
  constructor(private aoMap: THREE.Texture | null = null, private aoOrtho = 4096) {}
  group = new THREE.Group();
  private meshes: THREE.Mesh[] = [];

  async build(): Promise<LayerReport> {
    const base: LayerReport = { id: this.id, label: this.label, status: "pending",
      provenance: null, features: 0, bytes: 0, ms: 0, drawCalls: 0, triangles: 0 };
    const res = await load.grab<StreetscapePayload>("streetscape.json");
    if (!res.ok) return { ...base, status: "unavailable", error: res.error };

    const { footways, walls } = res.data.features;
    let tris = 0, dc = 0;

    if (footways.length) {
      const built = ribbons(footways.map((f) => ({
        p: f.p, width: f.k === "pedestrian" ? 6 : 2.4, y: 0.008,
        color: new THREE.Color(f.k === "pedestrian" ? 0xb8ad9b : 0xc0b6a6),
      })));
      let fwMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95 });
      if (this.aoMap) fwMat = applyBakedAO(fwMat, this.aoMap, this.aoOrtho, 0.8);
      const m = new THREE.Mesh(built.geometry, fwMat);
      m.receiveShadow = true; m.name = "footways";
      this.group.add(m); this.meshes.push(m);
      tris += built.triangles; dc++;
    }

    if (walls.length) {
      const built = wallStrips(walls.map((w) => ({
        p: w.p, base: 0, top: w.h,
        color: new THREE.Color(w.k === "hedge" ? 0x5f7a4a : w.k === "fence" ? 0x8b8478 : 0xb0a595),
        closed: false,
      })), true);
      const m = new THREE.Mesh(built.geometry, new THREE.MeshStandardMaterial({
        vertexColors: true, roughness: 0.9, flatShading: true,
      }));
      m.castShadow = true; m.receiveShadow = true; m.name = "walls";
      this.group.add(m); this.meshes.push(m);
      tris += built.triangles; dc++;
    }

    return { ...base, status: "ready", provenance: res.data.provenance,
             features: footways.length + walls.length, bytes: res.bytes, ms: res.ms,
             drawCalls: dc, triangles: tris };
  }

  setVisible(v: boolean) { this.group.visible = v; }
  dispose() { this.meshes.forEach((m) => m.geometry.dispose()); }
}

/* ------------------------------------------------------------------ building parts */
interface PartFeature { id: string; r: XZ[]; h: number; min: number; roof: string | null }

/** The 145 buildings whose contributors mapped real 3D volumes. These are stepped — a base block
 *  with a tower on top — which is exactly the detail a single extruded prism cannot express. */
export class BuildingPartsLayer implements Layer {
  id = "buildingparts"; label = "3D building parts";
  group = new THREE.Group();
  private mesh?: THREE.Mesh;

  async build(): Promise<LayerReport> {
    const base: LayerReport = { id: this.id, label: this.label, status: "pending",
      provenance: null, features: 0, bytes: 0, ms: 0, drawCalls: 0, triangles: 0 };
    const res = await load.grab<Payload<PartFeature[]> & { count: number }>("building-parts.json");
    if (!res.ok) return { ...base, status: "unavailable", error: res.error };
    const feats = res.data.features;
    if (!feats.length) return { ...base, status: "empty", provenance: res.data.provenance, bytes: res.bytes };

    // extrudeFootprints builds from y=0, so a part with a raised base is drawn full-height and
    // then lifted by its own min_height — the overlap is inside the parent building and unseen
    const built = extrudeFootprints(
      feats.map((f) => ({ r: f.r, h: Math.max(f.h - f.min, 1.5), m: 0 as 0 })),
      { colorFor: (_f, i) => new THREE.Color().setHSL(
          0.085, 0.10 + hash01(i, 5) * 0.10, 0.50 + hash01(i, 9) * 0.10, THREE.SRGBColorSpace) },
    );
    this.mesh = new THREE.Mesh(built.geometry, applyFacadeDetail(
      new THREE.MeshStandardMaterial({
        vertexColors: true, roughness: 0.7, metalness: 0, flatShading: true,
      })));
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.name = "building_parts";

    // parts share one geometry, so lift each by writing a per-vertex offset is not possible here;
    // instead the group holds one mesh per distinct base height, which in practice is a handful
    const byBase = new Map<number, PartFeature[]>();
    for (const f of feats) {
      const k = Math.round(f.min * 2) / 2;
      (byBase.get(k) ?? byBase.set(k, []).get(k)!).push(f);
    }
    this.group.remove(this.mesh);
    let tris = 0, dc = 0;
    for (const [baseH, group] of byBase) {
      const b = extrudeFootprints(
        group.map((f) => ({ r: f.r, h: Math.max(f.h - f.min, 1.5), m: 0 as 0 })),
        { colorFor: (_f, i) => new THREE.Color().setHSL(
            0.085, 0.10 + hash01(i, 5) * 0.10, 0.50 + hash01(i, 9) * 0.10, THREE.SRGBColorSpace) },
      );
      const m = new THREE.Mesh(b.geometry, applyFacadeDetail(
        new THREE.MeshStandardMaterial({
          vertexColors: true, roughness: 0.7, metalness: 0, flatShading: true,
        })));
      m.position.y = baseH;
      m.castShadow = true; m.receiveShadow = true;
      m.name = "building_parts";
      this.group.add(m);
      tris += b.triangles; dc++;
    }
    this.mesh = undefined;

    return { ...base, status: "ready", provenance: res.data.provenance,
             features: feats.length, bytes: res.bytes, ms: res.ms,
             drawCalls: dc, triangles: tris };
  }

  setVisible(v: boolean) { this.group.visible = v; }
  dispose() { this.group.traverse((o) => (o as THREE.Mesh).geometry?.dispose?.()); }
}
