// scout. — ask → the agent writes a brief, searches, picks a top 10 and deep-dives the top 3 → you compare and choose.
// The page shows results, never the agent's reasoning: brief, progress, picks, deep dives, comparison.
import { ScoutMap } from "./map.js";

const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const money = (n, d = 0) => (n == null ? "—" : "$" + Number(n).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d }));
const num = (n) => (n == null ? "—" : Number(n).toLocaleString("en-US"));

// One search box: the agent decides from the sentence whether it's a home or a space for a business.
const STEPS = { null: [["understand", "Understanding"], ["brief", "Brief"], ["search", "Search"], ["top", "Top 10"], ["deep", "Deep dives"]],
                home: [["understand", "Home search"], ["brief", "Brief"], ["search", "Search"], ["top", "Top 10"], ["deep", "Deep dives"]],
                commercial: [["understand", "Business space"], ["brief", "Brief"], ["areas", "Best areas"], ["search", "Search"], ["top", "Top 10"], ["deep", "Deep dives"]] };const RADII = [0.5, 1, 2, 3, 5, 8, 10, 15, 20, 30];
const USE = { OfficeRetail: "Office/retail", OfficeMedical: "Medical office", Retail: "Retail", Office: "Office", Medical: "Medical", Flex: "Flex", Industrial: "Industrial" };

const S = { mode: null, meta: null, config: {}, run: 0, ctrl: null, query: "", brief: null, edits: {}, places: null,
            steps: {}, total: null, top: [], comparison: null, deep: {}, by: null, fallback: null, done: null,
            picked: [], view: "cards", sort: null, ctx: {}, t0: 0 };

const map = new ScoutMap($("#map"), { onSelect: (id) => openDetails(id), onHover: (id) => hover(id, true) });

// ---------------------------------------------------------------- boot
async function boot() {
  $("#ask").addEventListener("submit", (e) => { e.preventDefault(); const q = $("#q").value.trim() || $("#q").placeholder; $("#q").value = q; start({ query: q }); });
  $("#examples").addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) { $("#q").value = b.textContent; start({ query: b.textContent }); } });
  document.querySelectorAll(".view-switch button").forEach((b) => b.addEventListener("click", () => setView(b.dataset.view)));
  $("#searchNav").addEventListener("click", () => { $("#comparison").hidden = true; $("#explore").hidden = false; syncPicked(); map.resize(); window.scrollTo(0, 0); });
  $("#compareNav").addEventListener("click", () => S.picked.length ? showComparison() : toast("Add up to three picks with + to compare them side by side."));
  $("#compareButton").addEventListener("click", showComparison);
  $("#clearSelection").addEventListener("click", () => { S.picked = []; syncPicked(); });
  $("#backBrowse").addEventListener("click", () => { $("#comparison").hidden = true; $("#explore").hidden = false; syncPicked(); map.resize(); });
  $("#applyBrief").addEventListener("click", applyEdits);
  $("#detailDialog").addEventListener("click", (e) => { if (e.target.id === "detailDialog" || e.target.closest("[data-close]")) $("#detailDialog").close(); });
  const params = new URLSearchParams(location.search);
  if (params.get("q")) { $("#q").value = params.get("q"); start({ query: params.get("q") }); }
  $("#agentText").textContent = "Connecting…";
  try {
    [S.meta, S.config] = await Promise.all([fetch("/api/meta").then((r) => r.json()), fetch("/api/config").then((r) => r.json())]);
  } catch { $("#agentText").textContent = "Server not answering"; return; }
  const a = S.meta?.agent;
  $("#agentText").textContent = a ? `${a.framework} · ${a.model}` : "Fixed rules (no AI key)";
  $("#agentPill").querySelector(".status-dot").classList.toggle("connected", !!a);
  $("#examples").innerHTML = (S.meta.examples?.all || []).map((x) => `<button type="button" class="chip">${esc(x)}</button>`).join("");
}

function setMode(mode) {          // decided by the agent (a "mode" event), or chosen by the user in the brief
  S.mode = mode;
  document.body.dataset.mode = mode || "";
  renderProgress();
}
// ---------------------------------------------------------------- one run
async function start({ query, brief = null, places = null, mode = null }) {
  const run = ++S.run;
  S.ctrl?.abort();
  S.ctrl = new AbortController();
  Object.assign(S, { query: query ?? S.query, edits: {}, steps: {}, total: null, top: [], comparison: null, deep: {}, by: null,
                     fallback: null, done: null, picked: [], sort: null, ctx: {}, t0: performance.now() });
  if (!brief) { S.brief = null; setMode(mode); }          // a new question: the agent decides home or business again
  history.replaceState(null, "", `?q=${encodeURIComponent(S.query)}`);
  document.body.classList.add("has-results");
  $("#workspace").hidden = false;
  $("#empty").hidden = true;
  $("#applyBrief").hidden = true;
  $("#go").disabled = true;
  setView("cards");
  syncPicked();
  map.clear(); map.resize();
  renderProgress();
  renderBrief();
  $("#resultCount").textContent = "The agent is working on it…";
  $("#deepCards").innerHTML = ""; $("#moreCards").innerHTML = ""; $("#deepTitle").hidden = $("#moreTitle").hidden = true;
  $("#loading").innerHTML = '<div class="loading-card"></div>'.repeat(3);
  let finished = false;
  try {
    const res = await fetch("/api/run", { method: "POST", headers: { "Content-Type": "application/json" }, signal: S.ctrl.signal,
      body: JSON.stringify({ mode: brief ? S.mode : mode, query: S.query, brief, places }) });
    if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j.detail || `HTTP ${res.status}`); }
    const reader = res.body.getReader(), dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let cut;
      while ((cut = buf.indexOf("\n\n")) >= 0) {
        const chunk = buf.slice(0, cut); buf = buf.slice(cut + 2);
        if (!chunk.startsWith("data: ") || run !== S.run) continue;
        const ev = JSON.parse(chunk.slice(6));
        if (ev.type === "done") finished = true;
        onEvent(ev);
      }
    }
  } catch (e) {
    if (e.name === "AbortError" || run !== S.run) return;
    toast(`Search stopped: ${e.message}`);
  } finally {
    if (run === S.run) $("#go").disabled = false;
  }
  if (run === S.run && !finished) {
    $("#loading").innerHTML = "";
    $("#resultCount").textContent = S.top.length ? "The search ended early; these picks are kept." : "The search ended early.";
    if (!S.top.length) { $("#empty").hidden = false; $("#emptyText").textContent = "The connection dropped before the agent finished. Try again."; }
  }
}

