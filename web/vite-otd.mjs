import { loadEnv } from "vite";

/**
 * Serves `/api/vehicles` from the Vite dev and preview servers, so the live OTD feed works on a
 * developer's machine and not only on a Vercel deployment.
 *
 * The production path is the edge function in `api/vehicles.ts`; this is the same contract
 * implemented as Node middleware. Keeping them separate rather than sharing code is deliberate —
 * the edge runtime and Node differ enough that a shared file would need shims, and the contract is
 * small enough to state twice: 200 with an `unconfigured` body when there is no key, protobuf
 * bytes when it works.
 *
 * **The key never reaches the browser.** It is read here, in the Node process, from `OTD_API_KEY`
 * in `.env.local`. Vite only exposes `VITE_`-prefixed variables to client code, so the name matters:
 * `OTD_API_KEY` is invisible to the bundle by construction. Do not rename it with a VITE_ prefix.
 */
const DEFAULT_URL = "https://otd.delhi.gov.in/api/realtime/VehiclePositions.pb";

export function otdVehicles({ root, mode = "development" } = {}) {
  let key = "";
  let base = DEFAULT_URL;

  const middleware = async (req, res, next) => {
    if (!req.url || !req.url.startsWith("/api/vehicles")) return next();

    if (!key) {
      // 200, not 501: see api/vehicles.ts for why a non-2xx here costs a console error for
      // every visitor even though the client handles it.
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({
        error: "unconfigured",
        detail: "OTD_API_KEY is not set in this environment, so live vehicle positions are "
              + "unavailable. The app runs on deterministic replay until it is.",
      }));
      return;
    }

    const url = `${base}${base.includes("?") ? "&" : "?"}key=${encodeURIComponent(key)}`;
    try {
      const upstream = await fetch(url, {
        headers: { accept: "application/x-protobuf, application/octet-stream" },
        signal: AbortSignal.timeout(9000),
      });
      if (!upstream.ok) {
        res.statusCode = 502;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ error: "upstream", status: upstream.status }));
        return;
      }
      const buf = Buffer.from(await upstream.arrayBuffer());
      res.statusCode = 200;
      res.setHeader("content-type", "application/x-protobuf");
      // no edge cache locally, but keep the same shape so the client sees one contract
      res.setHeader("cache-control", "public, max-age=0, s-maxage=8");
      res.end(buf);
    } catch (e) {
      res.statusCode = 502;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: "fetch_failed", detail: String(e && e.message || e) }));
    }
  };

  return {
    name: "otd-vehicles",
    configResolved(cfg) {
      // "" as the prefix loads every variable, not just VITE_ ones — this runs in Node, and the
      // key is deliberately never handed to the client bundle.
      const env = loadEnv(mode, root ?? cfg.root ?? process.cwd(), "");
      // trimmed for the same reason as api/vehicles.ts: a trailing newline becomes %0A and 401s
      key = (process.env.OTD_API_KEY || env.OTD_API_KEY || "").trim();
      base = process.env.OTD_VEHICLE_URL || env.OTD_VEHICLE_URL || DEFAULT_URL;
      cfg.logger.info(key
        ? `  otd  live vehicle feed enabled at /api/vehicles`
        : `  otd  /api/vehicles returns 501 — no OTD_API_KEY in this environment`);
    },
    configureServer(server) { server.middlewares.use(middleware); },
    configurePreviewServer(server) { server.middlewares.use(middleware); },
  };
}
