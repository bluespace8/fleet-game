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
  const BAD_KEY = "fleet-game-damaged-save-v1";  // a copy of the last damaged save, kept for the player
  const STEP = 1 / 30, MAX_STEPS = 6;          // fixed simulation step, and a cap so a slow frame cannot spiral
  const STRESS = /[?&]stress\b/.test(location.search);
  const WORLD = { w: G.WORLD_W, h: G.WORLD_H };

  const SHIP_COLOR = { miner: "#5b9cf0", hauler: "#f0b020" };
  const RES_COLOR = { ore: "#e08a50", ice: "#7fd8f0", crystal: "#e27be0" };
  const BODY_HUE = {   // [light, base, dark], like PLANET_HUES in mission.js
    asteroid: ["#d9b08c", "#8a6044", "#33211a"], moon: ["#e4f6ff", "#7aa8c4", "#1f3342"],
    iceplanet: ["#9fe3f0", "#2f8fa8", "#0e3440"], rare: ["#e2b7ff", "#a64fc4", "#341d4f"],
  };

  let game = null;
  const ui = { selected: null, placing: false, paused: false, mouse: null, winShown: false };
  const view = { sc: 1, ox: 0, oy: 0, W: 1, H: 1, dpr: 1 };
  let stars = [], nebula = null;
  const trails = new Map();
  const shapes = new Map();
  let time = 0, acc = 0, lastT = 0, lastBoard = 0, lastSave = 0, boardKey = "", buildHtml = "", toastTimer = 0;
  const fps = { frames: 0, acc: 0, worst: 0 };

  // ---------------------------------------------------------------- game lifecycle

  function freshGame() {
    const g = G.newGame((Math.random() * 4294967296) >>> 0);
    if (STRESS) G.spawnStress(g, 30);
    return g;
  }

  function start(g) {
    game = g;
    ui.selected = null; ui.placing = false; ui.winShown = !!g.won; acc = 0;
    trails.clear(); shapes.clear();
    boardKey = ""; buildHtml = "";
    $("win").hidden = true;
    refresh();
  }

  function newGame(ask) {
    if (ask && !confirm("Start a new game with a new map? Unsaved progress is lost.")) return;
    start(freshGame());
    saveNow();
  }

  function saveNow(key) {
    if (STRESS) return true;   // never overwrite a real save with the 30-ship test fleet
    try { localStorage.setItem(key || AUTO_KEY, G.serialize(game)); return true; }
    catch (e) { toast("Could not save: " + e.message); return false; }
  }

  // Try the saves in order. Returns { state } for the first good one, plus a notice when a damaged
  // one was passed over. A damaged save is copied to BAD_KEY first so nothing is lost silently.
  function readSaves(keys) {
    let notice = "", found = false;
    for (const key of keys) {
      let text = null;
      try { text = localStorage.getItem(key); } catch (e) { continue; }
      if (!text) continue;
      found = true;
      const res = G.deserialize(text);
      if (res.ok) return { state: res.state, notice };
      try { localStorage.setItem(BAD_KEY, text); } catch (e) { /* storage full; the notice still shows */ }
      notice = (key === SAVE_KEY ? "Your saved game" : "The autosave") + " was damaged (" + res.error.replace(/.$/, "") + ").";
    }
    return { state: null, notice, found };
  }

  function loadNow() {
    const r = readSaves([SAVE_KEY, AUTO_KEY]);
    if (!r.state) { toast(r.notice ? r.notice + " Nothing to load." : "Nothing saved yet."); return false; }
    start(r.state);
    if (r.notice) toast(r.notice + " Loaded the other save.");
    return true;
  }

  function toast(msg) {
    const el = $("toast");
    el.textContent = msg;
    el.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove("show"), msg.length > 50 ? 5500 : 2200);
  }

  // ---------------------------------------------------------------- canvas setup

  function resize() {
    const r = canvas.getBoundingClientRect();
    view.dpr = Math.min(window.devicePixelRatio || 1, 2);
    view.W = Math.max(1, r.width); view.H = Math.max(1, r.height);
    canvas.width = Math.round(view.W * view.dpr);
    canvas.height = Math.round(view.H * view.dpr);
    const top = 56;
    view.sc = Math.max(0.2, Math.min(view.W / WORLD.w, (view.H - top - 10) / WORLD.h));
    view.ox = (view.W - WORLD.w * view.sc) / 2;
    view.oy = top + (view.H - top - 10 - WORLD.h * view.sc) / 2;
    buildSky();
  }

  function buildSky() {
    const { W, H, dpr } = view;
    const count = Math.min(420, Math.round((W * H) / 3000));
    stars = Array.from({ length: count }, () => {
      const layer = Math.random() < 0.6 ? 0 : Math.random() < 0.75 ? 1 : 2;
      return { x: Math.random() * W, y: Math.random() * H, layer, r: [0.6, 1, 1.5][layer] * (0.7 + Math.random() * 0.6),
        a: [0.45, 0.7, 0.95][layer], ph: Math.random() * 6.28, sp: 0.6 + Math.random() * 2.2,
        tint: Math.random() < 0.15 ? "#ffd9b0" : Math.random() < 0.3 ? "#b9d4ff" : "#ffffff" };
    });
    nebula = document.createElement("canvas");
    nebula.width = canvas.width; nebula.height = canvas.height;
    const n = nebula.getContext("2d");
    n.scale(dpr, dpr);
    const base = n.createLinearGradient(0, 0, W, H);
    base.addColorStop(0, "#03040b"); base.addColorStop(1, "#090a1c");
    n.fillStyle = base; n.fillRect(0, 0, W, H);
    const blob = (x, y, r, color) => {
      const g = n.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, color); g.addColorStop(1, "rgba(0,0,0,0)");
      n.fillStyle = g; n.fillRect(0, 0, W, H);
    };
    const big = Math.max(W, H);
    blob(W * 0.22, H * 0.28, big * 0.55, "rgba(98,80,214,0.20)");
    blob(W * 0.82, H * 0.72, big * 0.5, "rgba(42,120,214,0.16)");
    blob(W * 0.62, H * 0.12, big * 0.32, "rgba(232,123,164,0.07)");
    blob(W * 0.1, H * 0.9, big * 0.3, "rgba(27,175,122,0.06)");
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
    for (const s of stars) {
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

  function drawBase(b, i) {
    const color = i === 0 ? "#a197f2" : "#5fd0b0";
    const sr = G.BASE_R, rot = reduceMotion ? 0 : time * 0.3 + i;
    const glow = ctx.createRadialGradient(b.x, b.y, sr * 0.3, b.x, b.y, sr * 3);
    glow.addColorStop(0, hexA(color, 0.4)); glow.addColorStop(1, hexA(color, 0));
    ctx.fillStyle = glow;
    ctx.beginPath(); ctx.arc(b.x, b.y, sr * 3, 0, Math.PI * 2); ctx.fill();
    ctx.save();
    ctx.translate(b.x, b.y);
    ctx.rotate(rot);
    ctx.strokeStyle = hexA(color, 0.75); ctx.lineWidth = 2;
    ctx.setLineDash([sr * 0.5, sr * 0.22]);
    ctx.beginPath(); ctx.arc(0, 0, sr * 1.5, 0, Math.PI * 2); ctx.stroke();
    ctx.setLineDash([]);
    for (let k = 0; k < 4; k++) {
      ctx.rotate(Math.PI / 2);
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
    ctx.fillStyle = "#17143a"; ctx.fill();
    ctx.strokeStyle = color; ctx.lineWidth = 1.6; ctx.stroke();
    ctx.restore();
    const core = ctx.createRadialGradient(b.x, b.y, 0, b.x, b.y, sr * 0.55);
    core.addColorStop(0, "#ffffff"); core.addColorStop(0.35, hexA(color, 0.9)); core.addColorStop(1, hexA(color, 0));
    ctx.fillStyle = core;
    ctx.beginPath(); ctx.arc(b.x, b.y, sr * 0.55, 0, Math.PI * 2); ctx.fill();
    ctx.textAlign = "center";
    ctx.font = "700 11px system-ui, sans-serif";
    ctx.fillStyle = "rgba(235,232,255,0.95)";
    ctx.fillText(i === 0 ? "HOME" : "BASE " + (i + 1), b.x, b.y + sr * 1.5 + 16);
  }

  function drawTrail(ship, color) {
    const t = trails.get(ship.id);
    if (!t || t.length < 2) return;
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
    const color = SHIP_COLOR[ship.type];
    const busy = ship.st !== G.IDLE;
    const moving = ship.st === G.TO_BODY || ship.st === G.TO_BASE;
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
    for (const b of game.bodies) drawBody(b);
    game.bases.forEach(drawBase);
    for (const s of game.ships) drawTrail(s, SHIP_COLOR[s.type]);
    for (const s of game.ships) if (s.st === G.MINING) drawBeam(s);
    for (const s of game.ships) drawShip(s);
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
    const items = [["miner", "Miner", G.SHIP_TYPES.miner.blurb, G.SHIP_TYPES.miner.cost],
      ["hauler", "Hauler", G.SHIP_TYPES.hauler.blurb, G.SHIP_TYPES.hauler.cost],
      ["base", "New base", "Click empty space to place it", G.BASE_COST]];
    const html = items.map(([key, label, note, cost]) => {
      const ok = G.canAfford(game, cost);
      return `<button type="button" class="build-btn${key === "base" && ui.placing ? " active" : ""}" data-build="${key}"${ok ? "" : " disabled"}>
        <b>${label}</b> <small>${costText(cost)}</small><small>${note}</small></button>`;
    }).join("");
    if (html !== buildHtml) { buildHtml = html; $("build").innerHTML = html; }
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
      const sig = s.name + "|" + s.type + "|" + s.st + "|" + s.res + "|" + pct + "|" + G.jobText(game, s) + "|" + (s.id === ui.selected);
      if (sig === row.last) continue;
      row.last = sig;
      row.li.className = s.id === ui.selected ? "sel" : "";
      row.dot.style.background = SHIP_COLOR[s.type];
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
    $("goal").textContent = `Bases built ${game.bases.length - 1} / ${G.GOAL_BASES}`;
    renderBuild();
    renderBoard();
    $("b-pause").textContent = ui.paused ? "Resume" : "Pause";
    $("paused").style.display = ui.paused ? "block" : "none";
    const hint = $("hint");
    hint.style.display = ui.placing || ui.selected != null ? "block" : "none";
    hint.textContent = ui.placing ? "Click empty space to place the base (Esc to cancel)"
      : "Click a planet or asteroid to send this ship to mine it; click a base to send it home";
    if (game.won && !ui.winShown) showWin();
  }

  function showWin() {
    ui.winShown = true;
    const m = game.stats, mins = Math.floor(game.time / 60), secs = Math.floor(game.time % 60);
    $("win-text").textContent = `You built ${G.GOAL_BASES} bases in ${mins}m ${secs}s with ${game.ships.length} ships. ` +
      `Mined ${Math.floor(m.ore)} ore, ${Math.floor(m.ice)} ice and ${Math.floor(m.crystal)} crystal.`;
    $("win").hidden = false;
  }

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
    if (!game) return;
    const p = toWorld(ev);
    if (ui.placing) {
      const r = G.placeBase(game, p.x, p.y);
      if (!r.ok) return toast(r.reason);
      ui.placing = false;
      saveNow();
      buildHtml = "";
      refresh();
      return;
    }
    const h = hit(p);
    if (h && h.kind === "ship") return select(h.o.id === ui.selected ? null : h.o.id);
    if (ui.selected == null) return;
    if (h && h.kind === "body") {
      const r = G.orderShip(game, ui.selected, h.o.id);
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
  $("board").addEventListener("click", ev => {
    const li = ev.target.closest("[data-ship]");
    if (li) select(Number(li.dataset.ship) === ui.selected ? null : Number(li.dataset.ship));
  });

  function setPaused(v) { ui.paused = v; refresh(); }
  $("b-pause").addEventListener("click", () => setPaused(!ui.paused));
  $("b-save").addEventListener("click", () => { if (saveNow(SAVE_KEY)) toast(STRESS ? "Stress mode does not save." : "Saved."); });
  $("b-load").addEventListener("click", () => { if (loadNow()) toast("Loaded."); });
  $("b-new").addEventListener("click", () => newGame(true));
  $("w-new").addEventListener("click", () => newGame(false));
  $("w-keep").addEventListener("click", () => { $("win").hidden = true; });
  window.addEventListener("keydown", ev => {
    if (ev.key === "Escape") { ui.placing = false; ui.selected = null; boardKey = ""; buildHtml = ""; refresh(); }
  });
  // Space toggles pause wherever focus is. It is handled in the capture phase and cancelled, so a
  // focused button does not also "click" (keydown for most browsers, keyup for Firefox).
  const isSpace = ev => ev.key === " " || ev.code === "Space";
  window.addEventListener("keydown", ev => {
    if (!isSpace(ev)) return;
    ev.preventDefault();
    if (!ev.repeat) setPaused(!ui.paused);
  }, true);
  window.addEventListener("keyup", ev => { if (isSpace(ev)) ev.preventDefault(); }, true);
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
    if (!ui.paused) {   // fixed-step simulation; drawing happens once per animation frame
      acc += dt;
      let n = 0;
      while (acc >= STEP && n < MAX_STEPS) { G.step(game, STEP); time += STEP; acc -= STEP; n++; }
      if (n === MAX_STEPS) acc = 0;
      for (const s of game.ships) {
        let tr = trails.get(s.id);
        if (!tr) trails.set(s.id, tr = []);
        const moving = s.st === G.TO_BODY || s.st === G.TO_BASE;
        if (moving) tr.push([s.x, s.y]);
        if (tr.length > 14 || (!moving && tr.length)) tr.shift();
      }
      G.checkWin(game);
    }
    frame(ui.paused ? 0 : dt);
    if (t - lastBoard > 250) { lastBoard = t; refresh(); }
    if (t - lastSave > 10000) { lastSave = t; saveNow(); }
  }

  // ---------------------------------------------------------------- go

  resize();
  let first = null, notice = "";
  if (!STRESS) {
    const r = readSaves([AUTO_KEY, SAVE_KEY]);   // the autosave is the newest; the manual save is the fallback
    first = r.state; notice = r.notice;
  }
  start(first || freshGame());
  if (notice) toast(notice + (first ? " Loaded the other save." : " Started a new game; a copy of the damaged save was kept."));
  requestAnimationFrame(t => { lastT = t; lastSave = t; requestAnimationFrame(loop); });

  // for debugging from the console
  window.__fleet = { get game() { return game; }, ui };
})();
