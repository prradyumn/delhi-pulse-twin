import * as THREE from "three";
import type { Layer, LayerReport } from "./registry";
import { PALETTE } from "./palette";
import * as load from "../geo/load";
import type { Stop, BusRoute } from "../geo/types";

export class TransitLayer implements Layer {
  id = "transit"; label = "Bus stops & routes";
  group = new THREE.Group();
  stops: Stop[] = [];
  routes: BusRoute[] = [];
  private inst?: THREE.InstancedMesh;

  async build(): Promise<LayerReport> {
    const base: LayerReport = { id: this.id, label: this.label, status: "pending",
      provenance: null, features: 0, bytes: 0, ms: 0, drawCalls: 0, triangles: 0 };
    const res = await load.transit();
    if (!res.ok) return { ...base, status: "unavailable", error: res.error };

    this.stops = res.data.features.stops;
    this.routes = res.data.features.routes;

    const geo = new THREE.CylinderGeometry(3.2, 3.2, 7, 8);
    this.inst = new THREE.InstancedMesh(geo, new THREE.MeshStandardMaterial({
      color: PALETTE.stop, roughness: 0.6,
    }), this.stops.length);
    const m = new THREE.Matrix4();
    this.stops.forEach((s, i) => { m.makeTranslation(s.x, 3.5, s.z); this.inst!.setMatrixAt(i, m); });
    this.inst.name = "stops";
    this.group.add(this.inst);

    return { ...base, status: "ready", provenance: res.data.provenance,
             features: this.stops.length, bytes: res.bytes, ms: res.ms,
             drawCalls: 1, triangles: 8 * 4 * this.stops.length };
  }

  stopAtInstance(i: number): Stop | null { return this.stops[i] ?? null; }
  setVisible(v: boolean) { this.group.visible = v; }
  dispose() { this.inst?.geometry.dispose(); }
}
