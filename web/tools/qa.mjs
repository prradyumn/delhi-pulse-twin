#!/usr/bin/env node
/**
 * Browser QA. Drives the built app in headless Chrome over the DevTools protocol and asserts the
 * things the data invariants cannot: that it renders, holds its frame-rate budget, logs no errors,
 * runs both scenarios end to end, and degrades correctly when a layer's data is removed.
 *
 * This exists because the render caught bugs no amount of static reasoning did — earcut winding,
 * a Blender camera clipping at 100 m, three layers multiplied to black. Those were all found by
 * looking at a picture, and a check that only ever runs by hand is a check that stops running.
 *
 *   node tools/qa.mjs            # build must already exist; serves dist/ itself
 *   node tools/qa.mjs --shots    # also write screenshots to spike/results/app/
 *
 * No puppeteer: Chrome ships the protocol, and one fewer dependency in a project whose whole point
 * is that it runs from bundled data.
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFile, mkdir, writeFile, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, extname } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const DIST = join(ROOT, "dist");
const SHOT_DIR = join(ROOT, "..", "spike", "results", "app");
const WANT_SHOTS = process.argv.includes("--shots");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
               ".json": "application/json", ".glb": "model/gltf-binary",
               ".svg": "image/svg+xml", ".png": "image/png" };

/** Real bytes captured from the live OTD feed, trimmed to a header plus eleven whole entities.
 *  Whole top-level records are kept and concatenated, so nothing here is re-encoded: it is what
 *  Delhi sent. Regenerate with tools/fixtures/README.md. */
const FIXTURE = existsSync(join(ROOT, "tools", "fixtures", "otd-vehicles-sample.pb"))
  ? await readFile(join(ROOT, "tools", "fixtures", "otd-vehicles-sample.pb"))
  : null;
let serveFixture = false;

const failures = [];
const notes = [];
let checks = 0;
function check(cond, msg) {
  checks++;
  if (!cond) failures.push(msg);
  return cond;
}

if (!existsSync(join(DIST, "index.html"))) {
  console.error("\n  no build found — run `npm run build` first\n");
  process.exit(2);
}

// ---------------------------------------------------------------- static server
const PORT = 8700 + Math.floor(Math.random() * 300);
const server = createServer(async (req, res) => {
  const url = decodeURIComponent((req.url || "/").split("?")[0]);

  // The live-bus endpoint, answering exactly as an unconfigured deployment does.
  //
  // Not a convenience: without it this harness misrepresents every real deployment. Vercel always
  // has api/vehicles.ts (at the repo root, where Vercel requires it) and vite preview always has the plugin, and both return 501 with an
  // "unconfigured" body when there is no key. A bare static server returns 404 instead, and the
  // browser logs that as a console error even though the adapter handles it — which is how the
  // console-error gate went red the moment the manifest started permitting the adapter. Serving
  // the documented contract fixes the misrepresentation and exercises the client's unconfigured
  // path, which is the path most viewers will actually take.
  if (url === "/api/vehicles") {
    // Default: the unconfigured contract, as above. With the fixture armed, real captured OTD
    // bytes instead — so the live path is exercised without a key and without the network.
    if (serveFixture && FIXTURE) {
      res.writeHead(200, { "content-type": "application/x-protobuf" });
      res.end(FIXTURE);
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      error: "unconfigured",
      detail: "qa.mjs serves the unconfigured contract: no OTD key in the test environment.",
    }));
    return;
  }
  // the same bytes, fetchable directly, for the decoder check
  if (url === "/qa/otd-vehicles-sample.pb" && FIXTURE) {
    res.writeHead(200, { "content-type": "application/x-protobuf" });
    res.end(FIXTURE);
    return;
  }

  const path = join(DIST, url === "/" ? "index.html" : url);
  try {
    const buf = await readFile(path);
    res.writeHead(200, { "content-type": MIME[extname(path)] || "application/octet-stream" });
    res.end(buf);
  } catch {
    res.writeHead(404).end("not found");
  }
});
await new Promise((r) => server.listen(PORT, "127.0.0.1", r));

// ---------------------------------------------------------------- chrome + CDP
const chrome = spawn(CHROME, [
  "--headless=new", `--remote-debugging-port=${PORT + 1}`,
  "--window-size=1600,1000", "--hide-scrollbars",
  "--use-gl=angle", "--use-angle=metal", "--enable-unsafe-swiftshader",
  "--no-first-run", "--no-default-browser-check",
  `--user-data-dir=/tmp/dpt-qa-${Date.now()}`, "about:blank",
], { stdio: "ignore" });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ws, id = 0;
const pending = new Map();
const consoleErrors = [];

