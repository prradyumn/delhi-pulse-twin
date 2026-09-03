import { el, clear, hhmm } from "./dom";
import { store } from "../state/store";
import type { Corridor, ScenarioModel, Manifest } from "../geo/types";
import type { CorridorMetrics, Delta } from "../scenario/engine";
import { compare } from "../scenario/engine";

const n1 = (v: number) => v.toFixed(1);

export interface LabHandlers {
  onCorridor(id: string): void;
  onScenario(s: null | "bus_frequency" | "rainfall"): void;
  onFreq(mult: number): void;
  onRun(): void;
  onReset(): void;
  onExport(): void;
}

/**
 * A scenario cannot be mistaken for a forecast: the badge is always visible, the assumptions are
 * printed before and after Run, Reset restores the exact baseline snapshot, and no output says
 * "will". Weights come from the loaded model file and are shown next to the numbers they produce.
 */
export function scenarioLab(corridors: Corridor[], model: ScenarioModel, h: LabHandlers) {
  const body = el("div", { class: "pbody" });
  const node = el("aside", { class: "panel", id: "lab" },
    el("div", { class: "phead" },
      el("h2", { text: "Scenario Lab" }),
      el("span", { class: "badge base", text: "baseline" })), body);
  const badge = node.querySelector(".badge") as HTMLElement;

  let baseline: CorridorMetrics | null = null;
  let scenario: CorridorMetrics | null = null;

  function metricRow(label: string, value: string, note?: string) {
    return el("div", {},
      el("div", { class: "metric" },
        el("span", { class: "m-l", text: label }),
        el("span", { class: "m-v", text: value })),
      note ? el("p", { class: "dnote", text: note }) : null);
  }

  function deltaRow(d: Delta) {
    const improved = d.direction === "flat" ? null
      : (d.direction === "down") === d.lowerIsBetter;
    const cls = improved === null ? "flat" : improved ? "better" : "worse";
    const arrow = d.direction === "flat" ? "–" : d.direction === "up" ? "▲" : "▼";
    return el("div", { class: "delta" },
      el("span", { class: "d-l", text: d.label }),
      el("span", { class: "d-b", text: d.baseline }),
      el("span", { class: `d-a ${cls}`, text: arrow }),
      el("span", { class: "d-s", text: d.scenario }),
      d.note ? el("p", { class: "dnote", text: d.note }) : null);
  }

  function assumptions(active: string | null) {
    const s = store.get();
    const items: string[] = [
      `Baseline dataset v1, transform v${model.version === "0.1" ? "0.1.0" : model.version}, scenario model v${model.version}.`,
      `Corridor traffic uses the declared diurnal profile, not observed speeds.`,
      `MSI weights — speed ${model.msi_weights.speed_penalty}, transit ${model.msi_weights.transit_pressure}, weather ${model.msi_weights.weather_impact}.`,
    ];
    if (active === "bus_frequency") {
      items.push(`Baseline headway is an assumption of 12 minutes per route. No schedule exists in the source data.`);
      items.push(`Wait proxy is ${model.wait_proxy}.`);
      items.push(`Frequency multiplier ${s.busFreqMultiplier.toFixed(2)}× applied to combined corridor headway.`);
    }
    if (active === "rainfall") {
      const mult = model.rain_speed_multiplier[s.rain];
      items.push(`Rain band "${s.rain}" applies a declared speed multiplier of ${mult?.secondary ?? 1} on secondary roads.`);
      items.push(`This is a mobility-stress heuristic. It does not model flooding, drainage or water depth.`);
    }
    return el("div", {},
      el("h3", { class: "sub", text: "Assumptions" }),
      el("ul", { class: "limits" }, ...items.map((t) => el("li", { text: t }))));
  }

  function render() {
    const s = store.get();
    clear(body);

    // FR-01: layers fail independently. Without corridor geometry there is nothing to run a
    // scenario against, so the lab says so plainly instead of throwing and taking the app down.
    if (!corridors.length) {
      body.append(el("div", { class: "disabled-reason" },
        el("strong", { text: "Corridor geometry is unavailable. " }),
        "The Scenario Lab needs corridor spines to compute against. The rest of the scene is unaffected — check Data status for the failure."));
      badge.className = "badge base";
      badge.textContent = "unavailable";
      return;
    }

    const active = s.activeCorridor
      ? corridors.find((c) => c.id === s.activeCorridor) ?? corridors[0]
      : corridors[0];

    // --- corridor picker
    const pick = el("div", { class: "field" }, el("label", { text: "Corridor" }));
    const row = el("div", { class: "row", style: "flex-wrap:wrap;gap:4px" });
    for (const c of corridors) {
      const b = el("button", {
        class: s.activeCorridor === c.id ? "btn on" : "btn",
        style: "font-size:11px;padding:5px 8px", text: c.label,
        title: `${c.role} · ${n1(c.spine_len)} m`,
      });
      b.addEventListener("click", () => h.onCorridor(c.id));
      row.append(b);
    }
    pick.append(row);
    body.append(pick);

    // --- scenario picker
    const sc = el("div", { class: "field" }, el("label", { text: "Change one variable" }));
    const scRow = el("div", { class: "row", style: "flex-wrap:wrap;gap:4px" });
    const opts: [null | "bus_frequency" | "rainfall", string][] = [
      [null, "Baseline"], ["bus_frequency", "Bus frequency"], ["rainfall", "Rainfall stress"],
    ];
    const hasTransit = active.layers.includes("transit");
    for (const [id, label] of opts) {
      const disabled = id === "bus_frequency" && !hasTransit;
      const b = el("button", {
        class: s.scenario === id ? "btn on" : "btn",
        style: `font-size:11px;padding:5px 8px${disabled ? ";opacity:.45;cursor:not-allowed" : ""}`,
        text: label, disabled,
        title: disabled ? active.no_transit_reason ?? "No transit on this corridor" : label,
      });
      if (!disabled) b.addEventListener("click", () => h.onScenario(id));
      scRow.append(b);
    }
    sc.append(scRow);
    body.append(sc);

    if (!hasTransit) {
      body.append(el("div", { class: "disabled-reason" },
        el("strong", { text: "Bus frequency is unavailable here. " }),
        active.no_transit_reason ?? "This corridor has no transit layer."));
    }

    // --- parameter
    if (s.scenario === "bus_frequency" && hasTransit) {
      const f = el("div", { class: "field" }, el("label", { text: "Service frequency" }));
      const sl = el("input", { type: "range", min: "0.5", max: "3", step: "0.1",
        value: String(s.busFreqMultiplier), class: "slider",
        "aria-label": "Bus frequency multiplier" }) as HTMLInputElement;
      const v = el("span", { class: "val", text: `${s.busFreqMultiplier.toFixed(1)}×` });
      sl.addEventListener("input", () => h.onFreq(Number(sl.value)));
      f.append(el("div", { class: "row" }, sl, v));
      body.append(f);
    }
    if (s.scenario === "rainfall") {
      body.append(el("p", { class: "note",
        text: "Set the rainfall band on the time bar below, then run. The band drives a declared speed penalty by road class." }));
    }

    // --- baseline metrics, always visible
    if (baseline) {
      body.append(el("h3", { class: "sub", text: `Baseline at ${hhmm(baseline.timeMin)}` }));
      body.append(metricRow("Mean speed", `${n1(baseline.meanSpeedKmh)} km/h`));
      body.append(metricRow("Travel time", `${n1(baseline.travelTimeMin)} min`,
        `Along the ${n1(active.spine_len)} m spine.`));
      body.append(metricRow("Mobility Stress Index", baseline.msi.toFixed(2),
        baseline.msiWeightsRenormalised ? "Transit weight redistributed — no transit on this corridor." : undefined));
      if (baseline.busesPerHour !== null) {
        body.append(metricRow("Buses per hour", n1(baseline.busesPerHour),
          `From an assumed ${n1(baseline.headwayMin!)} min combined headway across routes ${baseline.routesServing.join(", ")}.`));
        body.append(metricRow("Wait-time proxy", `${n1(baseline.waitProxyMin!)} min`, "Half the headway. A proxy, not a measurement."));
      }
    }

    // --- comparison
    if (scenario && baseline) {
      body.append(el("h3", { class: "sub", text: "Baseline vs scenario" }));
      body.append(el("div", { class: "delta", style: "border-bottom:1px solid var(--line-2)" },
        el("span", { class: "d-l", style: "color:var(--text-3);font-size:10px;letter-spacing:.1em;text-transform:uppercase", text: "Metric" }),
        el("span", { class: "d-b", style: "font-size:10px", text: "base" }),
        el("span", { class: "d-a", text: "" }),
        el("span", { class: "d-s", style: "font-size:10px", text: "scenario" })));
      for (const d of compare(baseline, scenario)) body.append(deltaRow(d));
      body.append(el("p", { class: "note", style: "margin-top:10px" },
        el("span", { class: "badge sim", text: "simulated" }),
        " Estimated under the assumptions below. Not a forecast."));
    }

    body.append(assumptions(s.scenario));

    // --- actions
    const run = el("button", { class: "btn primary", text: scenario ? "Re-run" : "Run scenario",
                               disabled: s.scenario === null });
    const reset = el("button", { class: "btn", text: "Reset to baseline" });
    const exp = el("button", { class: "btn", text: "Export" });
    run.addEventListener("click", h.onRun);
    reset.addEventListener("click", h.onReset);
    exp.addEventListener("click", h.onExport);
    body.append(el("div", { class: "actions", style: "margin-top:14px" }, run, reset, exp));

    badge.className = `badge ${scenario ? "sim" : "base"}`;
    badge.textContent = scenario ? "simulated" : "baseline";
  }

  return {
    node,
    setMetrics(base: CorridorMetrics | null, scen: CorridorMetrics | null) {
      baseline = base; scenario = scen; render();
    },
    refresh: render,
  };
}