function onEvent(ev) {
  switch (ev.type) {
    case "start":
      S.agent = ev.agent;
      if (ev.mode) setMode(ev.mode);
      renderProgress();
      break;
    case "mode": setMode(ev.mode); break;
    case "step":
      S.steps[ev.key] = ev.state;
      renderProgress();
      break;
    case "brief":
      S.brief = ev.brief;
      renderBrief();
      map.anchors(ev.brief.anchors);
      if (!S.top.length) map.city(ev.brief.city);
      break;
    case "zones": map.zones(ev.zones); legend(); break;
    case "search":
      S.total = ev.total;
      map.candidates(ev.points);
      $("#resultCount").textContent = `${num(ev.total)} listing${ev.total === 1 ? "" : "s"} match your brief. Picking the best ten…`;
      break;
    case "top":
      S.top = ev.cards; S.comparison = ev.comparison; S.by = ev.by;
      $("#loading").innerHTML = "";
      if (!S.top.length) { $("#empty").hidden = false; $("#emptyText").textContent = "Nothing matches this brief. Widen a radius or the budget above."; }
      renderCards();
      map.top(S.top);
      legend();
      if (S.view === "table") renderTable();
      break;
    case "deep":
      S.deep[ev.id] = ev;
      updateDeep(ev.id);
      if (ev.rank === 1 && ev.context?.competitors) showCompetitors(ev.id, false);
      break;
    case "fallback":
      S.fallback = ev.reason;
      renderProgress();
      if (/credits|rejected/.test(ev.reason)) { $("#agentText").textContent = "AI unavailable · fixed rules"; $("#agentPill .status-dot").classList.remove("connected"); }
      break;
    case "done":
      S.done = ev;
      renderProgress();
      $("#resultCount").textContent = S.top.length
        ? `${S.by === "fallback" ? "Picked by fixed rules" : "Picked by the agent"} from ${num(S.total)} matching listing${S.total === 1 ? "" : "s"} · ${ev.stats.seconds}s`
        : "No listings matched.";
      break;
    case "error": toast(ev.text); break;
  }
}

// ---------------------------------------------------------------- progress (no reasoning, just where it is)
function renderProgress() {
  const steps = STEPS[S.mode];
  const done = !!S.done;
  const html = steps.map(([k, label]) => {
    const st = done || (k === "understand" && S.mode) ? "done" : S.steps[k] || (k === "understand" && S.query ? "live" : "");
    const extra = k === "deep" && S.top.length ? ` <b>${Object.keys(S.deep).length}/3</b>` : "";
    return `<span class="ps ${st}"><i></i>${label}${extra}</span>`;
  }).join("");
  const tag = S.fallback ? "" : S.agent ? "LangChain DeepAgents · orchestrator + 3 deep-dive sub-agents" : S.agent === null ? "Fixed rules · no AI key" : "";
  const fb = S.fallback ? `<span class="ps warn" title="${esc(S.fallback)}"><i></i>${esc(S.fallback)}</span>` : "";
  $("#progress").innerHTML = html + fb + `<span class="agent-tag">${tag}</span>`;
  $("#agentPill .status-dot").classList.toggle("live", !done && !!S.query);
}