for (let i = 0; i < 60; i++) {
  try {
    const tabs = await (await fetch(`http://127.0.0.1:${PORT + 1}/json/list`)).json();
    const page = tabs.find((t) => t.type === "page");
    if (page) { ws = new WebSocket(page.webSocketDebuggerUrl); break; }
  } catch { /* chrome still starting */ }
  await sleep(250);
}
if (!ws) { console.error("  chrome devtools never came up"); process.exit(2); }
await new Promise((r) => (ws.onopen = r));
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); }
  if (m.method === "Runtime.exceptionThrown") {
    consoleErrors.push(`EXCEPTION ${m.params.exceptionDetails.text}`);
  }
  if (m.method === "Log.entryAdded" && m.params.entry.level === "error") {
    consoleErrors.push(m.params.entry.text);
  }
};
const send = (method, params = {}) => {
  const mid = ++id;
  ws.send(JSON.stringify({ id: mid, method, params }));
  return new Promise((r) => pending.set(mid, r));
};
const evalJs = async (expression) => {
  const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (r?.exceptionDetails) throw new Error(r.exceptionDetails.text);
  return r?.result?.value;
};

await send("Network.enable");
await send("Network.setCacheDisabled", { cacheDisabled: true });
await send("Runtime.enable");
await send("Log.enable");
await send("Page.enable");

async function load(settleMs = 12000) {
  consoleErrors.length = 0;
  await send("Page.navigate", { url: `http://127.0.0.1:${PORT}/` });
  await sleep(settleMs);
}

async function shot(name) {
  if (!WANT_SHOTS) return;
  const s = await send("Page.captureScreenshot", { format: "png" });
  if (s?.data) {
    await mkdir(SHOT_DIR, { recursive: true });
    await writeFile(join(SHOT_DIR, `${name}.png`), Buffer.from(s.data, "base64"));
  }
}

const CLICK = (label) =>
  `[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(label)})?.click()`;

console.log("\n  DELHI PULSE TWIN — browser QA\n");

// ================================================================ 1. cold load
await load();
const boot = await evalJs(`JSON.stringify({
  ready: !!window.__twin,
  fps: window.__twin?.fps?.() ?? 0,
  totals: window.__twin?.totals?.() ?? null,
  layers: (window.__twin?.reports ?? []).map(r => ({ id: r.id, s: r.status, f: r.features })),
  onboarding: !!document.querySelector('.scrim'),
  canvas: (() => { const c = document.querySelector('canvas'); return c ? [c.width, c.height] : null; })(),
  fallback: document.querySelector('.fallback')?.textContent ?? null
})`);
const b = JSON.parse(boot);
check(b.ready, "app never signalled ready");
check(!b.fallback, `app showed a fatal fallback: ${b.fallback}`);
check(b.onboarding, "onboarding overlay did not appear on a cold load");
check(b.canvas && b.canvas[0] > 800, `canvas not sized: ${JSON.stringify(b.canvas)}`);

const cfg = JSON.parse(await readFile(join(ROOT, "..", "config", "study-area.json"), "utf8"));
const FPS_FLOOR = cfg.budgets.fps_floor;
// The budget gates on frame TIME. Headless Chrome presents at 30 Hz here regardless of how fast
// the app is — verified by turning every layer off and still measuring exactly 30 fps — so an fps
// assertion in this harness tests the harness. Frame time is the app's own cost.
const FRAME_MS_MAX = 1000 / FPS_FLOOR;
const DRAW_MAX = cfg.budgets.draw_calls_default_view;
const GPU_MS_MAX = cfg.budgets.gpu_ms_max ?? 16.7;
const TRI_MAX = cfg.budgets.triangles_default_view_m * 1e6;

const unavailable = b.layers.filter((l) => l.s === "unavailable");
check(unavailable.length === 0,
      `layers failed on a cold load: ${unavailable.map((l) => l.id).join(", ")}`);
const empty = b.layers.filter((l) => l.s === "empty");
if (empty.length) notes.push(`empty layers (not a failure): ${empty.map((l) => l.id).join(", ")}`);
console.log(`  layers        ${b.layers.length} registered, ${b.layers.filter(l => l.s === "ready").length} ready`);

await evalJs(CLICK("Explore freely"));
await sleep(2500);
const perf = JSON.parse(await evalJs(`JSON.stringify({
  fps: window.__twin.fps(), frameMs: window.__twin.frameMs(), totals: window.__twin.totals() })`));
console.log(`  performance   ${perf.frameMs.toFixed(1)} ms/frame · ${perf.fps} fps presented · ${perf.totals.drawCalls} draw calls · ${perf.totals.triangles.toLocaleString()} tris`);
check(perf.frameMs > 0 && perf.frameMs < FRAME_MS_MAX,
      `${perf.frameMs.toFixed(1)} ms/frame exceeds the ${FRAME_MS_MAX.toFixed(1)} ms budget (${FPS_FLOOR} fps floor)`);
if (perf.fps < FPS_FLOOR) {
  notes.push(`presented at ${perf.fps} fps — headless Chrome caps this; frame time is the real gate`);
}
check(perf.totals.drawCalls <= DRAW_MAX, `${perf.totals.drawCalls} draw calls over the ${DRAW_MAX} budget`);
check(perf.totals.triangles <= TRI_MAX, `${perf.totals.triangles} triangles over the ${TRI_MAX} budget`);
await shot("01-default-view");

