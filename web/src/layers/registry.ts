import * as THREE from "three";
import type { Provenance } from "../geo/types";

export type LayerStatus = "pending" | "ready" | "unavailable" | "empty";

export interface LayerReport {
  id: string; label: string; status: LayerStatus;
  provenance: Provenance | null;
  features: number; bytes: number; ms: number;
  drawCalls: number; triangles: number;
  error?: string;
}

export interface Layer {
  id: string;
  label: string;
  /** Resolve the layer's own data and build its objects. Must never throw: a failure is a
   *  reported status, because FR-01 requires missing layers to fail independently. */
  build(): Promise<LayerReport>;
  group: THREE.Group;
  setVisible(v: boolean): void;
  dispose(): void;
}

export class LayerRegistry {
  readonly layers = new Map<string, Layer>();
  readonly reports = new Map<string, LayerReport>();

  constructor(private root: THREE.Object3D) {}

  add(l: Layer) {
    this.layers.set(l.id, l);
    this.root.add(l.group);
    this.reports.set(l.id, { id: l.id, label: l.label, status: "pending", provenance: null,
                             features: 0, bytes: 0, ms: 0, drawCalls: 0, triangles: 0 });
    return this;
  }

  /** Build every layer in parallel; one rejection cannot take the scene with it. */
  async buildAll(onProgress?: (r: LayerReport) => void) {
    await Promise.all([...this.layers.values()].map(async (l) => {
      let r: LayerReport;
      try {
        r = await l.build();
      } catch (e) {
        r = { id: l.id, label: l.label, status: "unavailable", provenance: null,
              features: 0, bytes: 0, ms: 0, drawCalls: 0, triangles: 0,
              error: e instanceof Error ? e.message : String(e) };
      }
      this.reports.set(l.id, r);
      onProgress?.(r);
    }));
    return [...this.reports.values()];
  }

  setVisible(id: string, v: boolean) { this.layers.get(id)?.setVisible(v); }
  totals() {
    let dc = 0, tri = 0, bytes = 0;
    for (const r of this.reports.values()) { dc += r.drawCalls; tri += r.triangles; bytes += r.bytes; }
    return { drawCalls: dc, triangles: tri, bytes };
  }
}
