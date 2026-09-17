/**
 * Delhi OTD GTFS-Realtime vehicle positions — actual live buses.
 *
 * Two things make this different from the Open-Meteo adapter, and both were predicted by
 * `docs/02-ARCHITECTURE.md` before either existed:
 *
 * 1. **It needs a key**, and the NFR says secrets stay server-side. So the browser never sees the
 *    key: it calls our own `/api/vehicles`, which is the Vercel function in `web/api/vehicles.ts`.
 * 2. **It would be CORS-blocked anyway.** `otd.delhi.gov.in` sends no CORS headers, so a direct
 *    browser fetch cannot work regardless of the key. The proxy is not optional.
 *
 * Until the proxy is configured this adapter reports `unconfigured` and the app runs on the
 * deterministic replay, exactly as it does today. That is the scope lock: live positions are an
 * upgrade to a scene that already stands on its own.
 *
 * The protobuf is decoded by hand below rather than pulling in `gtfs-realtime-bindings` plus
 * `protobufjs`. A dozen fields do not justify two dependencies in a project whose whole argument
 * is that it runs from bundled data.
 *
 * **Why more than a dot on a map.** The first version read six fields — enough to place a marker.
 * But position is the least interesting thing in this feed. `current_status` plus `stop_id` plus
 * `timestamp` gives real arrival events at real stops, which is an OBSERVED headway, which is the
 * assumption the whole exposure model currently rests on (`assumed_headway_min`, and a wait proxy
 * of half of it). `speed` gives an observed traffic speed on a corridor whose colour is presently
 * a declared time-of-day heuristic. `occupancy_status` answers "will I get on". Each of those
 * converts a number this app currently labels *estimated* into one it can label *observed*, which
 * is worth far more than a smoother marker.
 *
 * Which of the optional fields Delhi actually populates is a measurement, not a spec question, so
 * `pipeline/record_vehicles.py` counts them and writes a coverage report. Nothing here assumes a
 * field is present.
 *
 * Deliberately NOT read: `license_plate` (VehicleDescriptor field 3). Buses are public vehicles
 * and it is in the feed, but it is a registration number tied to a physical asset, it buys this
 * project nothing, and reading it would put it in the browser.
 */

export type LiveBusState = "unconfigured" | "live" | "stale" | "unavailable";

/** gtfs-realtime.proto VehicleStopStatus */
export type StopStatus = "INCOMING_AT" | "STOPPED_AT" | "IN_TRANSIT_TO";
/** gtfs-realtime.proto CongestionLevel */
export type CongestionLevel =
  "UNKNOWN_CONGESTION_LEVEL" | "RUNNING_SMOOTHLY" | "STOP_AND_GO" | "CONGESTION" | "SEVERE_CONGESTION";
/** gtfs-realtime.proto OccupancyStatus */
export type OccupancyStatus =
  "EMPTY" | "MANY_SEATS_AVAILABLE" | "FEW_SEATS_AVAILABLE" | "STANDING_ROOM_ONLY"
  | "CRUSHED_STANDING_ROOM_ONLY" | "FULL" | "NOT_ACCEPTING_PASSENGERS" | "NO_DATA_AVAILABLE"
  | "NOT_BOARDABLE";

const STOP_STATUS: Record<number, StopStatus> =
  { 0: "INCOMING_AT", 1: "STOPPED_AT", 2: "IN_TRANSIT_TO" };
const CONGESTION: Record<number, CongestionLevel> =
  { 0: "UNKNOWN_CONGESTION_LEVEL", 1: "RUNNING_SMOOTHLY", 2: "STOP_AND_GO",
    3: "CONGESTION", 4: "SEVERE_CONGESTION" };
const OCCUPANCY: Record<number, OccupancyStatus> =
  { 0: "EMPTY", 1: "MANY_SEATS_AVAILABLE", 2: "FEW_SEATS_AVAILABLE", 3: "STANDING_ROOM_ONLY",
    4: "CRUSHED_STANDING_ROOM_ONLY", 5: "FULL", 6: "NOT_ACCEPTING_PASSENGERS",
    7: "NO_DATA_AVAILABLE", 8: "NOT_BOARDABLE" };

