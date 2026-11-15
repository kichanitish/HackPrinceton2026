// Property exploration: a full-screen view over the workspace (which stays exactly as it was underneath).
// Overview · Digital twin · Floor plan · Aerial · Market. One scan check (/api/proof) feeds every view.
import { api, cssVar, esc, icon, int, money, plural, sourceLink, sqft, toneIcon } from "./util.js";
import { knowledgeGraph, rentChart } from "./charts.js";
import { planSVG, scanSVG, zoneColor } from "./plan.js";
import { Tour, toRgb } from "./tour.js";

const $ = (s, r = document) => r.querySelector(s);
const E = { token: 0, detail: null, proof: null, card: null, tab: "overview", tour: null, sdkKey: undefined, ctx: null };
const TABS = [["overview", "Overview", "grid"], ["twin", "Digital twin", "cube"], ["plan", "Floor plan", "plan"], ["aerial", "Aerial", "globe"], ["market", "Market", "chart"]];
const ICON = {
  grid: '<path d="M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z"/>',
  cube: '<path d="M12 2l9 5v10l-9 5-9-5V7z"/><path d="M3 7l9 5 9-5M12 12v10"/>',
  plan: '<path d="M3 3h18v18H3zM3 12h8M11 3v13M16 12v9"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3.5 3 14.5 0 18M12 3c-3 3.5-3 14.5 0 18"/>',
  chart: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
  back: '<path d="M15 18l-6-6 6-6"/>',
};
const svg = (k, s = 18) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[k]}</svg>`;
export const STATUS = {
  verified: ["ok", "Verified on scan"], verified_with_caveats: ["ok", "Verified · caveats"], conflict: ["bad", "Fails scan check"],
  not_verifiable: ["rev", "Reviewed · scan unusable"], reviewed: ["rev", "Reviewed · no scan"], rejected: ["bad", "Rejected"],
  screened_only: ["muted", "Waiting"], queued: ["muted", "Waiting"], reviewing: ["live", "Reviewing"], inspecting: ["live", "Inspecting"],
};

export async function explore(id, ctx) {
  const token = ++E.token;
  E.ctx = ctx;
  E.card = ctx.card(id);
  E.tab = "overview";
  const view = $("#explore");
  view.hidden = false;
  document.body.classList.add("exploring");
  view.innerHTML = `<div class="ex-loading"><span class="spin"></span>Opening the property…</div>`;
  view.animate?.([{ opacity: 0, transform: "scale(.985)" }, { opacity: 1, transform: "none" }], { duration: 260, easing: "cubic-bezier(.2,.8,.2,1)" });
  try {
    const [detail, proof] = await Promise.all([
      api(`/api/space/${id}`, { program: ctx.program() }),
      api(`/api/proof/${id}`, { program: ctx.program() }).catch(() => null),
    ]);
    if (token !== E.token) return;                       // a newer open won
    E.detail = detail; E.proof = proof;
  } catch (e) {
    if (token === E.token) view.innerHTML = `<div class="ex-loading err">Could not open this property: ${esc(e.message)} <button class="btn" id="ex-close">Back</button></div>`;
    $("#ex-close")?.addEventListener("click", closeExplore);
    return;
  }
  if (E.sdkKey === undefined) { try { E.sdkKey = (await api("/api/config")).matterport_sdk_key; } catch { E.sdkKey = null; } }
  if (token === E.token) render();
}

export function closeExplore() {
  E.token++;
  E.tour?.destroy(); E.tour = null;
  $("#explore").hidden = true;
  document.body.classList.remove("exploring");
}
export const isExploring = () => !$("#explore").hidden;

function hero(s, cls = "") {
  const aerial = s.lat != null ? `/api/aerial/${s.property_id}.jpg?r=60&w=1200` : "";
  const photo = s.photo_url ? s.photo_url.replace("/112/", "/113/") : "";
  const first = photo || aerial;
  if (!first) return `<div class="ex-hero ${cls} empty"></div>`;
  // the label always says what the picture actually is
  return `<figure class="ex-hero ${cls}"><img src="${esc(first)}" alt="" data-fb="${photo ? esc(aerial) : ""}"
    onerror="if(this.dataset.fb){this.src=this.dataset.fb;this.dataset.fb='';this.nextElementSibling.textContent='Aerial · Vexcel'}else{this.parentElement.classList.add('empty')}">
    <figcaption>${photo ? "Listing photo" : "Aerial · Vexcel"}</figcaption></figure>`;
}

function render() {
  const { space: s, layout } = E.detail, c = E.card, st = E.ctx.status(s.space_id);
  const [cls, text] = STATUS[st] || STATUS.screened_only;
  const rent = s.rate_low_yr != null ? `${money(s.rate_low_yr, 0)}${s.rate_high_yr && s.rate_high_yr !== s.rate_low_yr ? `–${money(s.rate_high_yr, 0)}` : ""}<small>/sf/yr</small>` : `<span class="dim">Rent not listed</span>`;
  $("#explore").innerHTML = `
    <aside class="ex-nav">
      <button class="ex-back" id="ex-back">${svg("back")} Back to map</button>
      <nav>${TABS.map(([k, label, ic]) => `<button class="nav-item ${k === E.tab ? "active" : ""}" data-tab="${k}">${svg(ic)}<span>${label}</span>${k === "twin" && s.tour_level === "suite" ? '<i class="pip"></i>' : ""}</button>`).join("")}</nav>
      <div class="ex-mini">
        <span class="lbl">Screening match</span><b>${c ? `${c.match_pct}%` : "—"}</b><span class="hint">Heuristic from listing data</span>
      </div>
    </aside>
    <section class="ex-main">
      <header class="ex-head">
        <div>
          <div class="ex-tags"><span class="tag ${cls}">${esc(text)}</span>${E.ctx.recommended(s.space_id) ? '<span class="tag lime">Recommended</span>' : ""}<span class="tag muted">${esc(s.space_use)}</span></div>
          <h1>${esc(s.address)}</h1>
          <p class="dim">${esc([s.suite ? `Suite ${s.suite}` : null, s.floor_label, `${s.city}, ${s.state}`].filter(Boolean).join(" · "))}</p>
        </div>
        <div class="ex-kpis">
          <div><span class="lbl">Rent</span><b class="lime">${rent}</b></div>
          <div><span class="lbl">Size</span><b>${int(s.take_sqft)}<small> sf</small></b></div>
          <div><span class="lbl">Capacity</span><b>${int(layout.capacity.supported)}<small> ${esc(layout.capacity.unit.split(" ")[0])}</small></b></div>
          <div><span class="lbl">Available</span><b>${s.available_now ? "Now" : esc(s.available_date)}</b></div>
        </div>
      </header>
      <div class="ex-body" id="ex-body"></div>
    </section>`;
  $("#ex-back").onclick = closeExplore;
  $(".ex-nav nav").onclick = (e) => { const b = e.target.closest("[data-tab]"); if (b) show(b.dataset.tab); };
  show(E.tab);
}

function show(tab) {
  E.tab = tab;
  document.querySelectorAll(".ex-nav .nav-item").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
  if (tab !== "twin") { E.tour?.destroy(); E.tour = null; }
  const body = $("#ex-body");
  body.scrollTop = 0;
  ({ overview, twin, plan, aerial, market })[tab](body);
}

// ---------------------------------------------------------------- Overview: what we know, what failed, what's unknown
function overview(body) {
  const { space: s, why } = E.detail, v = E.proof?.verify, c = E.card;
  const conflicts = v?.conflicts || [], unknown = [...(v?.unverified || []), ...(v?.caveats || [])];
  const scanRow = !v || v.error ? ["unk", "Scan check", "Not available for this space"]
    : v.status === "unverified" ? ["unk", "Scan check", v.unverified?.[0] || "No scan of this suite"]
    : v.status === "conflict" ? ["bad", "Scan check", `${conflicts.length} requirement${conflicts.length > 1 ? "s" : ""} failed on measured rooms`]
    : ["ok", "Scan check", `${v.checks_passed}/${v.checks_total} checks pass on measured rooms`];
  const rows = [["ok", "Screening", "Right use, floor and size for the program"], scanRow];
  if (E.detail.layout.outdoor) rows.push(["unk", "Outdoor space", E.detail.layout.outdoor.status_text]);
  body.innerHTML = `
    <div class="ex-grid">
      ${hero(s)}
      <div class="card evidence">
        <h3>Evidence</h3>
        <ul class="ev-rows">${rows.map(([k, a, b]) => `<li class="${k}"><i></i><span><b>${esc(a)}</b>${esc(b)}</span></li>`).join("")}</ul>
        ${conflicts.length ? `<h4>Conflicts</h4><ul class="ev-list bad">${conflicts.map((x) => `<li><b>${esc(x.zone)}</b> needs ${esc(x.required.replace("≥ ", ""))} · has ${esc(x.measured.split(";")[0])}</li>`).join("")}</ul>` : ""}
        ${v?.build_out?.length ? `<h4>Build-out needed</h4><ul class="ev-list">${v.build_out.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : ""}
        ${unknown.length ? `<details class="ev-unknown"><summary>${plural(unknown.length, "open item")}</summary><ul class="ev-list unk">${unknown.map((x) => `<li>${esc(x)}</li>`).join("")}</ul></details>` : ""}
        ${v?.configuration_option ? `<p class="opt">${icon.info} ${esc(v.configuration_option.note)}</p>` : ""}
      </div>
    </div>
    <div class="ex-grid">
      <div class="card">
        <h3>Why it ranks here</h3>
        <ul class="why">${why.reasons.map((r) => `<li class="${r.tone}"><span class="ic">${toneIcon(r.tone)}</span><div><b>${esc(r.title)}</b>
          <details><summary>Evidence</summary><p class="dim">${esc(r.detail)}</p>${r.evidence.slice(0, 4).map((e) => `<p class="ev">${e.quote ? `“${esc(e.quote)}”` : `${esc(e.name)} <span class="dim">${esc(e.meta)}</span>`}</p>`).join("")}
          <p class="src">${sourceLink(r.source)}${r.caveat ? ` · ${esc(r.caveat)}` : ""}</p></details></div></li>`).join("")}</ul>
      </div>
      ${c ? `<div class="card">
        <h3>Screening match <span class="lime">${c.match_pct}%</span></h3>
        <p class="dim">A heuristic over listing data — not a physical check.</p>
        <div class="bars">${c.score_parts.map((p) => `<div class="bar"><span>${esc(p.label)}</span><i><b style="width:${Math.round(p.value * 100)}%"></b></i><em>${(p.value * p.weight * 100).toFixed(0)}/${Math.round(p.weight * 100)}</em></div>`).join("")}</div>
      </div>` : ""}
    </div>`;
}

