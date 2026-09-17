#!/usr/bin/env node
/**
 * Records a short demo reel of the running app.
 *
 * Why Playwright when `tools/qa.mjs` already drives Chrome over raw CDP and the project's stated
 * preference is one fewer dependency: CDP can screencast frames but cannot encode them, and this
 * machine has no ffmpeg. Playwright ships its own encoder alongside the browser, so it is the
 * dependency that actually buys something. It is a devDependency and nothing in web/src imports
 * it — the shipped bundle is unchanged.
 *
 * Everything here is driven through the real UI: the Places search, the reveal toggle, a click on
 * an actual building, the time slider, and mouse-drag orbits against OrbitControls. Nothing is
 * staged through a back door, so the reel cannot show something a viewer could not reproduce.
 *
 *   npm run reel              # build must exist; spawns its own preview server
 *   npm run reel -- --headed  # watch it being recorded
 *
 * Output: spike/results/reel/delhi-pulse-twin-<date>.webm
 */
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { mkdir, rename, readdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const WEB = dirname(dirname(fileURLToPath(import.meta.url)));
const ROOT = dirname(WEB);
const OUT_DIR = join(ROOT, "spike", "results", "reel");
const RAW_DIR = join(OUT_DIR, ".raw");
const PORT = 4188;
const W = 1600, H = 900;
const HEADED = process.argv.includes("--headed");

if (!existsSync(join(WEB, "dist", "index.html"))) {
  console.error("\n  no build found — run `npm run build` first\n");
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- preview server
// `vite preview`, not a bare static server: it carries the OTD middleware, so /api/vehicles is
// answered exactly as it is in production and the reel can show real live buses.
console.log("  starting preview server…");
const server = spawn("npx", ["vite", "preview", "--port", String(PORT), "--strictPort"], {
  cwd: WEB, stdio: "ignore", env: { ...process.env },
});
const stop = () => { try { server.kill(); } catch { /* already gone */ } };
process.on("exit", stop);
process.on("SIGINT", () => { stop(); process.exit(130); });

for (let i = 0; i < 60; i++) {
  try { if ((await fetch(`http://127.0.0.1:${PORT}/`)).ok) break; } catch { /* still starting */ }
  await sleep(250);
}

// ---------------------------------------------------------------- browser
await rm(RAW_DIR, { recursive: true, force: true });
await mkdir(RAW_DIR, { recursive: true });

const browser = await chromium.launch({
  headless: !HEADED,
  args: [
    // the same GPU flags the QA harness uses: without them headless falls back to a software
    // rasteriser and the reel records a slideshow of a city instead of a city
    "--use-gl=angle", "--use-angle=metal", "--enable-unsafe-swiftshader",
    "--hide-scrollbars", "--mute-audio",
  ],
});
const context = await browser.newContext({
  viewport: { width: W, height: H },
  deviceScaleFactor: 1,
  recordVideo: { dir: RAW_DIR, size: { width: W, height: H } },
});
const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });

// ---------------------------------------------------------------- shot helpers
const hold = (ms) => page.waitForTimeout(ms);

/** Orbit by dragging, which is what a viewer would do. dx/dy in pixels, spread over `steps`. */
async function orbit(dx, dy, steps = 60, pause = 16) {
  const cx = W / 2, cy = H / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(cx + (dx * i) / steps, cy + (dy * i) / steps);
    await sleep(pause);
  }
  await page.mouse.up();
}

/** Jump via the real Places search, which triggers the app's own eased flight. */
async function flyTo(name, settle = 2600) {
  await page.click('#mast >> text="Places"');
  await hold(500);
  await page.fill("#places .psearch", name);
  await hold(600);
  await page.press("#places .psearch", "Enter");
  await hold(settle);
}

/** Drag the clock. The slider is in minutes since midnight, 240..1400. */
async function setTime(minutes, steps = 24) {
  const box = await page.locator("#timebar .slider").boundingBox();
  const frac = (minutes - 240) / (1400 - 240);
  const x0 = box.x + 8, span = box.width - 16;
  const cur = Number(await page.inputValue("#timebar .slider"));
  const f0 = (cur - 240) / (1400 - 240);
  const y = box.y + box.height / 2;
  await page.mouse.move(x0 + span * f0, y);
  await page.mouse.down();
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(x0 + span * (f0 + (frac - f0) * (i / steps)), y);
    await sleep(22);
  }
  await page.mouse.up();
}

