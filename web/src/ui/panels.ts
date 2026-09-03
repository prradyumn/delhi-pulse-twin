import { el, clear, hhmm, kb, toggleButton } from "./dom";
import { store, type RainBand } from "../state/store";
import type { LayerReport } from "../layers/registry";
import { PALETTE, TRAFFIC_LABELS } from "../layers/palette";
import type { Manifest, WeatherData } from "../geo/types";
import { modeLabel } from "../geo/load";

const hex = (c: { getHexString(): string }) => `#${c.getHexString()}`;

/* ------------------------------------------------------------------ masthead */
export function masthead(m: Manifest) {
  const clock = el("span", { class: "stat" });
  const fps = el("span", { class: "stat" });
  const statusBtn = el("button", { class: "chip", text: "Data status" });
  const storyBtn = el("button", { class: "btn", text: "Guided story" });

  const node = el("header", { id: "mast" },
    el("div", { class: "brand" },
      el("strong", { text: "Delhi Pulse Twin" }),
      el("span", { text: `${m.study_area.id} · ${m.dataset_version} · transform ${m.transform_version}` })),
    el("div", { class: "spacer" }),
    clock, fps,
    el("span", { class: "chip", text: `${m.health.live_adapters.length} live feeds` }),
    statusBtn, storyBtn);

  const render = () => {
    const s = store.get();
    clear(clock);
    clock.append(el("b", { text: hhmm(s.timeMin) }), " local");
    clear(fps);
    const ok = s.fps >= 30;
    fps.append(el("b", { text: String(s.fps), style: ok ? "" : "color:var(--warn)" }), " fps");
  };
  store.on(render); render();
  return { node, statusBtn, storyBtn };
}

/* ------------------------------------------------------------------ layer rail */
export function layerRail(order: string[], onToggle: (id: string, on: boolean) => void,
                          onReveal: (on: boolean) => void) {
  const body = el("div", { class: "pbody" });
  const node = el("aside", { class: "panel", id: "rail" },
    el("div", { class: "phead" }, el("h2", { text: "Layers" })), body);

  let reports = new Map<string, LayerReport>();

  const render = () => {
    const s = store.get();
    clear(body);
    for (const id of order) {
      const r = reports.get(id);
      if (!r) continue;
      const on = s.layers[id] ?? true;
      const mode = r.provenance?.mode;
      const row = el("button", {
        class: "lrow", "data-status": r.status, "data-on": String(on),
        title: r.error ?? r.provenance?.dataset ?? r.label,
      },
        el("span", { class: "dot" }),
        el("span", { class: "name", text: r.label }),
        el("span", { class: `mode ${mode ? `mode-${mode}` : "mode-none"}`,
                     text: r.status === "unavailable" ? "failed"
                         : r.status === "empty" ? "empty"
                         : mode ? modeLabel(mode) : "—" }));
      row.addEventListener("click", () => onToggle(id, !on));
      body.append(row);
    }

    // The reveal toggle is a trust control, not a display option: ~92% of this box is estimated.
    const sub = el("div", { class: "subrow" },
      el("span", { text: "Reveal estimated heights" }),
      toggleButton(s.revealEstimated, () => onReveal(!store.get().revealEstimated),
                   "Reveal estimated building heights"));
    body.append(sub);
  };

  return {
    node,
    update(rs: LayerReport[]) { reports = new Map(rs.map((r) => [r.id, r])); render(); },
    refresh: render,
  };
}

/* ------------------------------------------------------------------ legend */
export function legend() {
  const body = el("div", { class: "pbody" });
  const node = el("aside", { class: "panel", id: "legend" },
    el("div", { class: "phead" }, el("h2", { text: "Legend" })), body);

  const swatch = (color: string, label: string) =>
    el("div", { class: "lgrow" }, el("span", { class: "sw", style: `background:${color}` }),
       el("span", { text: label }));

  const render = () => {
    clear(body);
    body.append(el("div", { class: "ramp" },
      ...PALETTE.traffic.map((c) => el("i", { style: `background:${hex(c)}` }))));
    body.append(el("div", { class: "ramp-labels" },
      el("span", { text: TRAFFIC_LABELS[0] }),
      el("span", { text: TRAFFIC_LABELS[TRAFFIC_LABELS.length - 1] })));
    body.append(el("p", { class: "note", style: "margin:6px 0 8px;font-size:11px",
      text: "Corridor colour is estimated from a declared time-of-day heuristic, not observed speeds." }));

    if (store.get().revealEstimated) {
      body.append(swatch(hex(PALETTE.revealObserved), "Height measured in OSM"));
      body.append(swatch(hex(PALETTE.revealEstimated), "Height estimated by rule v0.1"));
    } else {
      body.append(swatch(hex(PALETTE.buildingObserved), "Buildings"));
    }
    body.append(swatch(hex(PALETTE.green), "Parks, lawns & gardens"));
    body.append(swatch(hex(PALETTE.water), "Water"));
    body.append(swatch(hex(PALETTE.metro), "Metro & stations"));
    body.append(swatch(hex(PALETTE.bus), "Bus (replay)"));
  };
  store.on((_s, changed) => { if (changed.includes("revealEstimated")) render(); });
  render();
  return { node };
}