// ---------------------------------------------------------------- Digital twin (Matterport)
function twin(body) {
  const s = E.detail.space;
  if (!s.tour_model_id) { body.innerHTML = `<div class="card empty-state"><h3>No digital twin</h3><p class="dim">CoStar has no Matterport scan for this building.</p></div>`; return; }
  const others = (s.building_tours || []).filter((t) => t.model_id !== s.tour_model_id);
  const assigned = (E.proof?.verify?.assignment || []).filter((a) => s.tour_level === "suite");
  body.innerHTML = `<div class="twin">
    <div class="twin-frame" id="tour-frame"></div>
    <aside class="card twin-side">
      <span class="lbl">${s.tour_level === "suite" ? "This exact suite" : "The building — not this suite"}</span>
      <p class="dim">“${esc(s.tour_caption || "Tour")}”${s.tour_level === "suite" ? `, matched by ${esc(s.tour_matched_by)}` : ""}.</p>
      <p class="tour-status" id="tour-status"></p>
      ${assigned.length ? `<h4>Walk the proposed zones</h4><div class="zones-walk">${assigned.map((a) => `<button class="zone-btn ${a.ok ? "" : "bad"}" data-room="${esc(a.room_id)}" disabled>
        <i style="background:${zoneColor(a.zone_id)}"></i><span>${esc(a.zone)}<small>${int(a.sqft)} sf room${a.ok ? "" : " · fails a check"}</small></span></button>`).join("")}</div>` : ""}
      ${others.length ? `<h4>Other tours here</h4><div class="chips">${others.map((t) => `<button class="pill" data-model="${esc(t.model_id)}">${esc(t.caption || "Tour")}</button>`).join("")}</div>` : ""}
    </aside></div>`;
  const status = (t) => { const el = $("#tour-status"); if (el) el.textContent = t; };
  const start = (modelId, main) => {
    E.tour?.destroy();
    E.tour = new Tour($("#tour-frame"), modelId, E.sdkKey, (state, text) => { status(text); if (state === "ready" && main) placeZones(); });
    E.tour.mount();
  };
  start(s.tour_model_id, true);
  body.onclick = async (e) => {
    const m = e.target.closest("[data-model]");
    if (m) { start(m.dataset.model, false); return; }
    const z = e.target.closest(".zone-btn");
    if (z && !z.disabled) await E.tour?.goTo(E.proof.rooms.find((r) => r.id === z.dataset.room)).catch(() => {});
  };
}

