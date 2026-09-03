import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import type { Layer, LayerReport } from "./registry";
import { extrudeFootprints, fills, type XZ } from "./geom";
import { applyFacadeDetail } from "./facade";
import * as load from "../geo/load";
import type { Payload, Provenance } from "../geo/types";

export interface LandmarkFeature {
  id: string; osm: string; name: string; required: boolean;
  ring: XZ[]; centroid: [number, number]; area_m2: number;
  height_m: number | null; height_mode: "observed" | "estimated";
  /** massing extrudes the footprint; open is ground, and extruding it would be a lie */
  kind: "massing" | "open";
  serves: string | null; note: string | null;
}

/**
 * Progressive enhancement, in the honest direction. Every landmark renders immediately as a
 * massing block extruded from its verified OSM footprint — correct position, correct scale,
 * deliberately undetailed. Where the Phase 4 modelling sprint has produced an authored GLB, it
 * replaces the block. A missing GLB is a normal state, not an error.
 */
export class LandmarkLayer implements Layer {
  id = "landmarks"; label = "Landmarks";
  group = new THREE.Group();
  features: LandmarkFeature[] = [];
  authored: string[] = [];
  private massing?: THREE.Mesh;
  private plazas?: THREE.Mesh;
  private prov: Provenance | null = null;

  async build(): Promise<LayerReport> {
    const base: LayerReport = { id: this.id, label: this.label, status: "pending",
      provenance: null, features: 0, bytes: 0, ms: 0, drawCalls: 0, triangles: 0 };
    const res = await load.grab<Payload<LandmarkFeature[]> & { count: number }>("landmarks.json");
    if (!res.ok) return { ...base, status: "unavailable", error: res.error };

    this.features = res.data.features;
    this.prov = res.data.provenance;
    if (!this.features.length) return { ...base, status: "empty", provenance: this.prov, bytes: res.bytes };

    // Authored GLBs first; anything without one falls through to massing.
    const loader = new GLTFLoader();
    const pending = this.features.map(async (f) => {
      const url = `${load.DATA}/landmarks/${f.id}_lod0.glb`;
      try {
        const head = await fetch(url, { method: "HEAD" });
        if (!head.ok) return null;
        const gltf = await loader.loadAsync(url);
        gltf.scene.position.set(f.centroid[0], 0, f.centroid[1]);
        gltf.scene.name = `landmark_${f.id}`;
        gltf.scene.traverse((o) => {
          const m = o as THREE.Mesh;
          if (m.isMesh) { m.castShadow = true; m.receiveShadow = true; }
        });
        return { f, obj: gltf.scene };
      } catch {
        return null;
      }
    });
    const loaded = (await Promise.all(pending)).filter((x): x is { f: LandmarkFeature; obj: THREE.Group } => x !== null);
    for (const { f, obj } of loaded) { this.group.add(obj); this.authored.push(f.id); }

    let tris = 0, dc = loaded.length;
    const remaining = this.features.filter((f) => !this.authored.includes(f.id));

    // Only kind=massing may be extruded. Rajiv Chowk Central Park is 41,408 m² of open ground and
    // Jantar Mantar's footprint is its walled enclosure, not the instruments — extruding either
    // would put a twelve-metre slab over the most recognisable place in the box.
    const blocks = remaining.filter((f) => f.kind === "massing");
    if (blocks.length) {
      const built = extrudeFootprints(
        blocks.map((f) => ({ r: f.ring, h: f.height_m ?? 12,
                             m: (f.height_mode === "observed" ? 0 : 1) as 0 | 1 })),
        { colorFor: () => new THREE.Color(0xb59f86) },
      );
      this.massing = new THREE.Mesh(built.geometry, applyFacadeDetail(
        new THREE.MeshStandardMaterial({
          vertexColors: true, roughness: 0.66, metalness: 0, flatShading: true,
        }), { storeyM: 4.6, bayM: 5.4 }));
      this.massing.castShadow = true;
      this.massing.receiveShadow = true;
      this.massing.name = "landmark_massing";
      this.group.add(this.massing);
      tris += built.triangles; dc++;
    }

    const open = remaining.filter((f) => f.kind === "open");
    if (open.length) {
      // A paved plaza tone just above the ground band, so the site reads as a place without
      // pretending to be a building. See docs/07-RENDER-CORRECTNESS.md rule 5 for the y budget.
      const built = fills(open.map((f) => ({ r: f.ring, y: -0.1, color: new THREE.Color(0xc7bda6) })));
      this.plazas = new THREE.Mesh(built.geometry, new THREE.MeshStandardMaterial({
        vertexColors: true, roughness: 0.88, metalness: 0,
      }));
      this.plazas.receiveShadow = true;
      this.plazas.name = "landmark_plazas";
      this.group.add(this.plazas);
      tris += built.triangles; dc++;
    }

    const placeholders = blocks.map((f) => f.name);
    return {
      ...base, status: "ready", features: this.features.length,
      bytes: res.bytes, ms: res.ms, drawCalls: dc, triangles: tris,
      provenance: this.prov
        ? { ...this.prov, limitations: [
            ...this.prov.limitations,
            placeholders.length
              ? `${placeholders.length} landmark(s) still render as untextured massing blocks pending the modelling sprint: ${placeholders.join(", ")}.`
              : "All landmarks use authored models.",
          ] }
        : null,
    };
  }

  setVisible(v: boolean) { this.group.visible = v; }
  dispose() { this.massing?.geometry.dispose(); this.plazas?.geometry.dispose(); }
}