// ---------------------------------------------------------------- the brief (editable)
function renderBrief() {
  const b = S.brief, el = $("#brief");
  if (!b) { el.innerHTML = `<div class="bf"><span>Brief</span><em class="muted small">The agent is writing it…</em></div>`; $("#adjust").hidden = true; return; }
  const v = (k) => (k in S.edits ? S.edits[k] : b[k]);
  const ed = (k) => (k in S.edits ? " edited" : "");
  const sel = (k, opts) => `<select data-k="${k}">${opts.map(([val, lbl]) => `<option value="${val}"${String(v(k) ?? "") === String(val) ? " selected" : ""}>${lbl}</option>`).join("")}</select>`;
  const numIn = (k, ph = "Any", step = 50) => `<input type="number" data-k="${k}" min="0" step="${step}" value="${v(k) ?? ""}" placeholder="${ph}">`;
  const tog = (k, label, val) => `<label class="toggle"><input type="checkbox" data-k="${k}"${val ? " checked" : ""}>${label}</label>`;
  const near = (S.places ?? b.anchors.map((a) => ({ place: a.query, radius_mi: a.radius_mi, label: a.label })));
  const nearHtml = `<div class="near-list">${near.map((a, i) => `<span class="near-chip">${esc(a.label || a.place)} · ≤ <select data-near="${i}">${RADII.concat(RADII.includes(a.radius_mi) ? [] : [a.radius_mi]).sort((x, y) => x - y)
    .map((r) => `<option value="${r}"${r === a.radius_mi ? " selected" : ""}>${r} mi</option>`).join("")}</select><button data-drop="${i}" aria-label="Remove">×</button></span>`).join("")}
    <input class="add-place" placeholder="+ add a place" style="width:120px;font-size:12px"></div>`;
  const modeSel = `<select data-k="mode">${[["home", "A home to live in"], ["commercial", "Space for a business"]].map(([m, l]) => `<option value="${m}"${(S.edits.mode || b.mode) === m ? " selected" : ""}>${l}</option>`).join("")}</select>`;
  let html = `<label class="bf${ed("mode")}"><span>Looking for</span>${modeSel}</label>
    <label class="bf${ed("city")}"><span>Where</span>${sel("city", [["houston", "Houston, TX"], ["los_angeles", "Los Angeles, CA"]])}</label>`;
  if (b.mode === "home") {
    html += `<label class="bf${ed("beds")}"><span>Bedrooms</span>${sel("beds", [["", "Any"], ["0", "Studio"], ["1", "1"], ["2", "2"], ["3", "3+"]])}</label>
      <label class="bf${ed("baths_min")}"><span>Bathrooms</span>${sel("baths_min", [["", "Any"], ["1", "1+"], ["1.5", "1.5+"], ["2", "2+"], ["2.5", "2.5+"], ["3", "3+"]])}</label>
      <label class="bf${ed("budget_max")}"><span>Budget / mo</span>${numIn("budget_max")}</label>
      <label class="bf${ed("sqft_min")}"><span>Min sq ft</span>${numIn("sqft_min")}</label>
      <div class="bf${ed("anchors")}"><span>Near</span>${nearHtml}</div>
      <div class="bf"><span>Must</span><div class="near-list">${sel("pets", [["", "Any pets"], ["dog", "Dog allowed"], ["cat", "Cat allowed"]]).replace("<select", '<select style="width:auto"')}${tog("parking", "Parking", v("parking"))}</div></div>`;
  } else {
    const must = v("must_have") || [];
    html += `<label class="bf${ed("business")}"><span>Business</span><input data-k="business" value="${esc(v("business_label") || b.business_label || "")}"></label>
      <div class="bf${ed("sqft_min") || ed("sqft_max")}"><span>Size, sq ft</span><div class="pair">${numIn("sqft_min", "min", 100)}–${numIn("sqft_max", "max", 100)}</div></div>
      <label class="bf${ed("budget_max")}"><span>Budget / mo</span>${numIn("budget_max", "Any", 100)}</label>
      <div class="bf${ed("anchors")}"><span>Near</span>${nearHtml}</div>
      <div class="bf"><span>Must</span><div class="near-list">${tog("ground_floor", "Ground floor", v("ground_floor"))}${tog("must:kitchen", "Kitchen", must.includes("kitchen"))}${tog("must:parking", "Parking", must.includes("parking"))}</div></div>`;
  }
  el.innerHTML = html;
  el.onchange = (e) => {
    const t = e.target;
    if (t.dataset.near != null) { ensurePlaces(); S.places[+t.dataset.near].radius_mi = +t.value; S.edits.anchors = true; }
    else if (t.dataset.k?.startsWith("must:")) { const m = new Set(v("must_have") || []); t.checked ? m.add(t.dataset.k.slice(5)) : m.delete(t.dataset.k.slice(5)); S.edits.must_have = [...m]; }
    else if (t.dataset.k === "business") { S.edits.business = t.value.trim(); S.edits.business_label = t.value.trim().toLowerCase(); }
    else if (t.dataset.k) {
      const k = t.dataset.k;
      S.edits[k] = t.type === "checkbox" ? t.checked : t.value === "" ? null : ["city", "pets", "mode"].includes(k) ? t.value : Number(t.value);
    }
    $("#applyBrief").hidden = false;
    renderBrief();
  };
  el.onclick = (e) => {
    const d = e.target.closest("[data-drop]");
    if (d) { ensurePlaces(); S.places.splice(+d.dataset.drop, 1); S.edits.anchors = true; $("#applyBrief").hidden = false; renderBrief(); }
  };
  el.querySelector(".add-place")?.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || !e.target.value.trim()) return;
    e.preventDefault();
    ensurePlaces(); S.places.push({ place: e.target.value.trim(), radius_mi: 3, label: e.target.value.trim() });
    S.edits.anchors = true; $("#applyBrief").hidden = false; renderBrief();
  });
  const adj = (b.adjustments || []).map((a) => `${a.field.replace(/_/g, " ")} ${fmtAdj(a.from)} → ${fmtAdj(a.to)}`);
  $("#adjust").hidden = !adj.length;
  $("#adjust").textContent = adj.length ? `To find enough matches the brief was widened: ${adj.join(" · ")}` : "";
}
const fmtAdj = (x) => (x == null ? "any" : Array.isArray(x) ? x.join(", ") || "any" : typeof x === "number" ? (x > 100 ? num(x) : `${x}`) : String(x));
function ensurePlaces() { if (!S.places) S.places = S.brief.anchors.map((a) => ({ place: a.query, radius_mi: a.radius_mi, label: a.label })); }

function applyEdits() {
  if (S.edits.mode && S.edits.mode !== S.brief.mode) { S.places = null; start({ query: S.query, mode: S.edits.mode }); return; }   // a different kind of search: fresh brief
  delete S.edits.mode;
  const b = { ...S.brief };
  const locked = new Set(b.locked || []);
  for (const [k, val] of Object.entries(S.edits)) {
    if (k === "anchors") { locked.add("anchors"); continue; }
    b[k] = val; locked.add(k === "business_label" ? "business" : k);
  }
  if ("business" in S.edits) { delete b.space_uses; b.business = S.edits.business; }
  b.locked = [...locked];
  const places = S.places ? S.places.map(({ place, radius_mi }) => ({ place, radius_mi })) : b.anchors.map((a) => ({ place: a.query, radius_mi: a.radius_mi }));
  S.places = null;
  start({ query: S.query, brief: b, places });
}

// ---------------------------------------------------------------- cards
function img(c, w = 640) {
  const aerial = c.lat != null ? `/api/aerial/${c.property_id}.jpg?lat=${c.lat}&lon=${c.lon}&r=60&w=${w}` : "";
  const photo = c.mode === "home" ? c.photo : "";       // commercial listing photos are blocked off-site; aerials instead
  const first = photo || aerial;
  if (!first) return `<div class="placeholder"><strong>${esc(c.name)}</strong></div>`;
  return `<img loading="lazy" referrerpolicy="no-referrer" src="${esc(first)}" alt="" data-fb="${photo ? esc(aerial) : ""}"
    onerror="if(this.dataset.fb){this.src=this.dataset.fb;this.dataset.fb='';this.nextElementSibling&&(this.nextElementSibling.textContent='Aerial · Vexcel')}else{this.remove()}">
    <span class="img-tag">${photo ? "Photo" : "Aerial · Vexcel"}</span>`;
}

function petWords(pets) {
  const p = new Set(pets || []), cat = p.has("Cat"), dog = p.has("Dog");
  return cat && dog ? "<span>Cats &amp; dogs ok</span>" : dog ? "<span>Dogs ok</span>" : cat ? "<span>Cats ok</span>" : "";
}

function distLine(c) {
  const d = Object.entries(c.distances || {});
  return d.length ? `<p class="dist-line">${d.map(([k, v]) => `<span>${v.miles} mi to ${esc(v.nearest && v.nearest.length < 34 ? v.nearest : k)}</span>`).join("")}</p>` : "";
}

