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
 * `protobufjs`. Six fields do not justify two dependencies in a project whose whole argument is
 * that it runs from bundled data.
 */

export type LiveBusState = "unconfigured" | "live" | "stale" | "unavailable";

export interface LiveVehicle {
  id: string;
  routeId: string | null;
  tripId: string | null;
  lat: number;
  lon: number;
  bearing: number | null;
  speedMs: number | null;
  /** seconds since epoch, from the feed */
  timestamp: number | null;
}

export interface LiveBusFeed {
  state: LiveBusState;
  vehicles: LiveVehicle[];
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
    else if (wire === 2) this.p += this.varint();
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

/** gtfs-realtime.proto: Position { latitude=1 float, longitude=2 float, bearing=3 float, speed=5 float } */
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

/** TripDescriptor { trip_id=1 string, route_id=5 string } */
function readTrip(r: Reader) {
  const t: { tripId?: string; routeId?: string } = {};
  while (!r.done) {
    const { field, wire } = r.key();
    if (field === 1 && wire === 2) t.tripId = r.str();
    else if (field === 5 && wire === 2) t.routeId = r.str();
    else r.skip(wire);
  }
  return t;
}

/** VehicleDescriptor { id=1 string, label=2 string } */
function readVehicleDesc(r: Reader) {
  let id: string | undefined;
  while (!r.done) {
    const { field, wire } = r.key();
    if (field === 1 && wire === 2) id = r.str();
    else r.skip(wire);
  }
  return id;
}

/** VehiclePosition { trip=1, position=2, timestamp=5 uint64, vehicle=8 } */
function readVehiclePosition(r: Reader): LiveVehicle | null {
  let trip: ReturnType<typeof readTrip> = {};
  let pos: ReturnType<typeof readPosition> = {};
  let ts: number | null = null;
  let vid: string | undefined;
  while (!r.done) {
    const { field, wire } = r.key();
    if (field === 1 && wire === 2) trip = readTrip(new Reader(r.bytes()));
    else if (field === 2 && wire === 2) pos = readPosition(new Reader(r.bytes()));
    else if (field === 5 && wire === 0) ts = r.varint();
    else if (field === 8 && wire === 2) vid = readVehicleDesc(new Reader(r.bytes()));
    else r.skip(wire);
  }
  if (pos.lat === undefined || pos.lon === undefined) return null;
  return {
    id: vid ?? trip.tripId ?? "unknown",
    routeId: trip.routeId ?? null,
    tripId: trip.tripId ?? null,
    lat: pos.lat, lon: pos.lon,
    bearing: pos.bearing ?? null,
    speedMs: pos.speed ?? null,
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

/* ------------------------------------------------------------------ adapter */
export async function fetchLiveBuses(): Promise<LiveBusFeed> {
  const base: LiveBusFeed = {
    state: "unconfigured", vehicles: [], feedTime: null, ageSeconds: null,
    inBox: 0, error: null,
    provider: "Delhi Open Transit Data — GTFS-Realtime VehiclePositions",
  };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(ENDPOINT, { signal: ctrl.signal, cache: "no-store" });
    if (res.status === 501 || res.status === 404) {
      // the proxy is absent or has no key: the designed resting state, not a failure
      return { ...base, state: "unconfigured",
               error: "No live-bus proxy configured. See docs/08-LIVE-DATA.md." };
    }
    if (!res.ok) {
      return { ...base, state: "unavailable", error: `proxy returned HTTP ${res.status}` };
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
      vehicles, feedTime, ageSeconds: age, inBox, error: null,
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
