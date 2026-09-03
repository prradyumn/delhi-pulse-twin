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

// ================================================================ 2. no console errors
check(consoleErrors.length === 0,
      `${consoleErrors.length} console error(s): ${consoleErrors.slice(0, 3).join(" | ")}`);

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
    assumptions: (p?.querySelectorAll('.limits li') ?? []).length
  });
})()`));
check(exposure.open, "exposure panel did not open");
check(exposure.pm !== null, "exposure panel showed no PM2.5 figure");
check(/guideline/i.test(exposure.who ?? ""),
      "exposure panel did not anchor PM2.5 against the WHO guideline");
check(exposure.modes.length >= 3, `only ${exposure.modes.length} travel modes compared`);
check(exposure.assumptions >= 5,
      `only ${exposure.assumptions} assumptions listed — a dose figure needs its coefficients stated`);
console.log(`  exposure      PM2.5 ${exposure.pm} µg/m³, ${exposure.modes.length} modes, ${exposure.assumptions} assumptions`);
await shot("03-exposure");

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