/* ------------------------------------------------------------------ time bar */
const BANDS: RainBand[] = ["none", "light", "moderate", "heavy", "very_heavy"];

export function timeBar(weather: WeatherData | null,
                        onTime: (min: number) => void,
                        onPlay: (playing: boolean) => void,
                        onRain: (b: RainBand) => void) {
  const clock = el("div", { class: "clock" });
  const slider = el("input", { type: "range", min: "240", max: "1400", step: "1",
                               class: "slider", "aria-label": "Time of day" }) as HTMLInputElement;
  const play = el("button", { class: "btn", text: "Play" });
  const rain = el("div", { class: "rainsel", role: "group", "aria-label": "Rainfall band" });

  const node = el("div", { class: "panel", id: "timebar" }, clock, slider, play, rain);

  slider.addEventListener("input", () => onTime(Number(slider.value)));
  play.addEventListener("click", () => onPlay(!store.get().playing));

  const bandMeta = (id: RainBand) => weather?.rain_bands.find((b) => b.id === id);

  const renderRain = () => {
    const s = store.get();
    clear(rain);
    for (const b of BANDS) {
      const meta = bandMeta(b);
      const btn = el("button", {
        "aria-pressed": String(s.rain === b),
        text: meta?.label ?? b,
        title: meta?.imd ? `${meta.label} — IMD band ${meta.imd}` : String(meta?.label ?? b),
      });
      btn.addEventListener("click", () => onRain(b));
      rain.append(btn);
    }
  };

  const render = () => {
    const s = store.get();
    clear(clock);
    clock.append(el("span", { text: hhmm(s.timeMin) }),
                 el("small", { text: s.rain === "none" ? "WEEKDAY · DRY" : `WEEKDAY · RAIN ${s.rain.replace("_", " ").toUpperCase()}` }));
    if (slider.value !== String(Math.round(s.timeMin))) slider.value = String(Math.round(s.timeMin));
    play.textContent = s.playing ? "Pause" : "Play";
    play.className = s.playing ? "btn on" : "btn";
    renderRain();
  };
  store.on(render); render();
  return { node };
}

