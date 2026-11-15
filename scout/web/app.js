// Floorproof — request → the filter proposes candidates → the agent reviews and checks them (live, from backend events)
// → only the agent's picks become result cards; the spaces it rejected are listed with its reasons.
import { api, esc, icon, initTooltip, int, money, sourceLink } from "./util.js";
import { MapView } from "./mapview.js";
import { explore, closeExplore, isExploring, STATUS } from "./explore.js";

const $ = (s, r = document) => r.querySelector(s);
const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
const S = {
  meta: null, data: null, run: 0, ctrl: null, query: "", phase: "idle",
  cards: new Map(), order: [], status: new Map(), info: new Map(), reasons: new Map(), rejected: [],
  ranking: null, zones: null, steps: [], inspected: new Set(), reviewed: new Set(), current: "", selected: null, panel: "results", t0: 0,
};
const POOL = 12;
const SCAN_STATES = new Set(["verified", "verified_with_caveats", "conflict", "not_verifiable"]);
const pins = () => S.order.map((id, i) => ({ card: S.cards.get(id), rank: S.ranking ? i + 1 : null })).filter((x) => x.card);

const map = new MapView($("#map"), { onSelect: (id) => select(id, { fromMap: true }), onHover: (id) => hover(id) });

// ---------------------------------------------------------------- boot
async function boot() {
  initTooltip();
  $("#ask").addEventListener("submit", (e) => { e.preventDefault(); const q = $("#q").value.trim() || $("#q").placeholder; $("#q").value = q; start({ text: q }); });
  $("#cmd").addEventListener("submit", (e) => { e.preventDefault(); const q = $("#cmd-q").value.trim(); if (q) { $("#cmd-q").value = ""; start({ text: q }); } });
  $("#rerun").onclick = () => start({ program: S.data.program, text: S.query });
  const phone = matchMedia("(max-width: 860px)");
  $("#burger").onclick = () => document.body.classList.toggle(phone.matches ? "side-open" : "side-collapsed");
  document.querySelector(".side").addEventListener("click", (e) => { if (e.target.closest("[data-panel], #new")) document.body.classList.remove("side-open"); });
  document.addEventListener("click", (e) => { if (!e.target.closest(".side, #burger")) document.body.classList.remove("side-open"); });
  document.querySelectorAll("[data-panel]").forEach((b) => b.addEventListener("click", () => setPanel(b.dataset.panel)));
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && isExploring()) closeExplore(); });
  $("#map").addEventListener("click", (e) => { const b = e.target.closest("[data-explore]"); if (b) open(Number(b.dataset.explore)); });
  try {
    const [meta, pts] = await Promise.all([api("/api/meta"), api("/api/points")]);
    S.meta = meta;
    map.setPoints(pts.points);
  } catch (e) { toast(`The data isn't ready: ${e.message}`); return; }
  const c = S.meta.counts;
  $("#stats").innerHTML = `<li><b>${int(c.spaces)}</b>spaces for lease</li><li><b>${int(c.suite_tours)}</b>suites scanned in 3D</li><li><b>${int(c.graph_nodes)}</b>knowledge-graph nodes</li>`;
  $("#examples").innerHTML = S.meta.examples.map((x) => `<button type="button">${esc(x)}</button>`).join("");
  $("#examples").onclick = (e) => { const b = e.target.closest("button"); if (b) { $("#q").value = b.textContent; start({ text: b.textContent }); } };
  $("#agent-sub").textContent = S.meta.integrations.agent ? `${S.meta.integrations.agent.model} · ready` : "Deterministic mode";
  map.drift();
  const q = new URLSearchParams(location.search).get("q");
  if (q) { $("#q").value = q; start({ text: q }); }
}

