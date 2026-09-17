/**
 * One column on the right, several panels in it.
 *
 * The scenario lab, the selection drawer, the exposure panel and the reach panel were each
 * `position: fixed; top: 66px; right: 12px` with no z-index between them, so the one latest in
 * document order simply painted over the others. The lab is open on a default load and comes
 * after the drawer, which meant **clicking a building opened the drawer underneath the lab** and
 * the click looked like it did nothing. That is the whole of FR-10 — map, select, evidence — and
 * no check caught it because the QA harness never clicked the scene. `#drawer.stacked` was left
 * in the stylesheet as a fix for this that nothing ever applied.
 *
 * So the right-hand side is a real column now: the panels stack, the column scrolls if they do
 * not fit, and whichever panel was opened last is moved to the top, because that is the one the
 * user just asked for.
 */
export function rightRail() {
  const node = document.createElement("div");
  node.id = "rightrail";

  const raise = (panel: HTMLElement) => {
    if (node.firstElementChild !== panel) node.prepend(panel);
    node.scrollTop = 0;
  };

  /* Each panel owns its own `hidden` class and none of them knows this column exists. Watching
     for the class keeps it that way, so a panel added later inherits the behaviour without being
     told about it. Only a hidden -> visible transition raises: a panel re-rendering its own
     contents must not jump the queue. */
  const wasHidden = new WeakMap<HTMLElement, boolean>();
  const obs = new MutationObserver((records) => {
    for (const r of records) {
      const t = r.target as HTMLElement;
      if (t.parentElement !== node) continue;
      const hidden = t.classList.contains("hidden");
      if (wasHidden.get(t) && !hidden) raise(t);
      wasHidden.set(t, hidden);
    }
  });

  function mount(...panels: HTMLElement[]) {
    for (const p of panels) {
      node.append(p);
      wasHidden.set(p, p.classList.contains("hidden"));
      obs.observe(p, { attributes: true, attributeFilter: ["class"] });
    }
  }

  return { node, mount, raise };
}
