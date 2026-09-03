import * as THREE from "three";
import type { Layer, LayerReport } from "./registry";
import { ribbons, type XZ } from "./geom";
import { PALETTE } from "./palette";
import * as load from "../geo/load";
import type { Station } from "../geo/types";

export class RailLayer implements Layer {
  id = "rail"; label = "Metro & rail";
  group = new THREE.Group();
  stations: Station[] = [];

  async build(): Promise<LayerReport> {
    const base: LayerReport = { id: this.id, label: this.label, status: "pending",
      provenance: null, features: 0, bytes: 0, ms: 0, drawCalls: 0, triangles: 0 };
    const res = await load.rail();
    if (!res.ok) return { ...base, status: "unavailable", error: res.error };

    const { lines, stations } = res.data.features;
    this.stations = stations;
    let tris = 0, dc = 0;
    if (lines.length) {
      const g = ribbons(lines.map((l) => ({
        p: l.p as XZ[], width: l.k === "subway" ? 4 : 6, y: 0.16,
        color: l.k === "subway" ? PALETTE.metro : PALETTE.rail,
      })));
      this.group.add(new THREE.Mesh(g.geometry, new THREE.MeshStandardMaterial({
        vertexColors: true, roughness: 0.7,
      })));
      tris += g.triangles; dc++;
    }
    if (stations.length) {
      const geo = new THREE.CylinderGeometry(9, 9, 3, 12);
      const inst = new THREE.InstancedMesh(geo, new THREE.MeshStandardMaterial({
        color: PALETTE.station, roughness: 0.5,
      }), stations.length);
      const m = new THREE.Matrix4();
      stations.forEach((s, i) => { m.makeTranslation(s.x, 1.6, s.z); inst.setMatrixAt(i, m); });
      inst.name = "stations";
      this.group.add(inst);
      tris += 12 * 4 * stations.length; dc++;
    }
    return { ...base, status: "ready", provenance: res.data.provenance,
             features: lines.length + stations.length, bytes: res.bytes, ms: res.ms,
             drawCalls: dc, triangles: tris };
  }
  setVisible(v: boolean) { this.group.visible = v; }
  dispose() { this.group.traverse((o) => (o as THREE.Mesh).geometry?.dispose?.()); }
}