// ---------------------------------------------------------------- one run
async function start(body) {
  const run = ++S.run;
  S.ctrl?.abort();
  if (isExploring()) closeExplore();
  setBusy(true);
  if (!document.body.classList.contains("is-landing")) renderSkeleton();
  let data;
  try { data = await api("/api/search", { ...body, limit: 40 }); }
  catch (e) { if (run === S.run) { setBusy(false); toast(`Search failed: ${e.message}`); } return; }
  if (run !== S.run) return;                                  // a newer request replaced this one
  setBusy(false);
  S.data = data;
  if (body.text) { S.query = body.text; history.replaceState(null, "", `?q=${encodeURIComponent(body.text)}`); }
  S.cards = new Map(data.results.map((r) => [r.space_id, r]));
  S.order = data.results.slice(0, POOL).map((r) => r.space_id);            // the filter's proposals, not results
  S.status = new Map(S.order.map((id) => [id, "queued"]));
  S.info = new Map(); S.reasons = new Map(); S.rejected = []; S.ranking = null; S.zones = null; S.steps = [];
  S.inspected = new Set(); S.reviewed = new Set(); S.selected = null; S.t0 = performance.now();
  enterWorkspace();
  renderFilters();
  setPanel("results");
  step("screen", `Filter: ${int(data.funnel[0].n)} listings → ${int(data.total_matches)} pass city, use, size and budget`, "done");
  map.selected = null;
  map.showScreening(data.match_points, cityCenter(data));
  map.setTop(pins());
  map.fitTo(S.order.map((id) => [S.cards.get(id).lat, S.cards.get(id).lon]), [70, 70]);
  if (!data.results.length) { S.phase = "empty"; renderList(); return; }
  investigate(run);
}

function cityCenter(d) {
  const pts = d.match_points.length ? d.match_points : [[0, 29.76, -95.37]];
  return [pts.reduce((a, p) => a + p[1], 0) / pts.length, pts.reduce((a, p) => a + p[2], 0) / pts.length];
}

function enterWorkspace() {
  if (!document.body.classList.contains("is-landing")) return;
  map.stopDrift();
  document.body.classList.replace("is-landing", "is-work");
  map.follow(900);
}

async function investigate(run) {
  S.ctrl = new AbortController();
  S.phase = "investigating";
  S.current = "Starting the investigation";
  setRun("live", "Investigating");
  renderList();
  let finished = false;
  try {
    const res = await fetch("/api/agent", { method: "POST", headers: { "Content-Type": "application/json" }, signal: S.ctrl.signal,
      body: JSON.stringify({ program: S.data.program, text: S.data.parse.parser === "form" ? "" : S.query }) });
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
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
    step("warn", `Connection lost: ${e.message}`, "bad");
  }
  if (run !== S.run) return;
  if (!finished) {                                            // the stream ended without its closing event
    S.phase = S.ranking ? "ranked" : "interrupted";
    setRun("warn", "Interrupted");
    step("warn", "The investigation ended early — results so far are kept", "bad");
    renderList();
  }
  $("#rerun").hidden = false;
}

// ---------------------------------------------------------------- backend events
const pending = new Map();

function onEvent(ev) {
  switch (ev.type) {
    case "start": step("agent", `Site analyst online · ${ev.model.model}`, "done"); break;
    case "fallback": step("warn", `Deterministic mode — ${ev.reason.replace(/\.$/, "")}`, "warn"); setRun("warn", "Deterministic"); break;
    case "collection": {
      ev.cards.forEach((c) => S.cards.set(c.space_id, c));
      const ids = ev.cards.map((c) => c.space_id);
      if (ids.join() !== S.order.join()) { S.order = ids; ids.forEach((id) => S.status.has(id) || S.status.set(id, "queued")); map.setTop(pins()); renderList(); }
      break;
    }
    case "tool_call": toolCall(ev); break;
    case "tool_result": toolResult(ev); break;
    case "candidate": {
      const c = ev.card;
      S.cards.set(c.space_id, c);
      if (!S.status.has(c.space_id)) S.status.set(c.space_id, "queued");
      break;
    }
    case "card":
      S.status.set(ev.space_id, ev.status);
      S.info.set(ev.space_id, ev);
      if (SCAN_STATES.has(ev.status)) S.inspected.add(ev.space_id);
      S.reviewed.add(ev.space_id);
      if (!S.ranking && !S.order.includes(ev.space_id) && S.cards.has(ev.space_id)) {   // the agent pulled in another candidate
        S.order.push(ev.space_id);
        map.setTop(pins());
        renderList();
      }
      map.setState(ev.space_id, mapState(ev.status));
      updateRow(ev.space_id);
      renderProgress();
      break;
    case "exterior": break;
    case "note": S.steps.push({ kind: "note", text: ev.text, state: "note" }); break;
    case "ranking": ranking(ev); break;
    case "done":
      S.phase = "ranked";
      setRun("done", `Done · ${ev.stats.seconds}s`);
      step("done", `${S.reviewed.size} reviewed · ${ev.stats.checked} checked on scans · ${ev.stats.tool_calls} tool calls · ${ev.stats.seconds}s${ev.mode === "fallback" ? " · no AI" : ""}`, "done");
      $("#agent-sub").textContent = ev.mode === "fallback" ? "Deterministic · done" : "Done";
      S.current = "";
      renderProgress();
      break;
    case "error": step("warn", ev.text, "bad"); break;
  }
}

