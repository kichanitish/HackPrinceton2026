// Charts, drawn as inline SVG. Colors are CSS variables so light and dark each get their own steps.
// Text always wears ink tokens; the mark beside it carries the color.
import { esc, int, money } from "./util.js";

/** This space's asking rent beside the market's asking and signed medians, one zero-based axis. */
export function rentChart(rc) {
  const mid = rc.known ? (rc.low + (rc.high || rc.low)) / 2 : null;
  const rows = [];
  if (mid != null) rows.push({ label: "This space, asking", v: mid, color: "var(--blue)", tip: `Asking ${money(rc.low)}${rc.high && rc.high !== rc.low ? "–" + money(rc.high) : ""}/sq ft/yr · ${esc(rc.service_type || "service type not given")}` });
  const use = ({ OfficeMedical: "Medical office", OfficeRetail: "Office/retail" })[rc.space_use] || rc.space_use;
  if (rc.asking) rows.push({ label: `${use} asking`, sub: `${int(rc.asking.n)} spaces`, v: rc.asking.median, lo: rc.asking.p25, hi: rc.asking.p75, color: "var(--neutral-fill)", tip: `Median of ${int(rc.asking.n)} ${esc(rc.space_use.toLowerCase())} spaces asking in ${esc(rc.market_name)}; middle half ${money(rc.asking.p25)}–${money(rc.asking.p75)}` });
  if (rc.signed) rows.push({ label: `${use} signed`, sub: `${int(rc.signed.n)} deals`, v: rc.signed.median, lo: rc.signed.p25, hi: rc.signed.p75, color: "var(--neutral-fill)", tip: `Median of ${int(rc.signed.n)} signed ${esc(rc.space_use.toLowerCase())} deals in ${esc(rc.market_name)}; middle half ${money(rc.signed.p25)}–${money(rc.signed.p75)}` });
  if (!rows.length) return "";
  const top = Math.max(...rows.map((r) => r.hi ?? r.v), rc.budget_psf_yr || 0) * 1.18;
  const W = 620, L = 176, R = 60, rowH = 40, T = rc.budget_psf_yr ? 22 : 6, H = T + rows.length * rowH + 8;
  const x = (v) => L + (v / top) * (W - L - R);
  const body = rows.map((r, i) => {
    const cy = T + i * rowH + rowH / 2, w = Math.max(4, x(r.v) - L);
    return `<g tabindex="0" data-tip="<b>${esc(r.label)}</b><br>${r.tip}">
      <rect x="0" y="${cy - rowH / 2}" width="${W}" height="${rowH}" fill="transparent"/>
      <text x="0" y="${cy + (r.sub ? -2 : 4)}" font-size="13" fill="var(--ink)" font-weight="${i === 0 && mid != null ? 600 : 400}">${esc(r.label)}</text>
      ${r.sub ? `<text x="0" y="${cy + 13}" font-size="11.5" fill="var(--muted)">${esc(r.sub)}</text>` : ""}
      <path d="M${L},${cy - 8} h${w - 4} a4,4 0 0 1 4,4 v8 a4,4 0 0 1 -4,4 h-${w - 4} z" fill="${r.color}"/>
      ${r.lo != null ? `<line x1="${x(r.lo)}" x2="${x(r.hi)}" y1="${cy}" y2="${cy}" stroke="var(--ink-2)" stroke-width="1.5"/>
        <line x1="${x(r.lo)}" x2="${x(r.lo)}" y1="${cy - 4}" y2="${cy + 4}" stroke="var(--ink-2)" stroke-width="1.5"/>
        <line x1="${x(r.hi)}" x2="${x(r.hi)}" y1="${cy - 4}" y2="${cy + 4}" stroke="var(--ink-2)" stroke-width="1.5"/>` : ""}
      <text x="${Math.max(x(r.hi ?? r.v), x(r.v)) + 8}" y="${cy + 4}" font-size="13" font-weight="600" fill="var(--ink)" class="num">${money(r.v)}</text>
    </g>`;
  }).join("");
  const budget = rc.budget_psf_yr ? `<line x1="${x(rc.budget_psf_yr)}" x2="${x(rc.budget_psf_yr)}" y1="${T - 4}" y2="${H - 6}" stroke="var(--ink)" stroke-width="1.5" stroke-dasharray="4 3"/>
    <text x="${x(rc.budget_psf_yr)}" y="${T - 9}" font-size="11.5" fill="var(--ink-2)" text-anchor="middle">your budget ${money(rc.budget_psf_yr, 0)}</text>` : "";
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Asking rent compared with market medians, dollars per square foot per year">
    <line x1="${L}" x2="${L}" y1="${T}" y2="${H - 6}" stroke="var(--line-strong)"/>${body}${budget}</svg>`;
}

/** Match score as a small ring. */
export function scoreRing(score, size = 52) {
  const r = size / 2 - 4, c = 2 * Math.PI * r, off = c * (1 - Math.min(score, 100) / 100);
  return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" role="img" aria-label="Match score ${Math.round(score)} out of 100">
    <circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="var(--wash)" stroke-width="4"/>
    <circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="var(--blue)" stroke-width="4" stroke-linecap="round"
      stroke-dasharray="${c}" stroke-dashoffset="${off}" transform="rotate(-90 ${size / 2} ${size / 2})"/>
    <text x="50%" y="50%" dy=".35em" text-anchor="middle" font-size="${size * 0.31}" font-weight="700" fill="var(--ink)" font-family="var(--font)">${Math.round(score)}</text>
  </svg>`;
}