function cardHtml(c, rank) {
  const picked = S.picked.includes(c.id);
  const top3 = rank <= 3;
  let body;
  if (c.mode === "home") {
    const p = c.plan;
    body = `<div class="card-topline"><span class="city-label">${esc([c.neighbourhood, c.zip].filter(Boolean).join(" · ") || c.city)}</span><span class="availability">${p.available} available</span></div>
      <h3>${esc(c.name)}</h3><p class="card-address">${esc(c.address)}, ${esc(c.city)}</p>
      <div class="plan-facts"><span>${p.beds === 0 ? "Studio" : `${p.beds} bd`}</span><span>${p.baths} ba</span><span>${p.sqftMin ? num(p.sqftMin) + " sq ft" : "size n/a"}</span>${petWords(c.pets)}${c.parking?.length ? "<span>Parking</span>" : ""}</div>
      ${distLine(c)}
      ${top3 ? deepHtml(c.id) : ""}
      <div class="card-bottom"><div class="rent">${money(p.rentMin)}<small>/mo</small><span class="rent-sub">${esc(p.name || "")} · from</span></div><button class="details-link" data-open="${c.id}">Details →</button></div>`;
  } else {
    const q = c.quick || {};
    body = `<div class="card-topline"><span class="city-label">${esc([c.neighbourhood, c.zip, USE[c.space_use] || c.space_use].filter(Boolean).join(" · "))}</span><span class="availability">${c.available_now ? "Available now" : ""}</span></div>
      <h3>${esc(c.address)}${c.suite ? ` · ${esc(c.suite)}` : ""}</h3><p class="card-address">${esc(c.name !== c.address ? c.name : c.city)}</p>
      <div class="plan-facts"><span>${num(c.sqft)} sq ft</span>${c.ground ? "<span>Ground floor</span>" : c.floor ? `<span>${esc(c.floor)}</span>` : ""}${c.fitout ? `<span>Fit-out: ${esc(c.fitout)}</span>` : ""}${c.tour ? "<span>3D tour</span>" : ""}</div>
      <div class="quick"><div><b>${num(q.residents_units)}</b><span>apartment units ½ mi</span></div><div><b>${num(q.office_workers)}</b><span>office workers ½ mi</span></div><div><b>${num(q.competitors)}</b><span>competitors ½ mi</span></div></div>
      ${distLine(c)}
      ${top3 ? deepHtml(c.id) : ""}
      <div class="card-bottom"><div class="rent">${c.monthly ? "≈ " + money(c.monthly) : "Rent n/a"}<small>${c.monthly ? "/mo" : ""}</small><span class="rent-sub">${c.rate_yr ? money(c.rate_yr, 2) + " /sq ft/yr" : "Not listed: ask the broker"}</span></div><button class="details-link" data-open="${c.id}">Details →</button></div>`;
  }
  return `<article class="card ${picked ? "selected" : ""}" data-id="${c.id}" style="animation-delay:${(rank - 1) * 45}ms">
    <div class="card-media">${img(c)}<span class="rank">${rank}</span><button class="select-round" data-pick="${c.id}" aria-pressed="${picked}" aria-label="Add to compare">${picked ? "✓" : "+"}</button></div>
    <div class="card-content">${body}</div></article>`;
}

function deepHtml(id) {
  const d = S.deep[id];
  if (!d) return `<div class="deep" data-deep="${id}"><div class="deep-label">DEEP DIVE <em>sub-agent at work</em></div><div class="deep-wait"><i></i>Checking who's around, competitors and rent…</div></div>`;
  const by = d.by === "fallback" ? `<span class="by-rules">fixed rules</span>` : `<em>by a deep-dive agent</em>`;
  const lines = d.highlights.map((h) => `<li>${esc(h)}</li>`).join("") + d.watch_outs.map((w) => `<li class="wo">${esc(w)}</li>`).join("");
  return `<div class="deep" data-deep="${id}"><div class="deep-label">DEEP DIVE ${by}</div>${lines ? `<ul class="hl">${lines}</ul>` : ""}${factsHtml(d.context, true)}</div>`;
}

function factsHtml(ctx, compact = false) {
  if (!ctx || ctx.error) return "";
  if (ctx.mode === "commercial") {
    const w = ctx.who_visits, c = ctx.competitors, u = ctx.can_use, r = ctx.fair_rent;
    const plural = (n, one, many) => `${num(n)} ${n === 1 ? one : many}`;
    const who = [`${num(w.residents.units)} apt units`, `${num(w.office_workers.count)} office workers`, w.students.schools ? `${plural(w.students.schools, "school", "schools")} (1 mi)` : null,
                 w.visitors.hotels ? plural(w.visitors.hotels, "hotel", "hotels") : null].filter(Boolean).join(" · ");
    const past = (u.same_type_in_building || []).filter((x) => !x.current), here = (u.same_type_in_building || []).filter((x) => x.current);
    const usable = [u.fitout?.[0], past.length ? `Previously here: ${past[0].name} (${past[0].years})` : null,
                    u.parking?.spaces ? `${num(u.parking.spaces)} parking spaces` : null, u.transit_quarter_mi?.length ? `Transit: ${u.transit_quarter_mi[0]}` : null]
                   .filter(Boolean);
    const compNote = [here.length ? `In this building: ${here[0].name}` : null, c.nearest?.length ? `Nearest: ${c.nearest[0].name} (${c.nearest[0].miles} mi)` : null].filter(Boolean).join(" · ");
    const rentHead = r.vs_pct == null ? (r.rate_yr ? `${money(r.rate_yr, 2)}/sq ft/yr` : "Not listed") : r.vs_pct === 0 ? "At market" : `${Math.abs(r.vs_pct)}% ${r.vs_pct < 0 ? "below" : "above"} market`;
    const cards = [
      ["Who will visit", who, `within ½ mile${w.students.universities?.length ? ` · near ${w.students.universities[0]}` : ""}`],
      ["Competitors", c.counts.half_mi == null ? "Unknown" : `${c.counts.half_mi} mapped within ½ mi${c.counts.in_building ? ` · ${c.counts.in_building} in this building` : ""}`, compNote || (c.counts.half_mi == null ? "No map data for this kind of business" : "None mapped within 1 mi")],
      ["What you can use", usable[0] ? clip(usable[0], 70) : "No fit-out noted", usable.slice(1, 3).map((x) => clip(x, 60)).join(" · ")],
      ["Fair rent", rentHead,
       r.ref_median ? `Signed median ${money(r.ref_median, 2)}/sf/yr (${r.ref_n} deals)` : r.verdict || ""],
    ];
    return `<div class="facts">${cards.map(([k, b, p]) => `<div class="fact"><span>${k}</span><b>${esc(b)}</b>${p ? `<p>${esc(p)}</p>` : ""}</div>`).join("")}</div>`;
  }
  const near = Object.entries(ctx.anchors || {}).map(([k, a]) => [`To ${k}`, a.miles != null ? `${a.miles} mi` : "—", a.nearest || ""]);
  const named = new Set(Object.values(ctx.anchors || {}).map((a) => a.nearest));     // don't repeat a place already shown as "To …"
  const around = Object.entries(ctx.around || {}).filter(([, a]) => !named.has(a.name))
    .slice(0, compact ? 4 - Math.min(near.length, 2) : 7).map(([k, a]) => [`Nearest ${k}`, `${a.miles} mi`, a.name]);
  const cards = [...near.slice(0, 2), ...around];
  return `<div class="facts">${cards.map(([k, b, p]) => `<div class="fact"><span>${esc(k)}</span><b>${esc(b)}</b><p>${esc(clip(p, 48))}</p></div>`).join("")}</div>`;
}
const clip = (s, n) => (s && s.length > n ? s.slice(0, n - 1) + "…" : s || "");