const label = (id) => { const c = S.cards.get(Number(id)); return c ? `${c.address}${c.suite ? ` · ${c.suite}` : ""}` : `space ${id}`; };
const mapState = (st) => ({ verified: "ok", verified_with_caveats: "ok", conflict: "bad", not_verifiable: "unk" }[st] || "");

function toolCall(ev) {
  const a = ev.args || {};
  const t = {
    get_business_requirements: () => "Reading the code requirements",
    screen_spaces: () => (a.require_suite_scan ? "Asking the filter for suites with their own 3D scan" : "Taking the filter's candidates"),
    review_candidates: () => `Reviewing the evidence for ${(a.space_ids || []).length} candidates`,
    verify_layout: () => `${a.alternative_capacity ? `Testing ${a.alternative_capacity} as an alternative · ` : ""}Inspecting ${label(a.space_id)} on its 3D scan`,
    observe_exterior: () => `Reading the aerial · ${label(a.space_id)}`,
    submit_shortlist: () => "Deciding the shortlist",
  }[ev.tool]?.();
  if (!t) return;
  const s = step(ev.tool, t, "live");
  pending.set(ev.id, s);
  S.current = t;
  if (ev.tool === "review_candidates") (a.space_ids || []).forEach((x) => { const id = Number(x); if (!S.reviewed.has(id)) { S.status.set(id, "reviewing"); updateRow(id); } });
  if (ev.tool === "verify_layout" && !a.alternative_capacity) {
    const id = Number(a.space_id);
    S.status.set(id, "inspecting");
    map.inspect(id);
    updateRow(id);
    $("#agent-sub").textContent = "Inspecting…";
  }
  renderProgress();
}

function toolResult(ev) {
  const s = pending.get(ev.id), r = ev.result || {};
  const settle = (text, state = "done") => { if (s) { s.result = text; s.state = state; } renderSteps(); };
  if (r.error) { settle(r.error, "bad"); return; }
  if (ev.tool === "get_business_requirements") { S.zones = r.zones; settle(`${r.zones.length} zones · code minimum ${int(r.whole_space.legal_minimum_sqft)} sf`); if (S.panel === "requirements") renderRequirements(); }
  else if (ev.tool === "screen_spaces") settle(`${r.candidates.length} candidates · ${r.candidates.filter((c) => c.suite_scan).length} with a suite scan`);
  else if (ev.tool === "review_candidates") settle(`${r.spaces.filter((x) => !x.error).length} reviewed`);
  else if (ev.tool === "verify_layout") {
    const alt = /^ALTERNATIVE/.test(r.configuration || "");
    settle(`${alt ? "Alternative · " : ""}${r.status === "conflict" ? `✕ ${r.conflicts[0].zone}: ${r.conflicts[0].measured.split(";")[0]}` : r.status === "unverified" ? "No usable scan" : `✓ ${r.checks_passed}/${r.checks_total} checks pass`}`,
      r.status === "conflict" ? "bad" : r.status === "unverified" ? "warn" : "done");
  } else if (ev.tool === "observe_exterior") settle(r.vexcel_observation ? `Open ground: ${r.vexcel_observation.open_ground_next_to_building}` : "Site record only", r.vexcel_observation ? "done" : "warn");
  else if (ev.tool === "submit_shortlist") settle(r.accepted ? "Accepted" : `Sent back: ${r.problems[0]}`, r.accepted ? "done" : "bad");
  renderProgress();
}

