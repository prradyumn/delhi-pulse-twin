import type { Provenance } from "../../geo/types";

/**
 * Open-Meteo live weather and air quality. Free, no key, no server — which is why it is the one
 * live feed the MVP can carry without breaking the scope lock.
 *
 * Three rules this adapter obeys, all of them from the PRD:
 *
 * 1. **It never blocks boot.** Called after the scene is up, with a short timeout. A failure is a
 *    reported status, not an error state.
 * 2. **It degrades to the pinned snapshot.** Every consumer reads the same shape whether the value
 *    came from the network or from `weather/baseline.json`, and the shape carries which.
 * 3. **One value for the whole box.** Measured: querying all five corners of the 4 km study area
 *    returns the identical figure and the API snaps them to a single coordinate — the CAMS grid is
 *    about 11 km. Rendering an air-quality *surface* would be inventing spatial detail the data
 *    does not have, so there is no per-location air quality anywhere in this product.
 */

export type FeedState = "live" | "stale" | "fallback" | "unavailable" | "idle";

export interface AirReading {
  pm2_5: number; pm10: number; no2: number; so2: number; o3: number; co: number;
  source_time: string;
  state: FeedState;
  provider: string;
}

export interface WeatherReading {
  temp_c: number; feels_c: number; rh_pct: number; wind_kmh: number;
  precip_mm: number; rain_mm: number; weather_code: number;
  source_time: string;
  state: FeedState;
  provider: string;
}

export interface AirForecastHour { time: string; pm2_5: number }

export interface LiveBundle {
  air: AirReading | null;
  weather: WeatherReading | null;
  forecast: AirForecastHour[];
  /** the study-area centre these readings apply to, and the box they are being applied to */
  appliesTo: { lat: number; lon: number; note: string };
  fetchedAt: string;
  errors: string[];
}

const CENTRE = { lat: 28.6220, lon: 77.2180 };
const TIMEOUT_MS = 7000;
/** Anything older than this is reported stale rather than live. */
const STALE_AFTER_MIN = 90;

const AQ_URL =
  `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${CENTRE.lat}` +
  `&longitude=${CENTRE.lon}&current=pm10,pm2_5,carbon_monoxide,nitrogen_dioxide,` +
  `sulphur_dioxide,ozone&hourly=pm2_5&forecast_days=2&timezone=Asia%2FKolkata`;

const WX_URL =
  `https://api.open-meteo.com/v1/forecast?latitude=${CENTRE.lat}&longitude=${CENTRE.lon}` +
  `&current=temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,rain,` +
  `wind_speed_10m,weather_code&timezone=Asia%2FKolkata`;

async function getJson(url: string): Promise<unknown> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal, cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function ageMinutes(iso: string): number {
  const t = Date.parse(iso.includes("T") && !/[Z+]/.test(iso) ? `${iso}+05:30` : iso);
  if (Number.isNaN(t)) return Number.POSITIVE_INFINITY;
  return (Date.now() - t) / 60000;
}

function stateFor(iso: string): FeedState {
  return ageMinutes(iso) > STALE_AFTER_MIN ? "stale" : "live";
}

/** Fetch both feeds. Resolves even when everything fails — the caller inspects `errors`. */
export async function fetchLive(): Promise<LiveBundle> {
  const out: LiveBundle = {
    air: null, weather: null, forecast: [],
    appliesTo: {
      lat: CENTRE.lat, lon: CENTRE.lon,
      note: "One reading for the entire study area. The CAMS grid is about 11 km, so all four " +
            "corners of this 4 km box return the identical value — there is no measured " +
            "variation inside it to show.",
    },
    fetchedAt: new Date().toISOString(),
    errors: [],
  };

  const [aq, wx] = await Promise.allSettled([getJson(AQ_URL), getJson(WX_URL)]);

  if (aq.status === "fulfilled") {
    try {
      const d = aq.value as {
        current: Record<string, number | string>;
        hourly?: { time: string[]; pm2_5: (number | null)[] };
      };
      const c = d.current;
      const t = String(c.time);
      out.air = {
        pm2_5: Number(c.pm2_5), pm10: Number(c.pm10),
        no2: Number(c.nitrogen_dioxide), so2: Number(c.sulphur_dioxide),
        o3: Number(c.ozone), co: Number(c.carbon_monoxide),
        source_time: t, state: stateFor(t),
        provider: "Open-Meteo Air Quality (CAMS)",
      };
      if (d.hourly) {
        out.forecast = d.hourly.time
          .map((tt, i) => ({ time: tt, pm2_5: d.hourly!.pm2_5[i] ?? NaN }))
          .filter((h) => Number.isFinite(h.pm2_5));
      }
    } catch (e) {
      out.errors.push(`air quality parse: ${e instanceof Error ? e.message : String(e)}`);
    }
  } else {
    out.errors.push(`air quality: ${aq.reason instanceof Error ? aq.reason.message : String(aq.reason)}`);
  }

  if (wx.status === "fulfilled") {
    try {
      const c = (wx.value as { current: Record<string, number | string> }).current;
      const t = String(c.time);
      out.weather = {
        temp_c: Number(c.temperature_2m), feels_c: Number(c.apparent_temperature),
        rh_pct: Number(c.relative_humidity_2m), wind_kmh: Number(c.wind_speed_10m),
        precip_mm: Number(c.precipitation), rain_mm: Number(c.rain),
        weather_code: Number(c.weather_code),
        source_time: t, state: stateFor(t),
        provider: "Open-Meteo Forecast",
      };
    } catch (e) {
      out.errors.push(`weather parse: ${e instanceof Error ? e.message : String(e)}`);
    }
  } else {
    out.errors.push(`weather: ${wx.reason instanceof Error ? wx.reason.message : String(wx.reason)}`);
  }

  return out;
}

/** Map an IMD-style rain band from an observed precipitation rate, so the live feed can drive the
 *  same rainfall control the bundled scenario uses. */
export function bandFromRain(mmPerHour: number): "none" | "light" | "moderate" | "heavy" | "very_heavy" {
  if (mmPerHour <= 0.05) return "none";
  if (mmPerHour < 2.5) return "light";
  if (mmPerHour < 7.6) return "moderate";
  if (mmPerHour < 35) return "heavy";
  return "very_heavy";
}

export function airProvenance(a: AirReading, appliesTo: LiveBundle["appliesTo"]): Provenance {
  return {
    provider: a.provider,
    dataset: "Current surface PM2.5, PM10, NO2, SO2, O3 and CO for the study-area centre",
    license: "Open-Meteo, free for non-commercial use; CAMS data © ECMWF / Copernicus",
    attribution: "Air quality from Open-Meteo, based on Copernicus CAMS",
    retrieved_at: new Date().toISOString(),
    source_time: a.source_time,
    refresh_cadence: "hourly at source; this app re-reads every 10 minutes",
    bounds: [77.1975, 28.6039, 77.2385, 28.6401],
    crs: "point measurement, applied to the whole study area",
    mode: "observed",
    transform_version: "0.1.0",
    limitations: [
      a.state === "stale"
        ? `This reading is older than ${STALE_AFTER_MIN} minutes and is shown as stale, not live.`
        : "Live reading from the provider's most recent hour.",
      appliesTo.note,
      "A modelled reanalysis product, not a kerbside monitor. It will not capture a local source such as a single congested junction or a fire.",
      "Applied uniformly across the study area. Real intra-city variation in Delhi is large and this dataset cannot resolve it.",
    ],
  };
}