function renderCards() {
  const top = S.top;
  $("#deepTitle").hidden = !top.length;
  $("#moreTitle").hidden = top.length <= 3;
  $("#deepCards").innerHTML = top.slice(0, 3).map((c, i) => cardHtml(c, i + 1)).join("");
  $("#moreCards").innerHTML = top.slice(3).map((c, i) => cardHtml(c, i + 4)).join("");
  $("#resultsTitle").textContent = top.length >= 10 ? "Your top 10" : `Your top ${top.length}`;
  for (const host of [$("#deepCards"), $("#moreCards")]) {
    host.onclick = (e) => {
      const p = e.target.closest("[data-pick]");
      if (p) { e.stopPropagation(); togglePick(+p.dataset.pick); return; }
      const o = e.target.closest("[data-open]") || e.target.closest(".card-media");
      const card = e.target.closest(".card");
      if (o && card) openDetails(+card.dataset.id);
      else if (card) { map.focus(+card.dataset.id); if (S.deep[+card.dataset.id]) showCompetitors(+card.dataset.id, false); }
    };
    host.onpointerover = (e) => { const c = e.target.closest(".card"); hover(c ? +c.dataset.id : null); };
  }
}

function updateDeep(id) {
  const el = document.querySelector(`[data-deep="${id}"]`);
  if (el) el.outerHTML = deepHtml(id);
  renderProgress();
}

