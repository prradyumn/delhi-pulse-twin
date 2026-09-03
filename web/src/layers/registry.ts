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


/**
 * Detail that is only worth drawing from near the ground.
 *
 * MEASURED, back to back inside one browser session at a parked wide camera: rooftop detail cost
 * 10.6 ms of GPU time for 129,474 triangles, and street furniture 4.4 ms for 139,380 — against
 * 2.6 ms for 520,800 triangles of trees. The ratio is the whole point. Thousands of objects one or
 * two pixels tall are the worst case a rasteriser has: each triangle wastes most of its 2x2 quad,
 * each instance still pays full vertex and shader cost, and none of it resolves into anything a
 * viewer can see.
 *
 * So these layers declare the height below which they are worth drawing, and the frame loop tells
 * them where the camera is. The gate is on camera *height* rather than distance because this is an
 * orbit camera over a flat 4 km box, so height is the scale.
 *
 * It is a LOD decision, not a data one: nothing is dropped from a report, a count or a provenance
 * record, and every layer stays listed with its real feature count.
 *
 * **The thresholds are set relative to the default camera, which sits at 900 m.** That view is the
 * first thing anyone sees and it has to look its best, so every gate that reads at that scale must
 * be open there. The first version put the rooftop gate at exactly 900 m and silently stripped the
 * roofscape out of the hero view — the saving was real and the trade was wrong. The ladder now is:
 *
 *   street furniture   < 420 m    lamp posts and shelters: street-level only
 *   people on paths    < 950 m    open at the default view, closed beyond it
 *   rooftop detail     < 1200 m   parapets and tanks still read as texture at 900 m
 *
 * The wide budget camera sits at 1400 m, further out than the default, so it drops all three.
 */
export class AltitudeGate {
  private wanted = true;
  private inRange = true;

  constructor(private group: THREE.Group, readonly visibleBelowM: number) {}

  setCameraHeight(y: number) {
    const near = y < this.visibleBelowM;
    if (near === this.inRange) return false;
    this.inRange = near;
    this.group.visible = this.wanted && near;
    return true;
  }

  setVisible(v: boolean) { this.wanted = v; this.group.visible = v && this.inRange; }
  get visible() { return this.group.visible; }
}