function ranking(ev) {
  S.ranking = ev;
  ev.entries.forEach((e) => { S.reasons.set(e.space_id, e); if (e.status) S.status.set(e.space_id, e.status); map.setState(e.space_id, mapState(e.status)); });
  S.rejected = ev.rejected || [];
  S.rejected.forEach((e) => { S.reasons.set(e.space_id, e); S.status.set(e.space_id, e.status === "conflict" ? "conflict" : "rejected"); });
  S.order = ev.entries.map((e) => e.space_id);                  // only what the agent chose
  S.phase = "ranked";
  renderList();
  if (!reduced) document.querySelectorAll("#cards > li").forEach((li, k) =>
    li.animate([{ opacity: 0, transform: "translateY(10px)" }, { opacity: 1, transform: "none" }], { duration: 420, delay: k * 50, easing: "cubic-bezier(.2,.8,.2,1)", fill: "backwards" }));
  map.setTop(pins());
  if (S.order.length) map.fitTo(S.order.map((id) => [S.cards.get(id)?.lat, S.cards.get(id)?.lon]), [70, 70]);   // keep every pick in view
  if (ev.recommended_space_id) select(ev.recommended_space_id, { quiet: true });
}

// ---------------------------------------------------------------- the middle column
function setPanel(p) {
  S.panel = p;
  document.querySelectorAll("#nav [data-panel], .side-nav [data-panel]").forEach((b) => b.classList.toggle("active", b.dataset.panel === p));
  ({ results: renderList, investigation: renderSteps, requirements: renderRequirements, about: renderAbout })[p]();
}

function renderSkeleton() {
  if (S.panel !== "results") return;
  $("#list").innerHTML = `<div class="sk-head"></div>${"<div class='sk-card'><i></i><div><b></b><b></b><b></b></div></div>".repeat(5)}`;
}

function progressHtml() {
  const n = S.inspected.size, r = S.reviewed.size, live = S.phase === "investigating", done = !!S.ranking;
  const cls = (ok, on) => (ok ? "done" : on ? "on" : "");
  return `<div class="progress" id="progress">
    <div class="pr-steps">
      <span class="${cls(r > 0 || done, live && r === 0)}"><i></i>Review <b>${r}/${Math.max(r, S.order.length && !done ? S.order.length : r)}</b></span>
      <span class="${cls(done || n >= 3, live && r > 0 && !done)}"><i></i>Scan check <b>${n}</b></span>
      <span class="${cls(done, false)}"><i></i>Picked <b>${done ? S.ranking.entries.length : "—"}</b></span>
    </div>
    ${live && S.current ? `<p class="pr-now"><i class="pulse"></i>${esc(S.current)}</p>` : ""}
    ${S.phase === "interrupted" ? `<p class="pr-now warn">Investigation ended early · <button class="link" id="retry">Retry</button></p>` : ""}
  </div>`;
}
function renderProgress() {
  if (S.panel !== "results" || !$("#progress")) return;
  $("#progress").outerHTML = progressHtml();
  $("#retry")?.addEventListener("click", () => start({ program: S.data.program, text: S.query }));
  const n = $("#nav-count"); n.textContent = S.steps.filter((x) => x.kind !== "note").length || "";
}

