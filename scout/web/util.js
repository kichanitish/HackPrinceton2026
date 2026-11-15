// Small shared helpers: escaping, number formatting, icons, tooltip, API calls.

export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
export const int = (n) => (n == null ? "—" : Math.round(n).toLocaleString("en-US"));
export const money = (n, digits = 2) => (n == null ? "—" : "$" + Number(n).toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits }));
export const sqft = (n) => `${int(n)} sq ft`;
export const plural = (n, one, many) => `${int(n)} ${n === 1 ? one : many ?? one + "s"}`;
export const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

/** CoStar image CDN: swap the size segment (112 is large; 113 is 1,400×720). */
export const img = (url, size = 113) => (url ? url.replace("/112/", `/${size}/`) : null);

export async function api(path, body) {
  const res = await fetch(path, body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!res.ok) {
    let detail = res.statusText;
    try { detail = (await res.json()).detail || detail; } catch { /* not JSON */ }
    throw new Error(typeof detail === "string" ? detail : "Request failed");
  }
  return res.json();
}

const P = (d, extra = "") => `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" ${extra}>${d}</svg>`;
export const icon = {
  check: P('<path d="M3 8.5l3.2 3.2L13 4.8"/>'),
  alert: P('<path d="M8 2.2l6.3 11H1.7z"/><path d="M8 6.6v3.2M8 11.9v.1"/>'),
  info: P('<circle cx="8" cy="8" r="6.2"/><path d="M8 7.3v3.6M8 5v.1"/>'),
  dot: P('<circle cx="8" cy="8" r="2.4" fill="currentColor" stroke="none"/>'),
  cube: P('<path d="M8 1.8l5.6 3.1v6.2L8 14.2l-5.6-3.1V4.9z"/><path d="M2.4 4.9L8 8l5.6-3.1M8 8v6.2"/>'),
  ext: P('<path d="M6.5 3.5h-3v9h9v-3M9.5 2.5h4v4M13.5 2.5L7.5 8.5"/>', 'style="width:11px;height:11px"'),
  pin: P('<path d="M8 14.2s4.4-4 4.4-7.4A4.4 4.4 0 108 2.4 4.4 4.4 0 003.6 6.8c0 3.4 4.4 7.4 4.4 7.4z"/><circle cx="8" cy="6.8" r="1.5"/>'),
  building: '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 21V5.5L13 3v18M13 9l7 2v10M3 21h18M7.5 8.5h2M7.5 12h2M7.5 15.5h2M16 14h1.5M16 17.5h1.5"/></svg>',
};
export const toneIcon = (tone) => (tone === "good" ? icon.check : tone === "warn" ? icon.alert : icon.info);

export function sourceLink(source) {
  if (!source) return "";
  return source.url
    ? `<a href="${esc(source.url)}" target="_blank" rel="noopener">${esc(source.label)} ${icon.ext}</a>`
    : esc(source.label);
}

// ---- one tooltip for the whole page: any element with data-tip shows it on hover or focus
const tipEl = () => document.getElementById("tip");
function place(e) {
  const t = tipEl();
  const pad = 14, r = t.getBoundingClientRect();
  let x = e.clientX + pad, y = e.clientY + pad;
  if (x + r.width > innerWidth - 8) x = e.clientX - r.width - pad;
  if (y + r.height > innerHeight - 8) y = e.clientY - r.height - pad;
  t.style.left = `${Math.max(8, x)}px`;
  t.style.top = `${Math.max(8, y)}px`;
}
export function initTooltip() {
  document.addEventListener("pointermove", (e) => {
    const host = e.target.closest?.("[data-tip]");
    const t = tipEl();
    if (!host) { t.hidden = true; return; }
    t.innerHTML = host.dataset.tip;   // data-tip values are built with esc()
    t.hidden = false;
    place(e);
  });
  document.addEventListener("focusin", (e) => {
    const host = e.target.closest?.("[data-tip]");
    if (!host) return;
    const t = tipEl(), r = host.getBoundingClientRect();
    t.innerHTML = host.dataset.tip;
    t.hidden = false;
    place({ clientX: r.left + r.width / 2, clientY: r.bottom });
  });
  document.addEventListener("focusout", () => { tipEl().hidden = true; });
  document.addEventListener("scroll", () => { tipEl().hidden = true; }, true);
}
