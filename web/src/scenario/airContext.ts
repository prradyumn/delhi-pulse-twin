import type { AirReading, WeatherReading, MixingHour } from "../data/adapters/openMeteo";

/**
 * Why the air is like this, from data that costs nothing and needs no key.
 *
 * The app already showed a PM2.5 number, put it against the WHO guideline, and turned it into an
 * inhaled dose. What it never answered is the question anyone in Delhi actually asks next: *why is
 * it this bad, and what would change it?* Without that, the number is a verdict rather than
 * information, and the only advice available is "go at a different hour" with no reason attached.
 *
 * Three keyless quantities answer it, all live from Open-Meteo:
 *
 *  - **Mixing-layer depth.** The depth of atmosphere the city's emissions are stirred into.
 *    Measured over this box: 430 m late evening, collapsing to 135 m by dawn, against 1,500 m+ on
 *    a sunny afternoon. Same emissions, ten times the dilution. This is the dominant driver of
 *    Delhi's daily cycle and it is almost never put in front of a reader.
 *  - **Ventilation index** = mixing depth x wind speed. The standard meteorological measure of a
 *    city's ability to flush itself. When it is low, concentration rises whatever anyone does
 *    about emissions today.
 *  - **Fine fraction** = PM2.5 / PM10. Coarse dust and fine combustion particles come from
 *    completely different places. A ratio near 1 means essentially everything is combustion —
 *    traffic, burning, industry. A low ratio means mineral dust, which is construction, road dust
 *    and desert, and is a different problem with different answers.
 *
 * All of it is MODELLED, from CAMS at roughly 11 km resolution — not a monitor at the kerb. The
 * honest ceiling on this feature is that it explains the region, not the street. A ground-station
 * feed (OpenAQ carries the CPCB network) is what would make it observed, and that is stated in the
 * UI rather than glossed.
 */

export type Band = "very low" | "low" | "moderate" | "good" | "very good";

export interface Ventilation {
  /** mixing depth now, metres */
  blh_m: number;
  wind_kmh: number;
  /** m²/s — the conventional ventilation index, depth × wind speed */
  index: number;
  band: Band;
  plain: string;
  /** the best mixing depth in the next 12 hours, and when */
  best: { time: string; blh_m: number; hoursAway: number } | null;
  /** ratio of the day's peak mixing depth to now — how much more dilution is coming */
  liftFactor: number | null;
}

export interface Attribution {
  finePct: number | null;
  dust: number | null;
  /** what the mix points at, in plain words */
  reading: string;
  /** "combustion" | "mixed" | "dust" | "unknown" */
  kind: "combustion" | "mixed" | "dust" | "unknown";
}

export interface AirContext {
  ventilation: Ventilation | null;
  attribution: Attribution;
  /** where the air is coming from, as a compass name plus what lies that way */
  windFrom: { deg: number; name: string; note: string } | null;
  aod: number | null;
  aodNote: string | null;
  /** the single sentence worth reading first */
  headline: string;
  limitations: string[];
}

const COMPASS = ["north", "north-east", "east", "south-east",
                 "south", "south-west", "west", "north-west"];

function compass(deg: number): string {
  return COMPASS[Math.round(((deg % 360) + 360) % 360 / 45) % 8];
}

/**
 * What lies upwind of central Delhi, by sector. Geography, not a data source — and it is stated as
 * geography so nobody mistakes it for an attribution measurement. The north-west sector is the one
 * that matters most in October and November, because that is where the Punjab and Haryana stubble
 * fires are; a satellite fire feed is what would turn this note into evidence.
 */
function upwindNote(deg: number): string {
  const d = ((deg % 360) + 360) % 360;
  if (d >= 292.5 || d < 22.5) {
    return "From the north-west through north — the sector that carries smoke from the Punjab and "
         + "Haryana crop-residue fires in October and November, and from the industrial belt "
         + "beyond. Direction alone is not attribution: a satellite fire-detection feed is what "
         + "would make that a measurement rather than a note about geography.";
  }
  if (d < 112.5) {
    return "From the north-east through east — over the Yamuna floodplain, Ghaziabad and the "
         + "eastern industrial areas.";
  }
  if (d < 202.5) {
    return "From the south-east through south — over south Delhi, Noida and the Faridabad "
         + "industrial belt.";
  }
  return "From the south-west through west — over Gurugram, Dwarka and the Rajasthan desert "
       + "margin, the direction coarse mineral dust usually arrives from.";
}

function ventBand(index: number): Band {
  // Conventional ventilation-index breakpoints, in m²/s, as used in air-quality and prescribed-burn
  // practice. Declared thresholds, not derived from these data.
  if (index < 1000) return "very low";
  if (index < 2350) return "low";
  if (index < 3500) return "moderate";
  if (index < 6000) return "good";
  return "very good";
}

