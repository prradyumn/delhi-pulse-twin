/**
 * Serverless proxy for Delhi OTD GTFS-Realtime vehicle positions.
 *
 * It exists for two reasons, both stated in the NFRs before either feed was built:
 *
 *  - the OTD key must not reach the browser, and
 *  - `otd.delhi.gov.in` sends no CORS headers, so a direct browser fetch cannot work anyway.
 *
 * Returns 200 with an `unconfigured` body when there is no key, which the client treats as the
 * normal resting state — the app runs on deterministic replay until a key exists.
 *
 * HTTP 200 with an `unconfigured` body, not 501. Semantically 501 is the better status, and it cost a console error for every single visitor: Chrome logs any non-2xx as "Failed to load resource", regardless of the fetch being handled. This project's own design note says a build must never fire a request that logs an error for every user, so the request now SUCCEEDS and reports the missing capability in the payload. Tried 501 first, watched the console-error gate go red, and corrected it.
 *
 * Configure with one environment variable:
 *   OTD_API_KEY=<your key from https://otd.delhi.gov.in/>
 * Optionally:
 *   OTD_VEHICLE_URL=<override the endpoint if OTD moves it>
 */

/**
 * Vercel's Edge Runtime exposes `process.env`, but this file is compiled on its own — it is not
 * part of web/tsconfig.json and the root has no `@types/node`. Declaring the one member actually
 * used is smaller and more honest than pulling a Node type package into a worker bundle that has
 * no Node in it: everything else on `process` genuinely is unavailable here.
 */
declare const process: { env: Record<string, string | undefined> };

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
      { status: 200, headers: { "content-type": "application/json" } },
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