function hover(id, fromMap = false) {
  map.hover(id);
  document.querySelectorAll(".card").forEach((c) => c.classList.toggle("hot", +c.dataset.id === id));
  if (fromMap && id) document.querySelector(`.card[data-id="${id}"]`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
}

function showCompetitors(id, fly) {
  const d = S.deep[id], c = S.top.find((x) => x.id === id);
  if (d?.context?.competitors && c) map.competitors(d.context.competitors.nearest, fly ? [c.lat, c.lon] : null);
}

function legend() {
  const items = [["#9a6b1f", "Your places"], ["#8c9a8a", "Every match"], ["#24362f", "Top picks"]];
  if (S.mode === "commercial") items.splice(1, 0, ["#72916d", "Best areas"]), items.push(["#a3443a", "Competitors (pick #1)"]);
  $("#legend").innerHTML = items.map(([c, l]) => `<span><i style="background:${c}"></i>${l}</span>`).join("");
}

// ---------------------------------------------------------------- compare all 10 (the algorithm: compares, doesn't rank)
function setView(v) {
  S.view = v;
  document.querySelectorAll(".view-switch button").forEach((b) => b.setAttribute("aria-selected", b.dataset.view === v));
  $("#cardsView").hidden = v !== "cards";
  $("#tableView").hidden = v !== "table";
  if (v === "table") renderTable();
}

function cell(v, fmt) {
  if (v == null) return "—";
  if (fmt === "money") return money(v);
  if (fmt === "money2") return money(v, 2);
  if (fmt === "miles") return `${v} mi`;
  if (fmt === "bool") return v ? "Yes" : "No";
  if (typeof v === "number") return num(v);
  return esc(v);
}

function renderTable() {
  const cmp = S.comparison;
  if (!cmp) { $("#tableView").innerHTML = `<p class="muted small">The comparison appears when the top 10 is ready.</p>`; return; }
  const order = S.top.map((c) => c.id);
  let rows = cmp.rows.slice();
  if (S.sort) {
    const { key, dir } = S.sort;
    rows.sort((a, b) => { const x = a.values[key], y = b.values[key]; if (x == null) return 1; if (y == null) return -1; return (x > y ? 1 : x < y ? -1 : 0) * dir; });
  }
  const name = (id) => { const c = S.top.find((x) => x.id === id); return c.mode === "home" ? c.name : `${c.address}${c.suite ? " · " + c.suite : ""}`; };
  const actions = (id) => { const c = S.top.find((x) => x.id === id); return `<span class="row-actions">${toursOf(c).length ? `<button data-go="tour" data-id="${id}">3D tour</button>` : ""}<button data-go="aerial" data-id="${id}">Aerial</button><button data-go="street" data-id="${id}">Street</button></span>`; };
  const thumb = (id) => { const c = S.top.find((x) => x.id === id); return `<img class="row-thumb" alt="" loading="lazy" referrerpolicy="no-referrer" src="/api/aerial/${c.property_id}.jpg?lat=${c.lat}&lon=${c.lon}&r=60&w=200">`; };
  $("#tableView").innerHTML = `<div class="table-scroll"><table class="all-table"><thead><tr><th>#</th><th>Listing</th><th>See it</th>${cmp.columns.map((c) =>
    `<th data-sort="${esc(c.key)}"${S.sort?.key === c.key ? ` aria-sort="${S.sort.dir > 0 ? "ascending" : "descending"}"` : ""}>${esc(c.label)}<i>${S.sort?.key === c.key ? (S.sort.dir > 0 ? "▲" : "▼") : "↕"}</i></th>`).join("")}</tr></thead>
    <tbody>${rows.map((r) => `<tr data-id="${r.id}"><td class="rk">${order.indexOf(r.id) + 1}</td><td class="name"><div class="name-cell">${thumb(r.id)}<b>${esc(name(r.id))}</b></div></td><td>${actions(r.id)}</td>${cmp.columns.map((c) =>
      `<td class="${r.best.includes(c.key) ? "best" : ""}">${cell(r.values[c.key], c.fmt)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>
    <p class="table-note"># is the agent's order. ★ marks the best value in each column. Click a column to sort; click a row for details.</p>`;
  $("#tableView thead").onclick = (e) => {
    const th = e.target.closest("[data-sort]"); if (!th) return;
    const k = th.dataset.sort;
    S.sort = S.sort?.key === k ? (S.sort.dir > 0 ? { key: k, dir: -1 } : null) : { key: k, dir: 1 };
    renderTable();
  };
  $("#tableView tbody").onclick = (e) => {
    const go = e.target.closest("[data-go]");
    if (go) { e.stopPropagation(); openDetails(+go.dataset.id, go.dataset.go); return; }
    const tr = e.target.closest("tr[data-id]"); if (tr) openDetails(+tr.dataset.id);
  };
}

// ---------------------------------------------------------------- side by side (HomeFit's shortlist)
function togglePick(id) {
  const i = S.picked.indexOf(id);
  if (i >= 0) S.picked.splice(i, 1);
  else if (S.picked.length >= 3) { toast("Compare up to three at a time."); return; }
  else S.picked.push(id);
  syncPicked();
}

function syncPicked() {
  $("#navCount").textContent = S.picked.length;
  $("#trayCount").textContent = `${S.picked.length} / 3`;
  $("#tray").hidden = !S.picked.length;
  $("#trayItems").innerHTML = S.picked.map((id) => {
    const c = S.top.find((x) => x.id === id);
    return c ? `<div class="tray-item"><img alt="" referrerpolicy="no-referrer" src="/api/aerial/${c.property_id}.jpg?lat=${c.lat}&lon=${c.lon}&r=60&w=200"><span>${esc(c.mode === "home" ? c.name : c.address)}</span><button data-unpick="${id}" aria-label="Remove">×</button></div>` : "";
  }).join("");
  $("#trayItems").onclick = (e) => { const b = e.target.closest("[data-unpick]"); if (b) togglePick(+b.dataset.unpick); };
  document.querySelectorAll(".card").forEach((el) => {
    const on = S.picked.includes(+el.dataset.id);
    el.classList.toggle("selected", on);
    const b = el.querySelector("[data-pick]"); if (b) { b.setAttribute("aria-pressed", on); b.textContent = on ? "✓" : "+"; }
  });
}

const toursOf = (c) => (c.mode === "home" ? c.tours || [] : c.tour ? [c.tour] : []);

async function contextOf(id) {      // deep-dive context when there is one, else the same facts from the server
  if (S.deep[id]?.context) return S.deep[id].context;
  if (S.ctx[id]) return S.ctx[id];
  try {
    const r = await fetch("/api/listing", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mode: S.mode, id, brief: S.brief }) }).then((x) => x.json());
    S.ctx[id] = r.context;
  } catch { S.ctx[id] = null; }
  return S.ctx[id];
}

function detailRows(cards, ctxs) {
  const row = (label, f) => `<tr><th>${label}</th>${cards.map((c, i) => `<td>${ctxs[i] ? f(ctxs[i], c) : "—"}</td>`).join("")}</tr>`;
  if (S.mode === "commercial") return [
    row("Who will visit", (x) => `${num(x.who_visits.residents.units)} apartment units<br>${num(x.who_visits.office_workers.count)} office workers<br><span class="muted">${x.who_visits.students.schools} schools · ${x.who_visits.visitors.hotels} hotels nearby</span>`),
    row("Competitors", (x) => `${x.competitors.counts.half_mi == null ? "Unknown" : `${x.competitors.counts.half_mi} within ½ mi`}${x.competitors.nearest?.[0] ? `<br><span class="muted">Nearest: ${esc(x.competitors.nearest[0].name)} (${x.competitors.nearest[0].miles} mi)</span>` : ""}`),
    row("What you can use", (x) => [x.can_use.fitout?.[0] ? esc(clip(x.can_use.fitout[0], 90)) : null, x.can_use.parking?.spaces ? `${num(x.can_use.parking.spaces)} parking spaces` : null,
                                   x.can_use.transit_quarter_mi?.[0] ? `Transit: ${esc(x.can_use.transit_quarter_mi[0])}` : null].filter(Boolean).join("<br>") || '<span class="muted">Nothing noted</span>'),
    row("Fair rent", (x) => x.fair_rent.vs_pct == null ? esc(x.fair_rent.verdict || "—") : `${x.fair_rent.vs_pct === 0 ? "At market" : `${Math.abs(x.fair_rent.vs_pct)}% ${x.fair_rent.vs_pct < 0 ? "below" : "above"} market`}<br><span class="muted">Signed median ${money(x.fair_rent.ref_median, 2)}/sf/yr</span>`),
    row("Building", (x) => esc([x.can_use.building?.name, x.can_use.building?.class ? `Class ${x.can_use.building.class}` : null, x.can_use.building?.year_built ? `built ${x.can_use.building.year_built}` : null].filter(Boolean).join(" · ") || "—")),
  ].join("");
  return [
    row("Your places", (x) => Object.entries(x.anchors || {}).map(([k, a]) => `${a.miles} mi to ${esc(a.nearest || k)}`).join("<br>") || '<span class="muted">None in the brief</span>'),
    ...["school", "park", "grocery store", "rail or transit station"].map((k) => row(`Nearest ${k.split(" ")[0]}`, (x) => x.around?.[k] ? `${x.around[k].miles} mi<br><span class="muted">${esc(x.around[k].name)}</span>` : "—")),
    row("Plans that fit", (x) => { const f = (x.plans || []).filter((p) => p.fits); return f.length ? f.slice(0, 3).map((p) => `${esc(p.name || "Plan")}: ${money(p.rentMin)} · ${num(p.sqftMin)} sq ft`).join("<br>") : "—"; }),
    row("Pets & parking", (x) => `${esc((x.pets || []).filter((p) => p === "Dog" || p === "Cat").join(" & ") || "No pets listed")}<br><span class="muted">${esc((x.parking || []).join(", ") || "No parking listed")}</span>`),
  ].join("");
}

