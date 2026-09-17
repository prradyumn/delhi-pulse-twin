#!/usr/bin/env node
/**
 * Validates vercel.json's top-level keys.
 *
 * This exists because `vercel.json` sets `"additionalProperties": false`, and the file had carried
 * a `_note` key from the day it was written. Vercel rejects the whole file for one unknown
 * property and fails the deployment before the build starts — a 0 ms build with status Error and
 * nothing in the logs to read. The project therefore had never had a successful deployment, and
 * nothing said so, because a config file that is never deployed is never validated.
 *
 * JSON has no comments, so the temptation to invent `_`-prefixed ones is strong and it is exactly
 * what breaks. The explanation of why the config is shaped the way it is lives in README.md under
 * "Deploying", where prose is legal.
 *
 * The key list is vendored rather than fetched: `make check` has to work with no network, which is
 * the same rule the app itself lives by. Refresh with:
 *   curl -s https://openapi.vercel.sh/vercel.json | \
 *     node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(Object.keys(JSON.parse(s).properties).sort().join(' ')))"
 */
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

/** openapi.vercel.sh/vercel.json, properties, fetched 2026-09-17. */
const ALLOWED = new Set([
  "$schema", "alias", "build", "buildCommand", "builds", "bulkRedirectsPath", "bunVersion",
  "cleanUrls", "crons", "devCommand", "env", "experimentalAtproto", "experimentalBYOC",
  "experimentalEnvironmentVariables", "experimentalServiceGroups", "experimentalServices",
  "experimentalServicesV2", "fluid", "framework", "functionFailoverRegions", "functions", "git",
  "github", "headers", "ignoreCommand", "images", "installCommand", "name", "outputDirectory",
  "passiveRegions", "proxy", "redirects", "regions", "relatedProjects", "rewrites", "routes",
  "schedules", "scope", "services", "trailingSlash",
]);

/** Deprecated in the schema: allowed, but it will be removed and it is not worth depending on. */
const DEPRECATED = new Set(["build", "builds", "name", "env", "routes", "scope", "alias"]);

const raw = await readFile(join(ROOT, "vercel.json"), "utf8");
let cfg;
try {
  cfg = JSON.parse(raw);
} catch (e) {
  console.error(`\n  vercel.json is not valid JSON: ${e.message}\n`);
  process.exit(1);
}

const unknown = Object.keys(cfg).filter((k) => !ALLOWED.has(k));
const deprecated = Object.keys(cfg).filter((k) => DEPRECATED.has(k));

if (unknown.length) {
  console.error(`\n  vercel.json has ${unknown.length} key(s) Vercel does not allow: ${unknown.join(", ")}`);
  console.error("  The schema sets additionalProperties:false, so ONE unknown key fails the whole");
  console.error("  deployment before the build starts. JSON has no comments — put the explanation");
  console.error("  in README.md under \"Deploying\" instead.\n");
  process.exit(1);
}

// The function must be where Vercel looks for it, which is the other way this config has been wrong.
const { existsSync } = await import("node:fs");
if (!existsSync(join(ROOT, "api", "vehicles.ts"))) {
  console.error("\n  api/vehicles.ts is missing. Vercel only discovers functions under api/ at the");
  console.error("  project root — moving it anywhere else silently deploys no function at all.\n");
  process.exit(1);
}

console.log(`  vercel.json    ${Object.keys(cfg).length} keys, all valid`
            + (deprecated.length ? ` · deprecated in use: ${deprecated.join(", ")}` : "")
            + " · api/vehicles.ts present");