function renderList() {
  if (S.panel !== "results") return;
  const d = S.data;
  if (!d) return;
  if (S.phase === "empty") {
    $("#list").innerHTML = `<div class="empty"><h3>Nothing fits yet</h3><p>No space in the data passes screening for this request.${d.over_budget ? ` ${d.over_budget} more fit but are over budget.` : ""}</p></div>`;
    return;
  }
  if (!S.ranking) {                                             // the agent hasn't decided: candidates, not results
    $("#list").innerHTML = `
      <div class="list-head"><h2>Under review</h2><span class="dim">${int(d.total_matches)} pass the filter in ${esc(d.sizing.market_name)}</span></div>
      ${progressHtml()}
      <p class="review-note">The filter proposed these ${S.order.length}. The site analyst decides which to keep: nothing is a result until it does.</p>
      <ol class="review" id="cards">${S.order.map(rowHtml).join("")}</ol>`;
  } else {
    const r = S.ranking, picks = r.entries.length;
    $("#list").innerHTML = `
      <div class="list-head"><h2>Analyst's picks</h2><span class="dim">${picks} of ${r.reviewed ?? S.reviewed.size} reviewed</span></div>
      ${progressHtml()}
      ${recommendationHtml()}
      ${picks ? `<ol class="cards" id="cards">${S.order.map((id, i) => cardHtml(id, i + 1)).join("")}</ol>`
              : `<div class="empty"><h3>No space holds up</h3><p>The analyst rejected every candidate it reviewed. The reasons are below.</p></div>`}
      ${rejectedHtml()}
      <p class="list-foot">Every space here was chosen by the site analyst from the evidence. <b>Match %</b> is the filter's heuristic score from listing data, shown for reference; it doesn't decide the order.</p>`;
  }
  $("#retry")?.addEventListener("click", () => start({ program: S.data.program, text: S.query }));
  $("#rejected")?.addEventListener("click", (e) => { const b = e.target.closest("[data-explore]"); if (b) open(Number(b.dataset.explore)); });
  const cards = $("#cards");
  if (!cards) return;
  cards.onclick = (e) => {
    const ex = e.target.closest("[data-explore]");
    if (ex) { e.stopPropagation(); open(Number(ex.dataset.explore)); return; }
    const li = e.target.closest("li[data-id]");
    if (li) select(Number(li.dataset.id));
  };
  cards.ondblclick = (e) => { const li = e.target.closest("li[data-id]"); if (li) open(Number(li.dataset.id)); };
  cards.onkeydown = (e) => { const li = e.target.closest("li[data-id]"); if (li && e.key === "Enter") open(Number(li.dataset.id)); };
  cards.onpointerover = (e) => { const li = e.target.closest("li[data-id]"); map.hover(li ? Number(li.dataset.id) : null); };
  cards.onpointerleave = () => map.hover(null);
  $("#rec-open")?.addEventListener("click", () => open(S.ranking.recommended_space_id));
}

function recommendationHtml() {
  const r = S.ranking, s = r?.summary;
  if (!s?.recommendation) return "";
  return `<div class="recbox">
    <div class="rec-top"><span class="tag lime">Recommendation</span><span class="dim">${r.source === "agent" ? "Site analyst" : "Fixed rules"} · ${r.reviewed ?? S.reviewed.size} reviewed · ${r.checked.length} on scans</span></div>
    <p class="rec-text">${esc(s.recommendation)}</p>
    <ul class="rec-list">${s.key_reasons.map((k) => `<li class="ok">${icon.check}<span>${esc(k)}</span></li>`).join("")}${s.warnings.map((w) => `<li class="warn">${icon.alert}<span>${esc(w)}</span></li>`).join("")}</ul>
    ${r.recommended_space_id ? `<button class="btn-lime" id="rec-open">Explore ${esc(label(r.recommended_space_id))}</button>` : ""}
  </div>`;
}

function statusChip(id) {
  const st = S.status.get(id) || "queued", [cls, text] = STATUS[st] || STATUS.queued;
  const info = S.info.get(id) || S.reasons.get(id) || {};
  const tip = st === "conflict" && info.conflict ? info.conflict : st.startsWith("verified") && info.checks ? `${info.checks} checks pass on measured rooms` : "";
  return `<span class="st ${cls}"${tip ? ` data-tip="${esc(tip)}" tabindex="0"` : ""}><i></i>${esc(text)}</span>`;
}

function moveHtml(id) {
  return S.cards.get(id)?.discovered ? `<span class="mv new" data-tip="The analyst went looking for this one beyond the filter's first proposals" tabindex="0">found</span>` : "";
}

function rowHtml(id) {                                          // a candidate while the analyst works: no rank, no price
  const c = S.cards.get(id);
  if (!c) return "";
  return `<li class="rv ${S.selected === id ? "sel" : ""}" data-id="${id}" tabindex="0">
    <div><b>${esc(c.address)}</b><span>${esc([c.suite ? `Suite ${c.suite}` : null, c.space_use, c.scan_of_suite ? "has a 3D scan" : null].filter(Boolean).join(" · "))}</span></div>
    ${statusChip(id)}</li>`;
}