// ---- GPU budget, at a parked camera so the frustum is not changing under the measurement
//
// Each camera is measured TWICE and the lower median is used. This is not cherry-picking, it is
// the only defensible estimator here: thermal throttling, another process on the GPU and a second
// browser window can each only ADD time to a frame, never remove it, so of two samples of the
// same work the smaller is the better estimate of what the build costs.
//
// It matters because this harness produced 12.9 ms and 25.2 ms for the SAME commit at the same
// camera an hour apart, and 23.3 ms then 41.3 ms for another build in consecutive passes. A gate
// that reads one sample turns a hot laptop into a code review comment. The spread is printed so
// an unstable machine is visible rather than silently deciding the result.
async function benchTwice(pos, target, frames = 30) {
  const runs = [];
  for (let i = 0; i < 2; i++) {
    runs.push(JSON.parse(await evalJs(`(async () => JSON.stringify(
      await window.__twin.bench({ pos:[${pos}], target:[${target}], frames: ${frames} })))()`)));
  }
  const ok = runs.filter((r) => r.gpuMedianMs !== null);
  if (!ok.length) return { ...runs[0], gpuSpreadPct: null };
  const best = ok.reduce((a, b) => (b.gpuMedianMs < a.gpuMedianMs ? b : a));
  const worst = ok.reduce((a, b) => (b.gpuMedianMs > a.gpuMedianMs ? b : a));
  return { ...best,
           gpuSpreadPct: best.gpuMedianMs > 0
             ? ((worst.gpuMedianMs - best.gpuMedianMs) / best.gpuMedianMs) * 100 : 0 };
}

const benchWide = await benchTwice("1500,1400,2000", "0,0,0");
const benchClose = await benchTwice("1055,330,-19", "1055,0,-619");
for (const [label, r] of [["wide", benchWide], ["close", benchClose]]) {
  const g = r.gpuMedianMs;
  if (g === null) { notes.push(`GPU timer produced no samples for the ${label} view`); continue; }
  const spread = r.gpuSpreadPct === null ? "" : ` · repeat spread ${r.gpuSpreadPct.toFixed(0)}%`;
  console.log(`  gpu ${label.padEnd(9)} ${g.toFixed(2)} ms best of 2 over ${r.gpuSamples} frames · ${r.submitted.calls} calls · ${r.submitted.triangles.toLocaleString()} tris${spread}`);
  if (r.gpuSpreadPct !== null && r.gpuSpreadPct > 25) {
    notes.push(`${label} view repeated at ${r.gpuSpreadPct.toFixed(0)}% spread — this machine is `
               + `contended or throttling, so treat the absolute GPU figure as an upper bound`);
  }
  check(g < GPU_MS_MAX, `${label} view GPU ${g.toFixed(2)} ms (best of 2, repeat spread `
        + `${r.gpuSpreadPct === null ? "?" : r.gpuSpreadPct.toFixed(0)}%) exceeds the ${GPU_MS_MAX} ms budget`);
  check(r.disjoint === 0 || r.gpuSamples > 10,
        `${label} view: ${r.disjoint} disjoint GPU queries and only ${r.gpuSamples} good samples`);
}
notes.push(`pixel load ${benchWide.pixels.px.toLocaleString()} px at dpr ${benchWide.pixels.dpr}` +
           (benchWide.pixels.dpr < 2 ? " — a Retina display is 4x this, so verify on the device" : ""));

// ---- the low-quality path the PRD requires must actually exist and be cheaper
await evalJs(`window.__twin.setQuality('low')`);
const benchLow = JSON.parse(await evalJs(`(async () => JSON.stringify(
  await window.__twin.bench({ pos:[1055,330,-19], target:[1055,0,-619], frames: 24 })))()`));
await evalJs(`window.__twin.setQuality('medium')`);
if (benchLow.gpuMedianMs !== null && benchClose.gpuMedianMs !== null) {
  console.log(`  gpu low       ${benchLow.gpuMedianMs.toFixed(2)} ms`);
  // A tier that is not measurably cheaper is not a tier. This assertion previously passed by
  // accident and then failed once the tiers were identical, which is how the fake difference in
  // QUALITY_NOTES was found.
  check(benchLow.gpuMedianMs < benchClose.gpuMedianMs * 0.85,
        `low quality (${benchLow.gpuMedianMs.toFixed(2)} ms) is not meaningfully cheaper than `
        + `default (${benchClose.gpuMedianMs.toFixed(2)} ms) — the tiers must differ in something real`);
}

// ---- street furniture must be gated on altitude, or it costs 3-4 ms for sub-pixel geometry
const furn = JSON.parse(await evalJs(`(async () => {
  const t = window.__twin;
  await t.bench({ pos:[0,2400,2600], target:[0,0,0], frames: 6 });
  const high = t.furnitureState();
  await t.bench({ pos:[240,120,-1000], target:[0,0,-1200], frames: 6 });
  const low = t.furnitureState();
  return JSON.stringify({ high, low });
})()`));
check(furn.high.visible === false,
      `street furniture is still drawn from ${furn.high.cameraY} m, above its ${furn.high.gateM} m gate`);
