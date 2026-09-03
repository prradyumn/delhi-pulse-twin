export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number | boolean | null | undefined> = {},
  ...kids: (Node | string | null | undefined)[]
): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "class") n.className = String(v);
    else if (k === "text") n.textContent = String(v);
    else if (k === "html") n.innerHTML = String(v);
    else n.setAttribute(k, String(v));
  }
  for (const c of kids) if (c !== null && c !== undefined) n.append(c as Node | string);
  return n;
}

export const $ = <T extends HTMLElement = HTMLElement>(sel: string) =>
  document.querySelector(sel) as T | null;

export function clear(n: HTMLElement) { while (n.firstChild) n.removeChild(n.firstChild); }

/** hh:mm from minutes-since-midnight */
export function hhmm(min: number): string {
  const m = ((Math.round(min) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

export function kb(bytes: number): string {
  return bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(2)} MB`
    : `${(bytes / 1024).toFixed(1)} KB`;
}

export function toggleButton(pressed: boolean, onClick: () => void, label: string) {
  const b = el("button", { class: "toggle", "aria-pressed": String(pressed), "aria-label": label });
  b.addEventListener("click", onClick);
  return b;
}

/** Append children, skipping the nulls that conditional UI naturally produces.
 *  `Element.append` itself rejects null, unlike el()'s child list. */
export function add(parent: HTMLElement, ...kids: (Node | string | null | undefined)[]) {
  for (const k of kids) if (k !== null && k !== undefined) parent.append(k as Node | string);
  return parent;
}