function updateRow(id) {
  const li = document.querySelector(`#cards > li[data-id="${id}"]`);
  if (!li) return;
  li.outerHTML = S.ranking ? cardHtml(id, S.order.indexOf(id) + 1) : rowHtml(id);
  const fresh = document.querySelector(`#cards > li[data-id="${id}"] .st`);
  if (fresh && !reduced) fresh.animate([{ transform: "scale(.9)", opacity: .3 }, { transform: "none", opacity: 1 }], { duration: 320 });
}

function rejectedHtml() {
  if (!S.rejected.length) return "";
  return `<details class="rejected" id="rejected"><summary>Rejected by the analyst <b>${S.rejected.length}</b></summary><ul>
    ${S.rejected.map((e) => `<li><div><b>${esc(e.address)}${e.suite ? ` · ${esc(e.suite)}` : ""}</b><span>${esc(e.reason)}</span></div>
      <button class="pc-go" data-explore="${e.space_id}" aria-label="Explore ${esc(e.address)}" title="Explore">↗</button></li>`).join("")}</ul></details>`;
}

function thumb(c) {
  const aerial = c.lat != null ? `/api/aerial/${c.property_id}.jpg?r=45&w=320` : "";
  const photo = c.photo_url ? c.photo_url : "";
  const first = photo || aerial;
  if (!first) return `<div class="th empty"></div>`;
  return `<div class="th"><img loading="lazy" src="${esc(first)}" alt="" data-fb="${photo ? esc(aerial) : ""}"
    onerror="if(this.dataset.fb){this.src=this.dataset.fb;this.dataset.fb='';this.nextElementSibling.hidden=false}else{this.parentElement.classList.add('empty')}"><em ${photo ? "hidden" : ""}>Aerial</em></div>`;
}

function cardHtml(id, rank) {
  const c = S.cards.get(id);
  if (!c) return "";
  const e = S.reasons.get(id), st = S.status.get(id);
  const rec = S.ranking?.recommended_space_id === id;
  const rent = c.rent.known ? `${money(c.rent.low, 0)}${c.rent.is_range ? `–${money(c.rent.high, 0)}` : ""}<small>/sf/yr</small>` : `<span class="unk-txt">Rent not listed</span>`;
  const line = e?.reason || [c.suite ? `Suite ${c.suite}` : null, c.floor_label, c.space_use].filter(Boolean).join(" · ");
  return `<li class="pc ${rec ? "rec" : ""} ${st === "conflict" ? "rej" : ""} ${S.selected === id ? "sel" : ""}" data-id="${id}" tabindex="0">
    <div class="pc-img">${thumb(c)}<span class="rk">${rank}</span>${moveHtml(id)}</div>
    <div class="pc-main">
      <div class="pc-row"><b class="price">${rent}</b>${rec ? '<span class="st lime">★ Recommended</span>' : statusChip(id)}</div>
      <h3>${esc(c.address)}</h3>
      <p class="pc-line ${e?.reason ? "agent" : ""}">${esc(line)}</p>
      <div class="pc-meta">
        <span><svg viewBox="0 0 24 24"><path d="M4 4h16v16H4zM4 10h6v10"/></svg>${int(c.divisible ? c.take_sqft : c.sqft_max)} sqft</span>
        <span data-tip="Screening match — a heuristic from listing data, not a physical check" tabindex="0"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8"/><path d="M12 8v4l3 2"/></svg>${c.match_pct}% match</span>
        <span><svg viewBox="0 0 24 24"><circle cx="9" cy="8" r="3"/><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6M16 11a3 3 0 100-6M21 20c0-2.6-1.7-4.8-4-5.6"/></svg>fits ${int(c.max_capacity)}</span>
        <button class="pc-go" data-explore="${id}" aria-label="Explore ${esc(c.address)}" title="Explore">↗</button>
      </div>
      ${e?.option ? `<p class="pc-opt">${esc(e.option)}</p>` : ""}
    </div>
  </li>`;
}

