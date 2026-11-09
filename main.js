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
  const KEYBOARD_KEY = "fleet-game-keyboard-v1";  // "1" when keyboard mode is on
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
    endShown: false, endOpen: false, hangar: false, tech: false, feedback: false, starsSeen: 0,
    dlg: [], sort: { col: "best", dir: "desc" }, noLog: false, keyboard: false, cursor: null };   // cursor: keyboard base-placement spot
  const view = { sc: 1, ox: 0, oy: 0, W: 1, H: 1, dpr: 1 };
  let skyStars = [], nebula = null, scene = null;   // scene: the entry of SCENES in use
  const trails = new Map();
  const shapes = new Map();
  let time = 0, acc = 0, lastT = 0, lastBoard = 0, lastSave = 0, boardKey = "", buildHtml = "", basesHtml = "", toastTimer = 0, topH = 0;
  const fps = { frames: 0, acc: 0, worst: 0 };

  const WAR_COLOR = "#cfd9ff";   // warships keep one silver hull in every look; the hangar colours are for miners and haulers
  const shipColor = ship => looks.ship[ship.type] || WAR_COLOR;
  const isWar = ship => !!(ship && G.SHIP_TYPES[ship.type] && G.SHIP_TYPES[ship.type].war);

  // ---------------------------------------------------------------- theme wording
  // With the Space theme (or an old game.js without labelsFor) every word below is the original wording.
  const FALLBACK_LABELS = {
    res: { ore: "ore", ice: "ice", crystal: "crystal" }, resTitle: { ore: "Ore", ice: "Ice", crystal: "Crystal" },
    ship: { miner: "Miner", hauler: "Hauler" }, ships: "Ships",
    base: "base", baseTitle: "Base", bases: "Bases", home: "Home base", newBase: "New base",
    body: { asteroid: "Asteroid", moon: "Moon", iceplanet: "Ice planet", rare: "Rare planet" },
    storm: "Ion storm", shower: "Meteor shower", sector: "Sector", warp: "Warp to next sector",
  };
  const themeId = () => (G.labelsFor && looks.theme && looks.theme.id) || "space";
  const themed = () => themeId() !== "space";
  const LB = () => (G.labelsFor && looks.labels) || G.SPACE_LABELS || FALLBACK_LABELS;
  const labelArg = () => (G.labelsFor ? looks.labels : undefined);   // trailing argument of the game.js calls
  const lc = t => String(t).toLowerCase();
  const shipWord = () => (themed() ? lc(LB().ship.miner) : "ship");     // "hamster", "dwarf", or "ship"
  const shipsWord = () => (themed() ? lc(LB().ships) : "ships");
  const an = t => (/^[aeiou]/i.test(t) ? "an " : "a ") + t;
  const shipName = s => (G.shipLabel && G.labelsFor ? G.shipLabel(s, LB()) : s.name);
  const baseName = i => {   // "Home" / "Base 2" in Space; the theme's words otherwise
    const L = LB();
    return themed() ? (i === 0 ? L.home : L.baseTitle + " " + (i + 1)) : (i === 0 ? "Home" : "Base " + (i + 1));
  };

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
    if (STRESS) G.spawnStress(g, 30, 15);   // 30 ships and 15 aliens
    return g;
  }

  // Everything that depends on the current map: called for a new, loaded or warped game.
  function resetView() {
    clearDigits();
    ui.selected = null; ui.placing = false; ui.cursor = null; acc = 0;
    trails.clear(); shapes.clear(); alienAng.clear();
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
    const r = G.warpToNextSector(game, labelArg());
    if (!r.ok) return toast(r.reason);
    ui.winShown = false; ui.winOpen = false; $("win").hidden = true;
    resetView();
    saveNow();
    refresh();
    toast(LB().sector + " " + game.sector + ": further out, harder" + hazardNote(game.sector), true);
  }

  // What is new in a sector, for the warp toast: storms, then fog and flares, then showers and the first raiders.
  function hazardNote(n) {
    const T = G.TUNING, L = LB(), th = themed();
    const notes = [];
    if (n === T.storms.firstSector) notes.push(th ? L.storm + " slows " + lc(L.ships) + "." : "Ion storms slow ships.");
    if (n === T.events.firstSector) notes.push("Fog slows mining, and solar flares stun ships unless a Shield covers them.");
    if (n === T.showers.firstSector) notes.push(th ? L.shower + " can knock cargo off." : "Meteor showers can hurt ships and knock cargo off.");
    if (n === T.aliens.firstSector) notes.push("Alien raiders can arrive from now on: build a Turret or a Warship before they do.");
    return notes.length ? ". " + notes.join(" ") : ".";
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

  // ---------------------------------------------------------------- sky scenes
  // SCENES[name] = { build(n, W, H), draw(dt) }. build paints the static part into the offscreen
  // context n (CSS-pixel units) and sets up any moving things; draw(dt) runs every frame and must stay
  // cheap (no gradients made in loops). To add a scene, add an entry here; unknown names fall back to nebula.

  const SCENES = {};
  const spriteCache = new Map();

  function sceneName() {
    return G.sceneFor ? G.sceneFor(looks) : (looks.bg.scene || "nebula");
  }

  function buildSky() {
    const { W, H, dpr } = view;
    scene = SCENES[sceneName()] || SCENES.nebula;
    spriteCache.clear();   // sprites depend on the device scale and the view scale, which a rebuild may have changed
    nebula = document.createElement("canvas");
    nebula.width = canvas.width; nebula.height = canvas.height;
    const n = nebula.getContext("2d");
    n.scale(dpr, dpr);
    scene.build(n, W, H);
  }

  function sceneStars(n, rnd, count, maxR, alpha) {   // static specks painted into the backdrop
    for (let i = 0; i < count; i++) {
      const r = 0.5 + rnd() * maxR, t = rnd();
      n.globalAlpha = alpha * (0.35 + 0.65 * rnd());
      n.fillStyle = t < 0.15 ? "#ffd9b0" : t < 0.3 ? "#b9d4ff" : "#ffffff";
      n.fillRect(rnd() * view.W, rnd() * view.H, r, r);
    }
    n.globalAlpha = 1;
  }

  function spriteCanvas(w, h) {
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.ceil(w)); c.height = Math.max(1, Math.ceil(h));
    return c;
  }

  // -- nebula: the original drifting stars over colour blobs (unchanged)
  SCENES.nebula = {
    build(n, W, H) {
      const count = Math.min(420, Math.round((W * H) / 3000));
      skyStars = Array.from({ length: count }, () => {
        const layer = Math.random() < 0.6 ? 0 : Math.random() < 0.75 ? 1 : 2;
        return { x: Math.random() * W, y: Math.random() * H, layer, r: [0.6, 1, 1.5][layer] * (0.7 + Math.random() * 0.6),
          a: [0.45, 0.7, 0.95][layer], ph: Math.random() * 6.28, sp: 0.6 + Math.random() * 2.2,
          tint: Math.random() < 0.15 ? "#ffd9b0" : Math.random() < 0.3 ? "#b9d4ff" : "#ffffff" };
      });
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
    },
    draw(dt) {
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
    },
  };

  // -- sparse (Deep Black): pure black, about 1/8 of the usual stars, almost all still
  let sparseTw = [];
  SCENES.sparse = {
    build(n, W, H) {
      const rnd = G.rng(4242);
      n.fillStyle = "#000"; n.fillRect(0, 0, W, H);
      const count = Math.max(8, Math.round(Math.min(420, (W * H) / 3000) / 8));
      sparseTw = [];
      for (let i = 0; i < count; i++) {
        const x = rnd() * W, y = rnd() * H, r = 1 + rnd() * 1.4, t = rnd();
        const color = t < 0.15 ? "#ffd9b0" : t < 0.3 ? "#b9d4ff" : "#ffffff";
        if (i % 6 === 0) sparseTw.push({ x, y, r, color, ph: rnd() * 6.28, sp: 0.15 + rnd() * 0.25 });   // a few twinkle
        else { n.fillStyle = color; n.globalAlpha = 0.8 + rnd() * 0.2; n.fillRect(x, y, r, r); }
      }
      n.globalAlpha = 1;
    },
    draw(dt) {
      for (const s of sparseTw) {
        if (!reduceMotion) s.ph += s.sp * dt;
        const dip = reduceMotion ? 0 : Math.pow(Math.max(0, Math.sin(s.ph)), 10);   // dims only briefly
        ctx.globalAlpha = 0.95 - 0.8 * dip;
        ctx.fillStyle = s.color;
        ctx.fillRect(s.x, s.y, s.r, s.r);
      }
      ctx.globalAlpha = 1;
    },
  };

  // -- solar: a sun off to the left, planets on faint elliptical orbits, one ringed
  let solarPlanets = [], solarSun = { x: 0, y: 0, ct: 1, st: 0 };
  function planetSprite(r, light, dark, ring) {
    const pad = ring ? r * 1.9 : 2, size = (r + pad) * 2, c = spriteCanvas(size * view.dpr, size * view.dpr), g = c.getContext("2d"), m = size / 2;
    g.scale(view.dpr, view.dpr);   // built at device resolution, drawn at CSS size
    const ringPath = (a0, a1) => {
      g.beginPath(); g.ellipse(m, m, r * 1.85, r * 0.55, -0.35, a0, a1); g.stroke();
    };
    if (ring) {
      g.strokeStyle = "rgba(220,200,160,0.55)"; g.lineWidth = Math.max(1.5, r * 0.22); ringPath(Math.PI, Math.PI * 2);
    }
    const sh = g.createRadialGradient(m - r * 0.45, m - r * 0.3, r * 0.1, m, m, r * 1.05);
    sh.addColorStop(0, light); sh.addColorStop(1, dark);
    g.fillStyle = sh; g.beginPath(); g.arc(m, m, r, 0, Math.PI * 2); g.fill();
    if (ring) {
      g.strokeStyle = "rgba(235,215,175,0.8)"; g.lineWidth = Math.max(1.5, r * 0.22); ringPath(0, Math.PI);
    }
    return c;
  }
  SCENES.solar = {
    build(n, W, H) {
      const rnd = G.rng(777), u = Math.min(W, H);
      const bgG = n.createLinearGradient(0, 0, W, H);
      bgG.addColorStop(0, "#03040c"); bgG.addColorStop(1, "#060814");
      n.fillStyle = bgG; n.fillRect(0, 0, W, H);
      sceneStars(n, rnd, Math.round((W * H) / 3500), 1.1, 0.8);
      const sx = W * 0.1, sy = H * 0.55, sr = u * 0.1, tilt = -0.1;
      solarSun = { x: sx, y: sy, ct: Math.cos(tilt), st: Math.sin(tilt) };
      const defs = [   // [orbit rx (fraction of W), planet radius (fraction of the short side), light, dark, ring, rad/s, start angle]
        [0.17, 0.012, "#d8c7b0", "#6d6258", false, 0.020, -0.6],
        [0.28, 0.019, "#f2d9a0", "#a8793a", false, 0.014, 0.4],
        [0.41, 0.021, "#9cc8ff", "#2a5da8", false, 0.010, -0.2],
        [0.58, 0.016, "#f0a080", "#8c3a22", false, 0.007, 0.7],
        [0.78, 0.034, "#ecd6a0", "#9a7c48", true, 0.004, -0.4],
      ];
      n.strokeStyle = "rgba(160,180,255,0.10)"; n.lineWidth = 1;
      solarPlanets = defs.map(d => {
        const rx = W * d[0], ry = rx * 0.3;
        n.beginPath(); n.ellipse(sx, sy, rx, ry, tilt, 0, Math.PI * 2); n.stroke();
        const r = Math.max(2.5, u * d[1]);
        return { rx, ry, ang: d[6], w: d[5], sprite: planetSprite(r, d[2], d[3], d[4]), half: r + (d[4] ? r * 1.9 : 2) };
      });
      // sun: wide glow, then a bright disc
      const glow = n.createRadialGradient(sx, sy, sr * 0.5, sx, sy, sr * 4.5);
      glow.addColorStop(0, "rgba(255,200,90,0.55)"); glow.addColorStop(0.35, "rgba(255,150,50,0.18)"); glow.addColorStop(1, "rgba(255,120,30,0)");
      n.fillStyle = glow; n.fillRect(0, 0, W, H);
      const disc = n.createRadialGradient(sx, sy, 0, sx, sy, sr);
      disc.addColorStop(0, "#fffbe6"); disc.addColorStop(0.7, "#ffd56a"); disc.addColorStop(1, "#ff9d2e");
      n.fillStyle = disc; n.beginPath(); n.arc(sx, sy, sr, 0, Math.PI * 2); n.fill();
    },
    draw(dt) {
      const { x, y, ct, st } = solarSun;
      for (const p of solarPlanets) {
        if (!reduceMotion) p.ang += p.w * dt;
        const ex = p.rx * Math.cos(p.ang), ey = p.ry * Math.sin(p.ang);
        ctx.drawImage(p.sprite, x + ex * ct - ey * st - p.half, y + ex * st + ey * ct - p.half, p.half * 2, p.half * 2);
      }
    },
  };

  // -- spiral: a bright core and curved star arms, pre-rendered once and turned very slowly
  let spiralImg = null, spiralC = { x: 0, y: 0, r: 0, rot: 0 };
  SCENES.spiral = {
    build(n, W, H) {
      const rnd = G.rng(31337);
      const bgG = n.createLinearGradient(0, 0, W, H);
      bgG.addColorStop(0, "#02030a"); bgG.addColorStop(1, "#070511");
      n.fillStyle = bgG; n.fillRect(0, 0, W, H);
      sceneStars(n, rnd, Math.round((W * H) / 2600), 1.2, 0.85);
      const r = Math.min(W, H) * 0.62, S = Math.min(2048, Math.ceil(2 * r * view.dpr)), k = S / 900;   // device-resolution sprite; k keeps the 900-unit design
      const c = spriteCanvas(S, S), g = c.getContext("2d"), m = S / 2, R = S * 0.48;
      const arms = 3, tints = ["#cfe0ff", "#a9c4ff", "#ffd9e8", "#ffffff"];
      for (let a = 0; a < arms; a++) {
        const off = (a / arms) * Math.PI * 2;
        for (let i = 0; i < 700; i++) {
          const t = Math.pow(rnd(), 0.8), rad = 0.06 * R + t * 0.94 * R;
          const th = off + t * 4.2 + (rnd() - 0.5) * (0.5 - 0.3 * t);   // spiral with scatter
          const x = m + Math.cos(th) * rad + (rnd() - 0.5) * R * 0.09 * (0.4 + t);
          const y = m + Math.sin(th) * rad + (rnd() - 0.5) * R * 0.09 * (0.4 + t);
          g.globalAlpha = (0.2 + 0.8 * rnd()) * (1 - t * 0.55);
          g.fillStyle = tints[(rnd() * tints.length) | 0];
          const s = (0.8 + rnd() * (1.6 - t)) * k;
          g.fillRect(x, y, s, s);
        }
        for (let i = 0; i < 14; i++) {   // soft arm haze
          const t = (i + 0.5) / 14, rad = 0.06 * R + t * 0.94 * R, th = off + t * 4.2;
          const x = m + Math.cos(th) * rad, y = m + Math.sin(th) * rad, hr = R * (0.1 + 0.05 * t);
          const hz = g.createRadialGradient(x, y, 0, x, y, hr);
          hz.addColorStop(0, "rgba(120,150,255,0.10)"); hz.addColorStop(1, "rgba(120,150,255,0)");
          g.globalAlpha = 1; g.fillStyle = hz; g.fillRect(x - hr, y - hr, hr * 2, hr * 2);
        }
      }
      g.globalAlpha = 1;
      const core = g.createRadialGradient(m, m, 0, m, m, R * 0.28);
      core.addColorStop(0, "rgba(255,248,225,1)"); core.addColorStop(0.25, "rgba(255,222,160,0.75)");
      core.addColorStop(0.6, "rgba(255,170,110,0.22)"); core.addColorStop(1, "rgba(255,150,100,0)");
      g.fillStyle = core; g.fillRect(0, 0, S, S);
      spiralImg = c;
      spiralC = { x: W * 0.62, y: H * 0.5, r, rot: 0 };
    },
    draw(dt) {
      if (!spiralImg) return;
      if (!reduceMotion) spiralC.rot += 0.012 * dt;   // one turn in about 9 minutes
      ctx.save();
      ctx.translate(spiralC.x, spiralC.y); ctx.rotate(spiralC.rot);
      ctx.drawImage(spiralImg, -spiralC.r, -spiralC.r, spiralC.r * 2, spiralC.r * 2);
      ctx.restore();
    },
  };

  // -- belt: a diagonal band of lumpy rocks at three depths, drifting along the band
  let beltRocks = [], beltGeo = { cx: 0, cy: 0, dx: 1, dy: 0, nx: 0, ny: 1, len: 1 };
  function rockSprite(size, hue, rnd) {
    const c = spriteCanvas(size * view.dpr, size * view.dpr), g = c.getContext("2d"), m = size / 2, k = 9 + ((rnd() * 4) | 0);
    g.scale(view.dpr, view.dpr);   // built at device resolution, drawn at CSS size
    g.beginPath();
    for (let i = 0; i < k; i++) {
      const a = (i / k) * Math.PI * 2, r = m * (0.62 + rnd() * 0.36);
      g[i ? "lineTo" : "moveTo"](m + Math.cos(a) * r, m + Math.sin(a) * r);
    }
    g.closePath();
    const lg = g.createLinearGradient(0, 0, size, size);
    lg.addColorStop(0, "hsl(" + hue + ",14%," + (44 + rnd() * 10) + "%)");
    lg.addColorStop(1, "hsl(" + hue + ",16%," + (18 + rnd() * 8) + "%)");
    g.fillStyle = lg; g.fill();
    g.strokeStyle = "rgba(0,0,0,0.45)"; g.lineWidth = 1; g.stroke();
    g.fillStyle = "rgba(0,0,0,0.25)";   // a couple of craters
    for (let i = 0; i < 2; i++) { g.beginPath(); g.arc(m + (rnd() - 0.5) * m, m + (rnd() - 0.5) * m, m * (0.1 + rnd() * 0.12), 0, Math.PI * 2); g.fill(); }
    return c;
  }
  SCENES.belt = {
    build(n, W, H) {
      const rnd = G.rng(9001), u = Math.min(W, H);
      const bgG = n.createLinearGradient(0, 0, W, H);
      bgG.addColorStop(0, "#05060c"); bgG.addColorStop(1, "#0a0907");
      n.fillStyle = bgG; n.fillRect(0, 0, W, H);
      sceneStars(n, rnd, Math.round((W * H) / 3200), 1.1, 0.8);
      const ang = 0.5, dx = Math.cos(ang), dy = -Math.sin(ang), len = Math.hypot(W, H) + 120;
      beltGeo = { cx: W / 2, cy: H / 2, dx, dy, nx: -dy, ny: dx, len };
      n.save(); n.translate(W / 2, H / 2); n.rotate(-ang);   // faint dust glow along the band
      const hg = n.createLinearGradient(0, -u * 0.3, 0, u * 0.3);
      hg.addColorStop(0, "rgba(150,120,90,0)"); hg.addColorStop(0.5, "rgba(150,120,90,0.09)"); hg.addColorStop(1, "rgba(150,120,90,0)");
      n.fillStyle = hg; n.fillRect(-len, -u * 0.3, len * 2, u * 0.6); n.restore();
      const sprites = [28, 35, 40, 30, 0, 20, 33, 25].map(h => rockSprite(32, h, rnd));
      const sizes = [5, 9, 15], speeds = [6, 12, 22];   // far, mid, near (px, px/s)
      beltRocks = [];
      for (let i = 0; i < 190; i++) {
        const depth = rnd() < 0.5 ? 0 : rnd() < 0.6 ? 1 : 2;
        const spread = u * (0.12 + 0.12 * (rnd() + rnd()));
        beltRocks.push({ s: (rnd() - 0.5) * len, o: (rnd() + rnd() - 1) * spread, depth, size: sizes[depth] * (0.7 + rnd() * 0.7),
          spr: sprites[(rnd() * sprites.length) | 0], v: speeds[depth] });
      }
      beltRocks.sort((a, b) => a.depth - b.depth);   // far first
    },
    draw(dt) {
      const g = beltGeo, half = g.len / 2;
      for (const r of beltRocks) {
        if (!reduceMotion) { r.s += r.v * dt; if (r.s > half) r.s -= g.len; }
        const x = g.cx + g.dx * r.s + g.nx * r.o, y = g.cy + g.dy * r.s + g.ny * r.o;
        ctx.globalAlpha = 0.55 + 0.2 * r.depth;
        ctx.drawImage(r.spr, x - r.size / 2, y - r.size / 2, r.size, r.size);
      }
      ctx.globalAlpha = 1;
    },
  };

  // ---------------------------------------------------------------- theme scenes (Hamster habitat, Dwarven cavern)
  // Same contract as the scenes above: static parts go into the backdrop, draw(dt) only does a little work
  // (a few glow sprites, dust motes). Reduced motion: no flicker, no motes, no twinkle.

  let sceneT = 0;
  const sceneRnd = seed => G.rng(seed);

  // -- habitat: wood-shavings bedding, cage bars with a water bottle, a tube, a food bowl, soft warm light
  let motes = [];
  SCENES.habitat = {
    build(n, W, H) {
      const rnd = sceneRnd(2468), u = Math.min(W, H);
      const bg = n.createLinearGradient(0, 0, W, H);
      bg.addColorStop(0, "#5c3d22"); bg.addColorStop(1, "#432b17");   // mid-dark warm brown, so light sprites and labels stand out
      n.fillStyle = bg; n.fillRect(0, 0, W, H);
      const tones = ["#76563a", "#654528", "#573c24", "#7d5a38", "#3a2513"];
      n.lineCap = "round";
      const count = Math.min(1800, Math.round((W * H) / 700));
      for (let i = 0; i < count; i++) {   // curled shavings
        const x = rnd() * W, y = rnd() * H, len = 8 + rnd() * 16, a = rnd() * Math.PI * 2;
        n.strokeStyle = tones[(rnd() * tones.length) | 0]; n.globalAlpha = 0.25 + 0.4 * rnd(); n.lineWidth = 1 + rnd() * 1.6;
        n.beginPath(); n.moveTo(x, y);
        n.quadraticCurveTo(x + Math.cos(a) * len * 0.5 + (rnd() - 0.5) * len * 0.6, y + Math.sin(a) * len * 0.5 + (rnd() - 0.5) * len * 0.6,
          x + Math.cos(a) * len, y + Math.sin(a) * len);
        n.stroke();
      }
      n.globalAlpha = 1; n.lineCap = "butt";
      const barW = 58;   // cage bars down the left edge
      n.fillStyle = "rgba(60,35,12,0.22)"; n.fillRect(0, 0, barW, H);
      for (let x = 8; x < barW; x += 16) {
        n.fillStyle = "rgba(40,25,10,0.3)"; n.fillRect(x + 1.5, 0, 5, H);
        n.fillStyle = "#98a0ae"; n.fillRect(x, 0, 4, H);
        n.fillStyle = "#e6ebf2"; n.fillRect(x, 0, 1.3, H);
      }
      n.fillStyle = "#7d8592"; n.fillRect(0, H * 0.06, barW, 5); n.fillRect(0, H * 0.94 - 5, barW, 5);
      const tubeY = H - 56, tubeH = 34;   // a see-through tube along the bottom
      n.fillStyle = "rgba(200,230,255,0.2)"; n.fillRect(barW, tubeY, W - barW, tubeH);
      n.strokeStyle = "rgba(255,255,255,0.4)"; n.lineWidth = 1.5; n.strokeRect(barW, tubeY, W - barW, tubeH);
      n.fillStyle = "rgba(255,255,255,0.28)"; n.fillRect(barW, tubeY + 4, W - barW, 3);
      for (let x = barW + 70; x < W; x += 120) { n.fillStyle = "rgba(235,245,255,0.35)"; n.fillRect(x, tubeY - 2, 7, tubeH + 4); }
      const bx = barW + 8, by = H * 0.22;   // water bottle hung on the bars
      n.fillStyle = "rgba(150,210,255,0.35)"; n.fillRect(bx, by, 26, 72);
      n.fillStyle = "rgba(70,150,230,0.55)"; n.fillRect(bx + 2, by + 22, 22, 48);
      n.strokeStyle = "rgba(255,255,255,0.6)"; n.lineWidth = 1.2; n.strokeRect(bx, by, 26, 72);
      n.fillStyle = "#b8bec9"; n.fillRect(bx + 5, by - 6, 16, 6);
      n.fillRect(bx + 11, by + 72, 4, 14);
      n.fillStyle = "#e6ebf2"; n.beginPath(); n.arc(bx + 13, by + 88, 3, 0, Math.PI * 2); n.fill();
      const fx = W - 96, fy = H - 98;   // food bowl with seeds
      n.fillStyle = "rgba(60,35,12,0.3)"; n.beginPath(); n.ellipse(fx + 4, fy + 10, 50, 22, 0, 0, Math.PI * 2); n.fill();
      n.fillStyle = "#c2563e"; n.beginPath(); n.ellipse(fx, fy, 46, 22, 0, 0, Math.PI * 2); n.fill();
      n.fillStyle = "#8f3a28"; n.beginPath(); n.ellipse(fx, fy - 2, 38, 16, 0, 0, Math.PI * 2); n.fill();
      for (let i = 0; i < 46; i++) {
        const a = rnd() * Math.PI * 2, r = Math.sqrt(rnd());
        n.fillStyle = ["#f0dca0", "#d9b36a", "#8b6a3a"][(rnd() * 3) | 0];
        n.beginPath(); n.ellipse(fx + Math.cos(a) * r * 32, fy - 3 + Math.sin(a) * r * 12, 3.2, 1.7, rnd() * 3, 0, Math.PI * 2); n.fill();
      }
      const lg = n.createRadialGradient(W * 0.3, H * 0.15, 0, W * 0.3, H * 0.15, Math.max(W, H) * 0.8);   // soft warm light
      lg.addColorStop(0, "rgba(255,226,150,0.10)"); lg.addColorStop(1, "rgba(255,226,150,0)");
      n.fillStyle = lg; n.fillRect(0, 0, W, H);
      const vg = n.createRadialGradient(W / 2, H / 2, u * 0.4, W / 2, H / 2, Math.max(W, H) * 0.75);
      vg.addColorStop(0, "rgba(30,15,5,0)"); vg.addColorStop(1, "rgba(30,15,5,0.4)");
      n.fillStyle = vg; n.fillRect(0, 0, W, H);
      motes = reduceMotion ? [] : Array.from({ length: 14 }, () => ({ x: rnd() * W, y: rnd() * H, r: 0.8 + rnd() * 1.4, vy: -(2 + rnd() * 4), vx: 1 + rnd() * 3, ph: rnd() * 6.28 }));
    },
    draw(dt) {
      if (!motes.length) return;
      ctx.fillStyle = "#fff4d0";
      for (const m of motes) {
        m.y += m.vy * dt; m.x += m.vx * dt; m.ph += dt;
        if (m.y < -3) { m.y = view.H + 3; m.x = Math.random() * view.W; }
        if (m.x > view.W + 3) m.x = -3;
        ctx.globalAlpha = 0.2 + 0.2 * Math.sin(m.ph * 1.3);
        ctx.fillRect(m.x, m.y, m.r, m.r);
      }
      ctx.globalAlpha = 1;
    },
  };

  // -- cavern: dark rock, stalactites, flickering torches, glinting gems, a little dust
  let torches = [], torchGlow = null, torchR = 0, glints = [], dust = [];
  SCENES.cavern = {
    build(n, W, H) {
      const rnd = sceneRnd(1357), u = Math.min(W, H);
      const bg = n.createLinearGradient(0, 0, 0, H);
      bg.addColorStop(0, "#0c090d"); bg.addColorStop(0.5, "#1b1410"); bg.addColorStop(1, "#0d0a0c");
      n.fillStyle = bg; n.fillRect(0, 0, W, H);
      const mottle = ["rgba(70,56,50,", "rgba(40,30,34,", "rgba(88,66,52,"];
      for (let i = 0; i < 420; i++) {   // rock texture blotches
        n.fillStyle = mottle[(rnd() * 3) | 0] + (0.05 + rnd() * 0.12) + ")";
        n.beginPath(); n.ellipse(rnd() * W, rnd() * H, 6 + rnd() * 34, 4 + rnd() * 18, rnd() * 3, 0, Math.PI * 2); n.fill();
      }
      const wall = (side) => {   // jagged dark walls at the left and right edges
        const base = Math.max(34, W * 0.06);
        n.beginPath(); n.moveTo(side < 0 ? 0 : W, 0);
        for (let y = 0; y <= H + 30; y += 30) n.lineTo(side < 0 ? base * (0.5 + rnd() * 0.9) : W - base * (0.5 + rnd() * 0.9), y);
        n.lineTo(side < 0 ? 0 : W, H); n.closePath();
        n.fillStyle = "#070509"; n.fill();
        n.strokeStyle = "rgba(120,96,84,0.35)"; n.lineWidth = 1.5; n.stroke();
        return base;
      };
      const wl = wall(-1), wr = wall(1);
      const spike = (x, y0, w, h, dir) => {   // stalactite (dir 1, hangs down) or stalagmite (dir -1)
        n.beginPath(); n.moveTo(x - w / 2, y0); n.lineTo(x + (rnd() - 0.5) * w * 0.3, y0 + dir * h); n.lineTo(x + w / 2, y0); n.closePath();
        n.fillStyle = "#16111a"; n.fill();
        n.beginPath(); n.moveTo(x - w / 2, y0); n.lineTo(x - w * 0.1, y0 + dir * h * 0.9); n.lineTo(x - w * 0.15, y0); n.closePath();
        n.fillStyle = "rgba(150,124,110,0.22)"; n.fill();
      };
      n.fillStyle = "#0a070c"; n.fillRect(0, 0, W, 10);
      for (let x = wl; x < W - wr; x += 18 + rnd() * 30) spike(x, 6, 14 + rnd() * 26, 14 + rnd() * rnd() * 70, 1);
      n.fillRect(0, H - 8, W, 8);
      for (let x = wl + 40; x < W - wr - 40; x += 120 + rnd() * 200) spike(x, H - 6, 16 + rnd() * 22, 12 + rnd() * 30, -1);
      const gr = u * 0.34;   // torches on the walls
      const spots = [[wl * 0.55, H * 0.28], [wl * 0.55, H * 0.74], [W - wr * 0.55, H * 0.46], [W - wr * 0.55, H * 0.88]];
      torchR = gr;
      torchGlow = spriteCanvas(gr * 2 * view.dpr, gr * 2 * view.dpr);
      const tg = torchGlow.getContext("2d");
      tg.scale(view.dpr, view.dpr);
      const rg = tg.createRadialGradient(gr, gr, 0, gr, gr, gr);
      rg.addColorStop(0, "rgba(255,170,70,0.9)"); rg.addColorStop(0.35, "rgba(255,120,40,0.35)"); rg.addColorStop(1, "rgba(255,90,20,0)");
      tg.fillStyle = rg; tg.fillRect(0, 0, gr * 2, gr * 2);
      torches = spots.map(([x, y], i) => ({ x, y: y - 16, ph: rnd() * 6.28 + i }));
      for (const [x, y] of spots) {
        n.globalCompositeOperation = "lighter"; n.globalAlpha = 0.45;
        n.drawImage(torchGlow, x - gr, y - 16 - gr, gr * 2, gr * 2);
        n.globalCompositeOperation = "source-over"; n.globalAlpha = 1;
        n.fillStyle = "#3a2a1c"; n.fillRect(x - 2, y - 14, 4, 22);   // handle
        n.fillStyle = "#6b6f78"; n.fillRect(x - 6, y - 16, 12, 4); n.fillRect(x - 4, y + 8, 8, 3);
      }
      const gemCols = ["#6fe0f0", "#e27be0", "#7ff09a", "#ffc860"];
      glints = [];
      for (let i = 0; i < 34; i++) {   // gem specks
        const x = wl + rnd() * (W - wl - wr), y = rnd() * H, c = gemCols[(rnd() * 4) | 0], s = 1.4 + rnd() * 2.2;
        n.fillStyle = c; n.globalAlpha = 0.35 + 0.4 * rnd();
        n.beginPath(); n.moveTo(x, y - s); n.lineTo(x + s * 0.8, y); n.lineTo(x, y + s); n.lineTo(x - s * 0.8, y); n.closePath(); n.fill();
        if (i % 4 === 0) glints.push({ x, y, c, ph: rnd() * 6.28, sp: 1 + rnd() * 2 });
      }
      n.globalAlpha = 1;
      const vg = n.createRadialGradient(W / 2, H / 2, u * 0.45, W / 2, H / 2, Math.max(W, H) * 0.8);
      vg.addColorStop(0, "rgba(0,0,0,0)"); vg.addColorStop(1, "rgba(0,0,0,0.5)");
      n.fillStyle = vg; n.fillRect(0, 0, W, H);
      dust = reduceMotion ? [] : Array.from({ length: 12 }, () => ({ x: rnd() * W, y: rnd() * H, r: 0.8 + rnd() * 1.2, vy: 1 + rnd() * 3, ph: rnd() * 6.28 }));
    },
    draw(dt) {
      sceneT += dt;
      ctx.globalCompositeOperation = "lighter";
      for (const t of torches) {
        const f = reduceMotion ? 0.7 : 0.62 + 0.2 * Math.sin(sceneT * 9 + t.ph) + 0.12 * Math.sin(sceneT * 23 + t.ph * 2);
        ctx.globalAlpha = 0.28 * f;
        ctx.drawImage(torchGlow, t.x - torchR, t.y - torchR, torchR * 2, torchR * 2);
      }
      ctx.globalCompositeOperation = "source-over";
      for (const t of torches) {
        const f = reduceMotion ? 0.8 : 0.8 + 0.2 * Math.sin(sceneT * 9 + t.ph) + 0.1 * Math.sin(sceneT * 23 + t.ph * 2);
        ctx.globalAlpha = 1;
        ctx.fillStyle = "#ff8a28";
        ctx.beginPath(); ctx.moveTo(t.x - 5, t.y); ctx.quadraticCurveTo(t.x - 6, t.y - 9 * f, t.x, t.y - 17 * f); ctx.quadraticCurveTo(t.x + 6, t.y - 9 * f, t.x + 5, t.y); ctx.fill();
        ctx.fillStyle = "#ffe28a";
        ctx.beginPath(); ctx.moveTo(t.x - 2.5, t.y); ctx.quadraticCurveTo(t.x - 3, t.y - 5 * f, t.x, t.y - 9 * f); ctx.quadraticCurveTo(t.x + 3, t.y - 5 * f, t.x + 2.5, t.y); ctx.fill();
      }
      if (!reduceMotion) {
        for (const g of glints) {
          g.ph += g.sp * dt;
          const a = Math.pow(Math.max(0, Math.sin(g.ph)), 6);
          if (a < 0.05) continue;
          ctx.globalAlpha = a * 0.9; ctx.fillStyle = g.c;
          ctx.fillRect(g.x - 4, g.y - 0.5, 8, 1); ctx.fillRect(g.x - 0.5, g.y - 4, 1, 8);
        }
        ctx.fillStyle = "#c8b8a8";
        for (const m of dust) {
          m.y += m.vy * dt; m.ph += dt;
          if (m.y > view.H + 3) { m.y = -3; m.x = Math.random() * view.W; }
          ctx.globalAlpha = 0.12 + 0.1 * Math.sin(m.ph);
          ctx.fillRect(m.x, m.y, m.r, m.r);
        }
      }
      ctx.globalAlpha = 1;
    },
  };

  // ---------------------------------------------------------------- theme sprites
  // Ships, bases and bodies are painted once into small canvases at device resolution (CSS size x dpr,
  // times the view scale for things that live in the world) and then drawn with one drawImage each.
  // paint(g) draws around (0, 0). The cache is cleared whenever the sky is rebuilt (resize, theme or bg pick).

  function cached(key, w, h, q, paint) {
    const k = key + "|" + view.dpr + "|" + q;
    let c = spriteCache.get(k);
    if (!c) {
      const s = view.dpr * q;
      c = spriteCanvas(w * s, h * s);
      const g = c.getContext("2d");
      g.scale(s, s); g.translate(w / 2, h / 2);
      paint(g);
      spriteCache.set(k, c);
    }
    return c;
  }
  const circ = (g, x, y, r, fill) => { g.fillStyle = fill; g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill(); };
  const ell = (g, x, y, rx, ry, rot, fill) => { g.fillStyle = fill; g.beginPath(); g.ellipse(x, y, rx, ry, rot, 0, Math.PI * 2); g.fill(); };
  const blobPath = (g, r, rnd, k) => {   // a lumpy closed outline
    g.beginPath();
    for (let i = 0; i < k; i++) {
      const a = (i / k) * Math.PI * 2, rr = r * (0.82 + rnd() * 0.2);
      g[i ? "lineTo" : "moveTo"](Math.cos(a) * rr, Math.sin(a) * rr);
    }
    g.closePath();
  };

  // Ship sprites face +x, 40 x 40 CSS px; the caller scales the hauler up.
  function paintHamster(g, big, color) {
    const ol = "#2a1608";   // dark outline: the same shapes, a little bigger, painted first
    ell(g, -1, 0, 11.6, 9.1, 0, ol); circ(g, 8, 0, 6.8, ol); circ(g, -11, 0, 3.4, ol);
    circ(g, 5.2, -4.6, 4.1, ol); circ(g, 5.2, 4.6, 4.1, ol);
    for (const [x, y] of [[-5, -8], [-5, 8], [4, -8], [4, 8]]) circ(g, x, y, 3.6, ol);
    if (big) { circ(g, 9, -4.6, 4.9, ol); circ(g, 9, 4.6, 4.9, ol); }
    ell(g, -5, -8, 2.6, 1.6, 0.3, "#f0a8a0"); ell(g, -5, 8, 2.6, 1.6, -0.3, "#f0a8a0");   // feet
    ell(g, 4, -8, 2.6, 1.6, -0.3, "#f0a8a0"); ell(g, 4, 8, 2.6, 1.6, 0.3, "#f0a8a0");
    circ(g, -11, 0, 2, "#f0a8a0");   // tail
    ell(g, -1, 0, 10, 7.5, 0, "#e8b878");
    ell(g, -3, 0, 6, 4.4, 0, "#c98f4e");   // darker back patch
    if (big) {
      circ(g, 9, -4.6, 3.4, "#f2c98a"); circ(g, 9, 4.6, 3.4, "#f2c98a");   // cheek pouches
      g.fillStyle = color; g.fillRect(-9, -4.5, 8, 9);   // little backpack
      g.strokeStyle = "rgba(0,0,0,0.45)"; g.lineWidth = 1; g.strokeRect(-9, -4.5, 8, 9);
      g.fillStyle = "rgba(255,255,255,0.35)"; g.fillRect(-8, -3.5, 6, 2);
    }
    g.strokeStyle = color; g.lineWidth = 2.4;   // collar
    g.beginPath(); g.arc(5, 0, 6.4, -1.25, 1.25); g.stroke();
    circ(g, 8, 0, 5.2, "#eec58e");   // head
    circ(g, 5.2, -4.6, 2.6, "#e8b878"); circ(g, 5.2, 4.6, 2.6, "#e8b878");   // ears
    circ(g, 5.2, -4.6, 1.4, "#f0a8a0"); circ(g, 5.2, 4.6, 1.4, "#f0a8a0");
    circ(g, 10, -2.2, 0.95, "#2a1a10"); circ(g, 10, 2.2, 0.95, "#2a1a10");   // eyes
    circ(g, 13, 0, 1.2, "#e0707a");   // nose
  }
  function paintDwarf(g, color) {
    g.strokeStyle = "#6b4a2a"; g.lineWidth = 1.8;   // pick: handle, then head
    g.beginPath(); g.moveTo(-4, 9.5); g.lineTo(12, 9.5); g.stroke();
    g.strokeStyle = "#b8bec9"; g.lineWidth = 2.4;
    g.beginPath(); g.moveTo(11, 5); g.quadraticCurveTo(14, 9.5, 11, 14); g.stroke();
    ell(g, -2, 0, 6, 9, 0, "#7a4a2a");   // shoulders
    g.fillStyle = "#3a2a1c"; g.fillRect(-3, -9, 2.4, 18);   // belt
    circ(g, 3, 8, 2.2, "#e8b890");   // hand on the pick
    circ(g, 5, 0, 4.6, "#e8b890");   // face
    ell(g, 8.5, 0, 4.4, 5.2, 0, "#b8541c");   // beard
    circ(g, 3, 0, 5.6, color);   // helmet
    g.strokeStyle = "rgba(0,0,0,0.5)"; g.lineWidth = 1; g.beginPath(); g.arc(3, 0, 5.6, 0, Math.PI * 2); g.stroke();
    circ(g, 8, 0, 3.4, "rgba(255,235,150,0.35)");   // lamp glow
    circ(g, 7.6, 0, 1.7, "#fff2a0");
  }
  function paintCart(g, color) {
    g.strokeStyle = "#8a8f9c"; g.lineWidth = 1.4;   // rails
    g.beginPath(); g.moveTo(-15, -7); g.lineTo(15, -7); g.moveTo(-15, 7); g.lineTo(15, 7); g.stroke();
    for (const [x, y] of [[-7, -7.5], [7, -7.5], [-7, 7.5], [7, 7.5]]) { circ(g, x, y, 2.6, "#2a2630"); circ(g, x, y, 1, "#aab0bc"); }
    g.fillStyle = color; g.fillRect(-11, -6.5, 22, 13);
    g.fillStyle = "#3a2c20"; g.fillRect(-9, -4.5, 18, 9);
    circ(g, -4, -1, 2.6, "#8a6a52"); circ(g, 1, 1.5, 2.8, "#e08a50"); circ(g, 5, -1.5, 2.2, "#a8aeb8"); circ(g, -1, 2.8, 1.8, "#c8693a");
    g.strokeStyle = "rgba(0,0,0,0.5)"; g.lineWidth = 1; g.strokeRect(-11, -6.5, 22, 13);
    g.fillStyle = "rgba(255,255,255,0.35)"; g.fillRect(-10, -6, 20, 1.6);
  }
  function shipSprite(ship) {
    const color = shipColor(ship), id = themeId(), type = ship.type;
    return cached("ship|" + id + "|" + type + "|" + color, 40, 40, 1, g => {
      if (id === "hamster") paintHamster(g, type === "hauler", color);
      else if (type === "hauler") paintCart(g, color);
      else paintDwarf(g, color);
    });
  }

  // Warship and alien raider: code-drawn, one cached sprite each (nose along +x), the same in every theme.
  function warSprite() {
    return cached("war|" + WAR_COLOR, 40, 40, 1, g => {
      g.beginPath();
      g.moveTo(14, 0); g.lineTo(-1, -5); g.lineTo(-10, -11); g.lineTo(-6, -2.6); g.lineTo(-9, 0);
      g.lineTo(-6, 2.6); g.lineTo(-10, 11); g.lineTo(-1, 5); g.closePath();
      g.fillStyle = WAR_COLOR; g.fill();
      g.lineJoin = "round"; g.strokeStyle = "rgba(8,10,28,0.9)"; g.lineWidth = 2.6; g.stroke();
      g.strokeStyle = "rgba(255,255,255,0.8)"; g.lineWidth = 0.9; g.stroke();
      g.fillStyle = "#ffb36b";   // twin guns
      g.fillRect(2, -7.4, 10, 1.8); g.fillRect(2, 5.6, 10, 1.8);
      g.fillStyle = "#3a4a9a"; g.fillRect(-4, -1.2, 9, 2.4);   // spine
      circ(g, 4, 0, 2.2, "#ff6a4a");
    });
  }
  function alienSprite() {
    return cached("alien", 40, 40, 1, g => {
      g.fillStyle = "#b02a6a";
      for (const s of [-1, 1]) { g.beginPath(); g.moveTo(-2, s * 5); g.lineTo(-13, s * 12); g.lineTo(-8, s * 3); g.closePath(); g.fill(); }
      ell(g, 0, 0, 12, 7.5, 0, "#4a1038");
      g.lineWidth = 1.6; g.strokeStyle = "#ff5fa8"; g.beginPath(); g.ellipse(0, 0, 12, 7.5, 0, 0, Math.PI * 2); g.stroke();
      ell(g, 3, 0, 5.5, 4, 0, "#ffc4e2");
      circ(g, 4, 0, 2.3, "#ff3030");
      circ(g, -6, 0, 1.6, "#ff9ad0");
    });
  }

  // Base sprites. Hamster: a static stand (and a little house at home) plus a wheel that turns. Dwarven: one
  // stone forge / great hall with its hearth glow. Tiers differ by shape, not just brightness.
  const BASE_BOX = 130;
  function shade(hex, f) {   // "#rrggbb" darkened (f<1) or lightened (f>1)
    const n = parseInt(hex.slice(1), 16);
    const c = v => Math.max(0, Math.min(255, Math.round(v * f)));
    return "rgb(" + c((n >> 16) & 255) + "," + c((n >> 8) & 255) + "," + c(n & 255) + ")";
  }
  function wheelRadius(home) { return G.BASE_R * (home ? 1.2 : 0.95); }
  function wheelSprite(color, tier, home) {
    const r = wheelRadius(home);
    return cached("wheel|" + color + "|" + tier + "|" + home, r * 2 + 12, r * 2 + 12, 1, g => {
      const spokes = 6 + tier * 2;
      g.strokeStyle = tier >= 2 ? "#ffd84a" : "#c8ccd6"; g.lineWidth = 3;
      g.beginPath(); g.arc(0, 0, r, 0, Math.PI * 2); g.stroke();
      if (tier >= 1) { g.lineWidth = 1.6; g.beginPath(); g.arc(0, 0, r * 0.62, 0, Math.PI * 2); g.stroke(); }
      g.strokeStyle = "#aeb4c0"; g.lineWidth = 1.4;
      g.beginPath();
      for (let k = 0; k < spokes; k++) { const a = (k / spokes) * Math.PI * 2; g.moveTo(0, 0); g.lineTo(Math.cos(a) * r, Math.sin(a) * r); }
      g.stroke();
      circ(g, 0, 0, 4.2, color);
      g.strokeStyle = "rgba(0,0,0,0.5)"; g.lineWidth = 1; g.beginPath(); g.arc(0, 0, 4.2, 0, Math.PI * 2); g.stroke();
    });
  }
  function standSprite(color, tier, home) {
    const r = wheelRadius(home);
    return cached("stand|" + color + "|" + tier + "|" + home, BASE_BOX, BASE_BOX, 1, g => {
      const halo = g.createRadialGradient(0, 0, r * 0.4, 0, 0, BASE_BOX / 2);
      halo.addColorStop(0, hexA(color, 0.3 + tier * 0.08)); halo.addColorStop(1, hexA(color, 0));
      g.fillStyle = halo; g.fillRect(-BASE_BOX / 2, -BASE_BOX / 2, BASE_BOX, BASE_BOX);
      ell(g, 0, r + 4, r * 1.05, 6, 0, "rgba(40,20,5,0.3)");
      g.strokeStyle = shade(color, 0.7); g.lineWidth = 4; g.lineCap = "round";
      g.beginPath(); g.moveTo(0, 0); g.lineTo(-r * 0.8, r + 4); g.moveTo(0, 0); g.lineTo(r * 0.8, r + 4); g.moveTo(-r * 0.9, r + 4); g.lineTo(r * 0.9, r + 4); g.stroke();
      g.lineCap = "butt";
      if (home) {   // a little house beside the wheel
        const hx = r * 1.15, hy = r * 0.35;
        g.fillStyle = "#f3e2c0"; g.fillRect(hx - 11, hy - 4, 22, 17);
        g.fillStyle = color; g.beginPath(); g.moveTo(hx - 14, hy - 3); g.lineTo(hx, hy - 15); g.lineTo(hx + 14, hy - 3); g.closePath(); g.fill();
        g.fillStyle = "#6b4a2e"; g.fillRect(hx - 3, hy + 4, 6, 9);
        g.strokeStyle = "rgba(0,0,0,0.4)"; g.lineWidth = 1; g.strokeRect(hx - 11, hy - 4, 22, 17);
      }
      if (tier >= 2) {   // sparkling ring of seeds
        g.fillStyle = "#fff0b0";
        for (let k = 0; k < 8; k++) { const a = (k / 8) * Math.PI * 2; g.beginPath(); g.arc(Math.cos(a) * (r + 12), Math.sin(a) * (r + 12), 2, 0, Math.PI * 2); g.fill(); }
      }
    });
  }
  function forgeSprite(color, tier, home) {
    return cached("forge|" + color + "|" + tier + "|" + home, BASE_BOX, BASE_BOX, 1, g => {
      const halo = g.createRadialGradient(0, 4, 8, 0, 4, BASE_BOX / 2);
      halo.addColorStop(0, "rgba(255,140,50," + (0.3 + tier * 0.08) + ")"); halo.addColorStop(1, "rgba(255,140,50,0)");
      g.fillStyle = halo; g.fillRect(-BASE_BOX / 2, -BASE_BOX / 2, BASE_BOX, BASE_BOX);
      const w = home ? 66 : 50, top = -12, bot = 18;
      ell(g, 0, bot + 2, w / 2 + 6, 5, 0, "rgba(0,0,0,0.35)");
      g.fillStyle = "#5b5a62"; g.fillRect(-w / 2, top, w, bot - top);   // stone wall with block lines
      g.strokeStyle = "rgba(20,18,26,0.55)"; g.lineWidth = 1; g.beginPath();
      for (let y = top + 7, row = 0; y < bot; y += 7, row++) {
        g.moveTo(-w / 2, y); g.lineTo(w / 2, y);
        for (let x = -w / 2 + (row % 2 ? 6 : 12); x < w / 2; x += 12) { g.moveTo(x, y - 7); g.lineTo(x, y); }
      }
      g.stroke();
      g.fillStyle = shade(color, 0.55);   // slate roof in the accent colour
      g.beginPath(); g.moveTo(-w / 2 - 4, top); g.lineTo(w / 2 + 4, top); g.lineTo(w / 2 - 6, top - 12); g.lineTo(-w / 2 + 6, top - 12); g.closePath(); g.fill();
      g.strokeStyle = color; g.lineWidth = 1.6; g.stroke();
      if (home) {   // great hall: pillars, pediment, banner
        g.fillStyle = "#8c8a94"; g.fillRect(-w / 2, top, 6, bot - top); g.fillRect(w / 2 - 6, top, 6, bot - top);
        g.fillStyle = color; g.beginPath(); g.moveTo(-14, top - 12); g.lineTo(14, top - 12); g.lineTo(0, top - 25); g.closePath(); g.fill();
        g.fillRect(-w / 2 + 10, top + 1, 6, 16); g.fillRect(w / 2 - 16, top + 1, 6, 16);
      }
      const aw = home ? 11 : 9;   // arch with the hearth glowing in it
      g.beginPath(); g.moveTo(-aw, bot); g.lineTo(-aw, 0); g.arc(0, 0, aw, Math.PI, 0); g.lineTo(aw, bot); g.closePath();
      const hg = g.createRadialGradient(0, 10, 1, 0, 8, aw * 1.6);
      hg.addColorStop(0, "#fff0a0"); hg.addColorStop(0.4, "#ff9a2a"); hg.addColorStop(1, "#3a1608");
      g.fillStyle = hg; g.fill();
      g.strokeStyle = "#cbc8d2"; g.lineWidth = 2; g.stroke();
      g.fillStyle = "#4a4a54"; g.fillRect(w / 2 - 8 - (home ? 6 : 0), top - 22, 8, 12);   // chimney
      g.fillStyle = "#2a2630";   // anvil by the door
      const ax = w / 2 + 8;
      g.fillRect(ax - 7, bot - 9, 14, 4); g.fillRect(ax - 3, bot - 5, 6, 5); g.fillRect(ax - 9, bot - 7, 4, 2);
      if (tier >= 1) {   // second chimney and wall torches
        g.fillStyle = "#4a4a54"; g.fillRect(-w / 2 + 2, top - 20, 8, 10);
        for (const sx of [-1, 1]) {
          g.fillStyle = "#3a2a1c"; g.fillRect(sx * (aw + 8) - 1.5, 2, 3, 9);
          circ(g, sx * (aw + 8), 0, 3.2, "#ff9a2a"); circ(g, sx * (aw + 8), 0, 1.5, "#ffe28a");
        }
      }
      if (tier >= 2) {   // gold trim and gems above the door
        g.strokeStyle = "#ffd84a"; g.lineWidth = 2;
        g.beginPath(); g.moveTo(-w / 2 - 4, top); g.lineTo(w / 2 + 4, top); g.stroke();
        for (let k = -2; k <= 2; k++) circ(g, k * 7, top - 5, 2.4, k % 2 ? "#6fe0f0" : "#e27be0");
      }
    });
  }

  // Body sprites: the same radius as the body, glow-free, so the "amount left" ring still reads around them.
  function bodySprite(b) {
    const id = themeId(), kind = BODY_HUE[b.kind] ? b.kind : "asteroid", r = Math.round(b.r), box = r * 2.8;
    return cached("body|" + id + "|" + kind + "|" + r, box, box, view.sc, g => {
      const rnd = G.rng(r * 131 + kind.length * 17 + (id === "hamster" ? 1 : 2));
      if (id === "hamster") {
        if (kind === "asteroid") {   // seed pile
          ell(g, 1, 2, r * 1.05, r * 0.95, 0, "rgba(40,20,5,0.3)");
          blobPath(g, r, rnd, 11); g.fillStyle = "#7a5836"; g.fill();
          const cols = ["#f0dca0", "#d9b36a", "#8b6a3a", "#f5ecd0"];
          for (let i = 0; i < Math.round(r * 2.4); i++) {
            const a = rnd() * Math.PI * 2, d = r * 0.88 * Math.sqrt(rnd());
            ell(g, Math.cos(a) * d, Math.sin(a) * d, r * 0.2, r * 0.1, rnd() * 3, cols[(rnd() * 4) | 0]);
          }
        } else if (kind === "moon") {   // nut stash
          ell(g, 1, 2, r * 1.05, r * 0.95, 0, "rgba(40,20,5,0.3)");
          for (let i = 0; i < 7; i++) {
            const a = i * 0.9 + 0.3, d = i ? r * 0.55 : 0;
            circ(g, Math.cos(a) * d, Math.sin(a) * d, r * 0.42, "#9a6a3a");
            ell(g, Math.cos(a) * d - r * 0.1, Math.sin(a) * d - r * 0.12, r * 0.2, r * 0.12, -0.6, "#c8975a");
          }
        } else if (kind === "iceplanet") {   // nut bowl
          circ(g, 1, 2, r * 1.05, "rgba(40,20,5,0.3)");
          circ(g, 0, 0, r, "#4f8fb0"); circ(g, 0, 0, r * 0.84, "#2c5870");
          for (let i = 0; i < 16; i++) {
            const a = rnd() * Math.PI * 2, d = r * 0.62 * Math.sqrt(rnd());
            circ(g, Math.cos(a) * d, Math.sin(a) * d, r * 0.2, "#a8743c");
            ell(g, Math.cos(a) * d - r * 0.05, Math.sin(a) * d - r * 0.06, r * 0.09, r * 0.06, -0.6, "#d6a468");
          }
        } else {   // carrot patch
          blobPath(g, r, rnd, 12); g.fillStyle = "#6b4a2e"; g.fill();
          for (let i = 0; i < 6; i++) {
            const a = (i / 6) * Math.PI * 2 + 0.3, x = Math.cos(a) * r * 0.5, y = Math.sin(a) * r * 0.5;
            for (let k = 0; k < 4; k++) ell(g, x + Math.cos(a + k * 1.6) * r * 0.16, y + Math.sin(a + k * 1.6) * r * 0.16, r * 0.2, r * 0.07, a + k * 1.6, "#4caf50");
            circ(g, x, y, r * 0.13, "#ff8a2a");
          }
          circ(g, 0, 0, r * 0.14, "#ff8a2a");
        }
        return;
      }
      // dwarven
      circ(g, 1, 2, r * 1.05, "rgba(0,0,0,0.35)");
      if (kind === "rare") {   // gem geode
        blobPath(g, r, rnd, 10); g.fillStyle = "#5a5560"; g.fill();
        circ(g, 0, 0, r * 0.68, "#2a1a4a");
        const cols = ["#e27be0", "#b45be0", "#f4b0f0"];
        for (let i = 0; i < 8; i++) {
          const a = (i / 8) * Math.PI * 2 + 0.2;
          g.fillStyle = cols[i % 3]; g.beginPath();
          g.moveTo(Math.cos(a - 0.2) * r * 0.2, Math.sin(a - 0.2) * r * 0.2); g.lineTo(Math.cos(a) * r * 0.66, Math.sin(a) * r * 0.66); g.lineTo(Math.cos(a + 0.2) * r * 0.2, Math.sin(a + 0.2) * r * 0.2);
          g.closePath(); g.fill();
        }
        circ(g, 0, 0, r * 0.16, "#fff0ff");
        return;
      }
      blobPath(g, r, rnd, 11);
      g.fillStyle = kind === "asteroid" ? "#4a4650" : "#3d4048"; g.fill();
      g.strokeStyle = "#8a7e74"; g.lineWidth = 1.4; g.stroke();   // pale rim so the rock reads against the dark cavern
      ell(g, -r * 0.3, -r * 0.35, r * 0.4, r * 0.25, -0.6, "rgba(255,255,255,0.08)");
      const seam = kind === "asteroid" ? "#d8793a" : "#d6dde8", lines = kind === "iceplanet" ? 3 : kind === "moon" ? 1 : 2;
      g.strokeStyle = seam; g.lineWidth = Math.max(1.5, r * (kind === "moon" ? 0.2 : 0.12)); g.lineCap = "round"; g.lineJoin = "round";
      for (let i = 0; i < lines; i++) {
        const o = (i - (lines - 1) / 2) * r * 0.5;
        g.beginPath(); g.moveTo(-r * 0.7, -r * 0.35 + o); g.lineTo(-r * 0.2, -r * 0.05 + o * 0.8); g.lineTo(r * 0.15, -r * 0.2 + o); g.lineTo(r * 0.7, r * 0.3 + o * 0.7); g.stroke();
      }
      g.lineCap = "butt"; g.lineJoin = "miter";
      if (kind !== "asteroid") {   // glints
        g.fillStyle = "#ffffff";
        for (let i = 0; i < 3; i++) { const x = (rnd() - 0.5) * r, y = (rnd() - 0.5) * r; g.fillRect(x - 2, y - 0.5, 4, 1); g.fillRect(x - 0.5, y - 2, 1, 4); }
      }
    });
  }

  // ---------------------------------------------------------------- drawing

  function hexA(hex, a) {
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${Math.max(0, Math.min(1, a))})`;
  }

  function drawSky(dt) {
    ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
    ctx.drawImage(nebula, 0, 0, view.W, view.H);
    if (scene) scene.draw(dt);
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

  // Canvas text. In themed scenes it gets a dark outline so it reads on the light-ish bedding and the rock.
  function labelText(t, x, y) {
    if (themed()) {
      ctx.lineJoin = "round"; ctx.lineWidth = 3.5; ctx.strokeStyle = "rgba(18,9,3,0.9)";
      ctx.strokeText(t, x, y);
      ctx.lineJoin = "miter";
    }
    ctx.fillText(t, x, y);
  }

  // Keyboard mode: the number to type for a target, in a small badge. Text only; the label strings are made once.
  const NUM_LABEL = [];
  function drawNum(n, x, y) {
    ctx.fillStyle = "rgba(10,11,29,0.85)";
    ctx.beginPath(); ctx.arc(x, y, 9, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = "#8fd8ff"; ctx.lineWidth = 1.2; ctx.stroke();
    ctx.textAlign = "center"; ctx.font = "700 11px system-ui, sans-serif"; ctx.fillStyle = "#e6f4ff";
    ctx.fillText(NUM_LABEL[n] || (NUM_LABEL[n] = G.targetLabel(n)), x, y + 4);
  }

  function drawBody(b) {
    const [light, base, dark] = BODY_HUE[b.kind] || BODY_HUE.asteroid;
    const frac = b.max > 0 ? b.amount / b.max : 0;
    const empty = b.amount <= 1e-6;
    ctx.globalAlpha = empty ? 0.35 : 1;
    if (themed()) {   // one cached sprite instead of the gradients below
      const bs = bodySprite(b), half = Math.round(b.r) * 1.4;
      ctx.drawImage(bs, b.x - half, b.y - half, half * 2, half * 2);
    } else {
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
    }
    // remaining-amount ring, like the progress ring on mission planets
    const ringR = b.r + 6;
    if (themed()) {   // dark backing under the ring
      ctx.lineWidth = 6; ctx.strokeStyle = "rgba(18,9,3,0.7)";
      ctx.beginPath(); ctx.arc(b.x, b.y, ringR, 0, Math.PI * 2); ctx.stroke();
    }
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = themed() ? "rgba(255,255,255,0.22)" : "rgba(255,255,255,0.12)";
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
    labelText(G.bodyLabel ? G.bodyLabel(b, LB()) : b.name, b.x, b.y + ringR + 15);
    ctx.font = "10px system-ui, sans-serif";
    ctx.fillStyle = empty ? "rgba(200,210,240,0.5)" : hexA(RES_COLOR[b.res], 0.9);
    labelText(empty ? "EMPTY" : `${Math.floor(b.amount)} ${(LB().res[b.res] || b.res).toUpperCase()}`, b.x, b.y + ringR + 28);
    if (ui.keyboard && !empty) drawNum(b.id + 1, b.x, b.y - ringR - 10);
  }

  // Upgraded bases are visibly different: a solid outer ring at Lv 2, plus a counter-turning second ring
  // with bright nodes and a brighter core at Lv 3.
  function drawBaseThemed(b, i) {
    const color = i === 0 ? looks.base.home : looks.base.main, tier = b.tier | 0, home = i === 0, half = BASE_BOX / 2;
    if (themeId() === "hamster") {
      ctx.drawImage(standSprite(color, tier, home), b.x - half, b.y - half, BASE_BOX, BASE_BOX);
      const ws = wheelSprite(color, tier, home), wh = ws.width / view.dpr / 1;   // CSS size
      ctx.save(); ctx.translate(b.x, b.y); ctx.rotate(baseSpin[i] || 0);
      ctx.drawImage(ws, -wh / 2, -wh / 2, wh, wh);
      ctx.restore();
    } else {
      ctx.drawImage(forgeSprite(color, tier, home), b.x - half, b.y - half, BASE_BOX, BASE_BOX);
      const f = reduceMotion ? 0.7 : 0.6 + 0.2 * Math.sin(time * 8 + i * 2) + 0.12 * Math.sin(time * 19 + i);
      ctx.fillStyle = "rgba(255,170,60," + (0.12 + 0.2 * f) + ")";   // hearth flicker
      ctx.beginPath(); ctx.arc(b.x, b.y + 8, 11 + tier * 2, 0, Math.PI * 2); ctx.fill();
    }
    const L = LB();
    ctx.textAlign = "center";
    ctx.font = "700 11px system-ui, sans-serif";
    ctx.fillStyle = "rgba(245,238,225,0.95)";
    // just under the sprite: the wheel's stand (and seed ring at Lv 3), or the forge's foundation
    const dy = themeId() === "hamster" ? wheelRadius(home) + (tier >= 2 ? 14 : 10) + 13 : 40;
    labelText((i === 0 ? L.home : L.baseTitle + " " + (i + 1)).toUpperCase() + (tier ? " " + TIER_NAME[tier] : ""), b.x, b.y + dy);
  }

  const baseSpin = [];   // wheel angle per base; turns only while a ship is unloading there
  function updateSpin(dt) {
    if (reduceMotion || !dt || themeId() !== "hamster") return;
    const on = new Set();
    for (const s of game.ships) {
      if (s.st !== G.UNLOADING) continue;
      let best = -1, bd = Infinity;
      for (let i = 0; i < game.bases.length; i++) {
        const d = Math.hypot(game.bases[i].x - s.x, game.bases[i].y - s.y);
        if (d < bd) { bd = d; best = i; }
      }
      if (best >= 0) on.add(best);
    }
    for (const i of on) baseSpin[i] = ((baseSpin[i] || 0) + dt * 1.4) % (Math.PI * 2);
  }

  function drawBaseBody(b, i) {
    if (themed()) return drawBaseThemed(b, i);
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

  // A small health bar centred at (x, y): only called for damaged things.
  function drawBar(x, y, w, frac) {
    frac = Math.max(0, Math.min(1, frac));
    ctx.fillStyle = "rgba(8,10,28,0.8)"; ctx.fillRect(x - w / 2 - 1, y - 1, w + 2, 5);
    ctx.fillStyle = frac > 0.5 ? "#5fd08a" : frac > 0.25 ? "#f0c040" : "#ee5b5b";
    ctx.fillRect(x - w / 2, y, w * frac, 3);
  }

  // A base with its add-ons: a down base is greyed with a label; a shield shows its range as a faint ring;
  // a turret is a small gun on the rim (aimed at the nearest alien in range); health bar only when hurt.
  function drawBase(b, i) {
    const T = G.TUNING, sr = G.BASE_R;
    ctx.globalAlpha = b.down ? 0.3 : 1;
    drawBaseBody(b, i);
    ctx.globalAlpha = 1;
    if (b.shield && !b.down) {
      const R = T.addons.shield.range;
      ctx.fillStyle = "rgba(90,200,255,0.045)";
      ctx.beginPath(); ctx.arc(b.x, b.y, R, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = "rgba(120,215,255,0.32)"; ctx.lineWidth = 1.5; ctx.setLineDash([10, 8]);
      ctx.beginPath(); ctx.arc(b.x, b.y, R, 0, Math.PI * 2); ctx.stroke();
      ctx.setLineDash([]);
    }
    if (b.turret && !b.down) {
      const tx = b.x + sr * 1.15, ty = b.y - sr * 1.15, a = game.aliens.length ? G.nearestAlien(game, tx, ty) : -1;
      let ax = 0.7071, ay = -0.7071;   // resting aim: up and right
      if (a >= 0) {
        const al = game.aliens.find(o => o.id === a), dx = al.x - tx, dy = al.y - ty, d = Math.hypot(dx, dy);
        if (d > 1e-6 && d <= T.addons.turret.range) { ax = dx / d; ay = dy / d; }
      }
      circ(ctx, tx, ty, 6.5, "#1a1d44");
      ctx.strokeStyle = "#ffb36b"; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(tx, ty, 6.5, 0, Math.PI * 2); ctx.stroke();
      ctx.lineWidth = 3; ctx.lineCap = "round";
      ctx.beginPath(); ctx.moveTo(tx, ty); ctx.lineTo(tx + ax * 13, ty + ay * 13); ctx.stroke();
      ctx.lineCap = "butt";
    }
    if (b.down) {
      ctx.textAlign = "center"; ctx.font = "700 12px system-ui, sans-serif"; ctx.fillStyle = "#ff8a8a";
      labelText("DOWN - repair it", b.x, b.y + 5);
    }
    if (b.hp < b.maxHp) drawBar(b.x, b.y - sr * 1.7 - 8, 54, b.hp / b.maxHp);
  }

  // A five-point collectible star with a soft pulse.
  function drawStar(s) {
    const pulse = reduceMotion ? 0.5 : 0.5 + 0.5 * Math.sin(time * 3 + s.id * 1.7);
    const R = 11 + pulse * 1.5;
    const glow = ctx.createRadialGradient(s.x, s.y, 2, s.x, s.y, R * 3);
    glow.addColorStop(0, "rgba(255,226,110," + (0.35 + pulse * 0.2) + ")"); glow.addColorStop(1, "rgba(255,226,110,0)");
    ctx.fillStyle = glow;
    ctx.beginPath(); ctx.arc(s.x, s.y, R * 3, 0, Math.PI * 2); ctx.fill();
    if (themed()) { ctx.fillStyle = "rgba(18,9,3,0.5)"; ctx.beginPath(); ctx.arc(s.x, s.y, R * 1.45, 0, Math.PI * 2); ctx.fill(); }   // dark halo
    ctx.beginPath();
    for (let k = 0; k < 10; k++) {
      const a = -Math.PI / 2 + k * Math.PI / 5, rr = k % 2 ? R * 0.45 : R;
      ctx[k ? "lineTo" : "moveTo"](s.x + Math.cos(a) * rr, s.y + Math.sin(a) * rr);
    }
    ctx.closePath();
    if (themed()) { ctx.lineJoin = "round"; ctx.lineWidth = 4.5; ctx.strokeStyle = "#1c0e04"; ctx.stroke(); ctx.lineJoin = "miter"; }
    ctx.fillStyle = "#ffd84a"; ctx.fill();
    ctx.strokeStyle = "#fff6c4"; ctx.lineWidth = 1.2; ctx.stroke();
    if (ui.selected != null) {
      ctx.strokeStyle = "rgba(255,226,110," + (0.25 + 0.3 * pulse) + ")"; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(s.x, s.y, R + 7 + pulse * 3, 0, Math.PI * 2); ctx.stroke();
    }
    if (ui.keyboard) drawNum(game.bodies.length + s.id + 1, s.x, s.y - R - 12);
  }

  // Ion storms: a drifting blue-violet cloud with a few turning arcs.
  function drawStorm(s, i) {
    const tid = themeId(), L = LB();
    if (tid !== "space") {   // sticky bedding patch / flooded tunnel: flat fills, same area, same arcs
      const ham = tid === "hamster";
      ctx.fillStyle = ham ? "rgba(214,170,96,0.3)" : "rgba(60,140,200,0.28)";
      ctx.beginPath(); ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = ham ? "rgba(255,225,160,0.5)" : "rgba(150,215,255,0.5)"; ctx.lineWidth = 2; ctx.setLineDash([6, 5]);
      ctx.beginPath(); ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2); ctx.stroke();
      ctx.setLineDash([]);
      ctx.lineWidth = 1.5;
      const a0 = reduceMotion ? i : time * 0.6 + i * 2;
      for (let k = 0; k < 3; k++) {
        const a = a0 + k * 2.09;
        ctx.beginPath(); ctx.arc(s.x, s.y, s.r * (0.45 + 0.18 * k), a, a + 1.1); ctx.stroke();
      }
      ctx.textAlign = "center"; ctx.font = "600 10px system-ui, sans-serif";
      ctx.fillStyle = ham ? "rgba(255,238,200,0.9)" : "rgba(200,235,255,0.9)";
      ctx.fillText(L.storm.toUpperCase(), s.x, s.y + 4);
      return;
    }
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
    const W = G.TUNING.showers, warn = typeof s.warn === "number" ? s.warn : W.warn, live = s.age >= warn;
    if (!live) {
      const k = 0.5 + 0.5 * Math.sin(time * 8);
      ctx.save();
      ctx.strokeStyle = "rgba(255,170,90," + (0.35 + 0.4 * k) + ")"; ctx.lineWidth = 2; ctx.setLineDash([8, 6]);
      ctx.beginPath(); ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2); ctx.stroke();
      ctx.restore();
      ctx.textAlign = "center"; ctx.font = "700 11px system-ui, sans-serif"; ctx.fillStyle = "rgba(255,190,120,0.95)";
      ctx.fillText(themed() ? LB().shower.toUpperCase() + " IN " + Math.ceil(warn - s.age) : "METEORS IN " + Math.ceil(warn - s.age), s.x, s.y + 4);
      return;
    }
    if (themed()) {   // paw swipes / falling rocks inside the same circle
      const ham = themeId() === "hamster";
      ctx.fillStyle = ham ? "rgba(255,170,120,0.08)" : "rgba(160,140,120,0.1)";
      ctx.beginPath(); ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = ham ? "rgba(255,190,140,0.45)" : "rgba(200,180,150,0.45)"; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2); ctx.stroke();
      for (let k = 0; k < (ham ? 5 : 14); k++) {
        const ph = (time * (ham ? 0.7 : 0.8) + k * (ham ? 0.21 : 0.173)) % 1;
        const ox = Math.sin(k * 12.9898) * s.r * 0.7, oy = Math.cos(k * 78.233) * s.r * 0.7;
        if (ham) {   // a big paw pad with four toes, swiping across and fading
          const x = s.x + ox + (ph - 0.5) * 50, y = s.y + oy + (ph - 0.5) * 20, a = Math.sin(ph * Math.PI);
          ctx.fillStyle = "rgba(240,190,160," + 0.85 * a + ")";
          ctx.beginPath(); ctx.arc(x, y, 7, 0, Math.PI * 2); ctx.fill();
          for (let t = 0; t < 4; t++) { ctx.beginPath(); ctx.arc(x - 8 + t * 5.3, y - (t === 1 || t === 2 ? 12 : 9), 3, 0, Math.PI * 2); ctx.fill(); }
        } else {   // a chunk of rock dropping
          const x = s.x + ox, y = s.y + oy + (ph - 0.5) * 70, a = Math.sin(ph * Math.PI);
          ctx.fillStyle = "rgba(" + (110 + (k % 3) * 25) + ",100,95," + 0.95 * a + ")";
          ctx.fillRect(x - 3, y - 3, 6 + (k % 3) * 2, 6 + (k % 2) * 3);
        }
      }
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

  // One trail point per ship per simulation step, so a trail is the same length (about a second of flight)
  // whatever the frame rate. A ship that stops lets its trail drain away.
  const TRAIL_POINTS = 30;
  function addTrailPoints() {
    for (const s of game.ships) {
      let tr = trails.get(s.id);
      if (!tr) trails.set(s.id, tr = []);
      const moving = !s.dead && (s.st === G.TO_BODY || s.st === G.TO_BASE || s.st === G.TO_STAR || (s.st === G.MANUAL && s.mv === 1) || (isWar(s) && s.mv === 1));
      if (moving) tr.push([s.x, s.y]);
      if (tr.length > TRAIL_POINTS || (!moving && tr.length)) tr.shift();
    }
  }

  // Engine trail, in the style picked in the hangar.
  function drawTrail(ship, color) {
    const t = trails.get(ship.id);
    if (!t || t.length < 2) return;
    const style = looks.trail.id;
    if (style === "spark") {
      for (let i = 0; i < t.length; i++) {
        const a = (i + 1) / t.length;
        ctx.fillStyle = hexA(color, 0.25 + a * 0.7);
        ctx.beginPath(); ctx.arc(t[i][0], t[i][1] + Math.sin(i * 2.1 + ship.id) * 2.5, 1.2 + a * 2.6, 0, Math.PI * 2); ctx.fill();
      }
      return;
    }
    if (style === "ribbon") {
      ctx.lineCap = "round"; ctx.lineJoin = "round";
      ctx.beginPath(); ctx.moveTo(t[0][0], t[0][1]);
      for (let i = 1; i < t.length; i++) ctx.lineTo(t[i][0], t[i][1]);
      ctx.strokeStyle = hexA(color, 0.22); ctx.lineWidth = 9; ctx.stroke();
      ctx.strokeStyle = hexA(color, 0.6); ctx.lineWidth = 3.5; ctx.stroke();
      ctx.lineCap = "butt"; ctx.lineJoin = "miter";
      return;
    }
    ctx.lineCap = "round";
    for (let i = 1; i < t.length; i++) {
      const a = i / t.length;
      ctx.strokeStyle = hexA(color, 0.1 + a * 0.7); ctx.lineWidth = 1.5 + a * 2.5;
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
    const moving = ship.st === G.TO_BODY || ship.st === G.TO_BASE || ship.st === G.TO_STAR || (ship.st === G.MANUAL && ship.mv === 1);
    const mining = ship.st === G.MINING || (ship.st === G.MANUAL && ship.mm === 1);
    const k = ship.type === "hauler" ? 1.3 : 1;
    const spec = G.SHIP_TYPES[ship.type], war = !!spec.war;
    ctx.save();
    ctx.translate(ship.x, ship.y);
    ctx.rotate(ship.ang);
    ctx.scale(k, k);
    if (war) {   // warship: one cached sprite, with a plain two-tone flame while it moves
      if (ship.mv === 1) {
        const len = 9 + (reduceMotion ? 0 : Math.random() * 4);
        ctx.fillStyle = "rgba(255,170,90,0.9)";
        ctx.beginPath(); ctx.moveTo(-9, -3); ctx.lineTo(-9 - len, 0); ctx.lineTo(-9, 3); ctx.closePath(); ctx.fill();
        ctx.fillStyle = "rgba(255,255,255,0.9)";
        ctx.beginPath(); ctx.moveTo(-9, -1.4); ctx.lineTo(-9 - len * 0.5, 0); ctx.lineTo(-9, 1.4); ctx.closePath(); ctx.fill();
      }
      ctx.globalAlpha = ship.stun > 0 ? 0.6 : 1;
      ctx.drawImage(warSprite(), -20, -20, 40, 40);
      ctx.globalAlpha = 1;
    } else if (themed()) {   // one cached sprite; idle ships are dimmed like the space hull
      ctx.globalAlpha = busy ? 1 : 0.85;
      ctx.drawImage(shipSprite(ship), -20, -20, 40, 40);
      ctx.globalAlpha = 1;
    } else {
    if (moving || mining) {
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
    }
    ctx.restore();
    if (busy && !war) {   // status ring: cargo load, in the colour of what's aboard
      const rr = 15 * k;
      if (themed()) { ctx.lineWidth = 5; ctx.strokeStyle = "rgba(18,9,3,0.6)"; ctx.beginPath(); ctx.arc(ship.x, ship.y, rr, 0, Math.PI * 2); ctx.stroke(); }
      ctx.lineWidth = 2;
      ctx.strokeStyle = themed() ? "rgba(255,255,255,0.25)" : "rgba(255,255,255,0.14)";
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
    if (ship.st === G.MANUAL) {   // flown by hand: a gold ring
      ctx.strokeStyle = "rgba(255,216,74,0.85)"; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(ship.x, ship.y, 27, 0, Math.PI * 2); ctx.stroke();
    }
    if (ship.stun > 0) {   // held by a solar flare
      ctx.strokeStyle = "rgba(255,214,90," + (reduceMotion ? 0.8 : 0.5 + 0.4 * Math.sin(time * 10 + ship.id)) + ")"; ctx.lineWidth = 2; ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.arc(ship.x, ship.y, 18 * k, 0, Math.PI * 2); ctx.stroke();
      ctx.setLineDash([]);
    }
    if (ship.rep > 0) {   // being repaired
      ctx.strokeStyle = "rgba(110,235,150,0.85)"; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(ship.x, ship.y, 20 * k, 0, Math.PI * 2); ctx.stroke();
    }
    if (ship.hp < ship.maxHp) drawBar(ship.x, ship.y + 17 * k, 24, ship.hp / ship.maxHp);
    if (ship.id === ui.selected) {
      if (war) drawOrders(ship);
      ctx.strokeStyle = "#8fd8ff"; ctx.lineWidth = 1.5; ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.arc(ship.x, ship.y, 22, 0, Math.PI * 2); ctx.stroke();
      ctx.setLineDash([]);
      ctx.textAlign = "left";
      ctx.font = "600 10.5px system-ui, sans-serif";
      ctx.fillStyle = "rgba(240,244,255,0.95)";
      labelText(shipName(ship).toUpperCase(), ship.x + 16, ship.y - 12);
    }
  }

  // ---- hazards and combat. All cheap: cached sprites, a few path ops, and shots/tracers batched into one stroke each.

  // The selected warship's order: a dashed line to its patrol point, the ship it escorts or the alien it hunts.
  function drawOrders(ship) {
    let tx = 0, ty = 0, col = "rgba(143,216,255,0.7)", ring = 0;
    if (ship.wo === "patrol") { tx = ship.wx; ty = ship.wy; ring = 11; }
    else if (ship.wo === "escort") { const t = game.ships[ship.wt]; if (!t || t.dead) return; tx = t.x; ty = t.y; ring = 24; }
    else if (ship.wo === "attack") {
      const nestOrder = typeof G.NEST_ORDER === "number" && ship.wt >= G.NEST_ORDER;
      const a = nestOrder ? G.nestById(game, ship.wt - G.NEST_ORDER) : game.aliens.find(o => o.id === ship.wt);
      if (!a || a.dead) return;
      tx = a.x; ty = a.y; ring = nestOrder ? G.NEST_GEO.nestR + 8 : 18; col = "rgba(255,120,120,0.8)";
    }
    else return;
    ctx.strokeStyle = col; ctx.lineWidth = 1.2; ctx.setLineDash([4, 5]);
    ctx.beginPath(); ctx.moveTo(ship.x, ship.y); ctx.lineTo(tx, ty); ctx.stroke();
    ctx.setLineDash([]);
    ctx.beginPath(); ctx.arc(tx, ty, ring, 0, Math.PI * 2); ctx.stroke();
    if (ship.wo === "patrol") { ctx.beginPath(); ctx.arc(tx, ty, 3, 0, Math.PI * 2); ctx.stroke(); }
  }

  const alienAng = new Map();   // last facing per alien id, for a raider that is standing still
  let alienAngPruned = 0;
  // Drop facings of aliens that are gone (about once a second), so the map cannot grow over a long run.
  function pruneAlienAng() {
    if (alienAng.size === 0 || Math.abs(time - alienAngPruned) < 1) return;
    alienAngPruned = time;
    const live = new Set();
    for (const a of game.aliens) live.add(a.id);
    for (const id of alienAng.keys()) if (!live.has(id)) alienAng.delete(id);
  }
  function drawAlien(a) {
    let dx = a.vx, dy = a.vy;
    const t = a.tgtKind === "ship" ? game.ships[a.tgt] : a.tgtKind === "base" ? game.bases[a.tgt] : null;
    if (t) { dx = t.x - a.x; dy = t.y - a.y; }
    pruneAlienAng();
    let ang = alienAng.get(a.id) || 0;
    if (dx * dx + dy * dy > 0.01) { ang = Math.atan2(dy, dx); alienAng.set(a.id, ang); }
    ctx.save();
    ctx.translate(a.x, a.y); ctx.rotate(ang);
    if (!t && !(a.nest >= 0)) ctx.globalAlpha = 0.6;   // leaving the map (nest guards idle at their nest and stay solid)
    ctx.drawImage(alienSprite(), -20, -20, 40, 40);
    ctx.restore();
    if (a.hp < a.maxHp) drawBar(a.x, a.y - 22, 26, a.hp / a.maxHp);
    if (ui.selected != null && isWar(game.ships[ui.selected]) && game.ships[ui.selected].wo === "attack" && game.ships[ui.selected].wt === a.id) {
      ctx.strokeStyle = "rgba(255,120,120,0.9)"; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(a.x, a.y, 17, 0, Math.PI * 2); ctx.stroke();
    }
  }

  function drawShots() {
    const sh = game.shots;
    if (!sh.length) return;
    ctx.lineCap = "round"; ctx.lineWidth = 2.4;
    for (let pass = 0; pass < 2; pass++) {   // one stroke for ours, one for theirs
      const side = pass ? "them" : "us";
      ctx.strokeStyle = pass ? "#ff7a6a" : "#9fe8ff";
      ctx.beginPath();
      for (let i = 0; i < sh.length; i++) {
        const s = sh[i];
        if (s.side !== side) continue;
        ctx.moveTo(s.x, s.y); ctx.lineTo(s.x - s.vx * 0.035, s.y - s.vy * 0.035);
      }
      ctx.stroke();
    }
    ctx.lineCap = "butt";
  }

  const DIRS8 = [[1, 0], [0.7071, 0.7071], [0, 1], [-0.7071, 0.7071], [-1, 0], [-0.7071, -0.7071], [0, -1], [0.7071, -0.7071]];
  function drawFx() {
    const list = game.fx;
    for (let i = 0; i < list.length; i++) {
      const f = list[i], t = Math.min(1, f.age / (f.life || 0.4)), a = 1 - t;
      if (f.kind === "block") {   // a turret stops a meteor: a tracer, then a spark
        ctx.strokeStyle = "rgba(140,235,255," + a + ")"; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(f.x, f.y); ctx.lineTo(f.x2, f.y2); ctx.stroke();
        ctx.beginPath(); ctx.arc(f.x2, f.y2, 4 + 12 * t, 0, Math.PI * 2); ctx.stroke();
      } else if (f.kind === "kill") {   // an alien died
        ctx.strokeStyle = "rgba(255,170,225," + a + ")"; ctx.lineWidth = 2;
        ctx.beginPath();
        for (const d of DIRS8) { ctx.moveTo(f.x + d[0] * (5 + 8 * t), f.y + d[1] * (5 + 8 * t)); ctx.lineTo(f.x + d[0] * (10 + 24 * t), f.y + d[1] * (10 + 24 * t)); }
        ctx.stroke();
        ctx.beginPath(); ctx.arc(f.x, f.y, 4 + 22 * t, 0, Math.PI * 2); ctx.stroke();
      } else {   // boom: a ship or base was lost
        ctx.fillStyle = "rgba(255,160,64," + 0.55 * a + ")";
        ctx.beginPath(); ctx.arc(f.x, f.y, 6 + 34 * t, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = "rgba(255,240,190," + a + ")"; ctx.lineWidth = 2.5;
        ctx.beginPath(); ctx.arc(f.x, f.y, 4 + 44 * t, 0, Math.PI * 2); ctx.stroke();
      }
    }
  }

  // A fog bank: a soft cloud painted once per radius, opaque enough in the middle to hide what is under it.
  function fogSprite(r) {
    const box = r * 2.5;
    return cached("fog|" + r, box, box, view.sc, g => {
      const grad = g.createRadialGradient(0, 0, r * 0.2, 0, 0, r * 1.05);
      grad.addColorStop(0, "rgba(116,128,160,0.95)"); grad.addColorStop(0.6, "rgba(104,118,152,0.9)"); grad.addColorStop(1, "rgba(96,110,146,0)");
      g.fillStyle = grad; g.beginPath(); g.arc(0, 0, r * 1.05, 0, Math.PI * 2); g.fill();
      const rnd = G.rng(r * 31 + 7);
      for (let i = 0; i < 9; i++) {   // lumpy puffs, so it reads as cloud and not as a disc
        const a = rnd() * Math.PI * 2, d = r * (0.45 + rnd() * 0.45), pr = r * (0.22 + rnd() * 0.18);
        const pg = g.createRadialGradient(Math.cos(a) * d, Math.sin(a) * d, 0, Math.cos(a) * d, Math.sin(a) * d, pr);
        pg.addColorStop(0, "rgba(150,164,198,0.5)"); pg.addColorStop(1, "rgba(150,164,198,0)");
        g.fillStyle = pg; g.beginPath(); g.arc(Math.cos(a) * d, Math.sin(a) * d, pr, 0, Math.PI * 2); g.fill();
      }
    });
  }

  // Live fog banks cover everything under them; a ship inside shows as a small dot so you can still find it.
  function drawFog() {
    const ev = game.events, W = G.TUNING.events.warn;
    let any = false;
    for (let i = 0; i < ev.length; i++) {
      const e = ev[i];
      if (e.kind !== "fog") continue;
      const warn = typeof e.warn === "number" ? e.warn : W;
      if (e.age < warn) continue;
      any = true;
      const left = (typeof e.dur === "number" ? e.dur : 40) - (e.age - warn);
      const r = Math.max(20, Math.round(e.r / 10) * 10), half = r * 1.25;
      ctx.globalAlpha = Math.max(0, Math.min(1, (e.age - warn) / 1.5, left / 1.5));
      ctx.drawImage(fogSprite(r), e.x - half, e.y - half, half * 2, half * 2);
      ctx.globalAlpha = 1;
      ctx.textAlign = "center"; ctx.font = "700 11px system-ui, sans-serif"; ctx.fillStyle = "rgba(230,238,255,0.8)";
      ctx.fillText("FOG: mining slowed", e.x, e.y + 4);
    }
    if (!any) return;
    for (const s of game.ships) {
      if (s.dead || !G.fogAt(game, s.x, s.y)) continue;
      circ(ctx, s.x, s.y, 3, "rgba(220,230,255,0.7)");
      if (s.id === ui.selected) {
        ctx.strokeStyle = "#8fd8ff"; ctx.lineWidth = 1.5; ctx.setLineDash([3, 3]);
        ctx.beginPath(); ctx.arc(s.x, s.y, 12, 0, Math.PI * 2); ctx.stroke();
        ctx.setLineDash([]);
      }
    }
  }

  // Map markers for events still in their warning phase (fog ring, raid arrow at the edge). Showers draw their own ring;
  // a flare is map-wide, so it only gets the banner.
  function drawWarnings() {
    if (!game.events.length) return;
    const list = G.eventWarnings(game), cx = game.w / 2, cy = game.h / 2;
    for (let i = 0; i < list.length; i++) {
      const w = list[i];
      if (w.kind === "fog") {
        ctx.strokeStyle = "rgba(180,195,230," + (reduceMotion ? 0.7 : 0.45 + 0.3 * Math.sin(time * 6)) + ")"; ctx.lineWidth = 2; ctx.setLineDash([8, 6]);
        ctx.beginPath(); ctx.arc(w.x, w.y, w.r, 0, Math.PI * 2); ctx.stroke();
        ctx.setLineDash([]);
        ctx.textAlign = "center"; ctx.font = "700 11px system-ui, sans-serif"; ctx.fillStyle = "rgba(205,215,240,0.95)";
        ctx.fillText("FOG IN " + w.secs, w.x, w.y + 4);
      } else if (w.kind === "raid") {
        const dx = cx - w.x, dy = cy - w.y, d = Math.hypot(dx, dy) || 1, ux = dx / d, uy = dy / d, px = -uy, py = ux;
        const pulse = reduceMotion ? 0.8 : 0.55 + 0.4 * Math.sin(time * 8);
        ctx.strokeStyle = "rgba(255,90,90," + pulse + ")"; ctx.fillStyle = "rgba(255,90,90," + pulse * 0.5 + ")"; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(w.x, w.y, 16, 0, Math.PI * 2); ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(w.x + ux * 50, w.y + uy * 50);
        ctx.lineTo(w.x + ux * 26 + px * 12, w.y + uy * 26 + py * 12);
        ctx.lineTo(w.x + ux * 26 - px * 12, w.y + uy * 26 - py * 12);
        ctx.closePath(); ctx.fill(); ctx.stroke();
        ctx.textAlign = "center"; ctx.font = "700 11px system-ui, sans-serif"; ctx.fillStyle = "rgba(255,170,170,0.95)";
        ctx.fillText("RAID IN " + w.secs, w.x + ux * 72, w.y + uy * 72 + 4);
      }
    }
  }

  // Seconds a flare still has to run (0 when none is live), and the screen tint for it.
  function flareLeft() {
    const ev = game.events, W = G.TUNING.events.warn;
    let left = 0;
    for (let i = 0; i < ev.length; i++) {
      const e = ev[i];
      if (e.kind !== "flare") continue;
      const warn = typeof e.warn === "number" ? e.warn : W;
      if (e.age >= warn) left = Math.max(left, (typeof e.dur === "number" ? e.dur : 10) - (e.age - warn));
    }
    return left;
  }
  function drawFlareTint() {
    if (!game.events.length || !(flareLeft() > 0)) return;
    ctx.fillStyle = "rgba(255,206,90," + (reduceMotion ? 0.12 : 0.10 + 0.06 * Math.sin(time * 5)) + ")";
    ctx.fillRect(0, 0, view.W, view.H);
  }

  function drawGhost() {
    const p = ui.cursor || ui.mouse;
    if (!ui.placing || !p) return;
    const ok = !G.baseSpotProblem(game, p.x, p.y, labelArg());
    ctx.save();
    ctx.strokeStyle = ok ? "#5fd0b0" : "#ee6b6b"; ctx.fillStyle = ok ? "rgba(95,208,176,0.15)" : "rgba(238,107,107,0.15)";
    ctx.lineWidth = 2; ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.arc(p.x, p.y, G.BASE_R * 1.5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.restore();
  }

  // The beacon and the alien nests, in world coordinates (inside frame's transform). owner: slice a
  // Same look in every theme, like the aliens. A nest is a dark pink hive; the beacon is a cyan derelict. A health bar shows
  // only when hurt; pips show the guards (filled alive, hollow waiting), with seconds to the next one back.
  function drawNests() {
    const list = game.nests;
    if (!list || !list.length) return;
    const geo = G.NEST_GEO, sel = chosenShip();
    const target = sel && !sel.dead && sel.wo === "attack" && sel.wt >= G.NEST_ORDER ? sel.wt - G.NEST_ORDER : -1;
    for (const n of list) {
      if (n.dead) continue;
      const beacon = n.kind === "beacon", r = beacon ? geo.beaconR : geo.nestR;
      const pulse = reduceMotion ? 0.5 : 0.5 + 0.5 * Math.sin(time * 2 + n.id);
      ctx.save();
      ctx.translate(n.x, n.y);
      const halo = ctx.createRadialGradient(0, 0, r * 0.5, 0, 0, r * 2.2);
      const hc = beacon ? "95,208,230" : "255,95,168";
      halo.addColorStop(0, "rgba(" + hc + "," + (0.16 + 0.12 * pulse) + ")"); halo.addColorStop(1, "rgba(" + hc + ",0)");
      ctx.fillStyle = halo; ctx.fillRect(-r * 2.2, -r * 2.2, r * 4.4, r * 4.4);
      ctx.lineJoin = "round"; ctx.lineWidth = 2;
      ctx.beginPath();
      if (beacon) { ctx.moveTo(0, -r); ctx.lineTo(r * 0.7, 0); ctx.lineTo(0, r); ctx.lineTo(-r * 0.7, 0); ctx.closePath(); }
      else for (let k = 0; k < 6; k++) { const a = k * Math.PI / 3 + Math.PI / 6; ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r); }
      if (!beacon) ctx.closePath();
      ctx.fillStyle = beacon ? "#12323c" : "#4a1038"; ctx.fill();
      ctx.strokeStyle = beacon ? "#7fe0f0" : "#ff5fa8"; ctx.stroke();
      ctx.beginPath(); ctx.arc(0, 0, r * 0.32, 0, Math.PI * 2);
      ctx.fillStyle = beacon ? "rgba(190,250,255," + (0.5 + 0.4 * pulse) + ")" : "rgba(255,196,226," + (0.5 + 0.4 * pulse) + ")"; ctx.fill();
      if (n.id === target) {
        ctx.strokeStyle = "rgba(255,120,120,0.9)"; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.arc(0, 0, r + 8, 0, Math.PI * 2); ctx.stroke();
      }
      ctx.restore();
      if (n.hp < n.max) drawBar(n.x, n.y - r - 10, 34, n.hp / n.max);
      if (!beacon) {
        const total = (G.TUNING.science.nest.guards | 0), waiting = n.guardIn ? n.guardIn.length : 0;
        let alive = 0;
        for (const a of game.aliens) if (a.nest === n.id) alive++;
        const shown = Math.max(total, alive + waiting);
        ctx.lineWidth = 1.2; ctx.strokeStyle = "#ff5fa8"; ctx.fillStyle = "#ff5fa8";
        for (let k = 0; k < shown; k++) {
          const px = n.x + (k - (shown - 1) / 2) * 9, py = n.y + r + 9;
          ctx.beginPath(); ctx.arc(px, py, 3, 0, Math.PI * 2);
          if (k < alive) ctx.fill(); else ctx.stroke();
        }
        if (waiting) {
          let soon = Infinity;
          for (const v of n.guardIn) if (v > 0 && v < soon) soon = v;   // a timer stuck at 0 is a guard held back by the map alien limit: not counting down, so not shown
          if (soon < Infinity) {
            ctx.font = "600 10px system-ui, sans-serif"; ctx.textAlign = "center"; ctx.fillStyle = "rgba(255,196,226,0.9)";
            ctx.fillText(Math.ceil(soon) + "s", n.x, n.y + r + 24);
          }
        }
      } else {
        ctx.font = "600 10px system-ui, sans-serif"; ctx.textAlign = "center"; ctx.fillStyle = "rgba(190,250,255,0.9)";
        ctx.fillText("BEACON", n.x, n.y + r + 14);
      }
    }
  }

  function frame(dt) {
    drawSky(dt);
    updateSpin(dt);
    ctx.save();
    ctx.translate(view.ox, view.oy);
    ctx.scale(view.sc, view.sc);
    drawOrbits();
    game.storms.forEach(drawStorm);
    for (const b of game.bodies) drawBody(b);
    for (const s of game.stars) if (!s.taken) drawStar(s);
    game.bases.forEach(drawBase);
    drawNests();
    for (const s of game.ships) if (!s.dead) drawTrail(s, shipColor(s));
    for (const s of game.ships) if (!s.dead && (s.st === G.MINING || (s.st === G.MANUAL && s.mm === 1))) drawBeam(s);
    for (const s of game.ships) if (!s.dead) drawShip(s);
    game.aliens.forEach(drawAlien);
    drawShots();
    drawFog();
    game.showers.forEach(drawShower);
    drawWarnings();
    drawFx();
    drawGhost();
    ctx.restore();
    drawFlareTint();
  }

  // ---------------------------------------------------------------- panels

  function resLine() {
    const L = LB();
    return G.RES.map(r => `<span><span class="dot" style="background:${RES_COLOR[r]}"></span>${L.res[r]} <b>${Math.floor(game.stock[r])}</b></span>`).join("");
  }

  function costText(cost) {
    const L = LB();
    return G.RES.filter(r => cost[r]).map(r => `${cost[r]} ${L.res[r]}`).join(", ");
  }

  // Replace a panel's buttons without dropping keyboard focus: the focused button (found by its data attribute) gets focus back.
  function setHtml(box, html, attr) {
    const a = document.activeElement;
    const id = a && a !== document.body && box.contains(a) && a.getAttribute ? a.getAttribute(attr) : null;
    box.innerHTML = html;
    if (id != null) { const n = box.querySelector("[" + attr + "=\"" + id + "\"]"); if (n && !n.disabled) n.focus(); }
  }

  function renderBuild() {
    const L = LB();
    const items = [["miner", L.ship.miner, G.SHIP_TYPES.miner.blurb, G.shipCost(game, "miner")],
      ["hauler", L.ship.hauler, G.SHIP_TYPES.hauler.blurb, G.shipCost(game, "hauler")],
      ["warship", G.TUNING.ships.warship.label, G.SHIP_TYPES.warship.blurb, G.shipCost(game, "warship")],
      ["base", L.newBase, themed() ? "Click an empty spot to place it" : "Click empty space to place it", G.baseCost(game)]];
    const html = items.map(([key, label, note, cost]) => {
      const ok = !game.over && G.canAfford(game, cost);
      return `<button type="button" class="build-btn${key === "base" && ui.placing ? " active" : ""}" data-build="${key}"${ok ? "" : " disabled"}>
        <b>${label}</b> <small>${costText(cost)}</small><small>${note}</small></button>`;
    }).join("");
    if (html !== buildHtml) { buildHtml = html; setHtml($("build"), html, "data-build"); }
  }

  function renderBases() {
    const html = game.bases.map((b, i) => {
      const cost = G.upgradeCost(game, i), tier = b.tier | 0;
      const label = baseName(i) + (tier ? " " + TIER_NAME[tier] : "");
      const next = G.TUNING.upgrades[tier + 1];
      const btn = cost
        ? `<button type="button" data-act="up:${i}"${!game.over && !b.down && G.canAfford(game, cost) ? "" : " disabled"} title="Unloads faster and takes ${shipsWord()} from further away">Upgrade<small>${costText(cost)}</small></button>`
        : `<small>Fully upgraded</small>`;
      let note = `unloads ${G.TUNING.upgrades[tier].unload}/s` + (next ? `, next ${next.unload}/s` : "");
      if (b.down) note = "DOWN: out of action until repaired";
      else if (b.hp < b.maxHp) note = `HP ${Math.ceil(b.hp)}/${b.maxHp}, ` + note;
      // add-ons and repair: a button while it can be bought, plain text once built
      const extra = ["shield", "turret"].map(kind => {
        const def = G.TUNING.addons[kind];
        if (b[kind]) return `<small class="done">${def.label} built</small>`;
        const c = G.addonCost(game, kind);
        return `<button type="button" data-act="add:${i}:${kind}"${!game.over && !b.down && G.canAfford(game, c) ? "" : " disabled"} title="${def.blurb}">${def.label}<small>${costText(c)}</small></button>`;
      });
      if (b.hp < b.maxHp) {
        const c = G.repairCost(game, "base", i);
        extra.push(`<button type="button" class="fix" data-act="fix:${i}"${!game.over && G.canAfford(game, c) ? "" : " disabled"} title="Restore full health${b.down ? " and bring the base back" : ""}">Repair<small>${costText(c) || "free"}</small></button>`);
      }
      return `<div class="base-row"><span class="lbl"><b>${label}</b><small>${note}</small></span>${btn}</div><div class="base-extra">${extra.join("")}</div>`;
    }).join("");
    if (html !== basesHtml) { basesHtml = html; setHtml($("bases"), html, "data-act"); }
  }

  // Rows are built once per ship set. Every refresh only updates text, widths and classes in place,
  // so a click never lands on a row that has just been thrown away.
  let boardRows = [];

  // The science readout and the Tech button. They show from the first sector that can pay science (or once any is earned).
  let sciShown = "", sciPulse = 0;
  function renderScience() {
    const live = !!game && (game.sector >= G.TUNING.science.firstSector || (game.sciTotal | 0) > 0 || (game.tech && game.tech.length > 0));
    $("sci").hidden = !live; $("b-tech").hidden = !live;
    if (!live) { sciShown = ""; return; }
    const html = `Science <b>${Math.floor(game.science + 1e-9)}</b>`;
    if (html !== sciShown) { sciShown = html; $("sci").innerHTML = html; }
  }
  function pulseScience() {
    const el = $("sci");
    if (reduceMotion || !el.classList) return;
    el.classList.remove("pulse");
    void el.offsetWidth;   // restart the animation
    el.classList.add("pulse");
    clearTimeout(sciPulse);
    sciPulse = setTimeout(() => el.classList.remove("pulse"), 700);
  }
  const SCI_SOURCE = { raider: "raider", turret: "turret kill", guard: "guard", wave: "wave repelled", beacon: "beacon", nest: "nest", secured: "sector secured" };
  let sciToastAt = 0, sciToastText = "", sciToastParts = 0;   // the text last shown by sciToast, so only a science toast is merged into
  function sciToast(msg) {   // events from one tick share one toast, so a nest kill shows its points and its name
    const now = Date.now(), el = $("toast");
    const merge = now - sciToastAt < 150 && sciToastText && el.textContent === sciToastText && sciToastParts < 3 && sciToastText.length + msg.length < 80;
    sciToastText = merge ? sciToastText + " · " + msg : msg;
    sciToastParts = merge ? sciToastParts + 1 : 1;
    toast(sciToastText);
    sciToastAt = now;
  }
  function onScienceMsg(e) {   // one event from G.drainEvents
    if (!e) return;
    if (e.type === "science:gain") {
      if (!(e.amount > 0)) return;
      sciToast(`+${e.amount} science` + (SCI_SOURCE[e.source] ? ` (${SCI_SOURCE[e.source]})` : ""));
      pulseScience(); renderScience();
    } else if (e.type === "tech:unlock") {
      const node = (G.TUNING.tech || []).find(o => o.id === e.id);
      sciToast("Tech unlocked: " + (node ? node.name : e.id));
      renderScience();
    } else if (e.type === "nest:destroyed") sciToast(e.kind === "beacon" ? "Beacon destroyed" : "Nest destroyed");
    else if (e.type === "wave:repelled") sciToast("Raid wave repelled");
  }
  // ---- credits, debt, warnings, the credits panel and the Mothball button (slice b)
  const fmtCr = n => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const signedCr = n => (Math.round(n) < 0 ? "-" : "+") + fmtCr(Math.abs(n));
  function pumpMsgs() { for (const e of G.drainEvents(game)) { onScienceMsg(e); onEconMsg(e); } }   // after a click: toast now, not later

  // A Mothball / Wake button and a status tag, on the right of the ship's row. A click on it never selects the row.
  function shipRowExtra(ship) {
    const box = document.createElement("span"); box.className = "rowx";
    const tag = document.createElement("small"); tag.className = "mtag";
    const btn = document.createElement("button"); btn.type = "button"; btn.className = "moth";
    btn.addEventListener("click", ev => { ev.stopPropagation(); mothballShip(ship.id); });
    box.append(tag, btn);
    return box;
  }

  function updateShipRowExtra(ship, node) {
    const box = node.querySelector(".rowx");
    if (!box) return;
    box.hidden = ship.dead;
    if (ship.dead) return;
    const tag = box.firstChild, btn = box.lastChild, W = G.TUNING.econ.maint.wakeSecs;
    const t = ship.mothballed ? "Mothballed" : ship.wake > 0 ? "Waking " + Math.ceil(ship.wake) + " s" : "";
    const b = ship.mothballed || ship.wake > 0 ? "Wake" : "Mothball";
    const title = ship.mothballed ? `Wake it. It works again after ${W} seconds (M)`
      : ship.wake > 0 ? "Waking up" : `Park it at a base (dock first) on ${Math.round(G.TUNING.econ.maint.mothball * 100)}% running costs (M)`;
    if (tag.textContent !== t) tag.textContent = t;
    if (btn.textContent !== b) btn.textContent = b;
    if (btn.title !== title) btn.title = title;
    btn.disabled = game.over || (ship.wake > 0 && !ship.mothballed);
  }

  function mothballShip(id) {
    const s = game && game.ships[id];
    if (!s) return;
    const r = G.setMothball(game, id, !s.mothballed);
    if (!r.ok) toast(r.reason);
    else { toast(shipName(s) + (ship.mothballed ? " is mothballed at the base." : ` is waking up (${G.TUNING.econ.maint.wakeSecs} s).`)); saveNow(); }
    boardKey = ""; refresh();
  }

  const econCache = { credits: "", debt: "", time: "", bar: "", body: "" };
  function setCached(key, el, html) { if (econCache[key] !== html) { econCache[key] = html; el.innerHTML = html; } }

  function renderEcon() {
    const E = G.TUNING.econ, L = LB(), r = game.rules || {}, rates = G.econRates(game), by = {};
    for (const w of G.econWarnings(game)) by[w.cause] = w;
    const level = c => by[c] ? (by[c].level === "danger" ? "red" : "amber") : "";
    const cr = $("credits"), dbt = $("debt"), tl = $("timeleft"), bar = $("warnbar");
    cr.hidden = false; $("econ").hidden = false;
    setCached("credits", cr, `<b>${fmtCr(game.credits)}</b> cr (${signedCr(rates.net)}/min)${game.credits < 0 ? " overdrawn" : ""}`);
    cr.title = by.overdrawn ? by.overdrawn.text : by.net ? by.net.text : "Credits: earned on delivery, spent on running costs";
    cr.classList.toggle("amber", game.credits < 0 || game.netNegFor >= E.netWarnSecs);
    cr.classList.toggle("red", !!by.bankrupt);
    const showDebt = !!r.debt && game.debt > 0;
    dbt.hidden = !showDebt;
    if (showDebt) {
      const pct = +(E.debt.rate * 100 * G.techMult(game, "interest")).toFixed(2);
      setCached("debt", dbt, `Debt <b>${fmtCr(game.debt)}</b> (+${pct}%/min), due leaving ${lc(L.sector)} ${E.debt.dueSector}`);
      dbt.classList.toggle("amber", level("debt") === "amber"); dbt.classList.toggle("red", level("debt") === "red");
    }
    const lim = G.timeLimit(game), showTime = lim > 0 && !game.won;
    tl.hidden = !showTime;
    if (showTime) {
      setCached("time", tl, `Time left <b>${fmtSecs(Math.ceil(lim - game.sectorTime))}</b>`);
      tl.classList.toggle("amber", level("timer") === "amber"); tl.classList.toggle("red", level("timer") === "red");
    }
    const banners = ["bankrupt", "debt", "timer"].filter(c => by[c]).map(c => by[c]);
    bar.hidden = !banners.length;
    bar.classList.toggle("danger", banners.some(w => w.level === "danger"));
    bar.style.top = (topH + 6) + "px";
    const barKey = banners.map(w => w.text).join("\n");
    if (econCache.bar !== barKey) {
      econCache.bar = barKey; bar.textContent = "";
      for (const w of banners) { const d = document.createElement("div"); d.textContent = w.text; bar.appendChild(d); }
    }
    // the credits panel
    const X = E.exchange, n = X.step, can = !game.over;
    const income = rates.net + rates.maint + rates.upkeep;
    const line = (a, b) => `<div class="eco-line"><span>${a}</span><b>${b}</b></div>`;
    let html = line("Income (run average)", signedCr(income) + "/min") + line("Ships", signedCr(-rates.maint) + "/min") +
      line(L.bases, signedCr(-rates.upkeep) + "/min") + line("Net", signedCr(rates.net) + "/min");
    if (showDebt) {
      const payable = Math.min(game.debt, Math.max(0, game.credits));
      html += line("Debt interest", "+" + fmtCr(rates.interest) + "/min (adds to the debt)") +
        `<button type="button" data-eco="pay"${can && payable > 0 ? "" : " disabled"} title="Pay the debt from your credits">Pay debt<small>${fmtCr(payable)} of ${fmtCr(game.debt)} cr</small></button>`;
    }
    html += `<div class="eco-ex">` + G.RES.map(res => {
      const have = Math.floor(game.stock[res] + 1e-9), sell = Math.min(n, have) * X.sell[res], price = X.buy[res];
      const buy = X.buyOn && price ? `<button type="button" data-eco="buy:${res}"${can && game.credits >= price ? "" : " disabled"} title="Buy up to ${n} for ${price} cr each">Buy ${n}<small>-${fmtCr(Math.min(n, Math.floor(Math.max(0, game.credits) / price)) * price || price)} cr</small></button>` : "";
      return `<div class="eco-row"><span>${L.res[res]} <b>${have}</b></span><button type="button" data-eco="sell:${res}"${can && have >= 1 ? "" : " disabled"} title="Sell up to ${n} for ${X.sell[res]} cr each">Sell ${n}<small>+${fmtCr(sell || X.sell[res])} cr</small></button>${buy}</div>`;
    }).join("") + `</div>`;
    if (econCache.body !== html) { econCache.body = html; setHtml($("econ-body"), html, "data-eco"); }
  }

  $("econ-body").addEventListener("click", ev => {
    const btn = ev.target.closest("[data-eco]");
    if (!btn || !game) return;
    const [act, res] = btn.dataset.eco.split(":"), n = G.TUNING.econ.exchange.step;
    const r = act === "pay" ? G.payDebt(game) : act === "sell" ? G.sellStock(game, res, n) : G.buyStock(game, res, n);
    if (!r.ok) toast(r.reason); else saveNow();
    pumpMsgs(); econCache.body = ""; buildHtml = ""; refresh();
  });

  // One message from the game: a warning is shown as a toast when it starts or changes (the banner and the top bar stay up on their own).
  function onEconMsg(e) {
    if (e.type === "econ:warn" && e.text) toast(e.text, true);
    else if (e.type === "debt:paid") toast(e.left > 0 ? `Paid ${fmtCr(e.amount)} cr of the loan. ${fmtCr(e.left)} cr left.` : "The starting loan is paid off.");
  }

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
        const hp = document.createElement("small"); hp.className = "hp";
        const fix = document.createElement("button"); fix.type = "button"; fix.className = "fix"; fix.hidden = true;
        fix.dataset.fix = s.id;
        const bar = document.createElement("div"); bar.className = "bar";
        const fill = document.createElement("i");
        bar.appendChild(fill);
        txt.append(name, hp, document.createElement("br"), job, bar);
        li.append(dot, txt, fix);
        const extra = shipRowExtra(s);
        if (extra) li.appendChild(extra);
        list.appendChild(li);
        return { li, dot, name, hp, job, fill, fix, last: "" };
      });
    }
    let live = 0, busy = 0;
    for (let i = 0; i < game.ships.length; i++) {
      const s = game.ships[i], row = boardRows[i];
      updateShipRowExtra(s, row.li);
      const pct = s.cargo > 0 ? Math.round((s.cargo / G.SHIP_TYPES[s.type].cap) * 100) : 0;
      const job = G.jobText(game, s, labelArg()), nm = shipName(s);
      const hurt = !s.dead && s.hp < s.maxHp, at = hurt && !game.over ? atBase(s) : -1;
      const cost = at >= 0 ? G.repairCost(game, "ship", s.id) : null, fixOk = cost && G.canAfford(game, cost);
      if (!s.dead) { live++; if (s.st !== G.IDLE || s.wo) busy++; }
      const sig = nm + "|" + s.type + "|" + s.st + "|" + s.res + "|" + pct + "|" + job + "|" + (s.id === ui.selected) + "|" + looks.ship.id +
        "|" + s.dead + "|" + Math.ceil(s.hp) + "|" + at + "|" + (cost ? costText(cost) : "") + "|" + fixOk;
      if (sig === row.last) continue;
      row.last = sig;
      row.li.className = (s.id === ui.selected ? "sel" : "") + (s.dead ? " dead" : "");
      row.dot.style.background = shipColor(s);
      row.dot.style.opacity = s.st === G.IDLE || s.dead ? 0.45 : 1;
      row.name.textContent = nm;
      row.hp.textContent = hurt ? " HP " + Math.ceil(s.hp) + "/" + s.maxHp : "";
      row.job.textContent = job;
      row.fill.style.width = pct + "%";
      row.fill.style.background = s.res ? RES_COLOR[s.res] : "#fff";
      row.fix.hidden = !cost;
      if (cost) { row.fix.textContent = "Repair " + costText(cost); row.fix.disabled = !fixOk; }
    }
    $("board-count").textContent = `${busy}/${live} working`;
  }

  // The base a ship is docked at (close enough to unload or be repaired, as game.js measures it), else -1.
  // With any true, bases that are down count too (a down base is where R repairs the base itself).
  function atBase(ship, any) {
    let i = G.nearestBase(game, ship.x, ship.y);
    if (any) {
      let bd = Infinity;
      for (let j = 0; j < game.bases.length; j++) {
        const d = Math.hypot(ship.x - game.bases[j].x, ship.y - game.bases[j].y);
        if (d < bd) { bd = d; i = j; }
      }
    }
    const b = game.bases[i];
    if (!b) return -1;
    return Math.hypot(ship.x - b.x, ship.y - b.y) <= G.BASE_R + 10 + G.TUNING.upgrades[b.tier | 0].dock + G.MANUAL_SLACK ? i : -1;
  }

  // Event warnings (kind and whole seconds left), the solar-flare banner while one runs, and the alien count.
  let alertsHtml = "";
  function renderAlerts() {
    const L = LB(), box = $("alerts"), chips = [];
    const NAME = { fog: "Fog", flare: "Solar flare", raid: "Alien raid", shower: themed() ? L.shower : "Meteor shower" };
    const list = game.events.length || game.showers.length ? G.eventWarnings(game) : [];
    for (const w of list) chips.push(`<div class="chip warn ${w.kind}">${NAME[w.kind] || w.kind} in <b>${w.secs}</b> s</div>`);
    const fl = game.events.length ? Math.ceil(flareLeft()) : 0;
    if (fl > 0) chips.push(`<div class="chip flare">Solar flare: ships outside a Shield are stunned (<b>${fl}</b> s)</div>`);
    if (game.aliens.length) chips.push(`<div class="chip raid">Aliens: <b>${game.aliens.length}</b></div>`);
    const html = chips.join("");
    if (html !== alertsHtml) { alertsHtml = html; box.innerHTML = html; }
    box.style.top = (topH + 6) + "px";
  }

  // Static page text that names things. Space keeps the HTML as written (saved on first use); a theme rewrites it.
  let textKey = null;
  const staticText = {};
  function applyThemeText() {
    const key = themeId();
    if (key === textKey) return;
    textKey = key;
    const L = LB(), els = { warp: $("b-warp"), wwarp: $("w-warp"), bases: $("bases-title"), help: $("help") };
    if (!("warp" in staticText)) for (const k in els) staticText[k] = els[k].innerHTML;
    if (key === "space") { for (const k in els) els[k].innerHTML = staticText[k]; return; }
    els.warp.textContent = L.warp; els.wwarp.textContent = L.warp;
    els.bases.firstChild.nodeValue = L.bases + " ";
    els.help.textContent = `Click ${an(shipWord())}, then ${an(lc(L.body.asteroid))} or ${an(lc(L.body.iceplanet))} to mine it, a star to collect it, or ${an(L.base)} to send it there. ` +
      `Build ${lc(L.bases)} to clear the ${lc(L.sector)}, then ${lc(L.warp)}. Pause: Space. Esc cancels. R repairs. Add ?stress to the address for a 30-${shipWord()}, 15-alien test (?stress&sector=3 for hazards).`;
  }

  function refresh() {
    applyThemeText();
    const L = LB();
    $("res").innerHTML = resLine();
    const left = game.stars.filter(s => !s.taken).length;
    $("goal").innerHTML = `${L.sector} <b>${game.sector}</b> &middot; ${L.bases} built <b>${game.bases.length - 1} / ${G.goalBases(game.sector)}</b> &middot; Stars <b>${game.stars.length - left} / ${game.stars.length}</b>`;
    const kills = ((game.stats && game.stats.kills) | 0);
    $("score").innerHTML = `Score <b>${G.scoreTotal(game)}</b>${kills || game.sector >= G.TUNING.aliens.firstSector ? ` &middot; Kills <b>${kills}</b>` : ""} &middot; Best <b>${Math.max(profile.best, G.scoreTotal(game))}</b> &middot; <span class="bankstar">&#9733; <b>${profile.stars}</b></span>`;
    updatePlayerButton();
    $("b-warp").hidden = !(game.won && !game.over);
    $("b-retire").disabled = game.over;
    renderBuild();
    renderBases();
    if (ui.selected != null && (!game.ships[ui.selected] || game.ships[ui.selected].dead)) { ui.selected = null; boardKey = ""; buildHtml = ""; }   // the selected ship was lost
    renderBoard();
    renderScience();
    renderEcon();
    renderAlerts();
    $("b-pause").textContent = ui.paused ? "Resume" : "Pause";
    $("paused").style.display = ui.paused ? "block" : "none";
    const hint = $("hint");
    hint.style.display = ui.placing || ui.selected != null ? "block" : "none";
    hint.textContent = themed()
      ? (ui.placing ? `Click an empty spot to place the ${L.base} (Esc to cancel)`
        : `Click ${an(lc(L.body.asteroid))} or ${an(lc(L.body.iceplanet))} to mine it, a star to collect it, or ${an(L.base)} to send it there (Esc to deselect)`)
      : ui.placing ? "Click empty space to place the base (Esc to cancel)"
      : "Click a planet or asteroid to mine it, a star to collect it, or a base to send this ship there (Esc to deselect)";
    if (!ui.placing && isWar(chosenShip())) hint.textContent = "Warship: click an alien or nest to attack, empty space to patrol there, Shift+click a ship to escort it (Esc to deselect)";
    if (ui.keyboard && ui.placing) hint.textContent = `Arrow keys move the cursor (Shift: faster), Enter places the ${themed() ? L.base : "base"}, Esc cancels`;
    renderLegend();
    syncInert();
    if (game.starsGot !== ui.starsSeen) claim();
    if (game.won && !ui.winShown && !game.over) showWin();
    if (game.over && !ui.endShown) showEnd();
    if ($("topbar").offsetHeight !== topH) resize();   // the top bar wrapped or unwrapped
  }

  function showWin() {
    ui.winShown = true; ui.winOpen = true;
    const c = game.clearInfo || { sector: game.sector, sectorPts: 0, timePts: 0, secs: Math.floor(game.sectorTime) };
    const L = LB(), sec = lc(L.sector);
    $("win-title").textContent = L.sector + " " + c.sector + " cleared";
    $("win-text").textContent = `${G.goalBases(c.sector)} ${lc(L.bases)} built in ${Math.floor(c.secs / 60)}m ${c.secs % 60}s. ` +
      `+${c.sectorPts} for the ${sec}, +${c.timePts} time bonus. Score so far ${G.scoreTotal(game)}. ` +
      (themed() ? `Go on to ${sec} ${c.sector + 1}` : `Warp to sector ${c.sector + 1}`) + `: a bigger map, with less to mine and higher prices.`;
    $("win").hidden = modal();
    focusCard();
  }

  // Title and opening sentence of the run-end card, by game.endReason (L: the labels in use; crew: a miner or hauler is still
  // afloat). The three economy causes are slice b's.
  const END_TEXT = {
    retired: { title: () => "Run over", text: () => "You retired the fleet. " },
    stranded: { title: () => "Stranded", text: (L, crew) => crew ? "Nothing left to mine and not enough to build with. "
      : `Every ${shipWord()} was lost and there is not enough left to build another. `},
    destroyed: { title: L => (themed() ? L.home : "Home base") + " destroyed", text: L => `Your ${lc(L.home)} was destroyed. ` },
    bankrupt: { title: () => "Bankrupt", text: () => `Bankrupt: credits stayed below ${fmtCr(G.TUNING.econ.bankrupt.floor + G.techAdd(game, "overdraft"))} for ${G.TUNING.econ.bankrupt.grace} seconds. ` },
    debt: { title: () => "Defaulted", text: () => `Defaulted: the starting loan wasn't repaid by the ${Math.round(G.TUNING.econ.debt.dueTime / 60)}-minute deadline. ` },
    timeout: { title: () => "Out of time", text: L => `Out of time: ${lc(L.sector)} ${game.sector}'s goal wasn't met within ${fmtSecs(G.timeLimit(game))}. ` },
  };

  function showEnd() {
    ui.endShown = true; ui.endOpen = true;
    claim();
    const total = G.scoreTotal(game), isBest = G.recordBest(profile, total);
    saveProfile();
    logRun(game.endReason);
    const why = game.endReason, s = game.score, L = LB(), row = (a, b, cls) => `<tr${cls ? ` class="${cls}"` : ""}><td>${a}</td><td>${b}</td></tr>`;
    const crew = game.ships.some(sh => !sh.dead && !isWar(sh));   // a miner or hauler still afloat
    const ET = END_TEXT[why] || END_TEXT.retired;
    $("end-title").textContent = ET.title(L);
    $("end-text").textContent = ET.text(L, crew) + `You reached ${lc(L.sector)} ${game.sector} and cleared ${game.cleared}.`;
    $("end-score").innerHTML = row("Materials delivered", Math.floor(s.mat)) + row(L.bases + " built", Math.floor(s.bases)) +
      row(L.sector + "s cleared", Math.floor(s.sectors)) + row("Time bonus", Math.floor(s.time)) +
      (s.kills > 0 ? row("Aliens destroyed (" + ((game.stats && game.stats.kills) | 0) + ")", Math.floor(s.kills)) : "") + row("Score", total, "sum");
    $("end-best").textContent = (isBest ? "New best score! " : "") + `Best score ${profile.best}. Stars collected this run ${game.starsGot}; ${profile.stars} in the bank.`;
    $("end").hidden = modal();
    focusCard();
  }

  // ---------------------------------------------------------------- hangar

  // A tiny picture for each theme card: a rocket, a hamster or a dwarf, painted on a small canvas.
  function paintThemePreview(c, id) {
    const g = c.getContext("2d"), s = view.dpr;
    g.setTransform(s, 0, 0, s, 0, 0);
    g.clearRect(0, 0, 36, 36);
    g.translate(18, 18);
    g.scale(1.2, 1.2);
    if (id === "hamster") paintHamster(g, false, looks.ship.miner);
    else if (id === "dwarven") paintDwarf(g, looks.ship.miner);
    else {
      g.fillStyle = looks.ship.miner;
      g.beginPath(); g.moveTo(11, 0); g.lineTo(-7, -7); g.lineTo(-3.5, 0); g.lineTo(-7, 7); g.closePath(); g.fill();
      g.strokeStyle = "rgba(255,255,255,0.85)"; g.lineWidth = 1; g.stroke();
      g.fillStyle = "rgba(255,255,255,0.85)"; g.beginPath(); g.arc(3, 0, 1.6, 0, Math.PI * 2); g.fill();
    }
  }

  function swatch(kind, l) {
    if (kind === "theme") return `<canvas class="tp" data-theme="${l.id}" width="${Math.round(36 * view.dpr)}" height="${Math.round(36 * view.dpr)}"></canvas>`;
    if (kind === "ship") return `<i style="background:${l.miner}"></i><i style="background:${l.hauler}"></i>`;
    if (kind === "base") return `<i style="background:${l.main}"></i><i style="background:${l.home}"></i>`;
    if (kind === "bg") return `<i class="wide" style="background:linear-gradient(135deg,${l.top},${l.bottom}),${l.blobs[0][3]};background-blend-mode:screen;border:1px solid rgba(255,255,255,0.25)"></i>`;
    return `<i class="wide" style="background:linear-gradient(90deg,transparent,${looks.ship.miner});height:6px;margin-top:8px"></i>`;
  }

  function renderHangar() {
    $("h-stars").textContent = profile.stars;
    renderHistory($("h-history"), 20);
    $("h-body").innerHTML = G.LOOK_KINDS.map(kind => {
      if (kind === "bg" && themed()) return `<h2>${G.LOOK_TITLES.bg}</h2><p class="hnote">Themes bring their own scene</p>`;   // the bg pick is kept
      const items = G.LOOKS[kind].map(l => {
        const owned = profile.owned[kind].indexOf(l.id) >= 0, picked = profile.pick[kind] === l.id;
        const status = picked ? "In use" : owned ? "Owned" : `&#9733; ${l.cost}`;
        const afford = owned || profile.stars >= l.cost;
        const note = kind === "theme" && l.note ? `<small class="note">${l.note}</small>` : "";
        return `<button type="button" class="look${kind === "theme" ? " themecard" : ""}${picked ? " picked" : ""}${owned ? "" : " locked"}" data-kind="${kind}" data-id="${l.id}"${afford ? "" : " title=\"Not enough stars yet\""}>
          <span class="sw${kind === "theme" ? " tall" : ""}">${swatch(kind, l)}</span><b>${l.name}</b>${note}<small>${status}</small></button>`;
      }).join("");
      return `<h2>${G.LOOK_TITLES[kind]}</h2><div class="look-grid">${items}</div>`;
    }).join("");
    for (const c of $("h-body").querySelectorAll("canvas.tp")) paintThemePreview(c, c.dataset.theme);
  }

  let hangarOpener = null;
  function openHangar() {
    if (!ui.hangar) hangarOpener = document.activeElement;
    ui.hangar = true;
    renderHangar();
    $("hangar").hidden = false;
    $("win").hidden = true; $("end").hidden = true;
    syncInert();
    const first = $("h-body").querySelector("button");
    (first || $("h-close")).focus();   // focus moves into the hangar
  }

  // The tech tree window. openTech belongs to slice a: it sets ui.tech, shows #tech, fills #t-body and moves focus in.
  let techOpener = null;
  const TECH_BRANCH = { mil: "Military", ind: "Industry", log: "Logistics" };
  const TECH_MARK = { owned: "✓ Owned", available: "● Available", short: "○ Not enough science", locked: "✕ Locked" };
  function techNode(id) { return G.TUNING.tech.find(o => o.id === id); }
  function renderTech() {
    const T = G.TUNING.tech, br = ["mil", "ind", "log"];
    const sci = Math.floor(game.science + 1e-9);
    const cols = br.map(b => {
      const nodes = T.filter(o => o.branch === b).sort((x, y) => x.tier - y.tier).map(o => {
        const st = G.techState(game, o.id), cost = G.techCost(o);
        let mark = TECH_MARK[st];
        if (st === "short") mark = `○ Need ${Math.ceil(cost - game.science - 1e-9)} more`;
        if (st === "locked" && o.needs) mark = `✕ Locked: needs ${techNode(o.needs).name}`;
        return `<button type="button" class="tn tn-${st}" data-tech="${o.id}" data-col="${br.indexOf(b)}" data-tier="${o.tier}" aria-disabled="${st === "owned" || st === "available" ? "false" : "true"}">
          <span class="tn-top"><b>${o.name}</b><span class="tn-cost">${cost} sci</span></span>
          <span class="tn-fx">${o.text}</span><span class="tn-state">${mark}</span></button>`;
      }).join("");
      return `<div class="tcol"><h2>${TECH_BRANCH[b]}</h2>${nodes}</div>`;
    }).join("");
    setHtml($("t-body"), `<p class="note">Science <b>${sci}</b>. It comes from fighting: raiders, guards, nests, the sector 2 beacon and repelled waves. Arrow keys move, Enter buys, Esc or T closes.</p><div class="tgrid">${cols}</div>`, "data-tech");
  }
  function techMsg(msg, bad) {
    const el = $("t-msg");
    el.textContent = msg || ""; el.className = "f-status" + (msg ? (bad ? " err" : " ok") : "");
  }
  function openTech() {
    if (!game || ui.tech || ui.feedback || ui.hangar || ui.dlg.length) return;
    techOpener = document.activeElement;
    ui.tech = true;
    techMsg("");
    renderTech();
    $("tech").hidden = false;
    $("win").hidden = true; $("end").hidden = true;
    syncInert();
    const body = $("t-body");
    const first = body.querySelector(".tn-available") || body.querySelector(".tn-short") || body.querySelector("button");
    (first || $("t-close")).focus();
  }
  function buyTech(id) {
    const node = techNode(id);
    if (!node) return;
    const r = G.unlockTech(game, id);
    if (!r.ok) { techMsg(r.reason || "Cannot buy that.", true); return; }
    techMsg(`${node.name} unlocked for ${r.cost} science.`);
    pumpMsgs();   // the game is paused here, so the loop would not
    saveNow();
    renderTech(); renderScience();
  }
  // Arrow keys walk the grid: left and right change branch at the same tier, up and down change tier.
  function techArrow(ev) {
    if (ev.key === "Enter" && ev.repeat) { ev.preventDefault(); return; }   // holding Enter must not re-buy and wipe the "unlocked" message
    const dirs = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }, d = dirs[ev.key];
    const a = document.activeElement;
    if (!d || !a || !a.dataset || a.dataset.tech == null) return;
    ev.preventDefault();
    const col = +a.dataset.col + d[0], tier = +a.dataset.tier + d[1];
    const n = $("t-body").querySelector(`[data-col="${col}"][data-tier="${tier}"]`);
    if (n) n.focus();
  }
  $("t-body").addEventListener("keydown", techArrow);
  $("t-body").addEventListener("click", ev => {
    const b = ev.target.closest && ev.target.closest("[data-tech]");
    if (b && game && ui.tech) buyTech(b.dataset.tech);
  });
  window.addEventListener("keydown", ev => {   // T closes the window it opened (keyActive is off while it is up)
    if (!ui.tech || ui.feedback || ui.dlg.length || ui.hangar || !ev.key || ev.key.toLowerCase() !== "t") return;
    if (ev.ctrlKey || ev.metaKey || ev.altKey || ev.repeat) return;
    const tag = ev.target && ev.target.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
    if (ev.stopImmediatePropagation) ev.stopImmediatePropagation();   // else the game's own T handler, next in line, would reopen it
    closeTech();
  });
  function closeTech() {
    ui.tech = false;
    $("tech").hidden = true;
    showCards();
    syncInert();
    focusBack(techOpener, "b-tech");
    techOpener = null;
  }

  // C moves focus to the first button in the credits panel (Pay debt, Sell, Buy). M mothballs or wakes the selected ship.
  function focusEcon() {
    const b = $("econ-body").querySelector("button:not([disabled])");
    if (b) b.focus(); else toast(`Credits ${fmtCr(game.credits)}. Nothing to press in the credits panel yet.`);
  }
  function toggleMothball() {
    const s = needShip();
    if (!s) return;
    if (s.wake > 0 && !s.mothballed) return toast(shipName(s) + " is waking up.");
    mothballShip(s.id);
  }

  function closeHangar() {
    ui.hangar = false;
    $("hangar").hidden = true;
    showCards();
    syncInert();
    focusBack(hangarOpener, "b-hangar");
    hangarOpener = null;
  }

  // Put focus back on the element that opened a dialog, if it can still take it.
  function focusBack(el, fallbackId) {
    const ok = n => n && document.contains(n) && !n.disabled && !n.inert && n.getClientRects().length && !(n.closest && n.closest("[inert]"));
    const t = ok(el) ? el : fallbackId && ok($(fallbackId)) ? $(fallbackId) : null;
    if (t && t.focus) t.focus();
  }

  // Everything behind a dialog or card is unreachable by Tab and click while it is open.
  function syncInert() {
    const block = !!(ui.feedback || ui.hangar || ui.tech || ui.dlg.length || !$("end").hidden);   // the win card covers only the stage
    $("side").inert = block; $("topbar").inert = block; $("paused").inert = ui.feedback;
  }

  // The win and run-end cards take focus when they appear, on their main button.
  function focusCard() {
    syncInert();
    const c = !$("win").hidden ? $("w-warp") : !$("end").hidden ? $("e-new") : null;
    if (c && c.focus) c.focus();
  }

  // The win and run-end cards show only when no hangar or dialog is on top.
  const modal = () => ui.hangar || ui.tech || ui.feedback || ui.dlg.length > 0;
  function showCards() {
    $("win").hidden = modal() || !ui.winOpen; $("end").hidden = modal() || !ui.endOpen;
    focusCard();
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
    if (kind === "bg" || kind === "theme") buildSky();
    boardKey = ""; basesHtml = "";
    renderHangar();
    if (game) refresh();
  });
  $("h-close").addEventListener("click", closeHangar);
  $("b-hangar").addEventListener("click", () => (ui.hangar ? closeHangar() : openHangar()));
  $("b-tech").addEventListener("click", () => (ui.tech ? closeTech() : openTech()));
  $("t-close").addEventListener("click", closeTech);
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
        th.tabIndex = 0; th.dataset.key = key; th.setAttribute("role", "button");
        th.addEventListener("keydown", ev => {   // Enter sorts from the keyboard; the table is rebuilt, so focus goes back to the same header
          if (ev.key !== "Enter") return;
          ev.preventDefault(); opts.onSort(key);
          const again = $("dlg-body").querySelector('th[data-key="' + key + '"]');
          if (again) again.focus();
        });
      }
      tr.appendChild(th);
    });
    t.appendChild(el("thead", "", null, [tr]));
    const body = el("tbody");
    rows.forEach((cells, i) => {
      const r = el("tr", (opts.rowClass && opts.rowClass(i)) || "");
      cells.forEach(c => r.appendChild(el("td", "", c)));
      if (opts.onRow) {
        r.classList.add("click"); r.addEventListener("click", () => opts.onRow(i));
        r.tabIndex = 0;
        r.addEventListener("keydown", ev => { if (ev.key === "Enter") { ev.preventDefault(); opts.onRow(i); } });
      }
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
    if (!ui.dlg.length) dlgOpener = document.activeElement;
    ui.dlg.push({ view, id });
    showDlg();
  }
  let dlgOpener = null;
  function dlgClosed() {
    if (ui.dlg.length) return;
    syncInert();
    focusBack(dlgOpener, null);
    dlgOpener = null;
  }
  function popDlg() { ui.dlg.pop(); showDlg(); dlgClosed(); }
  function closeAllDlg() { ui.dlg.length = 0; showDlg(); dlgClosed(); }
  function showDlg() {
    const top = ui.dlg[ui.dlg.length - 1];
    $("dlg").hidden = !top;
    if (!top) { $("dlg-body").textContent = ""; showCards(); return; }
    $("win").hidden = true; $("end").hidden = true;
    syncInert();
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
    $("win").hidden = true; $("end").hidden = true; $("hangar").hidden = true; $("tech").hidden = true; $("dlg").hidden = true;   // an open Players/Scores/Stats stack waits underneath
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
    $("hangar").hidden = !ui.hangar; $("tech").hidden = !ui.tech;
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
    const sel = chosenShip();
    if (sel && !sel.dead && isWar(sel)) {   // with a warship selected, an alien under the pointer is the target
      let ad = Infinity, al = null;
      for (const a of game.aliens) {
        const d = Math.hypot(a.x - p.x, a.y - p.y);
        if (d <= Math.max(G.TUNING.aliens.r + 8, 14 / view.sc) && d < ad) { ad = d; al = a; }
      }
      if (al) return { kind: "alien", o: al };
      let nd = Infinity, ne = null;   // no alien there: a live nest or the beacon
      for (const n of game.nests || []) {
        if (n.dead) continue;
        const d = Math.hypot(n.x - p.x, n.y - p.y);
        if (d <= Math.max((n.kind === "beacon" ? G.NEST_GEO.beaconR : G.NEST_GEO.nestR) + 8, 14 / view.sc) && d < nd) { nd = d; ne = n; }
      }
      if (ne) return { kind: "nest", o: ne };
    }
    let ship = null, sd = Infinity;   // ships win over whatever is beneath them
    for (const s of game.ships) {
      if (s.dead) continue;
      const d = Math.hypot(s.x - p.x, s.y - p.y);
      if (d <= sr && d < sd) { sd = d; ship = s; }
    }
    return ship ? { kind: "ship", o: ship } : best;
  }

  function select(id) {
    clearDigits();
    ui.selected = id;
    ui.placing = false;
    boardKey = ""; buildHtml = "";
    refresh();
  }

  function tryPlace(p) {
    const r = G.placeBase(game, p.x, p.y, labelArg());
    if (!r.ok) return toast(r.reason);
    ui.placing = false; ui.cursor = null;
    saveNow();
    buildHtml = ""; basesHtml = "";
    refresh();
  }

  function onClick(ev) {
    if (!game || modal()) return;
    const p = toWorld(ev);
    if (ui.placing) return tryPlace(p);
    const h = hit(p), sel = chosenShip(), war = !!sel && !sel.dead && isWar(sel);
    if (war && ev.shiftKey && h && h.kind === "ship" && h.o.id !== sel.id) {   // Shift+click one of our ships: escort it
      const r = G.orderEscort(game, sel.id, h.o.id);
      if (!r.ok) return toast(r.reason);
      return refresh();
    }
    if (h && h.kind === "ship") return select(h.o.id === ui.selected ? null : h.o.id);
    if (ui.selected == null) {
      if (h && h.kind === "star") toast(`Select ${an(shipWord())} first, then click the star.`);
      return;
    }
    if (war) {   // a warship: attack an alien, patrol at an empty spot, go home to a base; it cannot mine
      if (h && h.kind === "alien") { const r = G.orderAttack(game, sel.id, h.o.id); if (!r.ok) return toast(r.reason); }
      else if (h && h.kind === "nest") { const r = G.orderAttack(game, sel.id, { kind: "nest", id: h.o.id }); if (!r.ok) return toast(r.reason); }
      else if (h && h.kind === "base") G.returnToBase(game, sel.id, game.bases.indexOf(h.o), labelArg());
      else if (h) {   // a body or star: the rules say why a warship cannot take it
        const r = h.kind === "star" ? G.orderShipToStar(game, sel.id, h.o.id) : G.orderShip(game, sel.id, h.o.id, labelArg());
        return toast(r.ok ? "Warships do not mine." : r.reason);
      }
      else { const r = G.orderPatrol(game, sel.id, p.x, p.y); if (!r.ok) return toast(r.reason); }
      return refresh();
    }
    if (h && h.kind === "body") {
      const r = G.orderShip(game, ui.selected, h.o.id, labelArg());
      if (!r.ok) return toast(r.reason);
    } else if (h && h.kind === "star") {
      const r = G.orderShipToStar(game, ui.selected, h.o.id);
      if (!r.ok) return toast(r.reason);
    } else if (h && h.kind === "base") G.returnToBase(game, ui.selected, h.o.id, labelArg());
    else return select(null);
    refresh();
  }

  canvas.addEventListener("click", onClick);
  canvas.addEventListener("mousemove", ev => {
    ui.mouse = toWorld(ev);
    ui.cursor = null;   // the mouse takes the placement ghost back from the keyboard cursor
    if (!game) return;
    const h = hit(ui.mouse);
    canvas.style.cursor = ui.placing ? "crosshair" : h ? "pointer" : "default";
  });
  canvas.addEventListener("mouseleave", () => { ui.mouse = null; });

  $("build").addEventListener("click", ev => {
    const btn = ev.target.closest("[data-build]");
    if (!btn || !game) return;
    const key = btn.dataset.build;
    if (key === "base") {
      ui.placing = !ui.placing; ui.selected = null; boardKey = ""; buildHtml = "";
      ui.cursor = ui.placing && ui.keyboard ? { x: game.w / 2, y: game.h / 2 } : null;   // keyboard placement starts mid-map
      if (ui.placing && document.activeElement && document.activeElement.blur) document.activeElement.blur();   // Enter and Esc now go to the game
      refresh(); return;
    }
    const r = G.buildShip(game, key, labelArg());
    if (!r.ok) toast(r.reason);
    else { select(r.ship.id); saveNow(); }
    refresh();
  });
  $("bases").addEventListener("click", ev => {
    const btn = ev.target.closest("[data-act]");
    if (!btn || !game) return;
    const [act, id, kind] = btn.dataset.act.split(":"), i = Number(id);
    const r = act === "add" ? G.buildAddon(game, i, kind, labelArg())
      : act === "fix" ? G.repairBase(game, i, labelArg())
      : G.upgradeBase(game, i, labelArg());
    if (!r.ok) return toast(r.reason);
    saveNow();
    buildHtml = ""; basesHtml = "";
    refresh();
  });
  $("board").addEventListener("click", ev => {
    if (!game) return;
    const fix = ev.target.closest("[data-fix]");
    if (fix) {   // the Repair button on a row
      const r = G.repairShip(game, Number(fix.dataset.fix), labelArg());
      if (!r.ok) toast(r.reason); else saveNow();
      refresh();
      return;
    }
    const li = ev.target.closest("[data-ship]");
    if (!li) return;
    const id = Number(li.dataset.ship);
    if (game.ships[id] && game.ships[id].dead) return toast(game.ships[id].name + " was lost.");
    select(id === ui.selected ? null : id);
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
    if (ui.tech) return closeTech();
    clearDigits();
    const sel = game && ui.selected != null ? game.ships[ui.selected] : null;
    if (sel && sel.st === G.MANUAL) { G.releaseManual(game, sel.id); refresh(); return; }   // hand the ship back first
    ui.placing = false; ui.cursor = null; ui.selected = null; boardKey = ""; buildHtml = "";
    refresh();
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
  // ---------------------------------------------------------------- keyboard mode
  // Tab cycles ships whether or not keyboard mode is on. Everything else below needs it on (K toggles it).
  // keyActive is the one guard for every game key: nothing happens while a dialog, card or the feedback form is up,
  // or while focus is in a text box, so typing a name with K, F, E, H, WASD or digits works as normal.

  const held = { up: false, down: false, left: false, right: false };
  const DIR_KEYS = { arrowup: "up", w: "up", arrowdown: "down", s: "down", arrowleft: "left", a: "left", arrowright: "right", d: "right" };
  const digits = { s: "", timer: 0 };

  function keyActive(ev) {
    if (!game || ui.feedback || ui.hangar || ui.tech || ui.dlg.length || ui.winOpen || ui.endOpen) return false;
    if (!$("win").hidden || !$("end").hidden) return false;
    const t = ev && ev.target, tag = t && t.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || (t && t.isContentEditable)) return false;
    return !(ev.ctrlKey || ev.metaKey || ev.altKey);
  }

  const chosenShip = () => (game && ui.selected != null ? game.ships[ui.selected] : null);
  function needShip() {
    const s = chosenShip();
    if (!s) toast(`Select ${an(shipWord())} first (Tab).`);
    else if (s.dead) { toast(`${shipName(s)} was lost. Press Tab to pick another.`); return null; }
    return s;
  }

  // The selected ship when it is a live warship, else a toast.
  function needWar() {
    const s = needShip();
    if (s && !isWar(s)) { toast("Select a warship first (Tab). Warships come from the Build panel."); return null; }
    return s;
  }

  // R: repair the selected ship; if it is not damaged, the base it is docked at. Works with keyboard mode off too.
  function repairKey() {
    const s = needShip();
    if (!s) return;
    let r;
    const downAt = atBase(s, true);
    if (s.hp < s.maxHp && !(downAt >= 0 && game.bases[downAt].down)) r = G.repairShip(game, s.id, labelArg());
    else {
      const at = downAt;
      if (at < 0) return toast(`${shipName(s)} is not damaged. Fly it to a ${themed() ? LB().base : "base"} to repair the ${themed() ? LB().base : "base"}.`);
      if (!(game.bases[at].hp < game.bases[at].maxHp)) return toast(`${shipName(s)} and this ${themed() ? LB().base : "base"} are not damaged.`);
      r = G.repairBase(game, at, labelArg());
    }
    if (!r.ok) toast(r.reason); else { saveNow(); basesHtml = ""; }
    refresh();
  }

  function attackKey() {
    const s = needWar();
    if (!s) return;
    const id = G.nearestAlien(game, s.x, s.y);
    let target = id;
    if (id < 0) {   // no raiders or guards: the nearest nest or the beacon
      let best = null, bd = Infinity;
      for (const n of game.nests || []) {
        const d = Math.hypot(n.x - s.x, n.y - s.y);
        if (!n.dead && d < bd) { bd = d; best = n; }
      }
      if (!best) return toast("No aliens on the map.");
      target = { kind: "nest", id: best.id };
    }
    const r = G.orderAttack(game, s.id, target);
    if (!r.ok) toast(r.reason);
    refresh();
  }

  function patrolKey() {
    const s = needWar();
    if (!s) return;
    const r = G.orderPatrol(game, s.id, s.x, s.y);
    if (!r.ok) toast(r.reason);
    refresh();
  }

  function escortKey() {
    const s = needWar();
    if (!s) return;
    let best = null, bd = Infinity;
    for (const o of game.ships) {
      if (o.dead || isWar(o)) continue;
      const d = Math.hypot(o.x - s.x, o.y - s.y);
      if (d < bd) { bd = d; best = o; }
    }
    if (!best) return toast(`No ${shipWord()} left to escort.`);
    const r = G.orderEscort(game, s.id, best.id);
    if (!r.ok) toast(r.reason);
    refresh();
  }

  function mouseFocused(a) {   // a button the mouse clicked: Tab should still cycle ships, not walk the page
    try { return !a.matches(":focus-visible"); } catch (e) { return false; }
  }

  function cycleShip(dir) {
    const n = game.ships.length;
    if (!n) return;
    let id = ui.selected == null ? (dir > 0 ? -1 : 0) : ui.selected, tries = 0;
    do { id = (((id + dir) % n) + n) % n; tries++; } while (game.ships[id].dead && tries <= n);   // lost ships are skipped
    if (game.ships[id].dead) return;                                                              // every ship is lost
    select(id);
    const row = boardRows[id];
    if (row && row.li.scrollIntoView) row.li.scrollIntoView({ block: "nearest" });
  }

  // Tab/Shift+Tab take over only on the map, or on a top-bar or panel button focused by the mouse. Never in a dialog
  // (keyActive), and a keyboard-focused button keeps the normal Tab walk so every control stays reachable.
  function onTab(ev) {
    if (!keyActive(ev)) return;
    const a = document.activeElement;
    const onMap = !a || a === document.body || a === canvas || (a.closest && a.closest("#topbar, #side") && mouseFocused(a));
    if (!onMap) return;
    ev.preventDefault();
    cycleShip(ev.shiftKey ? -1 : 1);
  }

  function clearDigits() { clearTimeout(digits.timer); digits.s = ""; digits.timer = 0; }

  function orderTarget(n) {
    const sh = needShip();
    if (!sh) return;
    const r = G.orderToTarget(game, sh.id, n, labelArg());
    if (!r.ok) toast(r.reason);
    refresh();
  }

  // Digits typed within 0.6 s of each other make one number (1 then 2 is 12); 1-9 act at once when no longer number exists.
  function typeDigit(d) {
    if (!needShip()) { clearDigits(); return; }
    clearTimeout(digits.timer);
    const count = game.bodies.length + game.stars.length;
    digits.s += d;
    let r = G.resolveTargetKeys(digits.s, count);
    if (r.n == null && !r.wait && digits.s.length > 1) { digits.s = d; r = G.resolveTargetKeys(d, count); }   // not a number: start over
    if (r.n == null && !r.wait) { clearDigits(); toast("No target " + d + "."); return; }
    if (r.wait) {
      const g0 = game, sel0 = ui.selected;
      digits.timer = setTimeout(() => {
        const n = r.n; clearDigits();
        if (n != null && game === g0 && ui.selected === sel0 && !modal()) orderTarget(n);
      }, 600);
      return;
    }
    clearDigits();
    orderTarget(r.n);
  }

  function toggleManual() {
    const sh = needShip();
    if (!sh) return;
    const r = sh.st === G.MANUAL ? G.releaseManual(game, sh.id) : G.takeManual(game, sh.id);
    if (!r.ok) toast(r.reason);
    refresh();
  }

  function manualAct() {
    const sh = needShip();
    if (!sh) return;
    if (sh.st !== G.MANUAL) return toast("Press F to fly this ship by hand first.");
    const r = G.manualAction(game, sh.id, labelArg());
    if (!r.ok) toast(r.reason);
    refresh();
  }

  // Each tick the keys held now become the input of the selected manual ship; other manual ships hold still.
  function syncManualInput() {
    const ix = (held.right ? 1 : 0) - (held.left ? 1 : 0), iy = (held.down ? 1 : 0) - (held.up ? 1 : 0);
    const ships = game.ships;
    for (let i = 0; i < ships.length; i++) {
      if (ships[i].st !== G.MANUAL) continue;
      const own = ui.keyboard && ships[i].id === ui.selected;
      G.setManualInput(game, ships[i].id, own ? ix : 0, own ? iy : 0);
    }
  }

  function placementKey(ev, lk) {
    if (ev.key === "Enter") {
      ev.preventDefault();
      const p = ui.cursor || ui.mouse;
      if (p) tryPlace(p); else toast("Move the cursor with the arrow keys first.");
      return;
    }
    const dir = DIR_KEYS[lk];
    if (!dir) return;
    ev.preventDefault();
    const step = ev.shiftKey ? 40 : 10, c = ui.cursor || (ui.cursor = { x: game.w / 2, y: game.h / 2 });
    c.x = Math.max(0, Math.min(game.w, c.x + (dir === "right" ? step : dir === "left" ? -step : 0)));
    c.y = Math.max(0, Math.min(game.h, c.y + (dir === "down" ? step : dir === "up" ? -step : 0)));
  }

  function focusBuild() {
    const b = $("build").querySelector("button:not([disabled])") || $("side").querySelector("button:not([disabled])");
    if (b) b.focus(); else toast("Nothing to press in the panels yet.");
  }

  window.addEventListener("keydown", ev => {
    if (!game || !ev.key) return;
    if (ev.key === "Tab") return onTab(ev);
    if (!keyActive(ev)) return;
    const lk = ev.key.toLowerCase();
    if (lk === "k") { if (!ev.repeat) setKeyboard(!ui.keyboard); return; }
    if (!ui.placing && !ev.repeat) {
      if (lk === "r") { repairKey(); return; }   // repair works with keyboard mode off
      if (lk === "t") { openTech(); return; }       // T, C and M also work with keyboard mode off
      if (lk === "c") { focusEcon(); return; }
      if (lk === "m") { toggleMothball(); return; }
      if ((lk === "x" || lk === "p" || lk === "g") && (ui.keyboard || isWar(chosenShip()))) {   // warship orders: with a warship selected, or in keyboard mode
        if (lk === "x") attackKey(); else if (lk === "p") patrolKey(); else escortKey();
        return;
      }
    }
    if (!ui.keyboard) return;
    if (ui.placing) return placementKey(ev, lk);
    if (ev.key >= "0" && ev.key <= "9" && ev.key.length === 1) { if (!ev.repeat && !ev.shiftKey) typeDigit(ev.key); return; }
    const dir = DIR_KEYS[lk];
    if (dir) {
      const sh = chosenShip();
      if (sh && sh.st === G.MANUAL) { ev.preventDefault(); held[dir] = true; }
      return;
    }
    if (ev.repeat) return;
    if (lk === "h") { const sh = needShip(); if (sh) { const r = G.orderNearestBase(game, sh.id, labelArg()); if (!r.ok) toast(r.reason); refresh(); } }
    else if (lk === "f") toggleManual();
    else if (lk === "e") manualAct();
    else if (lk === "b") focusBuild();
  });
  window.addEventListener("keyup", ev => { const d = ev.key && DIR_KEYS[ev.key.toLowerCase()]; if (d) held[d] = false; });   // always, so a key never sticks
  window.addEventListener("blur", () => { held.up = held.down = held.left = held.right = false; });

  function setKeyboard(on) {
    ui.keyboard = !!on;
    if (!ui.keyboard) {   // hand every hand-flown ship back, and drop half-typed numbers and the placement cursor
      if (game) for (const sh of game.ships) if (sh.st === G.MANUAL) G.releaseManual(game, sh.id);
      clearDigits(); ui.cursor = null;
      held.up = held.down = held.left = held.right = false;
    } else if (ui.placing && game) ui.cursor = { x: game.w / 2, y: game.h / 2 };
    store(KEYBOARD_KEY, ui.keyboard ? "1" : "0", "the keyboard setting");
    applyKeyboardUi();
    if (game) refresh();
  }

  let legendKey = null;
  function renderLegend() {
    const key = ui.keyboard + "|" + themeId();
    if (key === legendKey) return;
    legendKey = key;
    const box = $("keys");
    box.hidden = !ui.keyboard;
    if (!ui.keyboard) return;
    const L = LB(), sh = shipWord(), base = themed() ? L.base : "base";
    const rows = [["Tab / Shift+Tab", "next / previous " + sh], ["1-9, 0", "send it to that target (two digits: type fast)"],
      ["H", "nearest " + base], ["F", "fly it by hand / hand back"], ["WASD, arrows", "steer"], ["E", "mine or unload nearby, again to stop"],
      ["R", "repair it, or the " + base + " it is at (works with keyboard mode off)"],
      ["X", "warship: attack the nearest alien"], ["P", "warship: patrol where it is"], ["G", "warship: escort the nearest " + sh + " (not a warship)"],
      ["T", "tech tree (science from conquest)"], ["C", "focus the credits panel"], ["M", "mothball or wake it"],
      ["B", "focus the build panel"], ["Esc", "hand back, then cancel"], ["K", "keyboard mode off"]];
    box.textContent = "";
    box.appendChild(el("b", "", "Keys"));
    for (const [k, t] of rows) box.appendChild(el("div", "", null, [el("kbd", "", k), el("span", "", " " + t)]));
  }

  function applyKeyboardUi() {
    $("b-keys").setAttribute("aria-pressed", ui.keyboard ? "true" : "false");
    $("b-keys").classList.toggle("active", ui.keyboard);
    renderLegend();
  }
  $("b-keys").addEventListener("click", () => setKeyboard(!ui.keyboard));

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
      $("fps").textContent = `${Math.round(fps.frames / fps.acc)} fps, worst ${Math.round(fps.worst)} ms, ${game.ships.length} ${lc(LB().ships)}`;
      fps.frames = 0; fps.acc = 0; fps.worst = 0;
    }
    const running = !ui.paused && !modal() && !game.over;
    if (running) {   // fixed-step simulation; drawing happens once per animation frame
      syncManualInput();
      acc += dt;
      let n = 0;
      while (acc >= STEP && n < MAX_STEPS) { G.step(game, STEP); time += STEP; acc -= STEP; n++; addTrailPoints(); }
      if (n === MAX_STEPS) acc = 0;
      for (const e of G.drainEvents(game)) { onScienceMsg(e); onEconMsg(e); }
      G.checkWin(game);
      if (game.starsGot !== ui.starsSeen || game.over || (game.won && !ui.winShown)) refresh();
    }
    frame(running ? dt : 0);
    if (t - lastBoard > 250) { lastBoard = t; refresh(); }
    if (t - lastSave > 10000) { lastSave = t; saveNow(); }
  }

  // ---------------------------------------------------------------- go

  ui.keyboard = readKey(KEYBOARD_KEY) === "1";
  applyKeyboardUi();
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