function mediaCell(c) {
  const tabs = [["aerial", "Aerial"], ...(toursOf(c).length ? [["tour", "3D tour"]] : []), ["street", "Street view"]];
  return `<div class="cmp-media" data-media="${c.id}"><div class="cmp-tabs">${tabs.map(([t, l], i) => `<button data-mtab="${t}" aria-pressed="${i === 0}">${l}</button>`).join("")}</div>
    <div class="cmp-view">${seeIt(c, "aerial", toursOf(c), true)}</div></div>`;
}

async function showComparison() {
  if (!S.picked.length) return;
  const cmp = S.comparison, ids = [...S.picked];
  const cards = ids.map((id) => S.top.find((x) => x.id === id));
  const rows = ids.map((id) => cmp.rows.find((r) => r.id === id));
  const best = {};                                   // best among the selected only
  for (const col of cmp.columns) {
    if (!col.better || ids.length < 2) continue;
    const vals = rows.map((r) => r.values[col.key]).filter((x) => x != null);
    if (!vals.length || new Set(vals).size === 1) continue;
    best[col.key] = col.better === "low" ? Math.min(...vals) : col.better === "high" ? Math.max(...vals) : true;
  }
  const render = (ctxs) => {
    const head = `<tr><th></th>${cards.map((c) => `<td>${mediaCell(c)}<p class="compare-property-name">${S.top.indexOf(c) + 1}. ${esc(c.mode === "home" ? c.name : c.address + (c.suite ? " · " + c.suite : ""))}</p><span class="muted small">${esc(c.address)}, ${esc(c.city)} ${esc(c.zip || "")}</span><div><button class="details-link" data-open="${c.id}">Full details →</button></div></td>`).join("")}</tr>`;
    const body = cmp.columns.map((col) => `<tr><th>${esc(col.label)}</th>${rows.map((r) => {
      const v = r.values[col.key];
      const win = col.key in best && v != null && v === best[col.key];
      return `<td>${cell(v, col.fmt)}${win ? '<span class="winner">best</span>' : ""}</td>`;
    }).join("")}</tr>`).join("");
    const deep = `<tr><th>Deep dive</th>${cards.map((c) => { const d = S.deep[c.id]; return `<td>${d ? `<ul class="hl">${d.highlights.map((h) => `<li>${esc(h)}</li>`).join("")}${d.watch_outs.map((w) => `<li class="wo">${esc(w)}</li>`).join("")}</ul>` : '<span class="muted">Deep dives cover the top 3</span>'}</td>`; }).join("")}</tr>`;
    const details = ctxs ? `<tr class="group"><th colspan="${cards.length + 1}">${S.mode === "commercial" ? "The location" : "Around it"}</th></tr>${detailRows(cards, ctxs)}`
                         : `<tr><th>Location</th><td colspan="${cards.length}" class="muted">Loading the details…</td></tr>`;
    $("#comparisonContent").innerHTML = `<div class="compare-scroll"><table class="comparison-table ${cards.length === 1 ? "one" : ""}">${head}${body}${deep}${details}</table></div>`;
  };
  render(null);
  $("#explore").hidden = true; $("#comparison").hidden = false; $("#tray").hidden = true; window.scrollTo(0, 0);
  $("#comparisonContent").onclick = (e) => {
    const t = e.target.closest("[data-mtab]");
    if (t) {
      const box = t.closest("[data-media]"), c = S.top.find((x) => x.id === +box.dataset.media);
      box.querySelectorAll("[data-mtab]").forEach((b) => b.setAttribute("aria-pressed", b === t));
      box.querySelector(".cmp-view").innerHTML = seeIt(c, t.dataset.mtab, toursOf(c), true);
      return;
    }
    const o = e.target.closest("[data-open]"); if (o) openDetails(+o.dataset.open);
  };
  const ctxs = await Promise.all(ids.map(contextOf));
  if (!$("#comparison").hidden && ids.join() === S.picked.join()) {
    const views = [...document.querySelectorAll(".cmp-media")].map((m) => [m.dataset.media, m.innerHTML]);   // keep the tab each column is on
    render(ctxs);
    views.forEach(([id, html]) => { const m = document.querySelector(`.cmp-media[data-media="${id}"]`); if (m) m.innerHTML = html; });
  }
}
// ---------------------------------------------------------------- details dialog
async function openDetails(id, tab = null) {
  const c = S.top.find((x) => x.id === id);
  if (!c) return;
  const dlg = $("#detailDialog");
  const rank = S.top.indexOf(c) + 1;
  let ctx = S.deep[id]?.context || S.ctx[id];
  const render = () => {
    const facts = c.mode === "home"
      ? [["Rent from", money(c.plan.rentMin) + "/mo"], ["Layout", `${c.plan.beds === 0 ? "Studio" : c.plan.beds + " bd"} · ${c.plan.baths} ba`], ["Size", c.plan.sqftMin ? num(c.plan.sqftMin) + " sq ft" : "—"], ["Available", `${c.plan.available} units`]]
      : [["Rent", c.monthly ? `≈ ${money(c.monthly)}/mo` : "Not listed"], ["Size", `${num(c.sqft)} sq ft`], ["Rate", c.rate_yr ? `${money(c.rate_yr, 2)}/sf/yr` : "—"], ["Floor", c.ground ? "Ground" : c.floor || "—"]];
    const tours = c.mode === "home" ? (c.tours || []) : c.tour ? [c.tour] : [];
    const d = S.deep[id];
    dlg.querySelector("#detailContent").innerHTML = `
      <div class="detail-image">${img(c, 1200)}<button class="icon-button" data-close aria-label="Close">×</button></div>
      <div class="detail-body">
        <div class="eyebrow">PICK #${rank}${rank <= 3 ? " · DEEP DIVE" : ""}</div>
        <h2>${esc(c.mode === "home" ? c.name : c.address + (c.suite ? " · " + c.suite : ""))}</h2>
        <p class="detail-address">${esc(c.address)}, ${esc(c.city)} ${esc(c.zip || "")}${c.neighbourhood ? " · " + esc(c.neighbourhood) : ""}</p>
        <div class="detail-facts">${facts.map(([k, v]) => `<div><span>${k}</span><strong>${esc(v)}</strong></div>`).join("")}</div>
        ${d ? `<h3>Deep dive ${d.by === "fallback" ? '<span class="by-rules">fixed rules</span>' : ""}</h3><ul class="hl">${d.highlights.map((h) => `<li>${esc(h)}</li>`).join("")}${d.watch_outs.map((w) => `<li class="wo">${esc(w)}</li>`).join("")}</ul>` : ""}
        <h3>${c.mode === "home" ? "Around it" : "The location"}</h3>
        ${ctx ? factsHtml(ctx) + extraHtml(ctx) : '<p class="muted small">Loading…</p>'}
        <h3>See it</h3>
        <div class="detail-tabs" role="tablist">${tours.length ? '<button role="tab" data-tab="tour" aria-selected="true">3D tour</button>' : ""}<button role="tab" data-tab="aerial" aria-selected="${!tours.length}">Aerial</button><button role="tab" data-tab="street" aria-selected="false">Street view</button></div>
        <div id="seeIt"></div>
        <p class="source-note">${esc((ctx?.sources || []).join(" · "))}. Distances are straight-line. ${c.mode === "home" ? "Rents are asking rents for the floor plan, before fees." : "Asking rents mix service types; confirm terms with the broker."}</p>
      </div>`;
    const tabs = dlg.querySelector(".detail-tabs");
    const show = (t) => { tabs.querySelectorAll("button").forEach((b) => b.setAttribute("aria-selected", b.dataset.tab === t)); dlg.querySelector("#seeIt").innerHTML = seeIt(c, t, tours); };
    tabs.onclick = (e) => { const b = e.target.closest("[data-tab]"); if (b) show(b.dataset.tab); };
    show(tab && (tab !== "tour" || tours.length) ? tab : tours.length ? "tour" : "aerial");
  };
  render();
  if (!dlg.open) dlg.showModal();
  if (!ctx) {
    try {
      ctx = await contextOf(id);
      if (dlg.open && ctx) render();
    } catch { /* the dialog still shows the card's facts */ }
  }
}