export interface LiveVehicle {
  id: string;
  label: string | null;
  routeId: string | null;
  tripId: string | null;
  directionId: number | null;
  /** the trip's scheduled start, from the feed's own TripDescriptor */
  startTime: string | null;
  lat: number;
  lon: number;
  bearing: number | null;
  speedMs: number | null;
  /** where it is relative to a stop — the field that makes an arrival event detectable */
  stopStatus: StopStatus | null;
  stopId: string | null;
  stopSequence: number | null;
  congestion: CongestionLevel | null;
  occupancy: OccupancyStatus | null;
  /** seconds since epoch, from the feed */
  timestamp: number | null;
}

/** Which optional fields this particular feed actually populates, counted per response. Reported
 *  in the UI rather than assumed, because a feed is free to send none of them. */
export interface FieldCoverage {
  speed: number; bearing: number; stopStatus: number; stopId: number;
  occupancy: number; congestion: number; routeId: number; startTime: number;
}

export interface LiveBusFeed {
  state: LiveBusState;
  vehicles: LiveVehicle[];
  /** count of vehicles carrying each optional field, so the UI can say what this feed gives */
  coverage: FieldCoverage;
  /** feed header timestamp, seconds since epoch */
  feedTime: number | null;
  ageSeconds: number | null;
  /** vehicles inside the study box, which is all this app can place */
  inBox: number;
  error: string | null;
  provider: string;
}

const ENDPOINT = "/api/vehicles";
const TIMEOUT_MS = 8000;
const STALE_AFTER_SEC = 180;
const BBOX = { w: 77.1975, s: 28.6039, e: 77.2385, n: 28.6401 };

/* ------------------------------------------------------------------ protobuf */
/** Minimal protobuf wire-format reader: varints, 64/32-bit, and length-delimited. */
class Reader {
  private p = 0;
  constructor(private buf: Uint8Array) {}
  get done() { return this.p >= this.buf.length; }

  varint(): number {
    let result = 0, shift = 0;
    for (;;) {
      const byte = this.buf[this.p++];
      result += (byte & 0x7f) * Math.pow(2, shift);
      if (byte < 0x80) return result;
      shift += 7;
      if (shift > 63) return result;   // malformed; bail rather than loop
    }
  }
  skip(wire: number) {
    if (wire === 0) this.varint();
    else if (wire === 1) this.p += 8;
    // `this.p += this.varint()` is wrong, and wrong in a way that reads as correct: `+=` takes
    // the value of `this.p` BEFORE evaluating the right-hand side, so the bytes the length varint
    // itself consumed are handed back. A one-byte length under-advanced the reader by one byte,
    // the next tag was read from inside the previous field, and the whole message shredded from
    // there. It survived review and shipped because the only feed it had ever been run against
    // was Delhi's empty midnight one: a bare FeedHeader of varints, where nothing is ever skipped
    // over a length-delimited field. The first feed with a bus in it failed on the first entity.
    else if (wire === 2) { const len = this.varint(); this.p += len; }
    else if (wire === 5) this.p += 4;
    else throw new Error(`unknown wire type ${wire}`);
  }
  bytes(): Uint8Array {
    const len = this.varint();
    const out = this.buf.subarray(this.p, this.p + len);
    this.p += len;
    return out;
  }
  float(): number {
    const dv = new DataView(this.buf.buffer, this.buf.byteOffset + this.p, 4);
    this.p += 4;
    return dv.getFloat32(0, true);
  }
  double(): number {
    const dv = new DataView(this.buf.buffer, this.buf.byteOffset + this.p, 8);
    this.p += 8;
    return dv.getFloat64(0, true);
  }
  str(): string { return new TextDecoder().decode(this.bytes()); }
  /** field key -> {field, wire} */
  key(): { field: number; wire: number } {
    const k = this.varint();
    return { field: k >>> 3, wire: k & 7 };
  }
}

/** Position { latitude=1 float, longitude=2 float, bearing=3 float, odometer=4 double, speed=5 float } */
function readPosition(r: Reader) {
  const pos: { lat?: number; lon?: number; bearing?: number; speed?: number } = {};
  while (!r.done) {
    const { field, wire } = r.key();
    if (field === 1 && wire === 5) pos.lat = r.float();
    else if (field === 2 && wire === 5) pos.lon = r.float();
    else if (field === 3 && wire === 5) pos.bearing = r.float();
    else if (field === 5 && wire === 5) pos.speed = r.float();
    else r.skip(wire);
  }
  return pos;
}

