"use strict";

// Browser side of the game: drawing, input and panels. All rules live in game.js (FleetGame).
// The look follows the dashboard's Mission view: dark nebula sky, dashed orbit lines, hex stations,
// ship flames, a glowing status ring on busy ships and a side board listing every ship's job.

(function () {
  const G = window.FleetGame;
  const $ = id => document.getElementById(id);
  const canvas = $("game"), ctx = canvas.getContext("2d");
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const SAVE_KEY = "fleet-game-save-v1";         // the Save button
  const AUTO_KEY = "fleet-game-autosave-v1";     // autosave, new game and base placement
  const BAD_KEY = "fleet-game-damaged-save-v1";  // first version's single damaged-save copy; only read, to seed the list
  const BACKUPS_KEY = "fleet-game-damaged-saves-v2";   // the last few damaged saves, newest first
  const PROFILE_KEY = "fleet-game-bank-v1";      // the old single star bank: read once to move it into Player 1, then never written
  const PLAYERS_KEY = "fleet-game-players-v1";   // every player and their star bank, hangar choices and best score
  const RUNS_KEY = "fleet-game-runs-v1";         // one record per finished run
  const BUYS_KEY = "fleet-game-purchases-v1";    // one record per hangar purchase
  const FEEDBACK_KEY = "fleet-game-feedback-v1";  // saved feedback entries; never part of a save
  const STEP = 1 / 30, MAX_STEPS = 6;          // fixed simulation step, and a cap so a slow frame cannot spiral
  const STRESS = /[?&]stress\b/.test(location.search);
  const STRESS_SECTOR = G.clampSector(Number((/[?&]sector=(\d+)/.exec(location.search) || [])[1]) || 1);

  const RES_COLOR = { ore: "#e08a50", ice: "#7fd8f0", crystal: "#e27be0" };
  const BODY_HUE = {   // [light, base, dark], like PLANET_HUES in mission.js
    asteroid: ["#d9b08c", "#8a6044", "#33211a"], moon: ["#e4f6ff", "#7aa8c4", "#1f3342"],
    iceplanet: ["#9fe3f0", "#2f8fa8", "#0e3440"], rare: ["#e2b7ff", "#a64fc4", "#341d4f"],
  };
  const TIER_NAME = ["", "Lv 2", "Lv 3"];

  // Players, scoreboard and logs need the newer rules; without them the page keeps the single-bank behaviour.
  const HAS = typeof G.parseRoster === "function";

  let game = null;
  let roster = null, runLog = null, buyLog = null;   // only set when HAS
  let profile = G.newProfile(), looks = G.currentLooks(profile);
  const ui = { selected: null, placing: false, paused: false, mouse: null, winShown: false, winOpen: false,
    endShown: false, endOpen: false, hangar: false, feedback: false, starsSeen: 0,
    dlg: [], sort: { col: "best", dir: "desc" }, noLog: false };
  const view = { sc: 1, ox: 0, oy: 0, W: 1, H: 1, dpr: 1 };
  let skyStars = [], nebula = null;
  const trails = new Map();
  const shapes = new Map();
  let time = 0, acc = 0, lastT = 0, lastBoard = 0, lastSave = 0, boardKey = "", buildHtml = "", basesHtml = "", toastTimer = 0, topH = 0;
  const fps = { frames: 0, acc: 0, worst: 0 };

  const shipColor = ship => looks.ship[ship.type];

  // ---------------------------------------------------------------- profile (stars, looks, best score)

  // One place for every localStorage write: stress mode writes nothing, and a full or blocked store
  // shows a notice instead of breaking the game.
  function store(key, text, what) {
    if (STRESS) return false;
    try { localStorage.setItem(key, text); return true; }
    catch (e) { toast("Could not save " + what + ": " + e.message); return false; }
  }

  function readKey(key) {
    try { return localStorage.getItem(key); } catch (e) { return null; }   // no storage: play without it
  }

  const nowIso = () => new Date().toISOString();
  const me = () => G.currentPlayer(roster);

  function useProfile(p) {
    profile = p;
    looks = G.currentLooks(profile);
  }

  function saveRoster() { return store(PLAYERS_KEY, G.serializeRoster(roster), "the players"); }
  function saveRuns() { return store(RUNS_KEY, G.serializeRunLog(runLog), "the run log"); }
  function saveBuys() { return store(BUYS_KEY, G.serializeBuyLog(buyLog), "the purchase log"); }

  // Returns a notice ("" when everything loaded cleanly).
  function loadProfile() {
    if (!HAS) {
      const text = readKey(PROFILE_KEY);
      const r = G.parseProfile(text);
      useProfile(r.profile);
      if (!r.ok) {
        addBackup(PROFILE_KEY, text);
        return r.error + " A fresh bank was started; a copy of the old one was kept.";
      }
      return "";
    }
    const notes = [];
    const rtext = readKey(PLAYERS_KEY);
    const r = G.parseRoster(rtext, readKey(PROFILE_KEY), nowIso());
    roster = r.roster;
    if (!r.ok) {
      addBackup(PLAYERS_KEY, rtext);
      saveRoster();
      notes.push((r.error || "The players list was damaged.") + " A fresh Player 1 was started; a copy of the old list was kept.");
    } else if (r.migrated) {
      if (saveRoster()) notes.push("Your best score and stars moved to Player 1");
    }
    const runsText = readKey(RUNS_KEY), rl = G.parseRunLog(runsText);
    runLog = rl.log;
    if (!rl.ok || rl.dropped) {
      addBackup(RUNS_KEY, runsText);
      saveRuns();
      notes.push(rl.ok ? rl.dropped + " damaged run record" + (rl.dropped > 1 ? "s were" : " was") + " dropped; a copy was kept."
        : "The run log was damaged; a fresh one was started and a copy was kept.");
    }
    const buysText = readKey(BUYS_KEY), bl = G.parseBuyLog(buysText);
    buyLog = bl.log;
    if (!bl.ok || bl.dropped) {
      addBackup(BUYS_KEY, buysText);
      saveBuys();
      notes.push(bl.ok ? bl.dropped + " damaged purchase record" + (bl.dropped > 1 ? "s were" : " was") + " dropped; a copy was kept."
        : "The purchase log was damaged; a fresh one was started and a copy was kept.");
    }
    useProfile(me().profile);
    return notes.join(" ");
  }

  function saveProfile() {
    if (STRESS) return;   // the test fleet never touches the real bank
    if (HAS) saveRoster();
    else store(PROFILE_KEY, G.serializeProfile(profile), "the star bank");
  }

  // Log the run in `game` under the current player. Never in stress mode, and never twice for one run
  // (addRun replaces an entry with the same key).
  function logRun(result) {
    if (!HAS || STRESS || !game || ui.noLog || !G.shouldLogRun(game)) return;
    runLog = G.addRun(runLog, G.runRecord(game, me().id, result, nowIso()));
    saveRuns();
  }

  // Move any newly collected stars into the bank.
  function claim() {
    if (!game) return;
    ui.starsSeen = game.starsGot;
    const n = G.claimStars(profile, game);
    if (!n) return;
    saveProfile();
    toast("+" + n + " star" + (n > 1 ? "s" : "") + " banked (" + profile.stars + " in all)", true);
  }

  // ---------------------------------------------------------------- game lifecycle

  function freshGame() {
    const g = G.newGame((Math.random() * 4294967296) >>> 0, STRESS ? STRESS_SECTOR : 1);
    if (STRESS) G.spawnStress(g, 30);
    return g;
  }

  // Everything that depends on the current map: called for a new, loaded or warped game.
  function resetView() {
    ui.selected = null; ui.placing = false; acc = 0;
    trails.clear(); shapes.clear();
    boardKey = ""; buildHtml = ""; basesHtml = "";
    resize();
  }

  function start(g, loaded) {
    game = g;
    ui.noLog = !!loaded && g.over;   // a finished run that is only loaded was logged when it ended
    G.syncClaimed(game, profile);       // stars the bank already paid for are gone from a reloaded map
    ui.winShown = !!g.won; ui.winOpen = false; ui.endShown = false; ui.endOpen = false; ui.starsSeen = g.starsGot;
    $("win").hidden = true; $("end").hidden = true;
    resetView();
    refresh();
  }

  function newGame(ask) {
    if (ask && game && !game.over && !confirm("Start a new game with a new map? Unsaved progress is lost.")) return;
    if (game && !game.over) logRun("abandoned");
    if (game && G.recordBest(profile, G.scoreTotal(game))) saveProfile();   // an abandoned run still counts for the best score
    start(freshGame());
    saveNow();
  }

  function warp() {
    const r = G.warpToNextSector(game);
    if (!r.ok) return toast(r.reason);
    ui.winShown = false; ui.winOpen = false; $("win").hidden = true;
    resetView();
    saveNow();
    refresh();
    toast("Sector " + game.sector + ": further out, harder" + hazardNote(game.sector), true);
  }

  function hazardNote(n) {
    if (n === G.TUNING.storms.firstSector) return ". Ion storms slow ships.";
    if (n === G.TUNING.showers.firstSector) return ". Meteor showers can knock cargo off.";
    return ".";
  }

  function saveNow(key) {
    if (STRESS) return true;   // never overwrite a real save with the 30-ship test fleet
    return store(key || AUTO_KEY, G.serialize(game), "the game");
  }

  // Keep the last few damaged saves (newest first) so nothing is lost silently.
  function addBackup(from, text) {
    if (STRESS) return;   // stress mode writes nothing
    let list = [];
    try {
      const raw = localStorage.getItem(BACKUPS_KEY);
      if (raw) list = JSON.parse(raw);
      else if (localStorage.getItem(BAD_KEY)) list = [{ at: "", from: "first version", text: localStorage.getItem(BAD_KEY) }];
    } catch (e) { list = []; }
    list = G.addBackup(list, { at: new Date().toISOString(), from, text: text || "" });
    try { localStorage.setItem(BACKUPS_KEY, JSON.stringify(list)); }
    catch (e) { /* storage full; the notice still shows */ }
  }

  // Try the saves in order. Returns { state } for the first good one, plus a notice when a damaged
  // one was passed over or an old one was upgraded.
  function readSaves(keys) {
    let notice = "", found = false;
    for (const key of keys) {
      let text = null;
      try { text = localStorage.getItem(key); } catch (e) { continue; }
      if (!text) continue;
      found = true;
      const res = G.deserialize(text);
      if (res.ok) return { state: res.state, notice: (notice ? notice + " " : "") + (res.notice || ""), found, damaged: !!notice };
      addBackup(key, text);
      notice = (key === SAVE_KEY ? "Your saved game" : "The autosave") + " was damaged (" + res.error.replace(/.$/, "") + ").";
    }
    return { state: null, notice, found, damaged: !!notice };
  }

  // One message, once, so a warning is never hidden by a second "Loaded." toast.
  function loadNow() {
    const r = readSaves([SAVE_KEY, AUTO_KEY]);
    if (!r.state) { toast(r.notice ? r.notice + " Nothing to load." : "Nothing saved yet.", true); return false; }
    start(r.state, true);
    toast(r.notice ? r.notice.trim() + (r.damaged ? " Loaded the other save." : " Loaded.") : "Loaded.", !!r.notice);
    return true;
  }

  function toast(msg, long) {
    const el = $("toast");
    el.textContent = msg;
    el.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove("show"), long || msg.length > 50 ? Math.min(9000, 3000 + msg.length * 60) : 2200);
  }

  // ---------------------------------------------------------------- canvas setup

  function resize() {
    const r = canvas.getBoundingClientRect();
    view.dpr = Math.min(window.devicePixelRatio || 1, 2);
    view.W = Math.max(1, r.width); view.H = Math.max(1, r.height);
    canvas.width = Math.round(view.W * view.dpr);
    canvas.height = Math.round(view.H * view.dpr);
    topH = $("topbar").offsetHeight;
    const top = Math.max(56, topH + 18), ww = game ? game.w : G.TUNING.world.w, wh = game ? game.h : G.TUNING.world.h;
    view.sc = Math.max(0.2, Math.min(view.W / ww, (view.H - top - 10) / wh));
    view.ox = (view.W - ww * view.sc) / 2;
    view.oy = top + (view.H - top - 10 - wh * view.sc) / 2;
    buildSky();
  }

  function buildSky() {
    const { W, H, dpr } = view;
    const count = Math.min(420, Math.round((W * H) / 3000));
    skyStars = Array.from({ length: count }, () => {
      const layer = Math.random() < 0.6 ? 0 : Math.random() < 0.75 ? 1 : 2;
      return { x: Math.random() * W, y: Math.random() * H, layer, r: [0.6, 1, 1.5][layer] * (0.7 + Math.random() * 0.6),
        a: [0.45, 0.7, 0.95][layer], ph: Math.random() * 6.28, sp: 0.6 + Math.random() * 2.2,
        tint: Math.random() < 0.15 ? "#ffd9b0" : Math.random() < 0.3 ? "#b9d4ff" : "#ffffff" };
    });
    nebula = document.createElement("canvas");
    nebula.width = canvas.width; nebula.height = canvas.height;
    const n = nebula.getContext("2d");
    n.scale(dpr, dpr);
    const bg = looks.bg;
    const base = n.createLinearGradient(0, 0, W, H);
    base.addColorStop(0, bg.top); base.addColorStop(1, bg.bottom);
    n.fillStyle = base; n.fillRect(0, 0, W, H);
    const big = Math.max(W, H);
    for (const [fx, fy, fr, color] of bg.blobs) {
      const g = n.createRadialGradient(W * fx, H * fy, 0, W * fx, H * fy, big * fr);
      g.addColorStop(0, color); g.addColorStop(1, "rgba(0,0,0,0)");
      n.fillStyle = g; n.fillRect(0, 0, W, H);
    }
  }

  // ---------------------------------------------------------------- drawing

  function hexA(hex, a) {
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${Math.max(0, Math.min(1, a))})`;
  }

  function drawSky(dt) {
    ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
    ctx.drawImage(nebula, 0, 0, view.W, view.H);
    const drift = [3, 7, 14];
    for (const s of skyStars) {
      if (!reduceMotion) {
        s.x -= drift[s.layer] * dt;
        if (s.x < -2) { s.x = view.W + 2; s.y = Math.random() * view.H; }
        s.ph += s.sp * dt;
      }
      ctx.globalAlpha = s.a * (0.65 + 0.35 * Math.sin(s.ph));
      ctx.fillStyle = s.tint;
      ctx.fillRect(s.x, s.y, s.r, s.r);
    }
    ctx.globalAlpha = 1;
  }

  function drawOrbits() {   // dashed rings around home, one per distinct body distance
    const home = game.bases[0];
    ctx.save();
    ctx.strokeStyle = "rgba(160,180,255,0.09)";
    ctx.lineWidth = 1 / view.sc;
    ctx.setLineDash([2 / view.sc, 7 / view.sc]);
    const seen = new Set();
    for (const o of game.bodies) {
      const r = Math.round(Math.hypot(o.x - home.x, o.y - home.y) / 40) * 40;
      if (seen.has(r)) continue;
      seen.add(r);
      ctx.beginPath(); ctx.arc(home.x, home.y, r, 0, Math.PI * 2); ctx.stroke();
    }
    ctx.restore();
  }

  function bodyShape(b) {   // a stable lumpy outline for asteroids, from the id
    let pts = shapes.get(b.id);
    if (pts) return pts;
    const rng = G.rng(b.id * 7919 + 1), n = 9;
    pts = [];
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2, k = 0.78 + rng() * 0.4;
      pts.push([Math.cos(a) * b.r * k, Math.sin(a) * b.r * k]);
    }
    shapes.set(b.id, pts);
    return pts;
  }

  function drawBody(b) {
    const [light, base, dark] = BODY_HUE[b.kind] || BODY_HUE.asteroid;
    const frac = b.max > 0 ? b.amount / b.max : 0;
    const empty = b.amount <= 1e-6;
    ctx.globalAlpha = empty ? 0.35 : 1;
    const glow = ctx.createRadialGradient(b.x, b.y, b.r * 0.8, b.x, b.y, b.r * 2.1);
    glow.addColorStop(0, base + "55"); glow.addColorStop(1, base + "00");
    ctx.fillStyle = glow;
    ctx.beginPath(); ctx.arc(b.x, b.y, b.r * 2.1, 0, Math.PI * 2); ctx.fill();
    const body = ctx.createRadialGradient(b.x - b.r * 0.4, b.y - b.r * 0.45, b.r * 0.1, b.x, b.y, b.r);
    body.addColorStop(0, light); body.addColorStop(0.55, base); body.addColorStop(1, dark);
    ctx.fillStyle = body;
    ctx.beginPath();
    if (b.kind === "asteroid") {
      bodyShape(b).forEach(([px, py], i) => ctx[i ? "lineTo" : "moveTo"](b.x + px, b.y + py));
      ctx.closePath();
    } else ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2);
    ctx.fill();
    if (b.kind === "iceplanet" || b.kind === "rare") {
      ctx.save();
      ctx.beginPath(); ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2); ctx.clip();
      ctx.strokeStyle = "rgba(255,255,255,0.12)"; ctx.lineWidth = b.r * 0.18;
      ctx.beginPath(); ctx.ellipse(b.x, b.y + b.r * 0.15, b.r * 1.2, b.r * 0.32, -0.35, 0, Math.PI * 2); ctx.stroke();
      ctx.restore();
    }
    // remaining-amount ring, like the progress ring on mission planets
    const ringR = b.r + 6;
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = "rgba(255,255,255,0.12)";
    ctx.beginPath(); ctx.arc(b.x, b.y, ringR, 0, Math.PI * 2); ctx.stroke();
    if (frac > 0) {
      ctx.strokeStyle = RES_COLOR[b.res]; ctx.lineCap = "round";
      ctx.beginPath(); ctx.arc(b.x, b.y, ringR, -Math.PI / 2, -Math.PI / 2 + frac * Math.PI * 2); ctx.stroke();
      ctx.lineCap = "butt";
    }
    ctx.globalAlpha = 1;
    if (ui.selected != null && !empty) {   // targets glow while a ship is selected
      const pulse = 0.5 + 0.5 * Math.sin(time * 4);
      ctx.strokeStyle = hexA(RES_COLOR[b.res], 0.25 + 0.3 * pulse); ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(b.x, b.y, ringR + 5 + pulse * 3, 0, Math.PI * 2); ctx.stroke();
    }
    ctx.textAlign = "center";
    ctx.font = "600 11.5px system-ui, sans-serif";
    ctx.fillStyle = "rgba(235,240,255,0.92)";
    ctx.fillText(b.name, b.x, b.y + ringR + 15);
    ctx.font = "10px system-ui, sans-serif";
    ctx.fillStyle = empty ? "rgba(200,210,240,0.5)" : hexA(RES_COLOR[b.res], 0.9);
    ctx.fillText(empty ? "EMPTY" : `${Math.floor(b.amount)} ${b.res.toUpperCase()}`, b.x, b.y + ringR + 28);
  }

  // Upgraded bases are visibly different: a solid outer ring at Lv 2, plus a counter-turning second ring
  // with bright nodes and a brighter core at Lv 3.
  function drawBase(b, i) {
    const color = i === 0 ? looks.base.home : looks.base.main;
    const tier = b.tier | 0;
    const sr = G.BASE_R, rot = reduceMotion ? 0 : time * 0.3 + i;
    const glow = ctx.createRadialGradient(b.x, b.y, sr * 0.3, b.x, b.y, sr * (3 + tier * 0.5));
    glow.addColorStop(0, hexA(color, 0.4 + tier * 0.1)); glow.addColorStop(1, hexA(color, 0));
    ctx.fillStyle = glow;
    ctx.beginPath(); ctx.arc(b.x, b.y, sr * (3 + tier * 0.5), 0, Math.PI * 2); ctx.fill();
    ctx.save();
    ctx.translate(b.x, b.y);
    if (tier >= 1) {
      ctx.strokeStyle = hexA(color, 0.6); ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(0, 0, sr * 1.95, 0, Math.PI * 2); ctx.stroke();
    }
    if (tier >= 2) {
      ctx.save();
      ctx.rotate(-rot * 1.5);
      ctx.strokeStyle = hexA(color, 0.5); ctx.lineWidth = 1.5; ctx.setLineDash([sr * 0.3, sr * 0.2]);
      ctx.beginPath(); ctx.arc(0, 0, sr * 2.3, 0, Math.PI * 2); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = "#ffffff";
      for (let k = 0; k < 8; k++) {
        const a = (k / 8) * Math.PI * 2;
        ctx.beginPath(); ctx.arc(Math.cos(a) * sr * 1.95, Math.sin(a) * sr * 1.95, 2.2, 0, Math.PI * 2); ctx.fill();
      }
      ctx.restore();
    }
    ctx.rotate(rot);
    ctx.strokeStyle = hexA(color, 0.75); ctx.lineWidth = 2;
    ctx.setLineDash([sr * 0.5, sr * 0.22]);
    ctx.beginPath(); ctx.arc(0, 0, sr * 1.5, 0, Math.PI * 2); ctx.stroke();
    ctx.setLineDash([]);
    const arms = tier >= 1 ? 6 : 4;
    for (let k = 0; k < arms; k++) {
      ctx.rotate(Math.PI * 2 / arms);
      ctx.fillStyle = hexA(color, 0.85);
      ctx.fillRect(sr * 1.05, -2, sr * 0.62, 4);
      ctx.fillRect(sr * 1.62, -5, 4, 10);
    }
    ctx.rotate(-rot * 2.2);
    ctx.beginPath();
    for (let k = 0; k < 6; k++) {
      const a = (k / 6) * Math.PI * 2;
      ctx[k ? "lineTo" : "moveTo"](Math.cos(a) * sr, Math.sin(a) * sr);
    }
    ctx.closePath();
    ctx.fillStyle = tier >= 2 ? "#2a2468" : tier >= 1 ? "#201b50" : "#17143a"; ctx.fill();
    ctx.strokeStyle = color; ctx.lineWidth = 1.6 + tier * 0.9; ctx.stroke();
    ctx.restore();
    const cr = sr * (0.55 + tier * 0.1);
    const core = ctx.createRadialGradient(b.x, b.y, 0, b.x, b.y, cr);
    core.addColorStop(0, "#ffffff"); core.addColorStop(0.35, hexA(color, 0.9)); core.addColorStop(1, hexA(color, 0));
    ctx.fillStyle = core;
    ctx.beginPath(); ctx.arc(b.x, b.y, cr, 0, Math.PI * 2); ctx.fill();
    ctx.textAlign = "center";
    ctx.font = "700 11px system-ui, sans-serif";
    ctx.fillStyle = "rgba(235,232,255,0.95)";
    ctx.fillText((i === 0 ? "HOME" : "BASE " + (i + 1)) + (tier ? " " + TIER_NAME[tier] : ""), b.x, b.y + sr * (tier >= 2 ? 2.3 : 1.5) + 16);
  }

  // A five-point collectible star with a soft pulse.
  function drawStar(s) {
    const pulse = reduceMotion ? 0.5 : 0.5 + 0.5 * Math.sin(time * 3 + s.id * 1.7);
    const R = 11 + pulse * 1.5;
    const glow = ctx.createRadialGradient(s.x, s.y, 2, s.x, s.y, R * 3);
    glow.addColorStop(0, "rgba(255,226,110," + (0.35 + pulse * 0.2) + ")"); glow.addColorStop(1, "rgba(255,226,110,0)");
    ctx.fillStyle = glow;
    ctx.beginPath(); ctx.arc(s.x, s.y, R * 3, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath();
    for (let k = 0; k < 10; k++) {
      const a = -Math.PI / 2 + k * Math.PI / 5, rr = k % 2 ? R * 0.45 : R;
      ctx[k ? "lineTo" : "moveTo"](s.x + Math.cos(a) * rr, s.y + Math.sin(a) * rr);
    }
    ctx.closePath();
    ctx.fillStyle = "#ffd84a"; ctx.fill();
    ctx.strokeStyle = "#fff6c4"; ctx.lineWidth = 1.2; ctx.stroke();
    if (ui.selected != null) {
      ctx.strokeStyle = "rgba(255,226,110," + (0.25 + 0.3 * pulse) + ")"; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(s.x, s.y, R + 7 + pulse * 3, 0, Math.PI * 2); ctx.stroke();
    }
  }

  // Ion storms: a drifting blue-violet cloud with a few turning arcs.
  function drawStorm(s, i) {
    const g = ctx.createRadialGradient(s.x, s.y, s.r * 0.1, s.x, s.y, s.r);
    g.addColorStop(0, "rgba(120,140,255,0.26)"); g.addColorStop(0.7, "rgba(90,110,235,0.14)"); g.addColorStop(1, "rgba(90,110,235,0)");
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = "rgba(170,190,255,0.35)"; ctx.lineWidth = 1.5;
    const a0 = reduceMotion ? i : time * 0.6 + i * 2;
    for (let k = 0; k < 3; k++) {
      const a = a0 + k * 2.09;
      ctx.beginPath(); ctx.arc(s.x, s.y, s.r * (0.45 + 0.18 * k), a, a + 1.1); ctx.stroke();
    }
    ctx.textAlign = "center";
    ctx.font = "600 10px system-ui, sans-serif";
    ctx.fillStyle = "rgba(190,205,255,0.7)";
    ctx.fillText("ION STORM", s.x, s.y + 4);
  }

  // Meteor showers: a dashed warning ring first, then streaks falling through the circle.
  function drawShower(s) {
    const W = G.TUNING.showers, live = s.age >= W.warn;
    if (!live) {
      const k = 0.5 + 0.5 * Math.sin(time * 8);
      ctx.save();
      ctx.strokeStyle = "rgba(255,170,90," + (0.35 + 0.4 * k) + ")"; ctx.lineWidth = 2; ctx.setLineDash([8, 6]);
      ctx.beginPath(); ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2); ctx.stroke();
      ctx.restore();
      ctx.textAlign = "center"; ctx.font = "700 11px system-ui, sans-serif"; ctx.fillStyle = "rgba(255,190,120,0.95)";
      ctx.fillText("METEORS IN " + Math.ceil(W.warn - s.age), s.x, s.y + 4);
      return;
    }
    ctx.fillStyle = "rgba(255,120,60,0.07)";
    ctx.beginPath(); ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = "rgba(255,150,80,0.4)"; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2); ctx.stroke();
    ctx.lineCap = "round";
    for (let k = 0; k < 14; k++) {   // streaks from a fixed pattern, so there is nothing to allocate or remember
      const ph = (time * 0.8 + k * 0.173) % 1;
      const ox = Math.sin(k * 12.9898) * s.r * 0.9, oy = Math.cos(k * 78.233) * s.r * 0.9;
      const x = s.x + ox + (ph - 0.5) * 40, y = s.y + oy + (ph - 0.5) * 60;
      ctx.strokeStyle = "rgba(255," + (170 + (k % 3) * 25) + ",110," + (0.9 * Math.sin(ph * Math.PI)) + ")";
      ctx.lineWidth = 1.6;
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x - 9, y - 14); ctx.stroke();
    }
    ctx.lineCap = "butt";
  }

  // Engine trail, in the style picked in the hangar.
  function drawTrail(ship, color) {
    const t = trails.get(ship.id);
    if (!t || t.length < 2) return;
    const style = looks.trail.id;
    if (style === "spark") {
      for (let i = 0; i < t.length; i++) {
        const a = (i + 1) / t.length;
        ctx.fillStyle = hexA(color, a * 0.85);
        ctx.beginPath(); ctx.arc(t[i][0], t[i][1] + Math.sin(i * 2.1 + ship.id) * 2, 0.8 + a * 2.2, 0, Math.PI * 2); ctx.fill();
      }
      return;
    }
    if (style === "ribbon") {
      ctx.lineCap = "round"; ctx.lineJoin = "round";
      ctx.beginPath(); ctx.moveTo(t[0][0], t[0][1]);
      for (let i = 1; i < t.length; i++) ctx.lineTo(t[i][0], t[i][1]);
      ctx.strokeStyle = hexA(color, 0.14); ctx.lineWidth = 7; ctx.stroke();
      ctx.strokeStyle = hexA(color, 0.4); ctx.lineWidth = 2.5; ctx.stroke();
      ctx.lineCap = "butt"; ctx.lineJoin = "miter";
      return;
    }
    ctx.lineCap = "round";
    for (let i = 1; i < t.length; i++) {
      const a = i / t.length;
      ctx.strokeStyle = hexA(color, a * 0.45); ctx.lineWidth = 1 + a * 2;
      ctx.beginPath(); ctx.moveTo(t[i - 1][0], t[i - 1][1]); ctx.lineTo(t[i][0], t[i][1]); ctx.stroke();
    }
    ctx.lineCap = "butt";
  }

  function drawBeam(ship) {
    const b = game.bodies[ship.target];
    if (!b) return;
    const d = Math.hypot(b.x - ship.x, b.y - ship.y) || 1;
    const flicker = reduceMotion ? 0.6 : 0.45 + 0.35 * Math.sin(time * 9 + ship.id);
    const ex = b.x + (ship.x - b.x) * (b.r / d), ey = b.y + (ship.y - b.y) * (b.r / d);
    ctx.save();
    ctx.strokeStyle = hexA(RES_COLOR[b.res], flicker); ctx.lineWidth = 1.6;
    ctx.setLineDash([3, 4]); ctx.lineDashOffset = -time * 40;
    ctx.beginPath(); ctx.moveTo(ship.x, ship.y); ctx.lineTo(ex, ey); ctx.stroke();
    ctx.restore();
    ctx.fillStyle = hexA(RES_COLOR[b.res], 0.5 * flicker);
    ctx.beginPath(); ctx.arc(ex, ey, 3 + flicker * 2, 0, Math.PI * 2); ctx.fill();
  }

  function drawShip(ship) {
    const color = shipColor(ship);
    const busy = ship.st !== G.IDLE;
    const moving = ship.st === G.TO_BODY || ship.st === G.TO_BASE || ship.st === G.TO_STAR;
    const k = ship.type === "hauler" ? 1.3 : 1;
    const spec = G.SHIP_TYPES[ship.type];
    ctx.save();
    ctx.translate(ship.x, ship.y);
    ctx.rotate(ship.ang);
    ctx.scale(k, k);
    if (moving || ship.st === G.MINING) {
      const len = (moving ? 12 : 6) + (reduceMotion ? 0 : Math.random() * 5);
      const flame = ctx.createLinearGradient(-5, 0, -5 - len, 0);
      flame.addColorStop(0, "rgba(255,255,255,0.95)");
      flame.addColorStop(0.3, hexA(color, 0.9));
      flame.addColorStop(1, hexA(color, 0));
      ctx.fillStyle = flame;
      ctx.beginPath(); ctx.moveTo(-5, -3); ctx.lineTo(-5 - len, 0); ctx.lineTo(-5, 3); ctx.closePath(); ctx.fill();
    }
    if (busy) { ctx.shadowColor = color; ctx.shadowBlur = 10; }
    ctx.beginPath();
    ctx.moveTo(11, 0); ctx.lineTo(-7, -7); ctx.lineTo(-3.5, 0); ctx.lineTo(-7, 7); ctx.closePath();
    ctx.fillStyle = busy ? color : hexA(color, 0.55);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.strokeStyle = busy ? "rgba(255,255,255,0.85)" : "rgba(255,255,255,0.35)"; ctx.lineWidth = 1; ctx.stroke();
    ctx.fillStyle = "rgba(255,255,255,0.85)";
    ctx.beginPath(); ctx.arc(3, 0, 1.6, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
    if (busy) {   // status ring: cargo load, in the colour of what's aboard
      const rr = 15 * k;
      ctx.lineWidth = 2;
      ctx.strokeStyle = "rgba(255,255,255,0.14)";
      ctx.beginPath(); ctx.arc(ship.x, ship.y, rr, 0, Math.PI * 2); ctx.stroke();
      if (ship.cargo > 0) {
        ctx.strokeStyle = RES_COLOR[ship.res];
        ctx.beginPath(); ctx.arc(ship.x, ship.y, rr, -Math.PI / 2, -Math.PI / 2 + (ship.cargo / spec.cap) * Math.PI * 2); ctx.stroke();
      } else {
        ctx.strokeStyle = hexA(color, 0.5 + (reduceMotion ? 0 : 0.3 * Math.sin(time * 5 + ship.id)));
        ctx.beginPath(); ctx.arc(ship.x, ship.y, rr, 0, 0.9); ctx.stroke();
      }
    }
    if (game.storms.length && G.inStorm(game, ship.x, ship.y)) {   // slowed by an ion storm
      ctx.strokeStyle = "rgba(160,190,255," + (reduceMotion ? 0.6 : 0.4 + 0.3 * Math.sin(time * 14 + ship.id)) + ")";
      ctx.lineWidth = 1.2; ctx.setLineDash([2, 3]);
      ctx.beginPath(); ctx.arc(ship.x, ship.y, 19 * k, 0, Math.PI * 2); ctx.stroke();
      ctx.setLineDash([]);
    }
    if (ship.hitCd > 3) {   // just hit by a meteor
      ctx.strokeStyle = "rgba(255,110,70," + Math.min(1, ship.hitCd - 3) + ")"; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(ship.x, ship.y, 21 * k, 0, Math.PI * 2); ctx.stroke();
    }
    if (ship.id === ui.selected) {
      ctx.strokeStyle = "#8fd8ff"; ctx.lineWidth = 1.5; ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.arc(ship.x, ship.y, 22, 0, Math.PI * 2); ctx.stroke();
      ctx.setLineDash([]);
      ctx.textAlign = "left";
      ctx.font = "600 10.5px system-ui, sans-serif";
      ctx.fillStyle = "rgba(240,244,255,0.95)";
      ctx.fillText(ship.name.toUpperCase(), ship.x + 16, ship.y - 12);
    }
  }

  function drawGhost() {
    if (!ui.placing || !ui.mouse) return;
    const ok = !G.baseSpotProblem(game, ui.mouse.x, ui.mouse.y);
    ctx.save();
    ctx.strokeStyle = ok ? "#5fd0b0" : "#ee6b6b"; ctx.fillStyle = ok ? "rgba(95,208,176,0.15)" : "rgba(238,107,107,0.15)";
    ctx.lineWidth = 2; ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.arc(ui.mouse.x, ui.mouse.y, G.BASE_R * 1.5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.restore();
  }

  function frame(dt) {
    drawSky(dt);
    ctx.save();
    ctx.translate(view.ox, view.oy);
    ctx.scale(view.sc, view.sc);
    drawOrbits();
    game.storms.forEach(drawStorm);
    for (const b of game.bodies) drawBody(b);
    for (const s of game.stars) if (!s.taken) drawStar(s);
    game.bases.forEach(drawBase);
    for (const s of game.ships) drawTrail(s, shipColor(s));
    for (const s of game.ships) if (s.st === G.MINING) drawBeam(s);
    for (const s of game.ships) drawShip(s);
    game.showers.forEach(drawShower);
    drawGhost();
    ctx.restore();
  }

  // ---------------------------------------------------------------- panels

  function resLine() {
    return G.RES.map(r => `<span><span class="dot" style="background:${RES_COLOR[r]}"></span>${r} <b>${Math.floor(game.stock[r])}</b></span>`).join("");
  }

  function costText(cost) {
    return G.RES.filter(r => cost[r]).map(r => `${cost[r]} ${r}`).join(", ");
  }

  function renderBuild() {
    const items = [["miner", "Miner", G.SHIP_TYPES.miner.blurb, G.shipCost(game, "miner")],
      ["hauler", "Hauler", G.SHIP_TYPES.hauler.blurb, G.shipCost(game, "hauler")],
      ["base", "New base", "Click empty space to place it", G.baseCost(game)]];
    const html = items.map(([key, label, note, cost]) => {
      const ok = !game.over && G.canAfford(game, cost);
      return `<button type="button" class="build-btn${key === "base" && ui.placing ? " active" : ""}" data-build="${key}"${ok ? "" : " disabled"}>
        <b>${label}</b> <small>${costText(cost)}</small><small>${note}</small></button>`;
    }).join("");
    if (html !== buildHtml) { buildHtml = html; $("build").innerHTML = html; }
  }

  function renderBases() {
    const html = game.bases.map((b, i) => {
      const cost = G.upgradeCost(game, i), tier = b.tier | 0;
      const label = (i === 0 ? "Home" : "Base " + (i + 1)) + (tier ? " " + TIER_NAME[tier] : "");
      const next = G.TUNING.upgrades[tier + 1];
      const btn = cost
        ? `<button type="button" data-up="${i}"${!game.over && G.canAfford(game, cost) ? "" : " disabled"} title="Unloads faster and takes ships from further away">Upgrade<small>${costText(cost)}</small></button>`
        : `<small>Fully upgraded</small>`;
      const note = `unloads ${G.TUNING.upgrades[tier].unload}/s` + (next ? `, next ${next.unload}/s` : "");
      return `<div class="base-row"><span class="lbl"><b>${label}</b><small>${note}</small></span>${btn}</div>`;
    }).join("");
    if (html !== basesHtml) { basesHtml = html; $("bases").innerHTML = html; }
  }

  // Rows are built once per ship set. Every refresh only updates text, widths and classes in place,
  // so a click never lands on a row that has just been thrown away.
  let boardRows = [];

  function renderBoard() {
    const list = $("board");
    const key = game.ships.map(s => s.id).join(",");
    if (key !== boardKey) {
      boardKey = key;
      list.textContent = "";
      boardRows = game.ships.map(s => {
        const li = document.createElement("li");
        li.dataset.ship = s.id;
        const dot = document.createElement("span"); dot.className = "dot";
        const txt = document.createElement("span"); txt.className = "txt";
        const name = document.createElement("span"); name.className = "name";
        const job = document.createElement("span"); job.className = "job";
        const bar = document.createElement("div"); bar.className = "bar";
        const fill = document.createElement("i");
        bar.appendChild(fill);
        txt.append(name, document.createElement("br"), job, bar);
        li.append(dot, txt);
        list.appendChild(li);
        return { li, dot, name, job, fill, last: "" };
      });
    }
    for (let i = 0; i < game.ships.length; i++) {
      const s = game.ships[i], row = boardRows[i];
      const pct = s.cargo > 0 ? Math.round((s.cargo / G.SHIP_TYPES[s.type].cap) * 100) : 0;
      const sig = s.name + "|" + s.type + "|" + s.st + "|" + s.res + "|" + pct + "|" + G.jobText(game, s) + "|" + (s.id === ui.selected) + "|" + looks.ship.id;
      if (sig === row.last) continue;
      row.last = sig;
      row.li.className = s.id === ui.selected ? "sel" : "";
      row.dot.style.background = shipColor(s);
      row.dot.style.opacity = s.st === G.IDLE ? 0.45 : 1;
      row.name.textContent = s.name;
      row.job.textContent = G.jobText(game, s);
      row.fill.style.width = pct + "%";
      row.fill.style.background = s.res ? RES_COLOR[s.res] : "#fff";
    }
    const busy = game.ships.filter(s => s.st !== G.IDLE).length;
    $("board-count").textContent = `${busy}/${game.ships.length} working`;
  }

  function refresh() {
    $("res").innerHTML = resLine();
    const left = game.stars.filter(s => !s.taken).length;
    $("goal").innerHTML = `Sector <b>${game.sector}</b> &middot; Bases built <b>${game.bases.length - 1} / ${G.goalBases(game.sector)}</b> &middot; Stars <b>${game.stars.length - left} / ${game.stars.length}</b>`;
    $("score").innerHTML = `Score <b>${G.scoreTotal(game)}</b> &middot; Best <b>${Math.max(profile.best, G.scoreTotal(game))}</b> &middot; <span class="bankstar">&#9733; <b>${profile.stars}</b></span>`;
    updatePlayerButton();
    $("b-warp").hidden = !(game.won && !game.over);
    $("b-retire").disabled = game.over;
    renderBuild();
    renderBases();
    renderBoard();
    $("b-pause").textContent = ui.paused ? "Resume" : "Pause";
    $("paused").style.display = ui.paused ? "block" : "none";
    const hint = $("hint");
    hint.style.display = ui.placing || ui.selected != null ? "block" : "none";
    hint.textContent = ui.placing ? "Click empty space to place the base (Esc to cancel)"
      : "Click a planet or asteroid to mine it, a star to collect it, or a base to send this ship there (Esc to deselect)";
    if (game.starsGot !== ui.starsSeen) claim();
    if (game.won && !ui.winShown && !game.over) showWin();
    if (game.over && !ui.endShown) showEnd();
    if ($("topbar").offsetHeight !== topH) resize();   // the top bar wrapped or unwrapped
  }

  function showWin() {
    ui.winShown = true; ui.winOpen = true;
    const c = game.clearInfo || { sector: game.sector, sectorPts: 0, timePts: 0, secs: Math.floor(game.sectorTime) };
    $("win-title").textContent = "Sector " + c.sector + " cleared";
    $("win-text").textContent = `${G.goalBases(c.sector)} bases built in ${Math.floor(c.secs / 60)}m ${c.secs % 60}s. ` +
      `+${c.sectorPts} for the sector, +${c.timePts} time bonus. Score so far ${G.scoreTotal(game)}. ` +
      `Warp to sector ${c.sector + 1}: a bigger map, with less to mine and higher prices.`;
    $("win").hidden = modal();
  }

  function showEnd() {
    ui.endShown = true; ui.endOpen = true;
    claim();
    const total = G.scoreTotal(game), isBest = G.recordBest(profile, total);
    saveProfile();
    logRun(game.endReason);
    $("end-title").textContent = game.endReason === "stranded" ? "Stranded" : "Run over";
    $("end-text").textContent = (game.endReason === "stranded"
      ? "Nothing left to mine and not enough to build with. "
      : "You retired the fleet. ") + `You reached sector ${game.sector} and cleared ${game.cleared}.`;
    const s = game.score, row = (a, b, cls) => `<tr${cls ? ` class="${cls}"` : ""}><td>${a}</td><td>${b}</td></tr>`;
    $("end-score").innerHTML = row("Materials delivered", Math.floor(s.mat)) + row("Bases built", Math.floor(s.bases)) +
      row("Sectors cleared", Math.floor(s.sectors)) + row("Time bonus", Math.floor(s.time)) + row("Score", total, "sum");
    $("end-best").textContent = (isBest ? "New best score! " : "") + `Best score ${profile.best}. Stars collected this run ${game.starsGot}; ${profile.stars} in the bank.`;
    $("end").hidden = modal();
  }

  // ---------------------------------------------------------------- hangar

  function swatch(kind, l) {
    if (kind === "ship") return `<i style="background:${l.miner}"></i><i style="background:${l.hauler}"></i>`;
    if (kind === "base") return `<i style="background:${l.main}"></i><i style="background:${l.home}"></i>`;
    if (kind === "bg") return `<i class="wide" style="background:linear-gradient(135deg,${l.top},${l.bottom}),${l.blobs[0][3]};background-blend-mode:screen;border:1px solid rgba(255,255,255,0.25)"></i>`;
    return `<i class="wide" style="background:linear-gradient(90deg,transparent,${looks.ship.miner});height:6px;margin-top:8px"></i>`;
  }

  function renderHangar() {
    $("h-stars").textContent = profile.stars;
    renderHistory($("h-history"), 20);
    $("h-body").innerHTML = G.LOOK_KINDS.map(kind => {
      const items = G.LOOKS[kind].map(l => {
        const owned = profile.owned[kind].indexOf(l.id) >= 0, picked = profile.pick[kind] === l.id;
        const status = picked ? "In use" : owned ? "Owned" : `&#9733; ${l.cost}`;
        const afford = owned || profile.stars >= l.cost;
        return `<button type="button" class="look${picked ? " picked" : ""}${owned ? "" : " locked"}" data-kind="${kind}" data-id="${l.id}"${afford ? "" : " title=\"Not enough stars yet\""}>
          <span class="sw">${swatch(kind, l)}</span><b>${l.name}</b><small>${status}</small></button>`;
      }).join("");
      return `<h2>${G.LOOK_TITLES[kind]}</h2><div class="look-grid">${items}</div>`;
    }).join("");
  }

  function openHangar() {
    ui.hangar = true;
    renderHangar();
    $("hangar").hidden = false;
    $("win").hidden = true; $("end").hidden = true;
  }

  function closeHangar() {
    ui.hangar = false;
    $("hangar").hidden = true;
    showCards();
  }

  // The win and run-end cards show only when no hangar or dialog is on top.
  const modal = () => ui.hangar || ui.feedback || ui.dlg.length > 0;
  function showCards() {
    $("win").hidden = modal() || !ui.winOpen; $("end").hidden = modal() || !ui.endOpen;
  }

  $("h-body").addEventListener("click", ev => {
    const btn = ev.target.closest("[data-kind]");
    if (!btn) return;
    const kind = btn.dataset.kind, id = btn.dataset.id;
    if (profile.owned[kind].indexOf(id) < 0) {
      const before = profile.stars;
      const r = G.buyLook(profile, kind, id);
      if (!r.ok) return toast(r.reason);
      if (HAS) {
        buyLog = G.addBuy(buyLog, G.buyRecord(me().id, kind, id, before - profile.stars, profile.stars, nowIso()));
        saveBuys();
      }
    }
    G.chooseLook(profile, kind, id);
    saveProfile();
    looks = G.currentLooks(profile);
    if (kind === "bg") buildSky();
    boardKey = ""; basesHtml = "";
    renderHangar();
    if (game) refresh();
  });
  $("h-close").addEventListener("click", closeHangar);
  $("b-hangar").addEventListener("click", () => (ui.hangar ? closeHangar() : openHangar()));
  $("e-hangar").addEventListener("click", openHangar);

  // ---------------------------------------------------------------- players, scoreboard, stats

  // Everything below builds DOM with textContent only, so a player name can never inject markup.
  function el(tag, cls, text, kids) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    if (kids) for (const k of kids) e.appendChild(k);
    return e;
  }

  function btn(label, onClick, cls, disabled) {
    const b = el("button", cls || "", label);
    b.type = "button";
    if (disabled) b.disabled = true;
    b.addEventListener("click", onClick);
    return b;
  }

  const pad2 = n => (n < 10 ? "0" : "") + n;
  function fmtDate(iso) {
    const d = new Date(iso);
    if (!iso || isNaN(d.getTime())) return "";
    return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate()) + " " + pad2(d.getHours()) + ":" + pad2(d.getMinutes());
  }
  function fmtSecs(s) { s = Math.max(0, Math.floor(Number(s) || 0)); return Math.floor(s / 60) + ":" + pad2(s % 60); }
  const num = v => (Number.isFinite(Number(v)) ? Math.round(Number(v)) : 0);
  const nameOf = id => { const p = roster.players.find(q => q.id === id); return p ? p.name : "(removed)"; };

  // A table from header labels and rows of cell texts. opts: sort (col keys per header), rowClass(i), onRow(i).
  function table(heads, rows, opts) {
    opts = opts || {};
    const t = el("table", "grid");
    const tr = el("tr");
    heads.forEach((h, i) => {
      const th = el("th", opts.keys && opts.keys[i] ? "sortable" : "", h);
      if (opts.keys && opts.keys[i]) {
        const key = opts.keys[i];
        if (ui.sort.col === key) th.textContent = h + (ui.sort.dir === "asc" ? " ▲" : " ▼");
        th.addEventListener("click", () => opts.onSort(key));
      }
      tr.appendChild(th);
    });
    t.appendChild(el("thead", "", null, [tr]));
    const body = el("tbody");
    rows.forEach((cells, i) => {
      const r = el("tr", (opts.rowClass && opts.rowClass(i)) || "");
      cells.forEach(c => r.appendChild(el("td", "", c)));
      if (opts.onRow) { r.classList.add("click"); r.addEventListener("click", () => opts.onRow(i)); }
      body.appendChild(r);
    });
    if (!rows.length) {
      const r = el("tr"), td = el("td", "empty", opts.empty || "Nothing yet.");
      td.colSpan = heads.length;
      r.appendChild(td); body.appendChild(r);
    }
    t.appendChild(body);
    return t;
  }

  function buyRows(list) {
    return list.map(b => [fmtDate(b.at), b.name || b.item, b.kind, "★ " + num(b.cost), "★ " + num(b.left) + " left"]);
  }

  // The hangar's History section: this player's newest purchases.
  function renderHistory(box, n) {
    box.textContent = "";
    if (!HAS) return;
    const list = G.playerBuys(buyLog, me().id).slice(0, n);
    box.appendChild(table(["When", "Item", "Kind", "Cost", "Stars after"], buyRows(list), { empty: "No purchases yet." }));
    if (G.playerBuys(buyLog, me().id).length > n) box.appendChild(el("p", "note", "Showing the newest " + n + ". The full list is in your stats."));
  }

  function openDlg(view, id) {
    if (ui.feedback) return;   // the feedback form has the screen
    const cur = ui.dlg[ui.dlg.length - 1];
    if (cur && cur.view === view && cur.id === id) return;   // already on top
    ui.dlg.push({ view, id });
    showDlg();
  }
  function popDlg() { ui.dlg.pop(); showDlg(); }
  function closeAllDlg() { ui.dlg.length = 0; showDlg(); }
  function showDlg() {
    const top = ui.dlg[ui.dlg.length - 1];
    $("dlg").hidden = !top;
    if (!top) { $("dlg-body").textContent = ""; showCards(); return; }
    $("win").hidden = true; $("end").hidden = true;
    renderDlg();
    // keep focus off the opener under the overlay, and off any player's Play button: name box in Players,
    // else the Close button, else (fallback) the first enabled button
    const bodyEl = $("dlg-body");
    let target = top.view === "players" ? bodyEl.querySelector("input.name-in") : null;
    if (!target) target = Array.from(bodyEl.querySelectorAll("button:not([disabled])")).find(b => b.textContent === "Close") || bodyEl.querySelector("button:not([disabled])");
    if (target) target.focus();
  }
  function renderDlg() {
    const top = ui.dlg[ui.dlg.length - 1];
    if (!top) return;
    const body = $("dlg-body");
    body.textContent = "";
    if (top.view === "players") viewPlayers(body);
    else if (top.view === "stats") viewStats(body, top.id);
    else viewScores(body);
  }

  function sortBy(col) {
    if (ui.sort.col === col) ui.sort.dir = ui.sort.dir === "asc" ? "desc" : "asc";
    else ui.sort = { col, dir: col === "name" ? "asc" : "desc" };
    renderDlg();
  }

  function viewScores(body) {
    const rows = G.rankPlayers(G.playerTotals(roster, runLog), ui.sort.col, ui.sort.dir);
    body.appendChild(el("h1", "", "Scoreboard"));
    body.appendChild(el("p", "note", "Every player on this browser. Click a heading to sort, click a player for their stats."));
    body.appendChild(table(["Player", "Best", "Runs", "Best sector", "Delivered", "Stars"],
      rows.map(r => [r.name, num(r.best), num(r.runs), num(r.bestSector), num(r.delivered && r.delivered.all), num(r.stars)]),
      { keys: ["name", "best", "runs", "bestSector", "delivered", "stars"], onSort: sortBy,
        rowClass: i => (rows[i].id === me().id ? "me" : ""), onRow: i => openDlg("stats", rows[i].id) }));
    body.appendChild(el("h2", "", "Top runs"));
    const top = G.topRuns(runLog, 10);
    body.appendChild(table(["#", "Player", "Score", "Sector", "When", "Result"],
      top.map((r, i) => [String(i + 1), nameOf(r.player), num(r.score), num(r.sector), fmtDate(r.at), r.result]),
      { empty: "No finished runs yet.", rowClass: i => (top[i].player === me().id ? "me" : "") }));
    body.appendChild(el("div", "row", null, [
      btn("Players", () => openDlg("players")), btn("Export logs", exportLogs),
      btn("Close", closeAllDlg, "primary")]));
  }

  function viewStats(body, id) {
    const t = G.playerTotals(roster, runLog).find(r => r.id === id);
    if (!t) { body.appendChild(el("p", "", "That player is gone.")); body.appendChild(el("div", "row", null, [btn("Back", popDlg, "primary")])); return; }
    const d = t.delivered || {};
    body.appendChild(el("h1", "", t.name + (t.id === me().id ? " (playing)" : "")));
    body.appendChild(table(["Best", "Runs", "Best sector", "Ore", "Ice", "Crystal", "Stars collected", "Stars banked", "Time played"],
      [[num(t.best), num(t.runs), num(t.bestSector), num(d.ore), num(d.ice), num(d.crystal), num(t.stars), num(t.bank), fmtSecs(t.secs)]]));
    body.appendChild(el("h2", "", "Runs, newest first"));
    const runs = G.playerRuns(runLog, id);
    const wrap = el("div", "scroll");
    wrap.appendChild(table(["When", "Score", "Sector", "Ore", "Ice", "Crystal", "Ships", "Bases", "Stars", "Time", "Result"],
      runs.map(r => { const q = r.delivered || {};
        return [fmtDate(r.at), num(r.score), num(r.sector), num(q.ore), num(q.ice), num(q.crystal), num(r.ships), num(r.bases), num(r.stars), fmtSecs(r.secs), r.result]; }),
      { empty: "No finished runs yet." }));
    body.appendChild(wrap);
    body.appendChild(el("h2", "", "Hangar purchases, newest first"));
    const wrap2 = el("div", "scroll");
    wrap2.appendChild(table(["When", "Item", "Kind", "Cost", "Stars after"], buyRows(G.playerBuys(buyLog, id)), { empty: "No purchases yet." }));
    body.appendChild(wrap2);
    body.appendChild(el("div", "row", null, [btn("Back", popDlg), btn("Close", closeAllDlg, "primary")]));
  }

  const nameMax = () => (G.TUNING.logs && G.TUNING.logs.nameMax) || 24;

  function viewPlayers(body) {
    body.appendChild(el("h1", "", "Players"));
    body.appendChild(el("p", "note", "Each player has their own stars, looks and best score. Playing as: " + me().name));
    const list = el("div", "plist");
    const totals = G.playerTotals(roster, runLog);
    for (const p of roster.players) {
      const t = totals.find(r => r.id === p.id) || {};
      const cur = p.id === me().id;
      list.appendChild(el("div", "prow" + (cur ? " me" : ""), null, [
        el("span", "pname", p.name + (cur ? " (playing)" : "")),
        el("small", "", "best " + num(t.best) + ", " + num(t.runs) + " runs, ★ " + num(p.profile && p.profile.stars)),
        btn("Play", () => switchPlayer(p.id), "", cur),
        btn("Rename", () => {
          const v = prompt("New name for " + p.name + ":", p.name);
          if (v == null) return;
          const r = G.renamePlayer(roster, p.id, v);
          if (!r.ok) return toast(r.reason || "That name cannot be used.");
          saveRoster(); renderDlg(); refresh();
        }),
        btn("Stats", () => openDlg("stats", p.id)),
        btn("Clear data", () => clearData(p)),
      ]));
    }
    body.appendChild(list);
    const input = el("input", "name-in");
    input.type = "text"; input.maxLength = nameMax(); input.placeholder = "New player name";
    const add = () => {
      const r = G.addPlayer(roster, input.value, nowIso());
      if (!r.ok) return toast(r.reason || "That name cannot be used.");
      saveRoster();
      toast("Added " + r.player.name + ". Press Play to switch to them.");
      renderDlg();
    };
    input.addEventListener("keydown", ev => { if (ev.key === "Enter") add(); if (ev.key !== "Escape") ev.stopPropagation(); });   // typing must not pause or cancel
    input.addEventListener("keyup", ev => ev.stopPropagation());
    body.appendChild(el("div", "row", null, [input, btn("Add player", add)]));
    body.appendChild(el("div", "row", null, [btn("Scores", () => openDlg("scores")), btn("Close", closeAllDlg, "primary")]));
  }

  function clearData(p) {
    if (!confirm("Clear all runs, purchases and the best score for " + p.name + "? Their name, stars and owned looks stay. This cannot be undone.")) return;
    const r = G.clearPlayerData(roster, runLog, buyLog, p.id);
    if (!r.ok) return toast(r.reason || "Nothing was cleared.");
    saveRoster(); saveRuns(); saveBuys();
    toast("Cleared " + r.runs + " run" + (r.runs === 1 ? "" : "s") + " and " + r.buys + " purchase" + (r.buys === 1 ? "" : "s") + " for " + p.name + ".");
    renderDlg(); refresh();
  }

  // Change player. A run in progress is logged as abandoned and a new run starts for the new player.
  function switchPlayer(id) {
    if (id === me().id) return;
    const live = game && !game.over;
    if (live && !confirm("Switch player? Your current run ends as abandoned, and " + nameOf(id) + " starts a new run.")) return;
    if (live) logRun("abandoned");
    if (game && G.recordBest(profile, G.scoreTotal(game))) saveProfile();
    const r = G.choosePlayer(roster, id);
    if (!r.ok) return toast(r.reason || "Could not switch player.");
    saveRoster();
    useProfile(me().profile);
    start(freshGame());
    saveNow();
    toast("Now playing as " + me().name + ".");
    renderDlg();
  }

  function exportLogs() {
    const text = G.exportLogs(roster, runLog, buyLog, nowIso());
    const d = new Date();
    const a = document.createElement("a");
    const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
    a.href = url;
    a.download = "fleet-game-logs-" + d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate()) + ".json";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    toast("Exported " + a.download);
  }

  $("dlg").addEventListener("click", ev => { if (ev.target === $("dlg")) popDlg(); });
  $("b-player").addEventListener("click", () => openDlg("players"));
  $("b-scores").addEventListener("click", () => openDlg("scores"));
  $("e-scores").addEventListener("click", () => openDlg("scores"));
  if (!HAS) for (const id of ["b-player", "b-scores", "e-scores", "h-history-wrap"]) $(id).hidden = true;

  function updatePlayerButton() { if (HAS) $("b-player").textContent = "☺ " + me().name; }

  // ---------------------------------------------------------------- feedback form

  const OFFLINE_SHORT = "Dashboard not running";
  const FALLBACK_TEXT = "Dashboard not running; saved here. Start the dashboard and press Send in Saved feedback.";
  const fb = { list: [], sending: false, opener: null, wasPaused: false };

  function loadFeedbackList() {
    let text = null;
    try { text = localStorage.getItem(FEEDBACK_KEY); } catch (e) { /* no storage: the list lasts for this visit only */ }
    fb.list = G.parseFeedbackList(text);
  }

  // Feedback is not game state, so it is kept in stress mode too. Returns false when the browser refuses.
  function saveFeedbackList() {
    try { localStorage.setItem(FEEDBACK_KEY, G.serializeFeedbackList(fb.list)); return true; }
    catch (e) { return false; }
  }

  function fbStatus(msg, kind) {
    const el = $("f-status");
    el.textContent = msg || "";
    el.className = "f-status" + (kind ? " " + kind : "");
  }

  function fbCount() {
    const n = $("f-message").value.trim().length;
    const c = $("f-count");
    c.textContent = n + " / " + G.FEEDBACK_MAX;
    c.classList.toggle("over", n > G.FEEDBACK_MAX);
  }

  function fbFocusables() {
    return Array.from($("feedback").querySelectorAll("button, select, textarea, input"))
      .filter(el => !el.disabled && el.getClientRects().length > 0);
  }

  // After a re-render or a disabled button, make sure focus has not fallen out of the dialog.
  function fbKeepFocus() {
    if (ui.feedback && !$("feedback").contains(document.activeElement)) $("f-title").focus();
  }

  function renderFeedbackList() {
    const list = $("f-list");
    list.textContent = "";
    const unsent = fb.list.filter(e => !e.sent).length;
    $("f-unsent").textContent = fb.list.length ? unsent + " not sent of " + fb.list.length : "nothing saved yet";
    $("f-send-unsent").disabled = fb.sending || !unsent;
    $("f-download").disabled = !fb.list.length;
    $("f-send").disabled = fb.sending;
    for (const id of ["f-type", "f-rating", "f-message", "f-info"]) $(id).disabled = fb.sending;
    $("f-send").textContent = fb.sending ? "Sending..." : "Send to team";
    for (const e of fb.list) {
      const p = e.payload, li = document.createElement("li");
      const state = document.createElement("span");
      state.className = "f-state " + (e.sent ? "sent" : "unsent");
      state.textContent = e.sent ? "Sent" : "Not sent";
      const txt = document.createElement("span"); txt.className = "f-txt";
      const first = document.createElement("div"); first.className = "f-first";
      first.textContent = p.type + ": " + (p.message.split("\n")[0] || "");
      const meta = document.createElement("div"); meta.className = "f-meta";
      meta.textContent = new Date(p.created).toLocaleString() + (!e.sent && e.lastError ? " - " + e.lastError : "");
      txt.append(first, meta);
      li.append(state, txt);
      const add = (act, label) => {
        const b = document.createElement("button");
        b.type = "button"; b.dataset.act = act; b.dataset.id = p.id; b.textContent = label;
        if (act === "send") b.disabled = fb.sending;
        li.appendChild(b);
      };
      if (!e.sent) add("send", "Send");
      add("copy", "Copy");
      add("delete", "Delete");
      list.appendChild(li);
    }
    fbKeepFocus();
  }

  function openFeedback(opener) {
    if (ui.feedback) return;
    fb.opener = opener || document.activeElement;
    fb.wasPaused = ui.paused;
    ui.feedback = true; ui.paused = true;
    $("win").hidden = true; $("end").hidden = true; $("hangar").hidden = true; $("dlg").hidden = true;   // an open Players/Scores/Stats stack waits underneath
    for (const id of ["side", "topbar", "paused"]) $(id).inert = true;   // nothing behind the dialog can be reached
    $("feedback").hidden = false;
    fbCount(); fbStatus("");
    renderFeedbackList();
    if (game) refresh();
    $("f-message").focus();
  }

  function closeFeedback() {
    if (!ui.feedback) return;
    ui.feedback = false; ui.paused = fb.wasPaused;
    $("feedback").hidden = true;
    for (const id of ["side", "topbar", "paused"]) $(id).inert = false;
    $("hangar").hidden = !ui.hangar;
    if (ui.dlg.length) showDlg(); else showCards();
    if (game) refresh();
    const back =fb.opener && document.contains(fb.opener) && fb.opener.getClientRects().length ? fb.opener : $("b-feedback");
    if (!ui.dlg.length) back.focus();   // showDlg has already placed focus when a dialog is coming back
    fb.opener = null;
  }

  // POST one payload. Resolves to { status, text } for any reply, or { error } when there was none (offline, refused, timed out).
  async function postFeedback(payload) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), G.FEEDBACK_TIMEOUT_MS);
    try {
      const res = await fetch(G.FEEDBACK_URL, { method: "POST", headers: { "Content-Type": "text/plain;charset=UTF-8" }, body: JSON.stringify(payload), signal: ctl.signal });
      let text = "";
      try { text = await res.text(); } catch (e) { text = ""; }
      return { status: res.status, text };
    } catch (e) {
      return { error: ctl.signal.aborted ? "Timed out" : String((e && e.message) || e) };
    } finally {
      clearTimeout(timer);
    }
  }

  function setSending(v) {
    fb.sending = v;
    renderFeedbackList();
  }

  // The "Send to team" button.
  async function submitFeedback() {
    if (fb.sending || !ui.feedback) return;
    const input = { type: $("f-type").value, rating: $("f-rating").value, message: $("f-message").value };
    const info = $("f-info").checked ? G.feedbackGameInfo(game, { userAgent: navigator.userAgent }) : null;
    const made = G.makeFeedback(input, info);
    if (!made.ok) {
      fbStatus(made.reason, "err");
      $(made.field === "message" ? "f-message" : made.field === "rating" ? "f-rating" : "f-type").focus();
      return;
    }
    const entry = G.newFeedbackEntry(made.payload);
    fbStatus("Sending...");
    setSending(true);
    const res = await postFeedback(entry.payload);
    const reply = res.error ? null : G.feedbackReply(res.status, res.text);
    let keep = true, msg, kind;
    if (reply && reply.sent) {
      entry.sent = true; entry.sentAt = new Date().toISOString();
      msg = reply.message; kind = "ok";
    } else if (reply && !reply.retry) {   // 400, 403, 413: sending the same thing again would fail the same way
      keep = false; msg = reply.message; kind = "err";
    } else {                              // no dashboard, 429, 5xx: keep it to send later
      entry.lastError = reply ? reply.message : OFFLINE_SHORT;
      msg = reply ? reply.message + " Saved here; press Send in Saved feedback to try again." : FALLBACK_TEXT;
      kind = "err";
    }
    let stored = true;
    if (keep) {
      fb.list.unshift(entry);
      stored = saveFeedbackList();
      if (entry.sent) { $("f-message").value = ""; fbCount(); }
    }
    if (!stored) msg += " Could not keep a copy in this browser.";
    fbStatus(msg, kind);
    setSending(false);
    fbKeepFocus();
  }

  // Send one saved entry again with its stored payload (same id), and update it.
  async function sendSaved(entry) {
    const res = await postFeedback(entry.payload);
    const reply = res.error ? null : G.feedbackReply(res.status, res.text);
    if (reply && reply.sent) { entry.sent = true; entry.sentAt = new Date().toISOString(); entry.lastError = null; return { ok: true, message: reply.message }; }
    entry.lastError = reply ? reply.message : OFFLINE_SHORT;
    return { ok: false, offline: !reply, message: reply ? reply.message : FALLBACK_TEXT };
  }

  async function sendOne(id) {
    const entry = fb.list.find(e => e.payload.id === id);
    if (fb.sending || !entry || entry.sent) return;
    fbStatus("Sending...");
    setSending(true);
    const r = await sendSaved(entry);
    const stored = saveFeedbackList();
    fbStatus(r.message + (stored ? "" : " Could not keep a copy in this browser."), r.ok ? "ok" : "err");
    setSending(false);
    fbKeepFocus();
  }

  async function sendAllUnsent() {
    if (fb.sending) return;
    const todo = fb.list.filter(e => !e.sent).reverse();   // oldest first
    if (!todo.length) return;
    fbStatus("Sending...");
    setSending(true);
    let done = 0, last = null;
    for (const entry of todo) {
      last = await sendSaved(entry);
      if (last.ok) done++;
      else if (last.offline) break;   // no dashboard: do not try the rest
    }
    const stored = saveFeedbackList();
    fbStatus("Sent " + done + " of " + todo.length + "." + (done < todo.length && !last.ok ? " " + last.message : "") +
      (stored ? "" : " Could not keep a copy in this browser."), done === todo.length ? "ok" : "err");
    setSending(false);
    fbKeepFocus();
  }

  function downloadAll() {
    if (!fb.list.length) return fbStatus("Nothing saved yet.", "err");
    const x = G.feedbackExport(fb.list, new Date());
    const url = URL.createObjectURL(new Blob([x.text], { type: "application/json" }));
    const a = document.createElement("a");
    a.href = url; a.download = x.name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    fbStatus("Downloaded " + x.name, "ok");
  }

  // Clipboard API when the page may use it; otherwise a selected read-only textarea and the browser's copy command.
  async function copyText(text) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) { await navigator.clipboard.writeText(text); return true; }
    } catch (e) { /* not allowed here (file pages): use the fallback */ }
    const ta = document.createElement("textarea");
    ta.value = text; ta.readOnly = true; ta.setAttribute("aria-label", "Feedback text to copy");
    ta.style.cssText = "position:fixed;left:-9999px;top:0;opacity:0";
    $("feedback").appendChild(ta);
    const back = document.activeElement;
    ta.focus(); ta.select();
    let ok = false;
    try { ok = document.execCommand("copy"); } catch (e) { ok = false; }
    ta.remove();
    if (back && back.focus) back.focus();
    return ok;
  }

  async function copyEntry(entry) {
    const ok = await copyText(G.feedbackText(entry));
    fbStatus(ok ? "Copied." : "Could not copy. Use Download all instead.", ok ? "ok" : "err");
  }

  for (const id of ["b-feedback", "p-feedback", "e-feedback", "w-feedback"]) $(id).addEventListener("click", ev => openFeedback(ev.currentTarget));
  $("f-close").addEventListener("click", closeFeedback);
  $("f-form").addEventListener("submit", ev => ev.preventDefault());   // Enter never sends; Ctrl+Enter and the button do
  $("f-send").addEventListener("click", submitFeedback);
  $("f-message").addEventListener("input", fbCount);
  $("f-send-unsent").addEventListener("click", sendAllUnsent);
  $("f-download").addEventListener("click", downloadAll);
  $("f-list").addEventListener("click", ev => {
    const btn = ev.target.closest("[data-act]");
    if (!btn) return;
    const entry = fb.list.find(e => e.payload.id === btn.dataset.id);
    if (!entry) return;
    if (btn.dataset.act === "send") sendOne(entry.payload.id);
    else if (btn.dataset.act === "copy") copyEntry(entry);
    else if (btn.dataset.act === "delete") {
      if (!confirm("Delete this saved feedback" + (entry.sent ? "?" : "? It has not been sent yet."))) return;
      fb.list = fb.list.filter(e => e !== entry);
      if (!saveFeedbackList()) fbStatus("Deleted, but the browser would not update its saved copy.", "err");
      renderFeedbackList();
    }
  });
  // Keys inside the dialog (capture phase, so they come before everything else): Tab stays inside, Ctrl/Cmd+Enter sends.
  window.addEventListener("keydown", ev => {
    if (!ui.feedback) return;
    if (ev.key === "Enter" && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); submitFeedback(); return; }
    if (ev.key !== "Tab") return;
    const items = fbFocusables();
    if (!items.length) { ev.preventDefault(); return; }
    const first = items[0], last = items[items.length - 1], at = document.activeElement;
    const edge = !$("feedback").contains(at) || at === $("f-title");
    if (ev.shiftKey && (edge || at === first)) { ev.preventDefault(); last.focus(); }
    else if (!ev.shiftKey && (edge || at === last)) { ev.preventDefault(); first.focus(); }
  }, true);

  // ---------------------------------------------------------------- input

  function toWorld(ev) {
    const r = canvas.getBoundingClientRect();
    return { x: (ev.clientX - r.left - view.ox) / view.sc, y: (ev.clientY - r.top - view.oy) / view.sc };
  }

  function hit(p) {
    let best = null, bd = Infinity;
    const consider = (o, kind, r) => {
      const d = Math.hypot(o.x - p.x, o.y - p.y);
      if (d <= r && d < bd) { bd = d; best = { kind, o }; }
    };
    for (const b of game.bodies) consider(b, "body", b.r + 8);
    for (const b of game.bases) consider(b, "base", G.BASE_R + 10);
    for (const s of game.stars) if (!s.taken) consider(s, "star", 18);
    const sr = Math.max(14, 14 / view.sc);
    let ship = null, sd = Infinity;   // ships win over whatever is beneath them
    for (const s of game.ships) {
      const d = Math.hypot(s.x - p.x, s.y - p.y);
      if (d <= sr && d < sd) { sd = d; ship = s; }
    }
    return ship ? { kind: "ship", o: ship } : best;
  }

  function select(id) {
    ui.selected = id;
    ui.placing = false;
    boardKey = ""; buildHtml = "";
    refresh();
  }

  function onClick(ev) {
    if (!game || modal()) return;
    const p = toWorld(ev);
    if (ui.placing) {
      const r = G.placeBase(game, p.x, p.y);
      if (!r.ok) return toast(r.reason);
      ui.placing = false;
      saveNow();
      buildHtml = ""; basesHtml = "";
      refresh();
      return;
    }
    const h = hit(p);
    if (h && h.kind === "ship") return select(h.o.id === ui.selected ? null : h.o.id);
    if (ui.selected == null) {
      if (h && h.kind === "star") toast("Select a ship first, then click the star.");
      return;
    }
    if (h && h.kind === "body") {
      const r = G.orderShip(game, ui.selected, h.o.id);
      if (!r.ok) return toast(r.reason);
    } else if (h && h.kind === "star") {
      const r = G.orderShipToStar(game, ui.selected, h.o.id);
      if (!r.ok) return toast(r.reason);
    } else if (h && h.kind === "base") G.returnToBase(game, ui.selected, h.o.id);
    else return select(null);
    refresh();
  }

  canvas.addEventListener("click", onClick);
  canvas.addEventListener("mousemove", ev => {
    ui.mouse = toWorld(ev);
    if (!game) return;
    const h = hit(ui.mouse);
    canvas.style.cursor = ui.placing ? "crosshair" : h ? "pointer" : "default";
  });
  canvas.addEventListener("mouseleave", () => { ui.mouse = null; });

  $("build").addEventListener("click", ev => {
    const btn = ev.target.closest("[data-build]");
    if (!btn || !game) return;
    const key = btn.dataset.build;
    if (key === "base") { ui.placing = !ui.placing; ui.selected = null; boardKey = ""; buildHtml = ""; refresh(); return; }
    const r = G.buildShip(game, key);
    if (!r.ok) toast(r.reason);
    else { select(r.ship.id); saveNow(); }
    refresh();
  });
  $("bases").addEventListener("click", ev => {
    const btn = ev.target.closest("[data-up]");
    if (!btn || !game) return;
    const r = G.upgradeBase(game, Number(btn.dataset.up));
    if (!r.ok) return toast(r.reason);
    saveNow();
    buildHtml = ""; basesHtml = "";
    refresh();
  });
  $("board").addEventListener("click", ev => {
    const li = ev.target.closest("[data-ship]");
    if (li) select(Number(li.dataset.ship) === ui.selected ? null : Number(li.dataset.ship));
  });

  function setPaused(v) { ui.paused = v; refresh(); }
  $("b-pause").addEventListener("click", () => setPaused(!ui.paused));
  $("b-save").addEventListener("click", () => { if (saveNow(SAVE_KEY)) toast(STRESS ? "Stress mode does not save." : "Saved."); });
  $("b-load").addEventListener("click", () => { loadNow(); });
  $("b-new").addEventListener("click", () => newGame(true));
  $("b-retire").addEventListener("click", () => {
    if (!game || game.over || !confirm("Retire this run? Your score is kept as a possible best, and your stars stay banked.")) return;
    G.retire(game);
    saveNow();
    refresh();
  });
  $("b-warp").addEventListener("click", warp);
  $("w-warp").addEventListener("click", warp);
  $("e-new").addEventListener("click", () => newGame(false));
  $("w-keep").addEventListener("click", () => { ui.winOpen = false; $("win").hidden = true; });
  window.addEventListener("keydown", ev => {
    if (ev.key !== "Escape") return;
    if (ui.feedback) return closeFeedback();
    if (ui.dlg.length) return popDlg();   // the top dialog; a stats view opened from the scoreboard goes back to it
    if (ui.hangar) return closeHangar();
    ui.placing = false; ui.selected = null; boardKey = ""; buildHtml = ""; refresh();
  });
  // Space toggles pause wherever focus is. It is handled in the capture phase and cancelled, so a
  // focused button does not also "click" (keydown for most browsers, keyup for Firefox).
  const isSpace = ev => ev.key === " " || ev.code === "Space";
  const typing = ev => ui.feedback || (ev.target && (ev.target.tagName === "INPUT" || ev.target.tagName === "TEXTAREA"));
  window.addEventListener("keydown", ev => {
    if (!isSpace(ev) || typing(ev)) return;   // a space typed in a name box or the feedback form is just a space
    ev.preventDefault();
    if (!ev.repeat) setPaused(!ui.paused);
  }, true);
  window.addEventListener("keyup", ev => { if (isSpace(ev) && !typing(ev)) ev.preventDefault(); }, true);
  window.addEventListener("beforeunload", () => { if (game) saveNow(AUTO_KEY); });
  window.addEventListener("resize", resize);

  // ---------------------------------------------------------------- main loop

  function loop(t) {
    requestAnimationFrame(loop);
    const raw = (t - lastT) / 1000;
    lastT = t;
    if (!game || !(raw > 0)) return;
    const dt = Math.min(0.25, raw);
    fps.frames++; fps.acc += raw; fps.worst = Math.max(fps.worst, raw * 1000);
    if (fps.acc >= 0.5) {
      $("fps").textContent = `${Math.round(fps.frames / fps.acc)} fps, worst ${Math.round(fps.worst)} ms, ${game.ships.length} ships`;
      fps.frames = 0; fps.acc = 0; fps.worst = 0;
    }
    const running = !ui.paused && !modal() && !game.over;
    if (running) {   // fixed-step simulation; drawing happens once per animation frame
      acc += dt;
      let n = 0;
      while (acc >= STEP && n < MAX_STEPS) { G.step(game, STEP); time += STEP; acc -= STEP; n++; }
      if (n === MAX_STEPS) acc = 0;
      for (const s of game.ships) {
        let tr = trails.get(s.id);
        if (!tr) trails.set(s.id, tr = []);
        const moving = s.st === G.TO_BODY || s.st === G.TO_BASE || s.st === G.TO_STAR;
        if (moving) tr.push([s.x, s.y]);
        if (tr.length > 14 || (!moving && tr.length)) tr.shift();
      }
      G.checkWin(game);
      if (game.starsGot !== ui.starsSeen || game.over || (game.won && !ui.winShown)) refresh();
    }
    frame(running ? dt : 0);
    if (t - lastBoard > 250) { lastBoard = t; refresh(); }
    if (t - lastSave > 10000) { lastSave = t; saveNow(); }
  }

  // ---------------------------------------------------------------- go

  const profileNotice = loadProfile();
  loadFeedbackList();
  resize();
  let first = null, notice = "", damaged = false;
  if (!STRESS) {
    const r = readSaves([AUTO_KEY, SAVE_KEY]);   // the autosave is the newest; the manual save is the fallback
    first = r.state; notice = r.notice; damaged = r.damaged;
  }
  start(first || freshGame(), !!first);
  const msgs = [profileNotice, notice && (notice.trim() + (first ? (damaged ? " Loaded the other save." : "") : " Started a new game; a copy of the damaged save was kept."))].filter(Boolean);
  if (msgs.length) toast(msgs.join(" "), true);
  requestAnimationFrame(t => { lastT = t; lastSave = t; requestAnimationFrame(loop); });

  // for debugging from the console
  window.__fleet = { get game() { return game; }, get profile() { return profile; }, ui };
})();
