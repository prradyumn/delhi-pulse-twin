import * as THREE from "three";
import type { Layer, LayerReport } from "./registry";
import { mergeBoxes } from "./geom";
import { fetchLiveBuses, type LiveBusFeed, type LiveVehicle } from "../data/adapters/gtfsRealtime";
import type { Manifest, Provenance } from "../geo/types";

/**
 * Actual live DTC buses, when a key and proxy exist.
 *
 * This is the only layer in the product that can legitimately be called live, and it is therefore
 * the only one allowed to say so. Three states, all visible to the user:
 *
 *  - `unconfigured` — no proxy or no key. The designed resting state: the deterministic replay
 *    layer carries on and nothing claims to be live.
 *  - `live` / `stale` — real vehicle positions, with the feed's own timestamp and age shown.
 *  - `unavailable` — the proxy exists but the upstream failed. Reported, not hidden.
 *
 * When live positions arrive the replay layer is turned off, because showing both would put
 * invented buses next to real ones on the same street.
 */
export class LiveBusLayer implements Layer {
  id = "livebuses"; label = "Live buses";
  group = new THREE.Group();
  feed: LiveBusFeed | null = null;

  private inst?: THREE.InstancedMesh;
  private capacity = 400;
  private mLon = 0;
  private mLat = 0;
  private cLon = 0;
  private cLat = 0;

  /** false when the manifest does not list the adapter: build() then places nothing and reports
   *  `unconfigured` without touching the network. */
  readonly enabled: boolean;

  constructor(manifest: Manifest) {
    this.enabled = manifest.health.live_adapters.includes("otd_vehicle_positions");
    const [w, s, e, n] = manifest.study_area.bbox_wgs84;
    const [mw, mh] = manifest.study_area.measured_extent_m;
    // Derived from the pipeline's own measured extent rather than a fresh projection, so a live
    // bus lands in the same frame as everything else. Over a 4 km box the difference from full
    // UTM is sub-metre — smaller than a bus.
    this.mLon = mw / (e - w);
    this.mLat = mh / (n - s);
    this.cLon = (w + e) / 2;
    this.cLat = (s + n) / 2;
  }

  private toLocal(lat: number, lon: number): [number, number] {
    return [(lon - this.cLon) * this.mLon, -(lat - this.cLat) * this.mLat];
  }

  async build(): Promise<LayerReport> {
    const base: LayerReport = { id: this.id, label: this.label, status: "pending",
      provenance: null, features: 0, bytes: 0, ms: 0, drawCalls: 0, triangles: 0 };

    // a slightly taller, brighter body than the replay bus, so a real vehicle is never mistaken
    // for a simulated one
    const body = new THREE.BoxGeometry(11.4, 2.4, 3.0);
    body.translate(0, 1.4, 0);
    const glazing = new THREE.BoxGeometry(9.8, 1.0, 3.06);
    glazing.translate(-0.2, 2.45, 0);
    const beacon = new THREE.BoxGeometry(1.6, 0.5, 1.6);
    beacon.translate(0, 3.1, 0);

    this.inst = new THREE.InstancedMesh(
      mergeBoxes([body, glazing, beacon]),
      new THREE.MeshStandardMaterial({
        color: 0x4fd08a, emissive: 0x1d5c3a, roughness: 0.4, metalness: 0.1, flatShading: true,
      }),
      this.capacity);
    this.inst.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.inst.frustumCulled = false;
    // see traffic.ts: moving casters would defeat the on-demand shadow map
    this.inst.castShadow = false;
    this.inst.count = 0;
    this.inst.name = "live_buses";
    this.group.add(this.inst);

    const f = this.enabled
      ? await fetchLiveBuses()
      : { state: "unconfigured" as const, vehicles: [], feedTime: null, ageSeconds: null,
          inBox: 0, provider: "Delhi Open Transit Data — GTFS-Realtime VehiclePositions",
          coverage: { speed: 0, bearing: 0, stopStatus: 0, stopId: 0,
                      occupancy: 0, congestion: 0, routeId: 0, startTime: 0 },
          error: "This build does not list otd_vehicle_positions in manifest.health.live_adapters, so no request was made." };
    this.feed = f;
    this.place(f.vehicles);

    return {
      ...base,
      status: f.state === "unconfigured" ? "empty"
            : f.state === "unavailable" ? "unavailable" : "ready",
      features: f.inBox,
      error: f.state === "unavailable" ? (f.error ?? "upstream failed") : undefined,
      drawCalls: 1, triangles: this.capacity * 36,
      provenance: this.provenance(f),
    };
  }