/** TripDescriptor { trip_id=1, start_time=2, start_date=3, route_id=5, direction_id=6 } */
function readTrip(r: Reader) {
  const t: { tripId?: string; routeId?: string; startTime?: string; directionId?: number } = {};
  while (!r.done) {
    const { field, wire } = r.key();
    if (field === 1 && wire === 2) t.tripId = r.str();
    else if (field === 2 && wire === 2) t.startTime = r.str();
    else if (field === 5 && wire === 2) t.routeId = r.str();
    else if (field === 6 && wire === 0) t.directionId = r.varint();
    else r.skip(wire);
  }
  return t;
}

/** VehicleDescriptor { id=1 string, label=2 string, license_plate=3 string }
 *  license_plate is skipped on purpose — see the module docstring. */
function readVehicleDesc(r: Reader) {
  const v: { id?: string; label?: string } = {};
  while (!r.done) {
    const { field, wire } = r.key();
    if (field === 1 && wire === 2) v.id = r.str();
    else if (field === 2 && wire === 2) v.label = r.str();
    else r.skip(wire);
  }
  return v;
}

/**
 * VehiclePosition { trip=1, position=2, current_stop_sequence=3, current_status=4,
 *                   timestamp=5, congestion_level=6, stop_id=7, vehicle=8, occupancy_status=9 }
 */
function readVehiclePosition(r: Reader): LiveVehicle | null {
  let trip: ReturnType<typeof readTrip> = {};
  let pos: ReturnType<typeof readPosition> = {};
  let veh: ReturnType<typeof readVehicleDesc> = {};
  let ts: number | null = null;
  let stopSeq: number | null = null;
  let status: StopStatus | null = null;
  let congestion: CongestionLevel | null = null;
  let stopId: string | null = null;
  let occupancy: OccupancyStatus | null = null;
  while (!r.done) {
    const { field, wire } = r.key();
    if (field === 1 && wire === 2) trip = readTrip(new Reader(r.bytes()));
    else if (field === 2 && wire === 2) pos = readPosition(new Reader(r.bytes()));
    else if (field === 3 && wire === 0) stopSeq = r.varint();
    else if (field === 4 && wire === 0) status = STOP_STATUS[r.varint()] ?? null;
    else if (field === 5 && wire === 0) ts = r.varint();
    else if (field === 6 && wire === 0) congestion = CONGESTION[r.varint()] ?? null;
    else if (field === 7 && wire === 2) stopId = r.str();
    else if (field === 8 && wire === 2) veh = readVehicleDesc(new Reader(r.bytes()));
    else if (field === 9 && wire === 0) occupancy = OCCUPANCY[r.varint()] ?? null;
    else r.skip(wire);
  }
  if (pos.lat === undefined || pos.lon === undefined) return null;
  return {
    id: veh.id ?? trip.tripId ?? "unknown",
    label: veh.label ?? null,
    routeId: trip.routeId ?? null,
    tripId: trip.tripId ?? null,
    directionId: trip.directionId ?? null,
    startTime: trip.startTime ?? null,
    lat: pos.lat, lon: pos.lon,
    bearing: pos.bearing ?? null,
    speedMs: pos.speed ?? null,
    stopStatus: status, stopId, stopSequence: stopSeq,
    congestion, occupancy,
    timestamp: ts,
  };
}

/** FeedEntity { id=1 string, vehicle=4 VehiclePosition } */
function readEntity(r: Reader): LiveVehicle | null {
  let v: LiveVehicle | null = null;
  while (!r.done) {
    const { field, wire } = r.key();
    if (field === 4 && wire === 2) v = readVehiclePosition(new Reader(r.bytes()));
    else r.skip(wire);
  }
  return v;
}

