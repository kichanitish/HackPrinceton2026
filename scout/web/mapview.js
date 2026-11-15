// The map: one Leaflet instance for the whole app. Full-bleed and drifting on the landing page; the workspace map
// once a search runs. Everything that changes on it follows a real event: screening draws the matches, the top ten
// get markers, the space being inspected pulses, results badge their marker, the ranking renumbers them.
import { esc, money } from "./util.js";

const L = window.L;
const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
const DRIFT = [
  { c: [29.7569, -95.3783], z: 13 }, { c: [29.7412, -95.4618], z: 13 }, { c: [29.7076, -95.4005], z: 13.25 },
  { c: [34.0485, -118.2551], z: 13 }, { c: [34.0623, -118.3481], z: 13 }, { c: [34.0179, -118.4925], z: 13 },
];

export class MapView {
  constructor(el, { onSelect, onHover } = {}) {
    this.onSelect = onSelect;
    this.onHover = onHover;
    this.map = L.map(el, { zoomControl: false, attributionControl: true, preferCanvas: true, zoomSnap: 0.25, wheelPxPerZoomLevel: 90,
      fadeAnimation: !reduced, zoomAnimation: !reduced, markerZoomAnimation: !reduced });
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19, className: "tiles", attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }).addTo(this.map);
    L.control.zoom({ position: "bottomright" }).addTo(this.map);
    this.map.setView(DRIFT[0].c, DRIFT[0].z);
    this.renderer = L.canvas({ padding: 0.3 });
    this.dots = new Map();        // space_id → circleMarker (every space)
    this.markers = new Map();     // space_id → marker (top ten)
    this.state = new Map();       // space_id → visual state
    this.selected = null;
    this.userMovedAt = 0;
    this.map.on("dragstart zoomstart", (e) => { if (e.originalEvent || e.type === "dragstart") this.userMovedAt = Date.now(); });
    this.pop = L.popup({ closeButton: false, autoPan: false, className: "fp-pop", offset: [0, -22], maxWidth: 320 });
  }

  // ---------------------------------------------------------------- every space, as a quiet dot
  setPoints(rows) {
    rows.forEach(([id, lat, lon]) => {
      const d = L.circleMarker([lat, lon], { renderer: this.renderer, radius: 1.6, stroke: false, fillColor: "#8c929c", fillOpacity: 0.45, interactive: false });
      d.addTo(this.map);
      this.dots.set(id, d);
    });
  }

  drift() {
    if (reduced) return;
    let i = 0;
    const step = () => {
      if (this.drifting === false) return;
      i = (i + 1) % DRIFT.length;
      this.map.flyTo(DRIFT[i].c, DRIFT[i].z, { duration: i % 3 === 0 ? 4 : 11, easeLinearity: 0.15 });
    };
    this.drifting = true;
    this.driftTimer = setInterval(step, 12000);
    setTimeout(step, 600);
  }

  stopDrift() { this.drifting = false; clearInterval(this.driftTimer); this.map.stop(); }

  /** Keep Leaflet's size in step while the container animates from full-bleed into the workspace. */
  follow(ms = 800) {
    const until = performance.now() + ms;
    const tick = () => { this.map.invalidateSize({ pan: false, debounceMoveend: true }); if (performance.now() < until) requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  }

  // ---------------------------------------------------------------- screening: matches light up, outward from the centre
  showScreening(matchPoints, cityCenter) {
    const matches = new Set(matchPoints.map((p) => p[0]));
    this.dots.forEach((d, id) => d.setStyle(matches.has(id) ? { fillColor: "#8c929c", fillOpacity: 0.12 } : { fillOpacity: 0.07, fillColor: "#5c6168" }));
    const c = L.latLng(cityCenter);
    const ordered = matchPoints.slice().sort((a, b) => c.distanceTo([a[1], a[2]]) - c.distanceTo([b[1], b[2]]));
    const reveal = (d) => d.setStyle({ fillColor: "#cff73a", fillOpacity: 0.7, radius: 2.6 });
    if (reduced) { ordered.forEach((p) => this.dots.get(p[0]) && reveal(this.dots.get(p[0]))); return; }
    ordered.forEach((p, k) => setTimeout(() => { const d = this.dots.get(p[0]); if (d) reveal(d); }, 120 + k * Math.min(9, 900 / ordered.length)));
  }

  fitTo(points, pad = [60, 60]) {
    const pts = points.filter((p) => p[0] != null && p[1] != null);
    if (!pts.length) return;
    this.map.flyToBounds(L.latLngBounds(pts), { padding: pad, maxZoom: 14, duration: reduced ? 0 : 1.1 });
  }

  // ---------------------------------------------------------------- the top ten
  setTop(cards) {        // [{card, rank}]
    const keep = new Set(cards.map((x) => x.card.space_id));
    this.markers.forEach((m, id) => { if (!keep.has(id)) { m.remove(); this.markers.delete(id); } });
    cards.forEach(({ card, rank }, k) => {
      if (card.lat == null) return;
      let m = this.markers.get(card.space_id);
      if (!m) {
        m = L.marker([card.lat, card.lon], { icon: this.icon(card.space_id, rank), riseOnHover: true, keyboard: false });
        m.on("click", () => this.onSelect?.(card.space_id));
        m.on("mouseover", () => { this.onHover?.(card.space_id); this.preview(card); });
        m.on("mouseout", () => { this.onHover?.(null); if (this.selected !== card.space_id) this.map.closePopup(this.pop); });
        setTimeout(() => m.addTo(this.map), reduced ? 0 : 250 + k * 70);
        this.markers.set(card.space_id, m);
      }
      m.card = card;
      m.rank = rank;
      m.setIcon(this.icon(card.space_id, rank));
      m.setZIndexOffset(1000 - (rank ?? 20) * 10 + (this.selected === card.space_id ? 5000 : 0));
    });
  }

  icon(id, rank) {
    const st = this.state.get(id) || "", sel = this.selected === id ? " sel" : "";
    return L.divIcon({ className: "", iconSize: [30, 30], iconAnchor: [15, 15],
      html: `<div class="mk ${st}${sel}${rank == null ? " pool" : ""}"><span>${rank ?? ""}</span><i></i></div>` });   // pool: a candidate, not yet ranked
  }

  setState(id, st) {
    this.state.set(id, st);
    const m = this.markers.get(id);
    if (m) m.setIcon(this.icon(id, m.rank));
  }

  inspect(id) {
    const m = this.markers.get(id);
    if (!m) return;
    this.setState(id, "inspecting");
    if (Date.now() - this.userMovedAt > 8000 && this.selected == null) {
      this.map.panTo(m.getLatLng(), { animate: !reduced, duration: 0.8 });
    }
  }

  select(id, { fly = true, afterMove = false } = {}) {     // afterMove: the map is fitting the top ten; preview once it settles
    const prev = this.selected;
    this.selected = id;
    [prev, id].forEach((x) => { const m = this.markers.get(x); if (m) { m.setIcon(this.icon(x, m.rank)); m.setZIndexOffset(1000 - (m.rank ?? 20) * 10 + (x === id ? 5000 : 0)); } });
    const m = this.markers.get(id);
    if (!m) return;
    if (fly) this.map.flyTo(m.getLatLng(), Math.max(this.map.getZoom(), 15), { duration: reduced ? 0 : 0.9 });
    if (afterMove && !reduced) {
      const show = () => { if (this.selected === id) this.preview(m.card, true); };
      this.map.once("moveend", show);
      setTimeout(() => { this.map.off("moveend", show); show(); }, 1500);   // in case the fit didn't move the map
      return;
    }
    this.preview(m.card, !fly);
  }

  hover(id) {
    this.markers.forEach((m, x) => m.getElement()?.querySelector(".mk")?.classList.toggle("hot", x === id));
  }

  preview(card, pan = false) {     // pan: a selection the user asked for; hover previews never move the map
    this.pop.options.autoPan = pan;
    this.pop.options.autoPanPadding = [24, 24];
    const thumb = card.lat != null ? `/api/aerial/${card.property_id}.jpg?r=45&w=320` : "";
    const rent = card.rent.known ? `${money(card.rent.low, 0)}${card.rent.is_range ? `–${money(card.rent.high, 0)}` : ""}<small>/sf/yr</small>` : `<span class="dim">Rent not listed</span>`;
    this.pop.setLatLng([card.lat, card.lon]).setContent(`<div class="pop">${thumb ? `<img src="${thumb}" alt="">` : ""}
      <div><b class="lime">${rent}</b><span>${esc(card.address)}${card.suite ? ` · ${esc(card.suite)}` : ""}</span></div>
      <button class="pop-go" data-explore="${card.space_id}">Explore</button></div>`).openOn(this.map);
  }
}
