import * as THREE from "three";
import type { Layer, LayerReport } from "./registry";
import type { Provenance } from "../geo/types";
import { ribbons } from "./geom";
import type { Route } from "../analysis/network";

/**
 * The two routes, drawn on top of the city.
 *
 * Deliberately the same treatment as the reach field: depth test off, so these read as lines on a
 * map rather than as tape stuck to the pavement between buildings. A route you cannot see behind a
 * building is not a route you can follow.
 *
 * Colour carries the meaning and nothing else does: amber is the quickest way, green is the least
 * you can breathe. They are drawn at different widths and heights so that where the two routes
 * agree — which is most of the time, and is itself the honest headline — you can still see that
 * both are there.
 */
export const ROUTE_COLOUR = { time: "#f2a63b", dose: "#5fce8a" };

export class RouteLayer implements Layer {
  id = "routes"; label = "Walking routes";
  group = new THREE.Group();
  private drawn: THREE.Mesh[] = [];

  async build(): Promise<LayerReport> {
    const prov: Provenance = {
      provider: "Derived (this prototype)",
      dataset: "Shortest walking paths over the OSM pedestrian network, by time and by modelled inhaled dose",
      license: "Derived from OSM geometry, ODbL 1.0",
      attribution: "© OpenStreetMap contributors — road and footway geometry",
      retrieved_at: "2026-09-03", source_time: null,
      refresh_cadence: "recomputed on demand, deterministic",
      bounds: [77.1975, 28.6039, 77.2385, 28.6401], crs: "EPSG:32643 + local origin",
      mode: "estimated", transform_version: "0.1.0",
      limitations: [
        "The quickest route is a shortest path on observed OSM geometry at a declared 4.8 km/h, with no crossing or signal delay charged. Real walking times will be longer, and longer by more on the route that crosses more main roads.",
        "The cleanest route minimises time × kerbside enrichment. The enrichment is a DECLARED geometric heuristic — a near-road gradient decaying with a 45 m length scale, scaled by road class as a proxy for traffic volume. It is not a pollution measurement and cannot be: there is one modelled concentration for the entire 16 km² box.",
        "Because concentration is uniform in the model, only the RATIO between the two routes is meaningful. The absolute microgram figures inherit every limitation of the air reading they are built on.",
        "Road class stands in for traffic volume because no vehicle counts are available for these streets. A quiet secondary road and a jammed one are treated identically.",
        "Nothing here knows about shade, surface, lighting, crowding or safety, all of which a person choosing a route at 21:00 would weigh above a 12% difference in particulate.",
      ],
    };
    return { id: this.id, label: this.label, status: "ready", provenance: prov,
             features: 0, bytes: 0, ms: 0, drawCalls: 0, triangles: 0 };
  }

  setRoutes(routes: { route: Route; kind: "time" | "dose" }[]) {
    this.clear();
    // the cleanest route goes down first and wider, so an overlapping quickest route sits inside
    // it and both remain visible where they agree
    const order = [...routes].sort((a) => (a.kind === "dose" ? -1 : 1));
    for (const [i, r] of order.entries()) {
      const wide = r.kind === "dose";
      const built = ribbons([{
        p: r.route.path, width: wide ? 9 : 4.5, y: 0.5 + i * 0.05,
        color: new THREE.Color(ROUTE_COLOUR[r.kind]),
      }]);
      const mesh = new THREE.Mesh(built.geometry, new THREE.MeshBasicMaterial({
        vertexColors: true, transparent: true, opacity: wide ? 0.85 : 0.95,
        depthTest: false, depthWrite: false, toneMapped: false, side: THREE.DoubleSide,
      }));
      mesh.renderOrder = 950 + i;
      mesh.frustumCulled = false;
      mesh.name = `route_${r.kind}`;
      this.group.add(mesh);
      this.drawn.push(mesh);
    }
    this.group.visible = routes.length > 0;
  }

  clear() {
    for (const m of this.drawn) {
      this.group.remove(m);
      m.geometry.dispose();
      (m.material as THREE.Material).dispose();
    }
    this.drawn = [];
    this.group.visible = false;
  }

  setVisible(v: boolean) { this.group.visible = v && this.drawn.length > 0; }
  dispose() { this.clear(); }
}