check(furn.low.visible === true,
      `street furniture is missing at ${furn.low.cameraY} m, below its ${furn.low.gateM} m gate`);
const fc = furn.low.counts;
check((fc.lamps ?? 0) > 1500 && (fc.shelters ?? 0) === 166,
      `furniture counts look wrong: ${JSON.stringify(fc)}`);
console.log(`  furniture     ${fc.lamps} lamps, ${fc.shelters} shelters, ${fc.signals} signals · `
            + `off above ${furn.high.gateM} m`);

// ================================================================ 2. no console errors
check(consoleErrors.length === 0,
      `${consoleErrors.length} console error(s): ${consoleErrors.slice(0, 3).join(" | ")}`);

// ================================================================ 2b. select -> evidence (FR-10)
//
// This harness never clicked the city, and so never noticed that the selection drawer had been
// opening *underneath* the scenario lab for as long as both shared `top: 66px; right: 12px`.
// Everything about the drawer was correct except that no one could see it. So the assertion is
// not "the drawer opened" — it is "the drawer is the thing painted at the drawer's own position".
async function clickScene(x, y) {
  for (const type of ["mousePressed", "mouseReleased"]) {
    await send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1, buttons: 1 });
  }
  await sleep(500);
}
let picked = null;
for (const [x, y] of [[620, 500], [500, 620], [760, 430], [900, 560], [430, 470], [1000, 430]]) {
  await clickScene(x, y);
  picked = JSON.parse(await evalJs(`(() => {
    const n = document.getElementById('drawer');
    if (!n || n.classList.contains('hidden')) return JSON.stringify({ open: false });
    const r = n.getBoundingClientRect();
    const at = document.elementFromPoint(r.left + r.width / 2, r.top + 20);
    return JSON.stringify({
      open: true,
      kind: n.querySelector('h2')?.textContent ?? null,
      // what the user's eye actually lands on at the drawer's own top edge
      topmost: at ? (at.closest('[id]')?.id ?? at.tagName) : null,
      // A drawer taller than its column is fine — the column scrolls. What is not fine is a
      // drawer positioned off the side, or one with no usable height showing.
      onScreen: r.top >= 0 && r.top < innerHeight - 200 && r.left >= 0 && r.right <= innerWidth + 1,
      modes: [...n.querySelectorAll('.badge')].map(b => b.textContent.trim()),
      // textContent, not innerText: the labels are uppercased by CSS, so innerText says "PROVIDER"
      provider: /Provider/.test(n.textContent),
    });
  })()`));
  if (picked.open) break;
}
check(picked?.open, "six clicks into the default view selected nothing — the scene is not pickable");
if (picked?.open) {
  check(picked.topmost === "drawer",
        `the selection drawer opened but #${picked.topmost} is painted over it — the click looks like it did nothing`);
  check(picked.onScreen, "the selection drawer opened outside the viewport or with no room to read it");
  check(picked.provider, "the selection drawer carried no provenance block (FR-10)");
  check(picked.modes.length > 0, "the selection drawer stated no data mode");
  console.log(`  selection     ${picked.kind} · modes ${picked.modes.join("/")} · drawer on top`);
}
await shot("01b-selection");
await evalJs(`document.querySelector('#drawer .phead button')?.click()`);
await sleep(300);

// ================================================================ 3. bus-frequency scenario
const busFreq = JSON.parse(await evalJs(`(async () => {
  const B = t => [...document.querySelectorAll('button')].find(b=>b.textContent.trim()===t);
  B('Baba Kharak Singh Marg')?.click(); await new Promise(r=>setTimeout(r,900));
  B('Bus frequency')?.click(); await new Promise(r=>setTimeout(r,300));
  const sl = document.querySelector('#lab input[type=range]');
  if (sl) { sl.value='2'; sl.dispatchEvent(new Event('input',{bubbles:true})); }
  await new Promise(r=>setTimeout(r,300));
  B('Run scenario')?.click(); await new Promise(r=>setTimeout(r,800));
  const rows = [...document.querySelectorAll('#lab .delta')].map(d =>
    [...d.children].map(c=>c.textContent.trim()));
  return JSON.stringify({ badge: document.querySelector('#lab .badge')?.textContent, rows });
})()`));
check(busFreq.badge === "simulated", `scenario badge is "${busFreq.badge}", expected "simulated"`);
const headway = busFreq.rows.find((r) => r[0]?.startsWith("Headway"));
check(!!headway, "bus-frequency run produced no headway delta");
if (headway) {
  const base = parseFloat(headway[1]), scen = parseFloat(headway[3]);
  check(scen < base, `headway did not fall at 2x frequency: ${base} -> ${scen}`);
  console.log(`  bus frequency headway ${base} -> ${scen} min at 2x`);
}
await shot("02-bus-frequency");

