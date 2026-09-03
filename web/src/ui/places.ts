import { el, clear } from "./dom";

export interface Place {
  id: string; name: string; cat: string; x: number; z: number;
  osm: string; dist: number; kind: string | null;
}

const CAT_LABEL: Record<string, string> = {
  heritage: "Heritage", attraction: "Attractions", district: "Districts",
  worship: "Places of worship", station: "Metro & rail", government: "Government",
  civic: "Civic", market: "Markets & retail", building: "Named buildings",
};
const CAT_ORDER = ["heritage", "attraction", "district", "station", "government",
                   "worship", "civic", "market", "building"];

/**
 * 352 named places from OSM, searchable, each with a framing distance chosen by category — a
 * district needs altitude, a statue does not. FR-04 in the PRD, deferred once and now cheap
 * because the data pass already resolved the names and positions.
 */
export function placePicker(places: Place[], onJump: (p: Place) => void) {
  const search = el("input", {
    type: "search", placeholder: "Search 352 places…", class: "psearch",
    "aria-label": "Search places",
  }) as HTMLInputElement;
  const list = el("div", { class: "plist" });
  const chips = el("div", { class: "pchips", role: "group", "aria-label": "Filter by category" });

  let activeCat: string | null = null;
  let query = "";

  const counts = new Map<string, number>();
  for (const p of places) counts.set(p.cat, (counts.get(p.cat) ?? 0) + 1);

  function renderChips() {
    clear(chips);
    const all = el("button", { class: activeCat === null ? "chip on" : "chip",
                               text: `All ${places.length}` });
    all.addEventListener("click", () => { activeCat = null; renderChips(); renderList(); });
    chips.append(all);
    for (const c of CAT_ORDER) {
      const n = counts.get(c);
      if (!n) continue;
      const b = el("button", { class: activeCat === c ? "chip on" : "chip",
                               text: `${CAT_LABEL[c]} ${n}` });
      b.addEventListener("click", () => { activeCat = activeCat === c ? null : c; renderChips(); renderList(); });
      chips.append(b);
    }
  }

  function renderList() {
    clear(list);
    const q = query.trim().toLowerCase();
    const hits = places.filter((p) =>
      (!activeCat || p.cat === activeCat) && (!q || p.name.toLowerCase().includes(q)));

    if (!hits.length) {
      list.append(el("p", { class: "note", style: "padding:10px 2px",
        text: q ? `Nothing matches “${query}”. These are OSM names, so spelling follows OSM.`
                : "No places in this category." }));
      return;
    }
    for (const p of hits.slice(0, 220)) {
      const row = el("button", { class: "prow" },
        el("span", { class: "pname", text: p.name }),
        el("span", { class: "pcat", text: p.kind ? `${CAT_LABEL[p.cat]} · ${p.kind}` : CAT_LABEL[p.cat] }));
      row.addEventListener("click", () => onJump(p));
      list.append(row);
    }
    if (hits.length > 220) {
      list.append(el("p", { class: "note", style: "padding:8px 2px",
        text: `${hits.length - 220} more — keep typing to narrow it.` }));
    }
  }

  search.addEventListener("input", () => { query = search.value; renderList(); });
  search.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      const first = list.querySelector(".prow") as HTMLButtonElement | null;
      first?.click();
    }
  });

  const body = el("div", { class: "pbody" }, search, chips, list);
  const node = el("aside", { class: "panel hidden", id: "places" },
    el("div", { class: "phead" }, el("h2", { text: "Jump to a place" })), body);
  const closeBtn = el("button", { class: "chip", text: "Close" });
  (node.querySelector(".phead") as HTMLElement).append(closeBtn);
  closeBtn.addEventListener("click", () => hide());

  function show() {
    node.classList.remove("hidden");
    renderChips(); renderList();
    search.focus(); search.select();
  }
  function hide() { node.classList.add("hidden"); }
  function toggle() { node.classList.contains("hidden") ? show() : hide(); }

  return { node, show, hide, toggle };
}