// ================================================================ the reel
//
// Sequenced so every shot is legible: the landmark tour stays in daylight, because Rashtrapati
// Bhavan and South Block are stone and go to silhouette after dark, and the night is saved for
// the closer, where a lit city is the point rather than the obstacle.
console.log("  recording…");
await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: "load" });
await page.waitForFunction("!!window.__twin?.ready", null, { timeout: 45000 });
await hold(1000);

// 1 — the opening card. It states what the app can and cannot claim before it shows anything,
// which is the argument, so it gets screen time rather than being clicked away.
await page.waitForSelector(".scrim .card", { timeout: 15000 });
await hold(4000);
await page.click('.scrim .card .actions >> text="Explore freely"');
await hold(1400);

// 2 — establishing. Lutyens' Delhi from the south-east.
await orbit(-170, 0, 55, 18);
await hold(500);

// 3 — building heights: where each one came from, then one building's own story.
await flyTo("Connaught Place", 2800);
await orbit(-80, 0, 32, 18);
await page.click('[aria-label="Reveal estimated building heights"]');
await hold(2400);                       // the legend rewrites itself to three height sources
await orbit(60, 0, 28, 18);
await hold(600);

// click buildings until one opens the drawer — the scene is picked by ray, so a fixed point is
// not guaranteed to hit
for (const [x, y] of [[700, 520], [560, 600], [880, 470], [430, 560], [1000, 600]]) {
  await page.mouse.click(x, y);
  await hold(600);
  if (await page.locator("#drawer:not(.hidden)").count()) break;
}
await hold(4200);                       // measured or assigned, the rule, then the provenance
await page.click("#drawer .phead button");
await page.click('[aria-label="Reveal estimated building heights"]');
await hold(500);

// 4 — live air. The number, the WHO multiple, and why the air is like this.
await page.click('#mast >> text="Air & exposure"');
await hold(4600);
await page.locator("#rightrail").evaluate((n) => n.scrollTo({ top: 430, behavior: "smooth" }));
await hold(3200);
await page.click('#mast >> text="Air & exposure"');
await hold(500);

// 5 — India Gate, in daylight, where the arch reads.
await flyTo("India Gate", 3000);
await orbit(-140, -25, 52, 18);
await hold(700);

// 6 — the Kartavya Path axis, still in daylight: South Block, then Rashtrapati Bhavan on its rise.
await flyTo("South Block", 2800);
await orbit(-110, 0, 44, 18);
await flyTo("Rashtrapati Bhavan", 3000);
await orbit(-120, -15, 48, 18);
await hold(900);

// 7 — the closer: the clock run to dusk over Connaught Place, where a lit city is the shot.
await flyTo("Connaught Place", 2800);
await setTime(18 * 60 + 40);
await hold(2400);                       // the lamps and the lit windows come up
await orbit(-150, 0, 56, 18);
await hold(1400);

// ================================================================ save
const video = page.video();
await context.close();
await browser.close();
stop();

await mkdir(OUT_DIR, { recursive: true });
const stamp = new Date().toISOString().slice(0, 10);
const webm = join(OUT_DIR, `delhi-pulse-twin-${stamp}.webm`);
await rename(await video.path(), webm);
await rm(RAW_DIR, { recursive: true, force: true });
console.log(`\n  reel saved  ${webm.replace(ROOT + "/", "")}`);

// H.264 alongside the WebM, because the reel exists to be shown. VP8 in a .webm plays in Chrome,
// Firefox and VLC and in very little else — not QuickTime, not Keynote, not PowerPoint, not most
// phones. Transcoding is skipped rather than failed if ffmpeg is absent: the WebM is still the
// recording, and a missing optional tool should not lose it.
const mp4 = webm.replace(/\.webm$/, ".mp4");
const ff = spawn("ffmpeg", [
  "-loglevel", "error", "-y", "-i", webm,
  "-c:v", "libx264", "-preset", "slow", "-crf", "23",
  // yuv420p and an even frame size are what the awkward players actually require
  "-pix_fmt", "yuv420p", "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2",
  "-r", "30", "-movflags", "+faststart", mp4,
], { stdio: "inherit" });
const code = await new Promise((r) => { ff.on("error", () => r(-1)); ff.on("close", r); });
if (code === 0) console.log(`  mp4 saved   ${mp4.replace(ROOT + "/", "")}`);
else console.log("  note: no ffmpeg on PATH — kept the .webm only (brew install ffmpeg)");

const left = (await readdir(OUT_DIR)).filter((f) => /\.(webm|mp4)$/.test(f));
console.log(`  in ${OUT_DIR.replace(ROOT + "/", "")}: ${left.join(", ")}`);
if (errors.length) console.log(`  note: ${errors.length} console error(s): ${errors.slice(0, 3).join(" | ")}`);
process.exit(0);