// ================================================================ 4. rainfall scenario
await load();
const rain = JSON.parse(await evalJs(`(async () => {
  const B = t => [...document.querySelectorAll('button')].find(b=>b.textContent.trim()===t);
  B('Explore freely')?.click(); await new Promise(r=>setTimeout(r,600));
  B('Barakhamba Road')?.click(); await new Promise(r=>setTimeout(r,900));
  B('Rainfall stress')?.click(); await new Promise(r=>setTimeout(r,300));
  B('Heavy')?.click(); await new Promise(r=>setTimeout(r,500));
  B('Run scenario')?.click(); await new Promise(r=>setTimeout(r,800));
  const rows = [...document.querySelectorAll('#lab .delta')].map(d =>
    [...d.children].map(c=>c.textContent.trim()));
  return JSON.stringify({ rows });
})()`));
const speed = rain.rows.find((r) => r[0] === "Mean speed");
check(!!speed, "rainfall run produced no mean-speed delta");
if (speed) {
  const base = parseFloat(speed[1]), scen = parseFloat(speed[3]);
  check(scen < base, `mean speed did not fall under heavy rain: ${base} -> ${scen}`);
  console.log(`  heavy rain    mean speed ${base} -> ${scen} km/h`);
}

// ================================================================ 4b. reach on foot
//
// The reach field is the first thing in this app that computes a graph at runtime, so the checks
// are about the graph being sound rather than about pixels: a fragmented graph still renders
// something, and that something is wrong. The 45%-connected version rendered perfectly.
await load();
const reach = JSON.parse(await evalJs(`(async () => {
  const B = t => [...document.querySelectorAll('button')].find(b=>b.textContent.trim()===t);
  B('Explore freely')?.click(); await new Promise(r=>setTimeout(r,900));
  const t = window.__twin;
  const g = t.reach.graph();
  t.reach.set(-60, -900, 'walk');
  await new Promise(r=>setTimeout(r,700));
  const walk = t.reach.last();
  t.reach.run('stepfree');
  await new Promise(r=>setTimeout(r,700));
  const free = t.reach.last();
  t.reach.run('metro');
  await new Promise(r=>setTimeout(r,700));
  const metro = t.reach.last();
  return JSON.stringify({ g, walk, free, metro, served: t.reach.servedKm2(),
                          visible: t.reach.visible(),
                          panel: document.getElementById('reach')?.innerText || '' });
})()`));

check(!!reach.g && reach.g.nodes > 3000,
      `walking graph too small: ${reach.g?.nodes} nodes`);
// the fragmentation bug this exact number caught: 45% connected renders fine and answers wrongly
check(reach.g.largestComponentPct > 80,
      `walking graph is fragmented: only ${reach.g.largestComponentPct?.toFixed(1)}% of nodes in the largest component`);
check(reach.g.stepEdges > 50 && reach.g.stepEdges < 400,
      `expected the ~110 stepped ways to survive into the graph, got ${reach.g.stepEdges} edges`);
check(reach.visible === true, "reach overlay did not become visible after a query");

// bands must be cumulative and strictly growing, or the raster is being written wrong
const A = reach.walk?.areasKm2 ?? [];
check(A.length === 5, `expected 5 reach bands, got ${A.length}`);
for (let i = 1; i < A.length; i++) {
  check(A[i] > A[i - 1], `reach band ${i} (${A[i]?.toFixed(2)} km²) is not larger than band ${i - 1}`);
}
check(A[4] < reach.served + 1e-6,
      `25-minute area ${A[4]?.toFixed(2)} km² exceeds the ${reach.served?.toFixed(2)} km² the network can serve at all`);

// removing the stepped ways can only ever take reach away
const F = reach.free?.compareAreasKm2 ?? [];
check(F.length === 5, "step-free comparison produced no bands");
for (let i = 0; i < F.length; i++) {
  check(F[i] <= A[i] + 1e-6,
        `step-free reach at band ${i} (${F[i]?.toFixed(3)}) exceeds the unrestricted reach (${A[i]?.toFixed(3)}) — impossible`);
}

// a detour ratio below 1 would mean walking beat a straight line
check(reach.walk.detour.median >= 1,
      `detour ratio ${reach.walk.detour.median} is below 1, which is geometrically impossible`);
check(reach.walk.detour.p90 >= reach.walk.detour.median, "p90 detour is below the median");

// the origin-free field must cover more ground than any single origin can
check((reach.metro?.areasKm2?.[4] ?? 0) > A[4],
      "the nearest-metro field covers less ground than one walking origin, which cannot be right");

check(/ASSUMPTIONS/i.test(reach.panel), "the reach panel showed a result with no assumptions");
check(/connected component/i.test(reach.panel),
      "the reach panel did not disclose graph fragmentation");
console.log(`  reach         ${reach.g.nodes} nodes, ${reach.g.largestComponentPct.toFixed(1)}% connected · `
            + `15-min ${A[2].toFixed(2)} km² of ${reach.served.toFixed(1)} km² served · `
            + `step-free costs ${reach.free.stepLossPct.toFixed(1)}%`);
await shot("04b-reach");