async function placeZones() {
  const rooms = E.proof?.rooms || [], as = E.proof?.verify?.assignment || [];
  if (!E.tour?.ready || !rooms.length || !as.length) return;
  const status = $("#tour-status");
  if (!E.tour.calibrate(rooms)) { if (status) status.textContent = "Connected · scan positions couldn't be matched to this tour; zones are on the floor plan."; return; }
  const pairs = as.map((a) => ({ room: rooms.find((r) => r.id === a.room_id), label: a.zone, description: `Floorproof · ${int(a.sqft)} sf room${a.ok ? "" : " · fails a check"}`,
    rgb: toRgb(cssVar(zoneColor(a.zone_id).slice(4, -1))) })).filter((p) => p.room);
  let live = 0;
  document.querySelectorAll(".zone-btn").forEach((b) => { if (E.tour.sweepFor(rooms.find((r) => r.id === b.dataset.room))) { b.disabled = false; live++; } });
  const placed = await E.tour.tagZones(pairs);
  if (status) status.textContent = `Connected · ${placed} zones tagged · ${live} to walk to`;
}

// ---------------------------------------------------------------- Floor plan: proposed zones, and the measured scan
function plan(body) {
  const { layout } = E.detail, c = layout.capacity, p = E.proof, v = p?.verify;
  const floor = p?.rooms?.length ? (p.rooms.find((r) => v?.assignment?.some((a) => a.room_id === r.id))?.floor_id || p.rooms[0].floor_id) : null;
  const measured = p?.rooms?.length ? scanSVG({ rooms: p.rooms }, { assignments: (v?.assignment || []).map((a) => ({ room_id: a.room_id, zone_id: a.zone_id, zone_label: a.zone, ok: a.ok, room_sqft: a.sqft })) }, floor) : "";
  body.innerHTML = `<div class="ex-grid wide">
    <div class="card">
      <div class="card-head"><h3>Measured rooms</h3><span class="tag ${v?.status === "conflict" ? "bad" : measured ? "ok" : "unk"}">${measured ? (v.status === "conflict" ? "Fails a check" : "From the Matterport scan") : "No scan"}</span></div>
      ${measured ? `<div class="fig draw">${measured}</div><p class="dim small">Zones placed in the rooms the scan measured. Red outline = the room fails its requirement.</p>`
        : `<p class="dim">No scan of this suite, so room geometry is unknown.</p>`}
    </div>
    <div class="card">
      <div class="card-head"><h3>Proposed zones</h3><span class="tag muted">Approximate shape</span></div>
      <p class="cap ${c.fits ? "" : "bad"}">${c.fits ? `Fits ${int(c.requested)} ${esc(c.unit)}${c.headroom ? ` · ${int(c.headroom)} spare` : ""}` : `Only ${int(c.supported)} of ${int(c.requested)} ${esc(c.unit)}`}</p>
      <div class="fig">${planSVG(layout)}</div>
      <table class="zt">${layout.zones.map((z) => `<tr><td><i style="background:${zoneColor(z.id)}"></i>${esc(z.label)} <span class="tag ${z.kind === "rule" ? "lime-outline" : "muted"}">${z.kind === "rule" ? "code" : "assumed"}</span></td><td>${int(z.sqft)} sf</td></tr>`).join("")}</table>
    </div></div>`;
}