// ---- knowledge graph: the slice of the graph the reasons walked, laid out by distance from the space
const TYPE = {
  Space: { cap: "This space", fill: "var(--ink)", ink: "var(--page)" },
  Building: { cap: "Building", fill: "var(--surface)" },
  MatterportModel: { cap: "3D tour", fill: "var(--surface)" },
  Market: { cap: "Market", fill: "var(--surface)" },
  State: { cap: "State", fill: "var(--surface)" },
  Rule: { cap: "Rule", fill: "var(--blue-wash)" },
  BusinessType: { cap: "Business type", fill: "var(--surface)" },
  Company: { cap: "Tenant", fill: "var(--surface)" },
  ApartmentCommunity: { cap: "Apartments", fill: "var(--surface)" },
};
const ORDER = ["Space", "MatterportModel", "Building", "Market", "State", "Rule", "BusinessType", "Company", "ApartmentCommunity"];

export function knowledgeGraph(graph) {
  const nodes = new Map(graph.nodes.map((n) => [n.id, { ...n }]));
  const adj = new Map([...nodes.keys()].map((k) => [k, []]));
  graph.edges.forEach((e) => { adj.get(e.source)?.push(e.target); adj.get(e.target)?.push(e.source); });
  const root = graph.nodes.find((n) => n.type === "Space");
  const depth = new Map([[root.id, 0]]);
  const queue = [root.id];
  while (queue.length) {
    const cur = queue.shift();
    for (const nb of adj.get(cur)) if (!depth.has(nb)) { depth.set(nb, depth.get(cur) + 1); queue.push(nb); }
  }
  const cols = [];
  nodes.forEach((n, id) => { const d = depth.get(id) ?? 0; (cols[d] ||= []).push(n); });
  cols.forEach((c) => c.sort((a, b) => ORDER.indexOf(a.type) - ORDER.indexOf(b.type) || a.label.localeCompare(b.label)));
  const W = 1040, nodeW = 168, nodeH = 38, gapY = 12, padT = 8;
  const rows = Math.max(...cols.map((c) => c.length));
  const H = padT * 2 + rows * (nodeH + gapY) - gapY;
  const colX = (i) => (cols.length === 1 ? 0 : (i * (W - nodeW)) / (cols.length - 1));
  cols.forEach((c, i) => {
    const total = c.length * (nodeH + gapY) - gapY, start = (H - total) / 2;
    c.forEach((n, j) => { n.x = colX(i); n.y = start + j * (nodeH + gapY); });
  });
  const seen = new Set();
  const edges = graph.edges.filter((e) => { const k = `${e.source}|${e.target}|${e.label}`; if (seen.has(k)) return false; seen.add(k); return true; }).map((e) => {
    let a = nodes.get(e.source), b = nodes.get(e.target);
    if (!a || !b) return "";
    if (a.x > b.x) [a, b] = [b, a];
    const x1 = a.x + nodeW, y1 = a.y + nodeH / 2, x2 = b.x, y2 = b.y + nodeH / 2, mx = (x1 + x2) / 2;
    return `<path d="M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}" fill="none" stroke="var(--line-strong)" stroke-width="1.25"><title>${esc(e.label)}</title></path>`;
  }).join("");
  const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
  const boxes = [...nodes.values()].map((n) => {
    const t = TYPE[n.type] || { cap: n.type, fill: "var(--surface)" };
    return `<g tabindex="0" data-tip="<b>${esc(n.label)}</b><br>${esc(t.cap)}">
      <rect x="${n.x}" y="${n.y}" width="${nodeW}" height="${nodeH}" rx="8" fill="${t.fill}" stroke="${n.type === "Space" ? "var(--ink)" : "var(--line-strong)"}"/>
      <text x="${n.x + 10}" y="${n.y + 14}" font-size="9.5" font-weight="600" letter-spacing=".05em" fill="${t.ink || "var(--muted)"}">${esc(t.cap.toUpperCase())}</text>
      <text x="${n.x + 10}" y="${n.y + 29}" font-size="12.5" font-weight="500" fill="${t.ink || "var(--ink)"}">${esc(clip(n.label, 23))}</text>
    </g>`;
  }).join("");
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Knowledge graph around this space: ${graph.nodes.length} nodes and ${graph.edges.length} relationships">${edges}${boxes}</svg>`;
}