// ================================================================ 4c. route comparison
//
// The invariants that matter are the ones a plausible-looking wrong answer would violate: the
// lowest-dose route can never inhale more than the quickest one, and the quickest can never take
// longer. Both were briefly false while road edges were charged zero distance to their own traffic.
const rt = JSON.parse(await evalJs(`(async () => {
  const B = t => [...document.querySelectorAll('button')].find(b=>b.textContent.trim()===t);
  B('Explore freely')?.click(); await new Promise(r=>setTimeout(r,900));
  const t = window.__twin;
  const one = t.reach.route(-60, -900, 700, -500);
  await new Promise(r=>setTimeout(r,250));
  // read the panel while the good result is still up: the deliberate failure below replaces it
  const panel = document.getElementById('reach')?.innerText || '';
  // a destination well outside the box must fail, and must not leave the last answer standing
  return JSON.stringify({ one, panel });
})()`));
// shot first: the deliberate failure below replaces this answer, and a screenshot named
// "route" that shows an error state is no use to anyone reviewing the build
await shot("04c-route");
const rtBad = JSON.parse(await evalJs(`(async () => {
  const t = window.__twin;
  // a destination well outside the box must fail, and must not leave the last answer standing
  const bad = t.reach.route(-60, -900, 60000, 60000);
  await new Promise(r=>setTimeout(r,150));
  const afterBad = document.getElementById('reach')?.innerText || '';
  return JSON.stringify({ bad, afterBad });
})()`));
rt.bad = rtBad.bad; rt.afterBad = rtBad.afterBad;

check(!!rt.one && !rt.one.error, `route query failed: ${rt.one?.error ?? "no result"}`);
if (rt.one && !rt.one.error) {
  const { fastest, cleanest } = rt.one;
  check(fastest.minutes > 0 && fastest.points > 1, "quickest route has no length");
  check(cleanest.minutes >= fastest.minutes - 1e-6,
        `the quickest route (${fastest.minutes}) is slower than the lowest-dose one (${cleanest.minutes})`);
  check(cleanest.doseMinutes <= fastest.doseMinutes + 1e-6,
        `the lowest-dose route inhales more (${cleanest.doseMinutes}) than the quickest (${fastest.doseMinutes})`);
  check(fastest.meanEnrich >= 1 && fastest.meanEnrich <= 1.25,
        `kerbside enrichment ${fastest.meanEnrich} is outside the model's 1.00-1.20 range`);
  // the road-centreline bug pinned every route to the peak; a mean at the ceiling means it is back
  check(fastest.meanEnrich < 1.199,
        `mean enrichment ${fastest.meanEnrich} is at the model ceiling — road edges are being charged zero distance to their own traffic again`);
  console.log(`  route         ${fastest.minutes.toFixed(1)} min quickest vs ${cleanest.minutes.toFixed(1)} min lowest-dose · `
              + `enrichment x${fastest.meanEnrich.toFixed(3)} -> x${cleanest.meanEnrich.toFixed(3)} · `
              + `saving ${(rt.one.doseSavedFrac * 100).toFixed(1)}%`);
}
check(!!rt.bad?.error, "a destination outside the mapped network returned a route instead of an error");
check(/no mapped way|140 m/i.test(rt.afterBad),
      "the panel did not say why the out-of-network destination failed");
check(!/Two ways to walk it/.test(rt.afterBad),
      "a failed route query left the previous result on screen");
check(/not the lever/i.test(rt.panel),
      "the route panel did not state the measured ceiling on route choice");
check(/2\.2%/.test(rt.panel), "the route panel did not quote the measured 2.2% ceiling");
await shot("04d-route-out-of-network");



// ================================================================ 5. no predictive wording
const wording = await evalJs(`(() => {
  const t = document.body.innerText;
  const bad = ['will be','will fall','will rise','will improve','will reduce','guaranteed','predicts'];
  return JSON.stringify(bad.filter(p => t.toLowerCase().includes(p)));
})()`);
const badWords = JSON.parse(wording);
check(badWords.length === 0, `predictive wording on screen: ${badWords.join(", ")}`);

// ================================================================ 6. exposure lab
const exposure = JSON.parse(await evalJs(`(async () => {
  const B = t => [...document.querySelectorAll('button')].find(b=>b.textContent.trim()===t);
  B('Air & exposure')?.click(); await new Promise(r=>setTimeout(r,1200));
  const p = document.querySelector('#exposure');
  return JSON.stringify({
    open: p && !p.classList.contains('hidden'),
    pm: p?.querySelector('.pmnum b')?.textContent ?? null,
    who: p?.querySelector('.pmwho')?.textContent ?? null,
    modes: [...(p?.querySelectorAll('.ex-mode') ?? [])].map(x=>x.textContent),
    hasObservedBadge: !!p?.querySelector('.badge'),
    assumptions: (p?.querySelectorAll('.limits li') ?? []).length,
    // the reach panel is open at this point in the run, and both used to occupy the same corner
    topmost: (() => {
      if (!p || p.classList.contains('hidden')) return null;
      const r = p.getBoundingClientRect();
      const at = document.elementFromPoint(r.left + r.width / 2, r.top + 20);
      return at ? (at.closest('[id]')?.id ?? at.tagName) : null;
    })(),
  });
})()`));
check(exposure.open, "exposure panel did not open");
check(exposure.topmost === "exposure",
      `the exposure panel opened but #${exposure.topmost} is painted over it`);