export function ventilation(
  wx: WeatherReading | null, mixing: MixingHour[],
): Ventilation | null {
  if (!wx || !mixing.length) return null;
  const now = Date.now();
  const parsed = mixing.map((m) => ({
    ...m,
    t: Date.parse(/[Z+]/.test(m.time) ? m.time : `${m.time}+05:30`),
  })).filter((m) => Number.isFinite(m.t));
  if (!parsed.length) return null;

  // nearest hour to now, rather than assuming the array starts at the current hour
  const current = parsed.reduce((a, b) =>
    Math.abs(b.t - now) < Math.abs(a.t - now) ? b : a);
  const windMs = wx.wind_kmh / 3.6;
  const index = current.blh_m * windMs;

  const ahead = parsed.filter((m) => m.t > now && m.t - now <= 12 * 3600_000);
  const best = ahead.length
    ? ahead.reduce((a, b) => (b.blh_m > a.blh_m ? b : a))
    : null;

  const band = ventBand(index);
  const plain =
    band === "very low" || band === "low"
      ? `The city is barely flushing: a ${Math.round(current.blh_m)} m mixing layer and `
        + `${wx.wind_kmh.toFixed(1)} km/h of wind. Emissions are accumulating in a shallow, still `
        + `box of air, which is why the number is what it is.`
      : band === "moderate"
      ? `Moderate dispersion — a ${Math.round(current.blh_m)} m mixing layer with `
        + `${wx.wind_kmh.toFixed(1)} km/h of wind is clearing some of what the city emits.`
      : `Good dispersion: a ${Math.round(current.blh_m)} m mixing layer and `
        + `${wx.wind_kmh.toFixed(1)} km/h of wind are flushing the city faster than it fills.`;

  return {
    blh_m: current.blh_m, wind_kmh: wx.wind_kmh, index, band, plain,
    best: best ? { time: best.time, blh_m: best.blh_m,
                   hoursAway: (best.t - now) / 3600_000 } : null,
    liftFactor: best && current.blh_m > 0 ? best.blh_m / current.blh_m : null,
  };
}

export function attribution(air: AirReading | null): Attribution {
  if (!air || !(air.pm10 > 0)) {
    return { finePct: null, dust: air?.dust ?? null, kind: "unknown",
             reading: "No PM10 figure, so the fine/coarse split cannot be computed." };
  }
  const fine = (air.pm2_5 / air.pm10) * 100;
  const dust = air.dust;
  let kind: Attribution["kind"];
  let reading: string;
  if (fine >= 85) {
    kind = "combustion";
    reading = `${fine.toFixed(0)}% of the particulate mass is fine (PM2.5 within PM10). Coarse `
            + `dust is essentially absent, so what is in the air is combustion — traffic, `
            + `burning and industry — and not construction or desert dust.`;
  } else if (fine >= 60) {
    kind = "mixed";
    reading = `${fine.toFixed(0)}% of the particulate is fine. A mix: combustion dominates, with a `
            + `real coarse-dust contribution from roads and construction on top.`;
  } else {
    kind = "dust";
    reading = `Only ${fine.toFixed(0)}% of the particulate is fine, so most of the mass is coarse `
            + `— mineral and road dust rather than combustion. Different problem, different `
            + `answers: watering and paving, not traffic restraint.`;
  }
  if (dust !== null) {
    reading += ` Modelled mineral dust is ${dust.toFixed(1)} µg/m³.`;
  }
  return { finePct: fine, dust, kind, reading };
}

export function aodNote(aod: number | null): string | null {
  if (aod === null) return null;
  if (aod < 0.2) return "A thin haze column — the whole atmosphere above the city is relatively clear.";
  if (aod < 0.5) return "A moderate haze column: enough aerosol overhead to visibly whiten the sky.";
  if (aod < 1.0) return "A thick haze column. Aerosol optical depth this high means the load is not "
                      + "just at street level — it extends through the atmosphere above the city.";
  return "A very thick haze column, the signature of a regional smoke or dust event rather than "
       + "local traffic alone.";
}

export function airContext(
  air: AirReading | null, wx: WeatherReading | null, mixing: MixingHour[],
): AirContext {
  const v = ventilation(wx, mixing);
  const attr = attribution(air);
  const windFrom = wx && wx.wind_from_deg !== null
    ? { deg: wx.wind_from_deg, name: compass(wx.wind_from_deg), note: upwindNote(wx.wind_from_deg) }
    : null;

  let headline: string;
  if (v && (v.band === "very low" || v.band === "low") && attr.kind === "combustion") {
    headline = "Still, shallow air over a city burning things. Today's number is mostly weather, "
             + "not a change in what Delhi is emitting.";
  } else if (v && (v.band === "very low" || v.band === "low")) {
    headline = "The air is not moving. Whatever is being emitted is staying put.";
  } else if (v && attr.kind === "combustion") {
    headline = "The city is dispersing reasonably well, so what is left is what it is emitting: "
             + "combustion, not dust.";
  } else if (v) {
    headline = "Dispersion is doing its job; the remaining load is coarse dust as much as combustion.";
  } else {
    headline = "No mixing-layer data available, so the meteorological half of the explanation is missing.";
  }
  if (v?.liftFactor && v.liftFactor > 1.8 && v.best) {
    // Attributed to the forecast, and stated as dilution rather than as an outcome. The wording
    // gate's banned list would not have caught "which is when it clears" — it contains none of
    // the forbidden phrases — but asserting a future state as fact is exactly what that rule is
    // for, and passing the regex is not the standard.
    headline += ` The forecast has the mixing layer about ${v.liftFactor.toFixed(1)}× deeper by `
              + `${v.best.time.slice(11, 16)}.`;
  }

  return {
    ventilation: v, attribution: attr, windFrom,
    aod: air?.aod ?? null, aodNote: aodNote(air?.aod ?? null),
    headline,
    limitations: [
      "Every figure here is MODELLED, from Copernicus CAMS and the Open-Meteo forecast at roughly "
      + "11 km resolution. None of it is a monitor at the kerb, and none of it can resolve "
      + "variation inside this 4 km box.",
      "Mixing-layer depth is a model diagnostic, not a measurement. It is the best available "
      + "explanation of the daily cycle, not a sounding.",
      "The ventilation index is depth × wind speed with declared breakpoints from air-quality "
      + "practice; it is an indicator, not a prediction of concentration.",
      "The fine fraction points at a source category, it does not apportion one. Real source "
      + "apportionment needs speciated chemistry, which no free feed provides.",
      "Wind direction says where the air came from. What lies that way is geography written into "
      + "this app, not an attribution — a satellite fire feed would be needed for that.",
    ],
  };
}