function select(id, { fromMap = false, quiet = false } = {}) {
  S.selected = id;
  document.querySelectorAll("#cards > li").forEach((li) => li.classList.toggle("sel", Number(li.dataset.id) === id));
  map.select(id, { fly: !fromMap && !quiet, afterMove: quiet });
  if (fromMap) document.querySelector(`#cards > li[data-id="${id}"]`)?.scrollIntoView({ block: "nearest", behavior: reduced ? "auto" : "smooth" });
}

function hover(id) {
  document.querySelectorAll("#cards > li").forEach((li) => li.classList.toggle("hot", Number(li.dataset.id) === id));
}

function open(id) {
  explore(id, {
    program: () => S.data.program,
    card: (x) => S.cards.get(x) || null,
    status: (x) => S.status.get(x) || "queued",
    recommended: (x) => S.ranking?.recommended_space_id === x,
  });
}

// ---------------------------------------------------------------- investigation, requirements, about
function step(kind, text, state) {
  const s = { kind, text, state, result: "" };
  S.steps.push(s);
  renderSteps();
  return s;
}

function renderSteps() {
  const n = $("#nav-count");
  if (n) n.textContent = S.steps.filter((x) => x.kind !== "note").length || "";
  if (S.panel !== "investigation") return;
  const rows = S.steps.filter((x) => x.kind !== "note");
  const notes = S.steps.filter((x) => x.kind === "note");
  $("#list").innerHTML = `<div class="list-head"><h2>Investigation</h2><span class="dim">${rows.length} steps</span></div>
    <ol class="steps">${rows.map((s) => `<li class="${s.state}"><i></i><div><b>${esc(s.text)}</b>${s.result ? `<span>${esc(s.result)}</span>` : ""}</div></li>`).join("")}</ol>
    ${notes.length ? `<details class="notes"><summary>Analyst notes (${notes.length})</summary>${notes.map((x) => `<p>${esc(x.text)}</p>`).join("")}</details>` : ""}`;
}

function renderRequirements() {
  if (S.panel !== "requirements" || !S.data) return;
  const d = S.data, z = d.sizing, p = d.program;
  const here = d.compare.find((c) => c.market === p.market), there = d.compare.find((c) => c.market !== p.market);
  $("#list").innerHTML = `<div class="list-head"><h2>Requirements</h2><span class="dim">${esc(d.display_name)} · ${int(p.capacity)} ${esc(d.business.unit.split(" ")[0])}</span></div>
    <div class="card-s"><span class="lbl">Code minimum</span><p class="big">${int(z.legal.gross_sqft)}<small> sf</small></p>
      <p class="dim">${z.legal.steps.map(esc).join(" · ")}</p><p class="src">${sourceLink({ label: `${z.legal.rule.code} · ${z.legal.rule.title}`, url: z.legal.rule.source_url })}</p>
      ${z.outdoor ? `<p class="warn-txt">+ ${int(z.outdoor.sqft)} sf outdoors · ${esc(z.outdoor.note)}</p>` : ""}</div>
    ${here?.rent && there?.rent ? `<div class="card-s"><span class="lbl">Rent for that space</span>
      <div class="cmp"><div><span>${esc(here.market_name)}</span><b>${money(here.rent.monthly, 0)}<small>/mo</small></b></div><div><span>${esc(there.market_name)}</span><b>${money(there.rent.monthly, 0)}<small>/mo</small></b></div></div>
      <p class="dim">${esc(here.rent.basis)}. Both cities use ${esc(here.rule_code)}${here.sqft_per_person !== there.sqft_per_person ? ", with different state licensing" : ""}.</p></div>` : ""}
    ${S.zones ? `<div class="card-s"><span class="lbl">Zones checked on scans</span><ul class="zl">${S.zones.map((x) => `<li><span>${esc(x.label)}${x.count > 1 ? ` × ${x.count}` : ""}</span><em>≥ ${int(x.min_sqft_each)} sf</em><i class="sev ${x.severity}">${x.severity}</i></li>`).join("")}</ul></div>` : ""}
    <p class="list-foot">${esc(z.disclaimer)}</p>`;
}