check(exposure.pm !== null, "exposure panel showed no PM2.5 figure");
check(/guideline/i.test(exposure.who ?? ""),
      "exposure panel did not anchor PM2.5 against the WHO guideline");
check(exposure.modes.length >= 3, `only ${exposure.modes.length} travel modes compared`);
check(exposure.assumptions >= 5,
      `only ${exposure.assumptions} assumptions listed — a dose figure needs its coefficients stated`);
console.log(`  exposure      PM2.5 ${exposure.pm} µg/m³, ${exposure.modes.length} modes, ${exposure.assumptions} assumptions`);
await shot("03-exposure");

// ================================================================ 6b. live buses, real bytes
//
// The GTFS-Realtime reader was written and reviewed against Delhi's *empty* midnight feed — a
// bare FeedHeader of varints. It therefore never skipped a length-delimited field, and never ran
// the line that got the skip wrong. The first daytime feed, 1,296 buses, failed on the first
// entity and the layer reported `unavailable`. Nothing caught it because nothing in this harness
// had ever handed the decoder a vehicle. So it does now, from bytes the feed actually sent.
if (!FIXTURE) {
  notes.push("no OTD fixture at tools/fixtures/otd-vehicles-sample.pb — live-bus decoding unchecked");
} else {
  const dec = JSON.parse(await evalJs(`(async () => {
    const r = await fetch('/qa/otd-vehicles-sample.pb', { cache: 'no-store' });
    const bytes = new Uint8Array(await r.arrayBuffer());
    try { return JSON.stringify({ ok: true, ...window.__twin.decodeFeed(bytes) }); }
    catch (e) { return JSON.stringify({ ok: false, error: String(e && e.message || e) }); }
  })()`));
  check(dec.ok, `the GTFS-Realtime decoder threw on real feed bytes: ${dec.error}`);
  if (dec.ok) {
    check(dec.count === 11, `decoded ${dec.count} vehicles from the fixture, expected 11`);
    check(!!dec.feedTime, "decoded no feed timestamp");
    const v = dec.first;
    check(!!v && v.lat > 28 && v.lat < 29 && v.lon > 76 && v.lon < 78,
          `first decoded vehicle is not in Delhi: ${JSON.stringify(v && [v.lat, v.lon])}`);
    check(!!v && typeof v.routeId === "string" && typeof v.id === "string",
          "decoded a position but no route or vehicle identity — the nested messages are being mis-read");
    console.log(`  live decode   ${dec.count} vehicles from real bytes · first ${v?.id} route ${v?.routeId}`);
  }

  // ...and the whole path: proxy contract -> adapter -> layer -> the replay yielding to it.
  // Only when this build is permitted to contact OTD at all, because the manifest is the
  // authority on that and a build made without a key must not be failed for obeying it.
  const permitted = JSON.parse(await evalJs(
    `JSON.stringify(window.__twin.manifest.health.live_adapters.includes('otd_vehicle_positions'))`));
  if (!permitted) {
    notes.push("this build does not permit otd_vehicle_positions, so the live-bus layer path is unchecked "
               + "(rebuild with OTD_API_KEY set to cover it)");
  } else {
    serveFixture = true;
    await load();
    await evalJs(CLICK("Explore freely"));
    await sleep(3500);
    const live = JSON.parse(await evalJs(`JSON.stringify({
      report: (window.__twin.reports || []).find(r => r.id === 'livebuses') ?? null,
      replayVisible: (window.__twin.reports || []).find(r => r.id === 'buses')?.status ?? null,
      chip: (() => { const c = document.querySelector('#mast [data-state]');
                     return c ? { state: c.getAttribute('data-state'), label: c.innerText.trim() } : null; })(),
    })`));
    serveFixture = false;
    check(live.report?.status === "ready",
          `live-bus layer is "${live.report?.status}" on a real feed: ${live.report?.error ?? "no error given"}`);
    check((live.report?.features ?? 0) > 0,
          "the live-bus layer reported ready with no vehicles placed");
    check(live.report?.provenance?.mode === "observed",
          `live positions carry mode "${live.report?.provenance?.mode}" — real vehicles are observed`);
    console.log(`  live buses    ${live.report?.features} placed in box · layer ${live.report?.status} · ${live.report?.provenance?.mode}`);
    check(consoleErrors.length === 0,
          `${consoleErrors.length} console error(s) on the live-bus path: ${consoleErrors.slice(0, 2).join(" | ")}`);
    await shot("05-live-buses");
  }
}