// ---------------------------------------------------------------- Aerial (Vexcel)
function aerial(body) {
  const { space: s, aerial: a, layout } = E.detail, o = layout.outdoor;
  const facts = [["Lot", s.lot_sqft ? `${sqft(s.lot_sqft)}` : null], ["Open lot", s.open_lot_sqft ? `≈ ${sqft(s.open_lot_sqft)}` : null],
    ["Parking", s.parking_ratio ? `${s.parking_ratio}/1,000 sf${s.parking_spaces ? ` · ${int(s.parking_spaces)} spaces` : ""}` : null],
    ["Frontage", s.frontage_ft ? `${int(s.frontage_ft)} ft${s.frontage_street ? ` on ${s.frontage_street}` : ""}` : null], ["Zoning", s.zoning]].filter(([, v]) => v);
  body.innerHTML = `<div class="ex-grid wide">
    <div class="aerial-big" id="aerial">${a.available ? '<span class="spin"></span>' : '<p class="dim">Aerial imagery is not configured.</p>'}</div>
    <div class="card">
      <div class="seg" id="radius"><button class="on" data-r="70">Close</button><button data-r="140">Block</button></div>
      ${o ? `<p class="opt">${icon.alert} <b>${int(o.sqft)} sf outdoor play space needed.</b> ${esc(o.status_text)} The lime box is that area to scale.</p>` : ""}
      <h4>Site record</h4>${facts.length ? `<dl class="dl">${facts.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("")}</dl>` : '<p class="dim">No site record in the CoStar data.</p>'}
      <p class="src">${esc(a.attribution)}</p>
    </div></div>`;
  if (!a.available) return;
  const load = (r) => {
    const box = $("#aerial"), image = new Image();
    image.alt = `Aerial view of ${s.address}`;
    image.onload = () => {
      const m = r * 2, yard = o ? Math.sqrt(o.sqft) * 0.3048 : 0;
      box.innerHTML = ""; box.append(image);
      box.insertAdjacentHTML("beforeend", `<div class="cross"></div><div class="scalebar" style="width:${(30.48 / m) * 100}%">100 ft<i></i></div>${o ? `<div class="yard" style="width:${(yard / m) * 100}%;height:${(yard / m) * 100}%">${int(o.sqft)} sf</div>` : ""}`);
    };
    image.onerror = () => { box.innerHTML = '<p class="dim">No aerial image for this location.</p>'; };
    image.src = `${a.url}?r=${r}&w=1400`;
  };
  load(70);
  $("#radius").onclick = (e) => { const b = e.target.closest("button"); if (!b) return; $("#radius").querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b)); load(Number(b.dataset.r)); };
}

