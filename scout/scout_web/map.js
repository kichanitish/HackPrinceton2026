// The map: your places (with their radius), the best areas (commercial), every match, the ten picks, and
// competitors around the pick you're looking at. Everything on it comes from a backend event.
const L = window.L;
const CITY = { houston: [29.7604, -95.3698], los_angeles: [34.0522, -118.2437] };
const MI = 1609.34;
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export class ScoutMap {
  constructor(el, { onSelect, onHover } = {}) {
    this.onSelect = onSelect;
    this.onHover = onHover;
    this.map = L.map(el, { zoomControl: false, scrollWheelZoom: false, preferCanvas: true });
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "© OpenStreetMap contributors" }).addTo(this.map);
    L.control.zoom({ position: "bottomright" }).addTo(this.map);
    this.map.on("click", () => this.map.scrollWheelZoom.enable());
    this.layers = { anchors: L.layerGroup().addTo(this.map), zones: L.layerGroup().addTo(this.map), cand: L.layerGroup().addTo(this.map),
                    comp: L.layerGroup().addTo(this.map), top: L.layerGroup().addTo(this.map) };
    this.pins = new Map();
    this.renderer = L.canvas({ padding: 0.3 });
    this.city("houston");
  }

  city(key) { this.map.setView(CITY[key] || CITY.houston, 11); }
  resize() { setTimeout(() => this.map.invalidateSize(), 60); }
  clear() { Object.values(this.layers).forEach((l) => l.clearLayers()); this.pins.clear(); }

  anchors(list) {
    this.layers.anchors.clearLayers();
    for (const a of list || []) {
      const pts = a.points || [];
      if (a.kind === "points") {
        pts.slice(0, 6).forEach((p) => {
          L.circle([p.lat, p.lon], { radius: a.radius_mi * MI, color: "#9a6b1f", weight: 1.2, dashArray: "4 5", fillColor: "#9a6b1f", fillOpacity: 0.04, interactive: false }).addTo(this.layers.anchors);
          L.marker([p.lat, p.lon], { icon: L.divIcon({ className: "", html: '<div class="anchor-dot"></div>', iconSize: [14, 14], iconAnchor: [7, 7] }) })
            .bindTooltip(`<b>${esc(p.name)}</b><br>within ${a.radius_mi} mi`, { direction: "top" }).addTo(this.layers.anchors);
        });
      } else {
        pts.forEach((p) => L.circleMarker([p.lat, p.lon], { renderer: this.renderer, radius: 4, color: "#9a6b1f", weight: 1.5, fillColor: "#fff", fillOpacity: 1 })
          .bindTooltip(esc(p.name)).addTo(this.layers.anchors));
      }
    }
  }

  zones(list) {
    this.layers.zones.clearLayers();
    (list || []).forEach((z, i) => {
      L.circle([z.lat, z.lon], { radius: 0.6 * MI, color: "#345c47", weight: 1, fillColor: "#72916d", fillOpacity: 0.13 - i * 0.015, interactive: true })
        .bindTooltip(`<b>${esc(z.name)}</b><br>${(z.residents_units || 0).toLocaleString()} apartment units · ${(z.office_workers || 0).toLocaleString()} office workers · ${z.competitors} competitors (½ mi)`)
        .addTo(this.layers.zones);
    });
  }

  candidates(points) {
    for (const [, lat, lon] of points || []) {
      L.circleMarker([lat, lon], { renderer: this.renderer, radius: 3, stroke: false, fillColor: "#8c9a8a", fillOpacity: 0.55, interactive: false }).addTo(this.layers.cand);
    }
  }

  top(cards) {
    this.layers.top.clearLayers();
    this.pins.clear();
    cards.forEach((c, i) => {
      const m = L.marker([c.lat, c.lon], { icon: this.icon(i + 1, false), riseOnHover: true, zIndexOffset: 1000 - i * 10 })
        .on("click", () => this.onSelect?.(c.id))
        .on("mouseover", () => this.onHover?.(c.id))
        .on("mouseout", () => this.onHover?.(null))
        .bindTooltip(`<b>${i + 1}. ${esc(c.name)}</b>`, { direction: "top", offset: [0, -24] })
        .addTo(this.layers.top);
      m.rank = i + 1;
      this.pins.set(c.id, m);
    });
    this.fit(cards);
  }

  icon(rank, hot) {
    return L.divIcon({ className: "", iconSize: [32, 32], iconAnchor: [14, 30],
      html: `<div class="pin ${rank <= 3 ? "top3" : ""} ${hot ? "hot" : ""}"><span>${rank}</span></div>` });
  }

  hover(id) { this.pins.forEach((m, k) => m.setIcon(this.icon(m.rank, k === id))); }

  competitors(list, center) {
    this.layers.comp.clearLayers();
    (list || []).forEach((p) => L.circleMarker([p.lat, p.lon], { renderer: this.renderer, radius: 5, color: "#fff", weight: 1.5, fillColor: "#a3443a", fillOpacity: 0.9 })
      .bindTooltip(`${esc(p.name)} · ${p.miles} mi`).addTo(this.layers.comp));
    if (center) this.map.flyTo(center, 15, { duration: 0.8 });
  }

  focus(id) {
    const m = this.pins.get(id);
    if (m) { this.map.flyTo(m.getLatLng(), Math.max(this.map.getZoom(), 14), { duration: 0.8 }); m.openTooltip(); }
  }

  fit(cards) {
    const pts = cards.map((c) => [c.lat, c.lon]);
    this.layers.anchors.eachLayer((l) => l instanceof L.Marker && pts.push(l.getLatLng()));   // named places, not every school
    if (pts.length) this.map.fitBounds(L.latLngBounds(pts), { padding: [40, 40], maxZoom: 14 });
  }
}
