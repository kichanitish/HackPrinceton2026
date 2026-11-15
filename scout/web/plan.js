// 2D plans: the approximate rectangle (always available) and the scanned rooms (when Matterport measured the suite).
import { esc, int } from "./util.js";

// Zone → color role. Entities keep their color across every plan; the order follows the validated palette.
const ZONE_COLOR = {
  seating: "blue", classrooms: "blue", workout: "blue", exam: "blue",
  extra: "blue-soft",
  kitchen: "orange", studio: "orange", staff: "orange",
  counter: "aqua", reception: "aqua", waiting: "aqua", office: "aqua",
  restrooms: "yellow", lockers: "yellow",
  lab: "magenta",
  circulation: "neutral-fill",
};
export const zoneColor = (id) => `var(--${ZONE_COLOR[id] || "neutral-fill"})`;
const inkOn = (id) => (["blue", "orange", "aqua", "magenta"].includes(ZONE_COLOR[id]) ? "#ffffff" : "var(--ink)");

/** The plan in its assumed 1:2 rectangle, drawn landscape: storefront on the left, back wall on the right. */
export function planSVG(layout) {
  const { shape, zones, outdoor } = layout;
  const padL = 34, padT = 26, padB = 14;
  const scale = 560 / shape.depth_ft;                      // px per foot
  const PW = shape.depth_ft * scale, PH = shape.width_ft * scale;
  let yard = "", yardW = 0;
  if (outdoor) {
    const side = Math.min(Math.sqrt(outdoor.sqft) * scale, PH);   // drawn to the same scale as the plan
    const w = (outdoor.sqft * scale * scale) / side;
    yardW = w + 16;
    yard = `<g data-tip="<b>${esc(outdoor.label)}</b><br>${esc(outdoor.basis)} = ${int(outdoor.sqft)} sq ft · ${esc(outdoor.code)}">
      <rect x="${padL + PW + 14}" y="${padT + PH - side}" width="${w}" height="${side}" rx="4" fill="var(--aqua)" fill-opacity=".13" stroke="var(--aqua)" stroke-width="1.5" stroke-dasharray="6 4"/>
      <text x="${padL + PW + 14 + w / 2}" y="${padT + PH - side / 2 - 4}" text-anchor="middle" font-size="12" font-weight="600" fill="var(--ink)">Outdoor play</text>
      <text x="${padL + PW + 14 + w / 2}" y="${padT + PH - side / 2 + 12}" text-anchor="middle" font-size="11.5" fill="var(--ink-2)" class="num">${int(outdoor.sqft)} sq ft</text>
    </g>`;
  }
  const W = padL + PW + yardW + 8, H = padT + PH + padB;
  const rects = zones.map((z) => {
    const x = padL + z.y * scale + 1, y = padT + z.x * scale + 1, w = Math.max(0, z.h * scale - 2), h = Math.max(0, z.w * scale - 2);
    const roomy = w > 74 && h > 34, tiny = w < 30 || h < 16;
    const name = z.label.length * 6.4 > w - 10 ? z.label.split(/ &| /)[0] : z.label;
    const text = tiny ? "" : roomy
      ? `<text x="${x + w / 2}" y="${y + h / 2 - 2}" text-anchor="middle" font-size="12" font-weight="600" fill="${inkOn(z.id)}">${esc(name)}</text>
         <text x="${x + w / 2}" y="${y + h / 2 + 13}" text-anchor="middle" font-size="11" fill="${inkOn(z.id)}" opacity=".9" class="num">${int(z.sqft)} sq ft</text>`
      : `<text x="${x + w / 2}" y="${y + h / 2 + 4}" text-anchor="middle" font-size="10.5" font-weight="600" fill="${inkOn(z.id)}" class="num">${w > 62 ? esc(name) : int(z.sqft)}</text>`;
    return `<g class="zone" data-zone="${esc(z.id)}" tabindex="0" data-tip="<b>${esc(z.label)}</b> · ${int(z.sqft)} sq ft (${Math.round(z.share * 100)}%)<br>${esc(z.basis)}<br>≈ ${z.h.toFixed(0)} × ${z.w.toFixed(0)} ft">
      <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="3" fill="${zoneColor(z.id)}"/>${text}</g>`;
  }).join("");
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Approximate floor plan, ${int(shape.sqft)} square feet in ${zones.length} zones">
    <text x="${padL + PW / 2}" y="14" text-anchor="middle" font-size="11.5" fill="var(--muted)" class="num">≈ ${shape.depth_ft.toFixed(0)} ft deep</text>
    <text transform="translate(12 ${padT + PH / 2}) rotate(-90)" text-anchor="middle" font-size="11.5" fill="var(--muted)" class="num">≈ ${shape.width_ft.toFixed(0)} ft storefront</text>
    <rect x="${padL}" y="${padT}" width="${PW}" height="${PH}" rx="4" fill="var(--chart)" stroke="var(--ink)" stroke-width="2"/>
    ${rects}
    <rect x="${padL - 3}" y="${padT + PH * 0.38}" width="6" height="${PH * 0.24}" fill="var(--chart)"/>
    <path d="M${padL - 12},${padT + PH / 2} l8,-5 v10 z" fill="var(--ink)"/>
    ${yard}
  </svg>`;
}

/** The rooms Matterport measured, with the suggested zone in each. */
export function scanSVG(scan, assignment, floorId) {
  const rooms = scan.rooms.filter((r) => r.walls.length && (!floorId || r.floor_id === floorId));
  if (!rooms.length) return "";
  const xs = rooms.flatMap((r) => r.walls.flatMap((w) => [w[0], w[2]]));
  const ys = rooms.flatMap((r) => r.walls.flatMap((w) => [w[1], w[3]]));
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const pad = 14, W = 640, s = (W - pad * 2) / Math.max(maxX - minX, 1), H = (maxY - minY) * s + pad * 2;
  const X = (v) => pad + (v - minX) * s, Y = (v) => pad + (maxY - v) * s;   // model y points up; SVG y points down
  const byRoom = new Map((assignment?.assignments || []).map((a) => [a.room_id, a]));
  const fills = rooms.map((r) => {
    const a = byRoom.get(r.id);
    if (!r.outline) return "";
    const bad = a && a.ok === false;
    return `<polygon class="${bad ? "room-bad" : "room-fill"}" points="${r.outline.map(([x, y]) => `${X(x).toFixed(1)},${Y(y).toFixed(1)}`).join(" ")}" fill="${a ? zoneColor(a.zone_id) : "var(--wash)"}" fill-opacity="${a ? 0.78 : 1}"${bad ? ' stroke="var(--crit)" stroke-width="3"' : ""}/>`;
  }).join("");
  const walls = rooms.map((r) => r.walls.map((w) => `<line x1="${X(w[0]).toFixed(1)}" y1="${Y(w[1]).toFixed(1)}" x2="${X(w[2]).toFixed(1)}" y2="${Y(w[3]).toFixed(1)}"/>`).join("")).join("");
  const labels = rooms.map((r) => {
    const a = byRoom.get(r.id);
    if (!r.center || !r.area_sqft) return "";
    const big = Math.sqrt(r.area_sqft) * s > 70;
    const name = a ? a.zone_label : r.label;
    const ink = a && r.outline ? inkOn(a.zone_id) : "var(--ink)";   // white only when the room is actually filled
    const tip = `<b>${esc(r.label || "Room")}</b> · ${int(r.area_sqft)} sq ft measured${r.width_ft && r.depth_ft ? `<br>${r.width_ft.toFixed(0)} × ${r.depth_ft.toFixed(0)} ft` : ""}${r.height_ft ? ` · ${r.height_ft.toFixed(1)} ft ceiling` : ""}${a ? `<br>Suggested: ${esc(a.zone_label)} (needs ${int(a.zone_sqft)} sq ft)` : ""}`;
    return `<g class="room" data-room="${esc(r.id)}" tabindex="0" data-tip="${tip}">
      <circle cx="${X(r.center[0])}" cy="${Y(r.center[1])}" r="${big ? 0 : 5}" fill="${a ? "var(--ink)" : "var(--muted)"}"/>
      ${big && name ? `<text x="${X(r.center[0])}" y="${Y(r.center[1]) - 1}" text-anchor="middle" font-size="12" font-weight="600" fill="${ink}">${esc(name.length > 18 ? name.split(/ &| /)[0] : name)}</text>` : ""}
      ${big ? `<text x="${X(r.center[0])}" y="${Y(r.center[1]) + 14}" text-anchor="middle" font-size="11" fill="${ink}" opacity=".85" class="num">${int(r.area_sqft)} sq ft</text>` : ""}
      <rect x="${X(r.center[0]) - 26}" y="${Y(r.center[1]) - 20}" width="52" height="40" fill="transparent"/>
    </g>`;
  }).join("");
  return `<svg viewBox="0 0 ${W} ${H.toFixed(0)}" role="img" aria-label="Floor plan measured by the Matterport scan, ${rooms.length} rooms">
    <rect width="${W}" height="${H.toFixed(0)}" rx="8" fill="var(--chart)"/>${fills}
    <g stroke="var(--ink)" stroke-width="2" stroke-linecap="round">${walls}</g>${labels}</svg>`;
}