// ================================================================ 6c. the guided story
//
// The five-minute guided story is the Phase 4 exit gate and the thing a reviewer is actually
// shown, and nothing here had ever run it. A story step that throws halfway leaves the demo
// stranded in front of an audience, which is the worst possible place to find out.
await load();
const story = JSON.parse(await evalJs(`(async () => {
  const steps = [];
  // Enter the story the way a viewer does: the onboarding scrim covers everything, so its own
  // button is the only way through. Wait for it rather than assume it — on a loaded machine the
  // overlay can still be a second away when the settle timer expires.
  let card = null;
  for (let i = 0; i < 40 && !card; i++) {
    card = [...document.querySelectorAll('.scrim .card .actions button')]
      .find(b => /guided story/i.test(b.textContent)) ?? null;
    if (!card) await new Promise(r => setTimeout(r, 250));
  }
  if (!card) return JSON.stringify({ steps: [], noOnboarding: true, scrimGone: false, finishOffered: false });
  card.click();
  await new Promise(r => setTimeout(r, 1200));
  for (let i = 0; i < 24; i++) {
    const n = document.getElementById('story');
    if (!n || n.classList.contains('hidden')) break;
    const r = n.getBoundingClientRect();
    const at = document.elementFromPoint(r.left + r.width / 2, r.top + 14);
    steps.push({
      title: n.querySelector('h3')?.textContent ?? null,
      body: n.querySelector('p')?.textContent?.length ?? 0,
      progress: n.querySelector('.prog')?.textContent ?? null,
      topmost: at ? (at.closest('[id]')?.id ?? at.tagName) : null,
      onScreen: r.top >= 0 && r.bottom <= innerHeight + 1,
    });
    const next = [...n.querySelectorAll('button')].find(b => /next|→|›/i.test(b.textContent));
    if (!next || next.disabled) break;
    next.click();
    await new Promise(r => setTimeout(r, 1100));
  }
  const last = document.getElementById('story');
  return JSON.stringify({
    steps,
    finishOffered: [...(last?.querySelectorAll('button') ?? [])].some(b => /finish/i.test(b.textContent)),
    scrimGone: !document.querySelector('.scrim'),
  });
})()`));
check(!story.noOnboarding, "the onboarding overlay never appeared, so the story was never entered");
check(story.scrimGone, "the onboarding overlay survived its own guided-story button");
check(story.steps.length >= 8,
      `the guided story stopped after ${story.steps.length} step(s) — it is the demo path`);
check(story.steps.every(s => s.title && s.body > 60),
      "a guided-story step rendered without a title or with almost no body text");
check(story.steps.every(s => s.topmost === "story"),
      `a guided-story step was painted over by #${story.steps.find(s => s.topmost !== "story")?.topmost}`);
check(story.steps.every(s => s.onScreen), "a guided-story step rendered outside the viewport");
check(story.finishOffered, "the last story step offered no way to finish");
check(consoleErrors.length === 0,
      `${consoleErrors.length} console error(s) during the guided story: ${consoleErrors.slice(0, 2).join(" | ")}`);
console.log(`  guided story  ${story.steps.length} steps, all rendered and on top, no errors`);
await shot("06-guided-story");

// ================================================================ 7. FR-01 degradation
const MOVE = ["corridors.json", "ground.json"];
for (const f of MOVE) await rename(join(DIST, "data", "@v1", f), join(DIST, "data", "@v1", `${f}.qabak`));
try {
  await load();
  const deg = JSON.parse(await evalJs(`(async () => {
    const B = t => [...document.querySelectorAll('button')].find(b=>b.textContent.trim()===t);
    B('Explore freely')?.click(); await new Promise(r=>setTimeout(r,900));
    return JSON.stringify({
      alive: !!window.__twin, fps: window.__twin?.fps?.() ?? 0,
      frameMs: window.__twin?.frameMs?.() ?? 0,
      layers: (window.__twin?.reports ?? []).map(r => r.id + ':' + r.status),
      labMsg: document.querySelector('#lab .disabled-reason')?.textContent?.slice(0,60) ?? null,
      fallback: !!document.querySelector('.fallback')
    });
  })()`));
  check(deg.alive && !deg.fallback, "removing two data files took the whole app down (FR-01)");
  check(deg.frameMs > 0 && deg.frameMs < FRAME_MS_MAX,
        `degraded scene at ${deg.frameMs.toFixed(1)} ms/frame, over the ${FRAME_MS_MAX.toFixed(1)} ms budget`);
  const down = deg.layers.filter((l) => l.endsWith(":unavailable"));
  check(down.length === 2, `expected 2 unavailable layers, got ${down.length}: ${down.join(", ")}`);
  check(!!deg.labMsg, "Scenario Lab did not state why it was unavailable");
  console.log(`  FR-01         app alive at ${deg.frameMs.toFixed(1)} ms/frame with ${down.length} layers down`);
  await shot("04-degraded");
} finally {
  for (const f of MOVE) await rename(join(DIST, "data", "@v1", `${f}.qabak`), join(DIST, "data", "@v1", f));
}

// ================================================================ report
ws.close(); chrome.kill(); server.close();

console.log("");
for (const n of notes) console.log(`  note: ${n}`);
if (failures.length) {
  console.error(`  BROWSER QA FAILED — ${failures.length} of ${checks} checks\n`);
  for (const f of failures) console.error(`    - ${f}`);
  console.error("");
  process.exit(1);
}
console.log(`  all ${checks} browser checks passed\n`);
process.exit(0);