/** FeedMessage { header=1 FeedHeader, entity=2 repeated FeedEntity } */
export function decodeFeed(buf: Uint8Array): { feedTime: number | null; vehicles: LiveVehicle[] } {
  const r = new Reader(buf);
  const vehicles: LiveVehicle[] = [];
  let feedTime: number | null = null;
  while (!r.done) {
    const { field, wire } = r.key();
    if (field === 1 && wire === 2) {
      // FeedHeader { gtfs_realtime_version=1, incrementality=2, timestamp=3 uint64 }
      const h = new Reader(r.bytes());
      while (!h.done) {
        const k = h.key();
        if (k.field === 3 && k.wire === 0) feedTime = h.varint();
        else h.skip(k.wire);
      }
    } else if (field === 2 && wire === 2) {
      const v = readEntity(new Reader(r.bytes()));
      if (v) vehicles.push(v);
    } else {
      r.skip(wire);
    }
  }
  return { feedTime, vehicles };
}

const NO_COVERAGE: FieldCoverage = {
  speed: 0, bearing: 0, stopStatus: 0, stopId: 0,
  occupancy: 0, congestion: 0, routeId: 0, startTime: 0,
};

function countCoverage(vs: LiveVehicle[]): FieldCoverage {
  const c = { ...NO_COVERAGE };
  for (const v of vs) {
    if (v.speedMs !== null) c.speed++;
    if (v.bearing !== null) c.bearing++;
    if (v.stopStatus !== null) c.stopStatus++;
    if (v.stopId !== null) c.stopId++;
    if (v.occupancy !== null && v.occupancy !== "NO_DATA_AVAILABLE") c.occupancy++;
    if (v.congestion !== null && v.congestion !== "UNKNOWN_CONGESTION_LEVEL") c.congestion++;
    if (v.routeId !== null) c.routeId++;
    if (v.startTime !== null) c.startTime++;
  }
  return c;
}

/* ------------------------------------------------------------------ adapter */
export async function fetchLiveBuses(): Promise<LiveBusFeed> {
  const base: LiveBusFeed = {
    state: "unconfigured", vehicles: [], coverage: { ...NO_COVERAGE },
    feedTime: null, ageSeconds: null, inBox: 0, error: null,
    provider: "Delhi Open Transit Data — GTFS-Realtime VehiclePositions",
  };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(ENDPOINT, { signal: ctrl.signal, cache: "no-store" });
    // 501 and 404 are still honoured for a deployment running an older proxy, but the current
    // contract is 200 with a JSON body: a non-2xx status logs a console error in every browser
    // for every visitor, which this app is explicitly not willing to spend on an expected state.
    if (res.status === 501 || res.status === 404) {
      return { ...base, state: "unconfigured",
               error: "No live-bus proxy configured. See docs/08-LIVE-DATA.md." };
    }
    if (!res.ok) {
      return { ...base, state: "unavailable", error: `proxy returned HTTP ${res.status}` };
    }
    if ((res.headers.get("content-type") || "").includes("json")) {
      // the proxy answered, and what it has to say is that it cannot serve the feed
      let detail = "The live-bus proxy reported no configuration.";
      let kind = "unconfigured";
      try {
        const j = await res.json() as { error?: string; detail?: string };
        if (j.detail) detail = j.detail;
        if (j.error) kind = j.error;
      } catch { /* an unparseable body is still an unconfigured proxy */ }
      return { ...base,
               state: kind === "unconfigured" ? "unconfigured" : "unavailable",
               error: detail };
    }
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.length < 8) {
      return { ...base, state: "unavailable", error: "proxy returned an empty feed" };
    }
    const { feedTime, vehicles } = decodeFeed(buf);
    const age = feedTime ? Date.now() / 1000 - feedTime : null;
    const inBox = vehicles.filter(
      (v) => v.lon >= BBOX.w && v.lon <= BBOX.e && v.lat >= BBOX.s && v.lat <= BBOX.n).length;
    return {
      ...base,
      state: age !== null && age > STALE_AFTER_SEC ? "stale" : "live",
      vehicles, coverage: countCoverage(vehicles),
      feedTime, ageSeconds: age, inBox, error: null,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // an aborted or refused request means no proxy, which is the normal state today
    return { ...base, state: /abort|Failed to fetch|NetworkError/i.test(msg) ? "unconfigured" : "unavailable",
             error: msg };
  } finally {
    clearTimeout(timer);
  }
}