/* ------------------------------------------------------------------ export */
export function exportPanel(m: Manifest, model: ScenarioModel,
                            baseline: CorridorMetrics | null, scenario: CorridorMetrics | null,
                            canvas: HTMLCanvasElement) {
  const s = store.get();
  const lines: string[] = [
    "DELHI PULSE TWIN — scenario summary",
    "",
    `Study area      ${m.study_area.id}  bbox ${m.study_area.bbox_wgs84.join(", ")}`,
    `Dataset         ${m.dataset_version}, transform v${m.transform_version}, built ${m.built_at}`,
    `Scenario model  v${model.version}`,
    `Clock           ${hhmm(s.timeMin)} local, weekday`,
    `Rainfall band   ${s.rain}`,
    `Corridor        ${baseline?.label ?? "—"}`,
    "",
  ];
  if (baseline) {
    lines.push("BASELINE  (mode: estimated — declared heuristic, not observed speeds)");
    lines.push(`  mean speed            ${n1(baseline.meanSpeedKmh)} km/h`);
    lines.push(`  travel time           ${n1(baseline.travelTimeMin)} min`);
    lines.push(`  mobility stress index ${baseline.msi.toFixed(2)}${baseline.msiWeightsRenormalised ? "  (transit weight redistributed)" : ""}`);
    if (baseline.busesPerHour !== null) {
      lines.push(`  buses per hour        ${n1(baseline.busesPerHour)}  (assumed headway ${n1(baseline.headwayMin!)} min)`);
      lines.push(`  wait-time proxy       ${n1(baseline.waitProxyMin!)} min`);
    }
    lines.push("");
  }
  if (scenario && baseline) {
    lines.push(`SCENARIO  (mode: simulated — ${s.scenario})`);
    if (s.scenario === "bus_frequency") lines.push(`  parameter: frequency multiplier ${s.busFreqMultiplier.toFixed(2)}x`);
    if (s.scenario === "rainfall") lines.push(`  parameter: rainfall band ${s.rain}`);
    for (const d of compare(baseline, scenario)) {
      lines.push(`  ${d.label.padEnd(26)} ${d.baseline.padStart(10)} -> ${d.scenario.padStart(10)}`);
    }
    lines.push("");
  }
  lines.push("METRIC DEFINITIONS");
  for (const [k, v] of Object.entries(model.definitions)) lines.push(`  ${k}: ${v}`);
  lines.push("");
  lines.push("ASSUMPTIONS AND LIMITS");
  lines.push(`  ${m.height_rule.disclosure}`);
  lines.push("  Corridor traffic is a declared time-of-day heuristic. No observed Delhi speed data was used.");
  lines.push("  Bus movement is deterministic replay from OSM route relations. Headway is assumed, not scheduled.");
  lines.push("  Outputs are estimates under the stated assumptions. Not a forecast and not routing advice.");
  lines.push("");
  lines.push("SOURCES");
  for (const a of m.attribution) lines.push(`  ${a}`);

  const text = lines.join("\n");

  const card = el("div", { class: "card" },
    el("h1", { text: "Export" }),
    el("p", { class: "lede", text: "The summary below carries scope, time, sources and assumptions, so it stays truthful once it leaves the app." }),
    el("pre", { style: "font-family:var(--mono);font-size:10.5px;line-height:1.55;background:var(--panel-2);border:1px solid var(--line);padding:12px;overflow:auto;max-height:44vh;white-space:pre-wrap", text }));

  const copy = el("button", { class: "btn primary", text: "Copy summary" });
  const shot = el("button", { class: "btn", text: "Copy image to clipboard" });
  const close = el("button", { class: "btn", text: "Close" });
  card.append(el("div", { class: "actions" }, copy, shot, close));

  copy.addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(text); copy.textContent = "Copied"; }
    catch { copy.textContent = "Clipboard blocked — select the text above"; }
  });
  shot.addEventListener("click", () => {
    canvas.toBlob(async (blob) => {
      if (!blob) { shot.textContent = "Could not capture"; return; }
      try {
        await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
        shot.textContent = "Image copied";
      } catch { shot.textContent = "Clipboard blocked by the browser"; }
    }, "image/png");
  });

  const scrim = el("div", { class: "scrim" }, card);
  const dismiss = () => scrim.remove();
  close.addEventListener("click", dismiss);
  scrim.addEventListener("click", (e) => { if (e.target === scrim) dismiss(); });
  return scrim;
}