function renderAbout() {
  const w = S.data?.weights || [];
  $("#list").innerHTML = `<div class="list-head"><h2>How it scores</h2></div>
    <div class="card-s"><span class="lbl">How a space gets here</span><p class="dim"><b>1 · Filter.</b> Fixed rules keep spaces in your city, of the right use, big enough under the building code and within budget. They only propose candidates.<br>
      <b>2 · Review.</b> The site analyst (one AI agent) reads each candidate's evidence: fit-out, past tenants, demand, competition, rent against signed deals.<br>
      <b>3 · Scan check.</b> Where a suite has its own 3D scan, your layout is tested against the measured rooms.<br>
      <b>4 · Decide.</b> The analyst picks the spaces worth your time and rejects the rest, with a reason for each. Nothing is added after it decides.</p></div>
    <div class="card-s"><span class="lbl">Statuses</span><ul class="legend">
      <li><span class="st ok"><i></i>Verified on scan</span> every required zone fits measured rooms</li>
      <li><span class="st rev"><i></i>Reviewed · no scan</span> the analyst judged the evidence; no scan of this suite to measure</li>
      <li><span class="st bad"><i></i>Fails scan check</span> a required zone doesn't fit the measured rooms</li>
      <li><span class="st bad"><i></i>Rejected</span> the analyst decided against it, reason given</li></ul></div>
    <div class="card-s"><span class="lbl">Match % · the filter's heuristic</span><p class="dim">A fixed formula over listing data, shown on each pick for reference. It doesn't decide the order; the analyst does, and a space that fails a scan check can never sit above one that passed.</p>
      <ul class="zl">${w.map((x) => `<li><span>${esc(x.label)}</span><em>${Math.round(x.weight * 100)}%</em></li>`).join("")}</ul></div>`;
}

// ---------------------------------------------------------------- filters (the locked program) and chrome
function renderFilters() {
  const d = S.data, p = d.program, z = d.sizing;
  const here = d.compare.find((c) => c.market === p.market);
  $("#filters").innerHTML = `
    <div class="pills">
      <span class="pill lime">${esc(d.display_name[0].toUpperCase() + d.display_name.slice(1))}</span>
      <label class="pill"><input type="number" min="1" max="2000" value="${p.capacity}" data-k="capacity" aria-label="Capacity">${esc(d.business.unit.split(" ")[0])}</label>
      ${["houston", "los_angeles"].map((m) => `<button class="pill ${p.market === m ? "on" : ""}" data-k="market" data-v="${m}">${m === "houston" ? "Houston" : "Los Angeles"}</button>`).join("")}
      <label class="pill">$<input type="number" min="1" step="0.5" value="${p.budget_psf_yr ?? ""}" placeholder="any" data-k="budget_psf_yr" aria-label="Budget per sq ft per year">/sf/yr</label>
    </div>
    <button class="pill outline" data-panel-go="requirements">Code min ${int(z.legal.gross_sqft)} sf${here?.rent ? ` · ≈ ${money(here.rent.monthly, 0)}/mo` : ""}</button>`;
  $("#filters").onchange = (e) => {
    const el = e.target.closest("input[data-k]"); if (!el) return;
    const v = el.value === "" ? null : Number(el.value);
    if (el.dataset.k === "capacity" && (!v || v < 1)) return;
    start({ program: { ...S.data.program, [el.dataset.k]: el.dataset.k === "capacity" ? Math.round(v) : v } });
  };
  $("#filters").onclick = (e) => {
    const b = e.target.closest("button[data-k]");
    if (b && !b.classList.contains("on")) start({ program: { ...S.data.program, [b.dataset.k]: b.dataset.v } });
    if (e.target.closest("[data-panel-go]")) setPanel("requirements");
  };
}

function setRun(kind, text) { $("#run").className = `run ${kind}`; $("#run").innerHTML = `<i></i>${esc(text)}`; }
function setBusy(b) { $("#go").disabled = b; $("#go").textContent = b ? "Screening…" : "Find spaces"; }
function toast(text) { const t = $("#toast"); t.textContent = text; t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => { t.hidden = true; }, 4500); }

boot();