function extraHtml(ctx) {
  if (ctx.mode === "commercial") {
    const comp = ctx.competitors.nearest.slice(0, 6), hist = ctx.can_use.same_type_in_building, draws = ctx.can_use.draws;
    return `<div class="detail-grid">
      <div><h3>Nearest competitors</h3>${comp.length ? `<ul class="list-plain">${comp.map((x) => `<li><span>${esc(x.name)}</span><span>${x.miles} mi</span></li>`).join("")}</ul>` : '<p class="muted small">None mapped within a mile.</p>'}</div>
      <div><h3>Nearby draws</h3>${draws.length ? `<ul class="list-plain">${draws.map((x) => `<li><span>${x.count} ${esc(x.what)}</span><span>${x.nearest ? esc(clip(x.nearest, 26)) : "½ mi"}</span></li>`).join("")}</ul>` : '<p class="muted small">No mapped draws within ½ mile.</p>'}
      ${hist.length ? `<h3>Same kind of business in this building</h3><ul class="list-plain">${hist.map((x) => `<li><span>${esc(x.name)}${x.current ? " (still there)" : ""}</span><span>${esc(x.years)}</span></li>`).join("")}</ul>` : ""}</div></div>
      ${ctx.can_use.fitout.length ? `<h3>From the listing</h3><p class="small">${ctx.can_use.fitout.map(esc).join("<br>")}</p>` : ""}`;
  }
  const plans = ctx.plans || [];
  return plans.length ? `<h3>Floor plans</h3><div class="plan-row head"><span>Plan</span><span>Layout</span><span>Sq ft</span><span>Rent from</span><span>Available</span></div>
    ${plans.map((p) => `<div class="plan-row ${p.fits ? "fit" : ""}"><span>${p.fits ? "<b>" : ""}${esc(p.name || "Plan")}${p.fits ? " ✓</b>" : ""}</span><span>${p.beds === 0 ? "Studio" : p.beds + " bd"} · ${p.baths} ba</span><span>${num(p.sqftMin)}</span><span>${money(p.rentMin)}</span><span>${p.available}</span></div>`).join("")}
    <p class="muted small">✓ plans match your brief.</p>` : "";
}

function seeIt(c, tab, tours, compact = false) {
  const cls = compact ? " compact" : "";
  if (tab === "tour" && tours.length) return `<div class="tour-frame${cls}"><iframe src="https://my.matterport.com/show/?m=${encodeURIComponent(tours[0])}&play=1&qs=1" allow="fullscreen; xr-spatial-tracking" title="3D tour"></iframe></div>`;
  if (tab === "aerial") return `<img class="aerial-image${cls}" referrerpolicy="no-referrer" alt="Aerial view" src="/api/aerial/${c.property_id}.jpg?lat=${c.lat}&lon=${c.lon}&r=90" onerror="this.outerHTML='<div class=placeholder><strong>No aerial here</strong><p>Vexcel had no image for this spot.</p></div>'">`;
  const loc = `${c.lat},${c.lon}`;
  const key = S.config?.google_embed_key;
  if (key) return `<iframe class="street-view-frame${cls}" loading="lazy" referrerpolicy="no-referrer-when-downgrade" src="https://www.google.com/maps/embed/v1/streetview?key=${encodeURIComponent(key)}&location=${loc}&radius=100&source=outdoor&fov=90" title="Street view"></iframe>`;
  return `<div class="placeholder${cls}"><strong>Street view</strong><p>Opens Google Maps at this address in a new tab.</p><a target="_blank" rel="noopener" href="https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${loc}">Open street view ↗</a></div>`;
}

function toast(text) { const t = $("#toast"); t.textContent = text; t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => { t.hidden = true; }, 4000); }

boot();