  /**
   * What THIS feed actually carries, counted from the response rather than read off the spec.
   *
   * GTFS-Realtime makes almost everything optional, so "the spec supports occupancy" is worth
   * nothing to a user; "84% of vehicles in this response reported occupancy" is worth something.
   * The distinction matters here because several planned features — observed headway from arrival
   * events, occupancy, the operator's own congestion assessment — each depend on a field the
   * operator may simply not populate, and the honest thing is to report which are present before
   * building a number on top of them.
   */
  provenance(f: LiveBusFeed): Provenance {
    const limitations: string[] = [];
    if (f.state === "unconfigured") {
      limitations.push(
        "NOT CONFIGURED. No OTD API key or proxy is present, so no live position is being shown "
        + "and nothing in this scene is claiming to be one. The bus replay layer continues to run.",
        "Setting this up needs a key from otd.delhi.gov.in and OTD_API_KEY on the deployment. See docs/08-LIVE-DATA.md.");
    } else {
      limitations.push(
        f.state === "stale"
          ? `Feed is ${Math.round((f.ageSeconds ?? 0))} s old and is reported stale, not live.`
          : `Live vehicle positions, feed timestamp ${f.feedTime ? new Date(f.feedTime * 1000).toISOString() : "unknown"}.`,
        f.vehicles.length === 0
          ? "The feed is connected and reporting ZERO vehicles. That is a real answer, not a "
            + "failure: outside service hours the operator publishes an empty feed. Verified "
            + "against the live endpoint at 23:55 IST, which returned a valid 2-second-old header "
            + "with no entities. The bus replay layer keeps running and stays labelled as replay."
          : `${f.vehicles.length} vehicles in the feed; ${f.inBox} inside the study box. Only those inside can be placed.`,
        "Positions are the operator's own reported GPS. Accuracy, update interval and coverage are the operator's, not this app's.",
        "A vehicle absent from the feed is not evidence that no bus is running — it may simply not be reporting.",
        fieldCoverageNote(f));
    }
    return {
      provider: "Delhi Open Transit Data (OTD), Government of NCT of Delhi",
      dataset: "GTFS-Realtime VehiclePositions for Delhi Transport Corporation buses",
      license: "Delhi OTD terms; access requires a registered API key",
      attribution: "Live bus positions © Delhi Open Transit Data",
      retrieved_at: new Date().toISOString(),
      source_time: f.feedTime ? new Date(f.feedTime * 1000).toISOString() : null,
      refresh_cadence: "feed updates every ~10 s; this app polls every 20 s",
      bounds: [77.1975, 28.6039, 77.2385, 28.6401],
      crs: "WGS84 from the feed, placed via the study-area local transform",
      mode: "observed",
      transform_version: "0.1.0",
      limitations,
    };
  }

  private place(vehicles: LiveVehicle[]) {
    if (!this.inst) return;
    const m = new THREE.Matrix4();
    const up = new THREE.Vector3(0, 1, 0);
    const fwd = new THREE.Vector3();
    const side = new THREE.Vector3();
    let n = 0;
    for (const v of vehicles) {
      if (n >= this.capacity) break;
      const [x, z] = this.toLocal(v.lat, v.lon);
      if (Math.abs(x) > 2100 || Math.abs(z) > 2200) continue;
      // bearing is compass degrees clockwise from north; +Z is south in this scene
      const rad = ((v.bearing ?? 0) * Math.PI) / 180;
      fwd.set(Math.sin(rad), 0, -Math.cos(rad));
      if (fwd.lengthSq() < 1e-6) fwd.set(1, 0, 0);
      side.crossVectors(fwd, up);
      m.makeBasis(fwd, up, side);
      m.setPosition(x, 0, z);
      this.inst.setMatrixAt(n++, m);
    }
    this.inst.count = n;
    this.inst.instanceMatrix.needsUpdate = true;
  }

  /** Re-poll. Returns the feed so the caller can update status and decide about replay. */
  async refresh(): Promise<LiveBusFeed> {
    const f = this.enabled
      ? await fetchLiveBuses()
      : { state: "unconfigured" as const, vehicles: [], feedTime: null, ageSeconds: null,
          inBox: 0, provider: "Delhi Open Transit Data — GTFS-Realtime VehiclePositions",
          coverage: { speed: 0, bearing: 0, stopStatus: 0, stopId: 0,
                      occupancy: 0, congestion: 0, routeId: 0, startTime: 0 },
          error: "This build does not list otd_vehicle_positions in manifest.health.live_adapters, so no request was made." };
    this.feed = f;
    this.place(f.vehicles);
    return f;
  }

  hasLive() { return this.feed?.state === "live" || this.feed?.state === "stale"; }
  liveCount() { return this.inst?.count ?? 0; }
  setVisible(v: boolean) { this.group.visible = v; }
  dispose() { this.inst?.geometry.dispose(); }
}


/** Free function so the provenance builder and the data-status panel can share one wording. */
export function fieldCoverageNote(f: LiveBusFeed): string {
  const n = f.vehicles.length;
  if (!n) {
    return "Field coverage cannot be assessed from an empty feed. The optional GTFS-Realtime "
         + "fields this app can use — speed, stop status, stop id, occupancy, congestion level — "
         + "are each reported only if the operator populates them, and that is measured from a "
         + "real response rather than assumed.";
  }
  const pct = (k: number) => `${Math.round((k / n) * 100)}%`;
  const c = f.coverage;
  const have: string[] = [];
  const missing: string[] = [];
  const put = (label: string, k: number) => (k > 0 ? have : missing).push(
    k > 0 ? `${label} ${pct(k)}` : label);
  put("route id", c.routeId);
  put("speed", c.speed);
  put("bearing", c.bearing);
  put("stop status", c.stopStatus);
  put("stop id", c.stopId);
  put("occupancy", c.occupancy);
  put("congestion level", c.congestion);
  put("scheduled start", c.startTime);
  const parts = [`Measured field coverage over ${n} vehicles in this response: ${have.join(", ") || "none"}.`];
  if (missing.length) {
    parts.push(`Not populated by this feed: ${missing.join(", ")} — so nothing here is derived from them.`);
  }
  return parts.join(" ");
}