/* ------------------------------------------------------------------ data status */
export function dataStatus(m: Manifest, reports: LayerReport[]) {
  const rows = reports.map((r) =>
    el("div", { class: "metric" },
      el("span", { class: "m-l" },
        el("span", { text: r.label }),
        r.provenance
          ? el("span", { class: `mode mode-${r.provenance.mode}`, text: ` ${modeLabel(r.provenance.mode)}` })
          : null),
      el("span", { class: "m-v", style: r.status === "unavailable" ? "color:var(--warn)" : "",
                   text: r.status === "ready" ? `${r.features.toLocaleString()} · ${kb(r.bytes)}`
                       : r.status === "empty" ? "no features"
                       : r.status === "unavailable" ? "unavailable" : "pending" })));

  const failed = reports.filter((r) => r.status === "unavailable");
  const totals = reports.reduce((a, r) => ({ dc: a.dc + r.drawCalls, tri: a.tri + r.triangles, b: a.b + r.bytes }),
                                { dc: 0, tri: 0, b: 0 });

  const card = el("div", { class: "card" },
    el("h1", { text: "Data status" }),
    el("p", { class: "lede", text: m.health.note }),
    el("h3", { class: "sub", text: "Layers" }), ...rows,
    el("h3", { class: "sub", text: "Budget" }),
    el("div", { class: "kv" },
      el("dt", { text: "Payload" }), el("dd", { class: "num", text: kb(totals.b) }),
      el("dt", { text: "Draw calls" }), el("dd", { class: "num", text: String(totals.dc) }),
      el("dt", { text: "Triangles" }), el("dd", { class: "num", text: totals.tri.toLocaleString() }),
      el("dt", { text: "Frame rate" }), el("dd", { class: "num", text: `${store.get().fps} fps` })),
    el("p", { class: "note", style: "margin-top:8px;font-size:11px",
      text: "Payload is the decoded size of the data files. Compressed transfer over the network is roughly a third of it — run `npm run budget` for the measured gzip figures the build gates on." }),
    failed.length
      ? el("div", { class: "disabled-reason" },
          el("strong", { text: `${failed.length} layer(s) unavailable. ` }),
          `The scene still loaded — layers fail independently. ${failed.map((f) => `${f.label}: ${f.error ?? "unknown"}`).join("; ")}`)
      : el("p", { class: "note", style: "margin-top:12px",
                  text: "All layers resolved. No live provider was contacted: every layer here is bundled and versioned." }),
    el("h3", { class: "sub", text: "Attribution" }),
    el("ul", { class: "limits" }, ...m.attribution.map((a) => el("li", { text: a }))));

  const scrim = el("div", { class: "scrim" }, card);
  const close = el("button", { class: "btn", text: "Close" });
  card.append(el("div", { class: "actions" }, close));
  const dismiss = () => scrim.remove();
  close.addEventListener("click", dismiss);
  scrim.addEventListener("click", (e) => { if (e.target === scrim) dismiss(); });
  return scrim;
}

/* ------------------------------------------------------------------ onboarding */
export function onboarding(m: Manifest, onExplore: () => void, onStory: () => void) {
  const est = m.height_rule.disclosure;
  const card = el("div", { class: "card" },
    el("h1", { text: "Delhi Pulse Twin" }),
    el("p", { class: "lede",
      text: `One locked ${m.study_area.measured_extent_m[0]} × ${m.study_area.measured_extent_m[1]} m box of Central Delhi — Connaught Place to India Gate. Layers of place, time and movement you can interrogate, plus two bounded scenarios you can test against a baseline.` }),

    el("h3", { class: "sub", text: "Every layer states what kind of number it is" }),
    el("div", { class: "modegrid" },
      el("div", {}, el("h4", { class: "mode-observed", text: "Observed" }),
        el("p", { text: "Measured by someone and timestamped. OSM geometry, the bundled weather snapshot." })),
      el("div", {}, el("h4", { class: "mode-estimated", text: "Estimated" }),
        el("p", { text: "Derived by a declared rule you can read. Building heights, corridor traffic." })),
      el("div", {}, el("h4", { class: "mode-simulated", text: "Simulated" }),
        el("p", { text: "Scenario output. Phrased as estimates under stated assumptions — never as a forecast." })),
      el("div", {}, el("h4", { class: "mode-replay", text: "Replay" }),
        el("p", { text: "Deterministic movement from a route sequence. Not live vehicle positions." }))),

    el("h3", { class: "sub", text: "What this can and cannot claim" }),
    el("ul", { class: "limits" },
      el("li", { text: est }),
      el("li", { text: "Corridor traffic is a declared time-of-day heuristic. No open Delhi speed dataset was obtainable, so nothing here is an observed speed." }),
      el("li", { text: "Bus movement is replay from OpenStreetMap route relations. There is no schedule in the source, so headway is an assumption." }),
      el("li", { text: "Not a forecast, not routing advice, and not a substitute for official transport or disaster-management systems." })),

    el("p", { class: "note", style: "margin-top:14px",
      text: `Runs entirely from bundled data — ${kb(m.total_uncompressed_bytes)} across ${Object.keys(m.assets).length} versioned files, no live provider required.` }));

  const bStory = el("button", { class: "btn primary", text: "Take the 4-minute guided story" });
  const bExplore = el("button", { class: "btn", text: "Explore freely" });
  card.append(el("div", { class: "actions" }, bStory, bExplore));

  const scrim = el("div", { class: "scrim" }, card);
  bStory.addEventListener("click", () => { scrim.remove(); onStory(); });
  bExplore.addEventListener("click", () => { scrim.remove(); onExplore(); });
  return scrim;
}
