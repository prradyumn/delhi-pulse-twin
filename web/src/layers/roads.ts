import * as THREE from "three";
import type { Layer, LayerReport } from "./registry";
import { ribbons, repaint, type XZ } from "./geom";
import { PALETTE } from "./palette";
import { applyStreetLighting, applyBakedAO } from "./facade";
import * as load from "../geo/load";
import type { Road } from "../geo/types";

const WIDTH: Record<string, number> = {
  motorway: 22, trunk: 20, primary: 17, secondary: 14, tertiary: 11,
  residential: 7, unclassified: 7, service: 5,
};

export class RoadsLayer implements Layer {
  id = "roads"; label = "Roads";
  constructor(private aoMap: THREE.Texture | null = null, private aoOrtho = 4096) {}
  group = new THREE.Group();
  roads: Road[] = [];
  private mesh?: THREE.Mesh;
  private vfeat: Uint32Array = new Uint32Array(0);

  async build(): Promise<LayerReport> {
    const base: LayerReport = { id: this.id, label: this.label, status: "pending",
      provenance: null, features: 0, bytes: 0, ms: 0, drawCalls: 0, triangles: 0 };
    const res = await load.roads();
    if (!res.ok) return { ...base, status: "unavailable", error: res.error };

    this.roads = res.data.features;

    // A kerb casing under each carriageway: a slightly wider, darker ribbon. This is the single
    // cheapest thing that stops a road network reading as coloured tape on a plane — it gives
    // every street an edge and makes junctions legible.
    const casing = ribbons(this.roads.map((r) => {
      const w = WIDTH[r.k] ?? 8;
      return { p: r.p as XZ[], width: w + 3.4,
               y: 0.012 + w * 0.002,
               color: (PALETTE.road[r.k] ?? PALETTE.road.service).clone().multiplyScalar(0.66) };
    }));
    let kerbMat = new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 0.95, metalness: 0,
    });
    if (this.aoMap) kerbMat = applyBakedAO(kerbMat, this.aoMap, this.aoOrtho, 0.65);
    const kerb = new THREE.Mesh(casing.geometry, kerbMat);
    kerb.receiveShadow = true;
    kerb.name = "road_casing";
    this.group.add(kerb);

    const built = ribbons(this.roads.map((r) => ({
      p: r.p as XZ[],
      width: WIDTH[r.k] ?? 8,
      // stack by class so a primary reads over a service road at a junction
      y: 0.03 + (WIDTH[r.k] ?? 8) * 0.002,
      color: PALETTE.road[r.k] ?? PALETTE.road.service,
    })));
    this.vfeat = built.vertexFeature;
    let roadMat = applyStreetLighting(
      new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.82, metalness: 0 }));
    if (this.aoMap) roadMat = applyBakedAO(roadMat, this.aoMap, this.aoOrtho, 0.55);
    this.mesh = new THREE.Mesh(built.geometry, roadMat);
    this.mesh.receiveShadow = true;
    this.mesh.name = "roads";
    this.group.add(this.mesh);

    return { ...base, status: "ready", provenance: res.data.provenance,
             features: this.roads.length, bytes: res.bytes, ms: res.ms,
             drawCalls: 2, triangles: built.triangles + casing.triangles };
  }

  /** Roads are runtime geometry so that colour stays data. Repaint on traffic/corridor change. */
  paint(colorFor: (r: Road, i: number) => THREE.Color | null) {
    if (!this.mesh) return;
    repaint(this.mesh.geometry, this.vfeat, (fi) => colorFor(this.roads[fi], fi));
  }

  roadAtVertex(v: number): Road | null { return this.roads[this.vfeat[v]] ?? null; }
  setVisible(v: boolean) { this.group.visible = v; }
  dispose() { this.mesh?.geometry.dispose(); }
}
