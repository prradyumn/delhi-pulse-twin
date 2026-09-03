import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import type { Layer, LayerReport } from "./registry";
import { extrudeFootprints, fills, type XZ } from "./geom";
import { applyFacadeDetail } from "./facade";
import * as load from "../geo/load";
import type { Payload, Provenance } from "../geo/types";

/** Written by blender/scripts/20_landmark_export.py. `source` is the honesty-critical field:
 *  a GLB loading successfully says nothing about whether anyone modelled it. */
interface LandmarkIndex {
  generated_at: string;
  landmarks: Record<string, {
    /** blend = hand-modelled; parametric = scripted reconstruction of characteristic form;
     *  placeholder = plain massing extruded from the footprint; open_ground = not a building */
    source: "blend" | "parametric" | "placeholder" | "open_ground";
    lods: number[]; height_m: number | null; required: boolean;
  }>;
}

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
 * deliberately undetailed. Where the Phase 4 sprint has produced a model — parametric or
 * hand-authored — it replaces the block, and the layer reports which of the three it got. A
 * missing GLB is a normal state, not an error.
 */
export class LandmarkLayer implements Layer {
  id = "landmarks"; label = "Landmarks";
  group = new THREE.Group();
  features: LandmarkFeature[] = [];
  authored: string[] = [];
  parametric: string[] = [];
  private loadedGlb: string[] = [];
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
    //
    // No HEAD probe: some static servers (Vite's own preview among them) answer HEAD with a 404
    // for files they will happily GET, which meant no GLB ever loaded. And `kind: open` landmarks
    // are skipped outright — there is no model to look for, and probing logged two 404s per load
    // that read like failures when they are the designed behaviour.
    const idxRes = await load.grab<LandmarkIndex>("landmarks/index.json");
    const index = idxRes.ok ? idxRes.data.landmarks : {};

    const loader = new GLTFLoader();
    const pending = this.features.map(async (f) => {
      if (f.kind === "open") return null;
      const entry = index[f.id];
      if (entry && !entry.lods.includes(0)) return null;
      const url = `${load.DATA}/landmarks/${f.id}_lod0.glb`;
      try {
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
    for (const { f, obj } of loaded) { this.group.add(obj); this.loadedGlb.push(f.id); }
    // A GLB that loaded is not a modelled landmark. Only the exporter knows which is which.
    this.authored = this.loadedGlb.filter((id) => index[id]?.source === "blend");
    this.parametric = this.loadedGlb.filter((id) => index[id]?.source === "parametric");

    let tris = 0, dc = loaded.length;
    const remaining = this.features.filter((f) => !this.loadedGlb.includes(f.id));

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

    // Three distinct honesty states, and the difference between them is a different claim: a
    // hand-modelled landmark, a scripted reconstruction of characteristic form, and a bare
    // extruded footprint are not the same thing. Anything that is neither authored nor parametric
    // is still a plain block, however it arrived.
    const named = (ids: string[]) =>
      this.features.filter((f) => ids.includes(f.id)).map((f) => f.name);
    const placeholders = this.features
      .filter((f) => f.kind !== "open"
                     && !this.authored.includes(f.id)
                     && !this.parametric.includes(f.id))
      .map((f) => f.name);
    return {
      ...base, status: "ready", features: this.features.length,
      bytes: res.bytes, ms: res.ms, drawCalls: dc, triangles: tris,
      provenance: this.prov
        ? { ...this.prov, limitations: [
            ...this.prov.limitations,
            this.parametric.length
              ? `${this.parametric.length} landmark(s) are PARAMETRIC reconstructions — the characteristic form (arch, colonnade, dome) built on the real OSM footprint and height. Recognisable silhouettes, not surveys: no measured drawings or photogrammetry were used, and the ornament of the real buildings is not attempted. ${named(this.parametric).join(", ")}.`
              : "",
            placeholders.length
              ? `${placeholders.length} landmark(s) render as untextured massing extruded from the real footprint — correctly placed and scaled, but not modelled: ${placeholders.join(", ")}.`
              : "",
            this.authored.length
              ? `${this.authored.length} landmark(s) use hand-modelled geometry: ${named(this.authored).join(", ")}.`
              : "",
          ].filter(Boolean) }
        : null,
    };
  }

  setVisible(v: boolean) { this.group.visible = v; }
  dispose() { this.massing?.geometry.dispose(); this.plazas?.geometry.dispose(); }
}
