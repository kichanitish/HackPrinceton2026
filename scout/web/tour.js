// Matterport 3D tour. The embed always works; the Showcase SDK (key locked to localhost) adds zone tags and
// "walk to this zone". If the SDK cannot connect, the tour still plays and the zone buttons explain why they are off.

// Matterport's documented bootstrap first, the older rolling loader as a fallback.
const SDK_URLS = [
  "https://static.matterport.com/showcase-sdk/bootstrap/3.0.0-0-g0517b8d76c/sdk.js",
  "https://static.matterport.com/showcase-sdk/latest.js",
];
let sdkScript = null;

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src;
    s.onload = () => (window.MP_SDK ? resolve() : reject(new Error("SDK script loaded without MP_SDK")));
    s.onerror = () => reject(new Error("Could not load the Matterport SDK"));
    document.head.append(s);
  });
}

function loadSdk(key) {
  if (window.MP_SDK) return Promise.resolve();
  sdkScript ||= loadScript(`${SDK_URLS[0]}?applicationKey=${encodeURIComponent(key)}`).catch(() => loadScript(SDK_URLS[1]));
  return sdkScript;
}

// The Model API reports positions z-up; the SDK works y-up. The right mapping is found by fit, not assumed.
const TRANSFORMS = [
  (p) => ({ x: p.x, y: p.z, z: -p.y }),
  (p) => ({ x: p.x, y: p.y, z: p.z }),
  (p) => ({ x: p.x, y: p.z, z: p.y }),
];
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

export class Tour {
  constructor(frameEl, modelId, sdkKey, onStatus = () => {}) {
    this.frameEl = frameEl;
    this.modelId = modelId;
    this.key = sdkKey;
    this.onStatus = onStatus;
    this.sdk = null;
    this.sweeps = [];
    this.sweepForLocation = new Map();   // Model API location id → SDK sweep id
    this.ready = false;
  }

  mount() {
    const params = new URLSearchParams({ m: this.modelId, play: "1", qs: "1", brand: "0", help: "0", title: "0" });
    if (this.key) params.set("applicationKey", this.key);
    const iframe = document.createElement("iframe");
    iframe.src = `https://my.matterport.com/show/?${params}`;
    iframe.allow = "fullscreen; xr-spatial-tracking";
    iframe.allowFullscreen = true;
    iframe.title = "Matterport 3D tour";
    this.frameEl.replaceChildren(iframe);
    this.iframe = iframe;
    if (!this.key) { this.onStatus("off", "Add MATTERPORT_SDK_KEY to .env to place zones in the tour."); return; }
    if (!["localhost", "127.0.0.1"].includes(location.hostname)) {
      this.onStatus("off", "Zone placement needs the app opened at http://localhost — the SDK key is locked to that domain.");
      return;
    }
    this.onStatus("connecting", "Connecting to the 3D tour…");
    this.connect().catch((e) => this.onStatus("off", `The tour plays, but zone placement is unavailable (${e.message || e}).`));
  }

  async connect() {
    await loadSdk(this.key);
    if (!this.iframe.contentWindow) throw new Error("the tour frame was closed");
    const sdk = await Promise.race([
      window.MP_SDK.connect(this.iframe, this.key),
      new Promise((_, reject) => setTimeout(() => reject(new Error("SDK connection timed out")), 25000)),
    ]);
    this.sdk = sdk;
    await new Promise((resolve) => {
      let done = false;
      const sub = sdk.Sweep.data.subscribe({
        onCollectionUpdated: (collection) => {
          // A sweep carries three ids (sid, id, uuid); keep them all so either API's id can be matched.
          this.sweeps = Object.entries(collection).map(([key, s]) => ({ id: s.sid || s.id || key, ids: [key, s.sid, s.id, s.uuid].filter(Boolean), position: s.position }));
          if (!done && this.sweeps.length) { done = true; resolve(); }
        },
      });
      setTimeout(() => { if (!done) { done = true; resolve(); } }, 8000);
      this.sub = sub;
    });
    this.ready = true;
    this.onStatus("ready", `Connected · ${this.sweeps.length} scan positions`);
  }

  /** Map each room's scan positions (Model API) onto SDK sweeps: by id when they match, otherwise by position. */
  calibrate(rooms) {
    const locations = rooms.flatMap((r) => r.locations || []);
    if (!this.ready || !locations.length || !this.sweeps.length) return false;
    const byAnyId = new Map(this.sweeps.flatMap((s) => s.ids.map((i) => [i, s.id])));
    const direct = locations.filter((l) => byAnyId.has(l.id));
    if (direct.length >= locations.length * 0.6) {
      direct.forEach((l) => this.sweepForLocation.set(l.id, byAnyId.get(l.id)));
      return true;
    }
    let best = null;
    for (const t of TRANSFORMS) {
      let total = 0;
      const map = new Map();
      for (const l of locations) {
        const p = t(l);
        let near = null, d = Infinity;
        for (const s of this.sweeps) { const k = dist(p, s.position); if (k < d) { d = k; near = s; } }
        total += d;
        if (d < 1.0) map.set(l.id, near.id);
      }
      if (!best || total < best.total) best = { total, map };
    }
    if (best.map.size < locations.length * 0.5) return false;
    this.sweepForLocation = best.map;
    return true;
  }

  sweepFor(room) {
    for (const l of room.locations || []) {
      const id = this.sweepForLocation.get(l.id);
      if (id) return this.sweeps.find((s) => s.id === id);
    }
    return null;
  }

  async goTo(room) {
    const sweep = this.sweepFor(room);
    if (!sweep) return false;
    const T = this.sdk.Sweep.Transition;
    const options = { transition: T?.FLY ?? T?.FADEOUT, transitionTime: 1600 };
    for (const id of [sweep.id, ...sweep.ids.filter((i) => i !== sweep.id)]) {   // the docs leave open which id moveTo wants
      try { await this.sdk.Sweep.moveTo(id, options); return true; } catch { /* try the next id form */ }
    }
    return false;
  }

  /** Drop a labelled tag in each assigned room. Returns how many were placed. */
  async tagZones(pairs) {
    if (!this.ready) return 0;
    const tags = [];
    for (const { room, label, description, rgb } of pairs) {
      const sweep = this.sweepFor(room);
      if (!sweep) continue;
      tags.push({
        label, description,
        anchorPosition: { x: sweep.position.x, y: sweep.position.y - 0.9, z: sweep.position.z },
        stemVector: { x: 0, y: 0.5, z: 0 },
        color: rgb,
      });
    }
    if (!tags.length) return 0;
    try {
      if (this.sdk.Tag?.add) await this.sdk.Tag.add(...tags);
      else await this.sdk.Mattertag.add(tags);
      return tags.length;
    } catch { return 0; }
  }

  destroy() {
    try { this.sub?.cancel?.(); this.sdk?.disconnect?.(); } catch { /* already gone */ }
    this.frameEl.replaceChildren();
  }
}

/** "#2a78d6" or "rgb(…)" → {r,g,b} in 0–1, as the SDK wants. */
export function toRgb(color) {
  const ctx = document.createElement("canvas").getContext("2d");
  ctx.fillStyle = color;
  const hex = ctx.fillStyle;
  if (hex.startsWith("#")) return { r: parseInt(hex.slice(1, 3), 16) / 255, g: parseInt(hex.slice(3, 5), 16) / 255, b: parseInt(hex.slice(5, 7), 16) / 255 };
  const m = hex.match(/[\d.]+/g) || [0, 0, 0];
  return { r: m[0] / 255, g: m[1] / 255, b: m[2] / 255 };
}
