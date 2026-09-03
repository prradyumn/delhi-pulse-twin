#!/usr/bin/env node
/**
 * Budgets are gates, not wishes. This fails the build when an asset or the total transfer breaches
 * config/study-area.json:budgets, measured as gzip because that is what a CDN actually ships.
 *
 *   node tools/budget.mjs            # measure public/data
 *   node tools/budget.mjs --dist     # measure a built dist/ as well
 */
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { join, relative, extname } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const REPO = join(ROOT, "..");
const cfg = JSON.parse(readFileSync(join(REPO, "config", "study-area.json"), "utf8"));
const B = cfg.budgets;

const walk = (dir) => existsSync(dir)
  ? readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
      d.isDirectory() ? walk(join(dir, d.name)) : [join(dir, d.name)])
  : [];

const gz = (p) => gzipSync(readFileSync(p), { level: 9 }).length;
const kb = (n) => (n / 1024).toFixed(1).padStart(8) + " KB";

const failures = [];
const check = (name, actual, limit, unit = "KB") => {
  const ok = actual <= limit;
  if (!ok) failures.push(`${name}: ${actual.toFixed(1)} ${unit} exceeds the ${limit} ${unit} gate`);
  return ok ? "pass" : "FAIL";
};

console.log("\n  DELHI PULSE TWIN — budget gate");
console.log(`  study area ${cfg.study_area.id} · transform v${cfg.transform_version}\n`);

// ---------------------------------------------------------------- data payload
const dataDir = join(ROOT, "public", "data", "@v1");
const files = walk(dataDir).filter((f) => [".json", ".glb", ".bin"].includes(extname(f)));
if (!files.length) {
  console.error("  no data found under public/data/@v1 — run the pipeline first (make data)\n");
  process.exit(2);
}

let total = 0;
console.log("  ASSET                                          RAW        GZIP");
for (const f of files.sort()) {
  const raw = statSync(f).size, z = gz(f);
  total += z;
  console.log(`  ${relative(dataDir, f).padEnd(38)} ${kb(raw)}  ${kb(z)}`);
}
console.log(`  ${"TOTAL (gzip)".padEnd(38)} ${" ".repeat(11)}${kb(total)}\n`);

// buildings.json is the single largest asset and the one that grows if the box unfreezes
const bj = files.find((f) => f.endsWith("buildings.json"));
if (bj && B.buildings_glb_kb) {
  const z = gz(bj) / 1024;
  console.log(`  buildings payload      ${z.toFixed(1)} KB gzip   limit ${B.buildings_glb_kb} KB   ${check("buildings payload", z, B.buildings_glb_kb)}`);
}

const totalMB = total / 1024 / 1024;
const gate = B.initial_transfer_mb.hard_gate, target = B.initial_transfer_mb.target;
console.log(`  initial transfer       ${totalMB.toFixed(2)} MB gzip   target ${target} MB, gate ${gate} MB   ${check("initial transfer", totalMB, gate, "MB")}`);
if (totalMB > target) console.log(`  note: over the ${target} MB target but inside the ${gate} MB gate`);

// ---------------------------------------------------------------- landmark assets
const glbs = files.filter((f) => f.endsWith(".glb") && f.includes("landmark"));
for (const g of glbs) {
  const z = gz(g) / 1024;
  const lim = /lod2/.test(g) ? B.landmark_lod2_kb : /lod1/.test(g) ? B.landmark_lod1_kb : B.landmark_lod0_kb;
  console.log(`  ${relative(dataDir, g).padEnd(38)} ${z.toFixed(1)} KB   limit ${lim} KB   ${check(relative(dataDir, g), z, lim)}`);
}

// ---------------------------------------------------------------- built bundle
if (process.argv.includes("--dist")) {
  const dist = join(ROOT, "dist");
  const js = walk(dist).filter((f) => f.endsWith(".js"));
  const css = walk(dist).filter((f) => f.endsWith(".css"));
  const jsz = js.reduce((a, f) => a + gz(f), 0) / 1024;
  const cssz = css.reduce((a, f) => a + gz(f), 0) / 1024;
  console.log(`\n  bundle js              ${jsz.toFixed(1)} KB gzip across ${js.length} chunk(s)`);
  console.log(`  bundle css             ${cssz.toFixed(1)} KB gzip`);
  console.log(`  data + bundle          ${(totalMB + (jsz + cssz) / 1024).toFixed(2)} MB gzip   gate ${gate} MB   ${check("data + bundle", totalMB + (jsz + cssz) / 1024, gate, "MB")}`);
}

console.log("");
if (failures.length) {
  console.error("  BUDGET GATE FAILED");
  for (const f of failures) console.error(`    - ${f}`);
  console.error("");
  process.exit(1);
}
console.log("  budget gate passed\n");
