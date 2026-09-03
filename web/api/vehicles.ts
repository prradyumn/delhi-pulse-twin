/**
 * Serverless proxy for Delhi OTD GTFS-Realtime vehicle positions.
 *
 * It exists for two reasons, both stated in the NFRs before either feed was built:
 *
 *  - the OTD key must not reach the browser, and
 *  - `otd.delhi.gov.in` sends no CORS headers, so a direct browser fetch cannot work anyway.
 *
 * Returns 501 when unconfigured, which the client treats as the normal resting state rather than
 * an error — the app runs on deterministic replay until a key exists.
 *
 * Configure with one environment variable:
 *   OTD_API_KEY=<your key from https://otd.delhi.gov.in/>
 * Optionally:
 *   OTD_VEHICLE_URL=<override the endpoint if OTD moves it>
 */

const DEFAULT_URL = "https://otd.delhi.gov.in/api/realtime/VehiclePositions.pb";
/** Cache briefly at the edge: the feed updates every ~10 s and OTD rate-limits per key. */
const CACHE_SECONDS = 8;

export const config = { runtime: "edge" };

export default async function handler(): Promise<Response> {
  const key = process.env.OTD_API_KEY;
  if (!key) {
    return new Response(
      JSON.stringify({
        error: "unconfigured",
        detail: "OTD_API_KEY is not set, so live vehicle positions are unavailable. The app runs "
              + "on deterministic replay until it is. See docs/08-LIVE-DATA.md.",
      }),
      { status: 501, headers: { "content-type": "application/json" } },
    );
  }

  const base = process.env.OTD_VEHICLE_URL || DEFAULT_URL;
  const url = `${base}${base.includes("?") ? "&" : "?"}key=${encodeURIComponent(key)}`;

  try {
    const upstream = await fetch(url, {
      headers: { accept: "application/x-protobuf, application/octet-stream" },
      signal: AbortSignal.timeout(9000),
    });
    if (!upstream.ok) {
      return new Response(
        JSON.stringify({ error: "upstream", status: upstream.status }),
        { status: 502, headers: { "content-type": "application/json" } },
      );
    }
    const body = await upstream.arrayBuffer();
    return new Response(body, {
      status: 200,
      headers: {
        "content-type": "application/x-protobuf",
        "cache-control": `public, max-age=0, s-maxage=${CACHE_SECONDS}, stale-while-revalidate=20`,
      },
    });
  } catch (e) {
    return new Response(
      JSON.stringify({ error: "fetch_failed", detail: e instanceof Error ? e.message : String(e) }),
      { status: 502, headers: { "content-type": "application/json" } },
    );
  }
}