// ---------------------------------------------------------------- Market: rent, occupancy history, demand, the graph
function market(body) {
  const { why, space: s } = E.detail, rc = why.rent_check;
  const pick = (id) => why.reasons.find((r) => r.id === id);
  const block = (r) => r ? `<div class="card"><div class="card-head"><h3>${esc(r.title)}</h3></div>
    ${r.evidence.length ? `<ul class="rows">${r.evidence.slice(0, 6).map((e) => `<li>${e.quote ? `<span>“${esc(e.quote)}”</span>` : `<span>${esc(e.name)}</span><em>${esc(e.meta)}</em>`}</li>`).join("")}</ul>` : `<p class="dim">${esc(r.detail)}</p>`}
    <p class="src">${sourceLink(r.source)}${r.caveat ? ` · ${esc(r.caveat)}` : ""}</p></div>` : "";
  body.innerHTML = `<div class="ex-grid wide">
    <div class="card">
      <div class="card-head"><h3>Rent check</h3><span class="tag ${rc.tone === "good" ? "ok" : rc.tone === "warn" ? "bad" : "muted"}">${rc.known ? `${money((rc.low + (rc.high || rc.low)) / 2, 0)}/sf/yr` : "Not listed"}</span></div>
      <p class="lead">${esc(rc.verdict)}</p>
      <div class="rent-chart">${rentChart(rc) || ""}</div>
      ${rc.monthly_est ? `<p class="dim">≈ ${money(rc.monthly_est, 0)}/month for ${sqft(s.take_sqft)} · ${esc(rc.service_type && !/Unknown/.test(rc.service_type) ? rc.service_type : "service type not stated")}</p>` : ""}
      <p class="src">${esc(rc.caveat)}</p>
    </div>
    ${block(pick("history")) || `<div class="card"><h3>Occupancy history</h3><p class="dim">No tenants of this type on record in this building.</p></div>`}
    ${block(pick("demand"))}
    ${block(pick("competition"))}
  </div>
  <details class="card kg"><summary>Knowledge graph · ${why.graph.nodes.length} of ${int(why.graph_size.nodes)} nodes behind these facts</summary>
    <div class="kg-wrap"><div class="fig" style="min-width:760px">${knowledgeGraph(why.graph)}</div></div></details>`;
}
