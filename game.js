"use strict";

// Fleet game logic. No DOM, no timers, no randomness except the seeded generator, so it runs
// unchanged in the browser (as the global FleetGame) and under Node (module.exports, see tests.js).
//
// State is plain data (numbers, strings, arrays), so saving is JSON. Bodies, bases and ships are
// never removed, so an id is also its index in the array; that keeps the hot loop free of lookups.

(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.FleetGame = factory();
})(typeof self !== "undefined" ? self : this, function () {
  const VERSION = 1;
  const WORLD_W = 1600, WORLD_H = 1000;
  const BASE_R = 26;            // drawn and docking radius of a base
  const BASE_GAP = 110;         // closest two bases may be
  const GOAL_BASES = 5;         // bases the player must build to win (home not counted, so 6 in all)
  const RES = ["ore", "ice", "crystal"];
  const START_STOCK = { ore: 70, ice: 0, crystal: 0 };

  // speed in world units per second, cap in units, rate in units mined per second.
  const SHIP_TYPES = {
    miner:  { label: "Miner",  speed: 85,  cap: 20, rate: 5, cost: { ore: 40, ice: 0, crystal: 0 },
              blurb: "Small and cheap. Carries 20." },
    hauler: { label: "Hauler", speed: 135, cap: 60, rate: 4, cost: { ore: 90, ice: 30, crystal: 0 },
              blurb: "Fast and large. Carries 60." },
  };
  const BASE_COST = { ore: 120, ice: 40, crystal: 15 };

  // ship states
  const IDLE = 0, TO_BODY = 1, MINING = 2, TO_BASE = 3;

  // ---------------------------------------------------------------- random

  function rng(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const SYL = ["ka", "ve", "lo", "ri", "tan", "mor", "zi", "bel", "or", "ix", "su", "dra", "nem", "pa", "qu", "ul"];
  function makeName(r, kind) {
    if (kind === "asteroid") return "Rock " + (10 + Math.floor(r() * 90));
    let s = "";
    const n = 2 + Math.floor(r() * 2);
    for (let i = 0; i < n; i++) s += SYL[Math.floor(r() * SYL.length)];
    return s[0].toUpperCase() + s.slice(1);
  }

  // ---------------------------------------------------------------- world

  const BODY_SPECS = [
    { kind: "asteroid",  res: "ore",     n: 3, r: [9, 15],  amt: [160, 300], minHome: 110, maxHome: 380 },
    { kind: "asteroid",  res: "ore",     n: 6, r: [9, 17],  amt: [160, 340], minHome: 160 },
    { kind: "moon",      res: "ice",     n: 2, r: [14, 19], amt: [140, 240], minHome: 150, maxHome: 520 },
    { kind: "iceplanet", res: "ice",     n: 2, r: [20, 28], amt: [200, 340], minHome: 260 },
    { kind: "rare",      res: "crystal", n: 3, r: [22, 29], amt: [80, 140],  minHome: 420 },
  ];

  function pickSpot(r, state, rad, minHome, maxHome, sep) {
    const m = 60;
    const home = state.bases[0];
    for (let i = 0; i < 300; i++) {
      const x = m + r() * (state.w - 2 * m), y = m + r() * (state.h - 2 * m);
      const dh = Math.hypot(x - home.x, y - home.y);
      if (dh < minHome + rad || (maxHome && dh > maxHome)) continue;
      let ok = true;
      for (let j = 0; j < state.bodies.length && ok; j++) {
        const b = state.bodies[j];
        if (Math.hypot(x - b.x, y - b.y) < b.r + rad + sep) ok = false;
      }
      if (ok) return { x, y };
    }
    return null;
  }

  function generateBodies(state, r) {
    for (const spec of BODY_SPECS) {
      for (let i = 0; i < spec.n; i++) {
        const rad = spec.r[0] + r() * (spec.r[1] - spec.r[0]);
        let spot = null;
        for (let sep = 46; sep >= 6 && !spot; sep -= 20) spot = pickSpot(r, state, rad, spec.minHome, spec.maxHome, sep);
        if (!spot) spot = pickSpot(r, state, rad, 60, 0, 4);   // very unlikely; keep the count
        if (!spot) continue;
        const amount = Math.round(spec.amt[0] + r() * (spec.amt[1] - spec.amt[0]));
        state.bodies.push({ id: state.bodies.length, kind: spec.kind, res: spec.res, name: makeName(r, spec.kind),
          x: spot.x, y: spot.y, r: rad, amount, max: amount });
      }
    }
  }

  function newGame(seed) {
    seed = (seed >>> 0);
    const r = rng(seed);
    const state = {
      ver: VERSION, seed, time: 0, w: WORLD_W, h: WORLD_H,
      bodies: [], bases: [], ships: [],
      stock: { ore: START_STOCK.ore, ice: START_STOCK.ice, crystal: START_STOCK.crystal },
      won: false, wonAt: 0, stress: false,
      stats: { ore: 0, ice: 0, crystal: 0 },   // total mined
    };
    state.bases.push({ id: 0, x: state.w / 2 + (r() - 0.5) * 260, y: state.h / 2 + (r() - 0.5) * 160, home: true });
    generateBodies(state, r);
    addShip(state, "miner");
    addShip(state, "miner");
    return state;
  }

  // ---------------------------------------------------------------- costs and building

  function canAfford(state, cost) {
    for (let i = 0; i < RES.length; i++) {
      if (state.stock[RES[i]] + 1e-9 < (cost[RES[i]] || 0)) return false;
    }
    return true;
  }

  function pay(state, cost) {
    for (let i = 0; i < RES.length; i++) state.stock[RES[i]] -= cost[RES[i]] || 0;
    for (let i = 0; i < RES.length; i++) if (state.stock[RES[i]] < 0) state.stock[RES[i]] = 0;
  }

  function addShip(state, type) {
    const id = state.ships.length;
    let count = 1;
    for (let i = 0; i < id; i++) if (state.ships[i].type === type) count++;
    const base = state.bases[0];
    const a = id * 2.399;
    const ship = { id, type, name: SHIP_TYPES[type].label + " " + count,
      x: base.x + Math.cos(a) * (BASE_R + 12), y: base.y + Math.sin(a) * (BASE_R + 12), ang: a,
      st: IDLE, target: -1, dest: -1, cargo: 0, res: "", mv: 0 };
    state.ships.push(ship);
    return ship;
  }

  function buildShip(state, type) {
    const def = SHIP_TYPES[type];
    if (!def) return { ok: false, reason: "Unknown ship type." };
    if (!canAfford(state, def.cost)) return { ok: false, reason: "Not enough materials for a " + def.label.toLowerCase() + "." };
    pay(state, def.cost);
    return { ok: true, ship: addShip(state, type) };
  }

  // Returns "" when a base can go at (x, y), otherwise the reason it cannot. Allocation free.
  function baseSpotProblem(state, x, y) {
    const m = BASE_R + 6;
    if (!(x >= m && y >= m && x <= state.w - m && y <= state.h - m)) return "Too close to the edge of space.";
    for (let i = 0; i < state.bases.length; i++) {
      if (Math.hypot(x - state.bases[i].x, y - state.bases[i].y) < BASE_GAP) return "Too close to another base.";
    }
    for (let i = 0; i < state.bodies.length; i++) {
      const b = state.bodies[i];
      if (Math.hypot(x - b.x, y - b.y) < b.r + BASE_R + 24) return "Too close to a planet or asteroid.";
    }
    return "";
  }

  function placeBase(state, x, y) {
    const problem = baseSpotProblem(state, x, y);
    if (problem) return { ok: false, reason: problem };
    if (!canAfford(state, BASE_COST)) return { ok: false, reason: "Not enough materials for a base." };
    pay(state, BASE_COST);
    const base = { id: state.bases.length, x, y, home: false };
    state.bases.push(base);
    checkWin(state);
    return { ok: true, base };
  }

  function checkWin(state) {
    if (!state.won && state.bases.length - 1 >= GOAL_BASES) { state.won = true; state.wonAt = state.time; }
    return state.won;
  }

  // ---------------------------------------------------------------- orders

  function orderShip(state, shipId, bodyId) {
    const ship = state.ships[shipId], body = state.bodies[bodyId];
    if (!ship || !body) return { ok: false, reason: "No such ship or body." };
    if (body.amount <= 1e-6) return { ok: false, reason: body.name + " is empty." };
    ship.target = bodyId;
    ship.dest = -1;
    // A loaded ship unloads first if it is already heading home or carries the wrong resource.
    // An empty hold has nothing to unload, so it goes straight to the new target.
    if (ship.cargo > 0 && (ship.st === TO_BASE || ship.res !== body.res)) ship.st = TO_BASE;
    else ship.st = TO_BODY;
    return { ok: true };
  }

  function recallShip(state, shipId) {
    const ship = state.ships[shipId];
    if (!ship) return { ok: false, reason: "No such ship." };
    ship.target = -1;
    ship.dest = -1;
    if (ship.st !== IDLE) ship.st = TO_BASE;
    return { ok: true };
  }

  // Like recallShip, but to one chosen base instead of the nearest.
  function returnToBase(state, shipId, baseId) {
    const ship = state.ships[shipId], base = state.bases[baseId];
    if (!ship || !base) return { ok: false, reason: "No such ship or base." };
    ship.target = -1;
    ship.dest = baseId;
    if (ship.st !== IDLE) ship.st = TO_BASE;
    return { ok: true };
  }

  // ---------------------------------------------------------------- simulation

  function nearestBase(state, x, y) {
    let best = 0, bd = Infinity;
    for (let i = 0; i < state.bases.length; i++) {
      const dx = state.bases[i].x - x, dy = state.bases[i].y - y, d = dx * dx + dy * dy;
      if (d < bd) { bd = d; best = i; }
    }
    return best;
  }

  // Move toward (tx, ty) at the ship's speed. Returns true once there.
  function moveTo(ship, tx, ty, dt) {
    const dx = tx - ship.x, dy = ty - ship.y;
    const d = Math.sqrt(dx * dx + dy * dy);
    const step = SHIP_TYPES[ship.type].speed * dt;
    if (d <= step) { ship.x = tx; ship.y = ty; ship.mv = 0; return true; }
    const k = step / d;
    ship.x += dx * k;
    ship.y += dy * k;
    ship.ang = Math.atan2(dy, dx);
    ship.mv = 1;
    return false;
  }

  function stepShip(state, ship, dt) {
    const def = SHIP_TYPES[ship.type];
    if (ship.st === IDLE) { ship.mv = 0; return; }
    if (ship.st === TO_BODY || ship.st === MINING) {
      const body = state.bodies[ship.target];
      if (!body || body.amount <= 1e-6) {          // emptied before or while we were there
        ship.target = -1;
        ship.st = TO_BASE;
        return;
      }
      if (ship.st === TO_BODY) {
        const a = ship.id * 2.399, stop = body.r + 12;
        if (moveTo(ship, body.x + Math.cos(a) * stop, body.y + Math.sin(a) * stop, dt)) ship.st = MINING;
        return;
      }
      ship.mv = 0;
      const take = Math.min(def.rate * dt, body.amount, def.cap - ship.cargo);
      body.amount -= take;
      if (body.amount < 1e-6) body.amount = 0;
      ship.cargo += take;
      ship.res = body.res;
      state.stats[body.res] += take;
      if (ship.cargo >= def.cap - 1e-9 || body.amount === 0) ship.st = TO_BASE;
      return;
    }
    // TO_BASE: fly to the chosen base (else the nearest), unload, then repeat the run if the body still has something
    const base = state.bases[ship.dest >= 0 && ship.dest < state.bases.length ? ship.dest : nearestBase(state, ship.x, ship.y)];
    const a = ship.id * 2.399, stop = BASE_R + 10;
    if (!moveTo(ship, base.x + Math.cos(a) * stop, base.y + Math.sin(a) * stop, dt)) return;
    if (ship.cargo > 0) { state.stock[ship.res] += ship.cargo; ship.cargo = 0; }
    ship.res = "";
    ship.dest = -1;
    const body = ship.target >= 0 ? state.bodies[ship.target] : null;
    if (body && body.amount > 1e-6) ship.st = TO_BODY;
    else { ship.target = -1; ship.st = IDLE; }
  }

  function step(state, dt) {
    state.time += dt;
    const ships = state.ships;
    for (let i = 0; i < ships.length; i++) stepShip(state, ships[i], dt);
  }

  // ---------------------------------------------------------------- text for the mission board

  function r0(n) { return Math.floor(n + 1e-6); }

  function jobText(state, ship) {
    const body = ship.target >= 0 ? state.bodies[ship.target] : null;
    const def = SHIP_TYPES[ship.type];
    switch (ship.st) {
      case TO_BODY: return "Flying to " + (body ? body.name : "target");
      case MINING: return "Mining " + (body ? body.name : "") + " " + r0(ship.cargo) + "/" + def.cap;
      case TO_BASE:
        return ship.cargo > 0 ? "Hauling " + r0(ship.cargo) + " " + ship.res + " home"
          : (body ? "Back to base, then " + body.name : "Returning to base");
      default: return "Idle. Select it, then pick a target.";
    }
  }

  // ---------------------------------------------------------------- stress test helper

  // Top the fleet up to `total` ships for free and send them all mining. Bodies get 8x the stuff so
  // the ships stay busy for the whole test. Deterministic for a given state.
  function spawnStress(state, total) {
    if (!state.stress) {
      state.stress = true;
      for (const b of state.bodies) { b.amount *= 8; b.max *= 8; }
    }
    const r = rng(state.seed ^ 0x5eed);
    while (state.ships.length < total) addShip(state, state.ships.length % 3 === 2 ? "hauler" : "miner");
    for (const ship of state.ships) {
      const b = state.bodies[Math.floor(r() * state.bodies.length)];
      if (b) orderShip(state, ship.id, b.id);
    }
    return state;
  }

  // ---------------------------------------------------------------- save / load

  function serialize(state) {
    return JSON.stringify(state);
  }

  function num(v, def) { return typeof v === "number" && isFinite(v) ? v : def; }

  // Returns { ok: true, state } or { ok: false, error }. Rebuilds the state field by field so a
  // damaged or hand-edited save cannot put NaNs or dangling ids into the game.
  function deserialize(text) {
    let raw;
    try { raw = JSON.parse(text); } catch (e) { return { ok: false, error: "Save is not valid JSON." }; }
    if (!raw || typeof raw !== "object") return { ok: false, error: "Save is empty." };
    if (raw.ver !== VERSION) return { ok: false, error: "Save is from a different version." };
    if (!Array.isArray(raw.bodies) || !Array.isArray(raw.bases) || !Array.isArray(raw.ships) || !raw.stock) {
      return { ok: false, error: "Save is missing parts." };
    }
    if (!raw.bases.length) return { ok: false, error: "Save has no base." };
    const state = {
      ver: VERSION, seed: num(raw.seed, 0) >>> 0, time: num(raw.time, 0), w: WORLD_W, h: WORLD_H,
      bodies: [], bases: [], ships: [],
      stock: { ore: 0, ice: 0, crystal: 0 }, won: !!raw.won, wonAt: num(raw.wonAt, 0), stress: !!raw.stress,
      stats: { ore: 0, ice: 0, crystal: 0 },
    };
    for (const k of RES) {
      state.stock[k] = Math.max(0, num(raw.stock[k], 0));
      state.stats[k] = Math.max(0, num(raw.stats && raw.stats[k], 0));
    }
    for (let i = 0; i < raw.bodies.length; i++) {
      const b = raw.bodies[i];
      if (!b || RES.indexOf(b.res) < 0) return { ok: false, error: "Save has a bad planet." };
      const max = Math.max(0, num(b.max, 0));
      state.bodies.push({ id: i, kind: String(b.kind || "asteroid"), res: b.res, name: String(b.name || "Rock"),
        x: num(b.x, 0), y: num(b.y, 0), r: Math.max(4, num(b.r, 10)), amount: Math.min(max, Math.max(0, num(b.amount, 0))), max });
    }
    for (let i = 0; i < raw.bases.length; i++) {
      const b = raw.bases[i];
      if (!b) return { ok: false, error: "Save has a bad base." };
      state.bases.push({ id: i, x: num(b.x, 0), y: num(b.y, 0), home: i === 0 });
    }
    for (let i = 0; i < raw.ships.length; i++) {
      const s = raw.ships[i];
      if (!s || !SHIP_TYPES[s.type]) return { ok: false, error: "Save has a bad ship." };
      const st = num(s.st, 0) | 0;
      const target = num(s.target, -1) | 0;
      const dest = num(s.dest, -1) | 0;
      const res = RES.indexOf(s.res) >= 0 ? s.res : "";
      const cargo = res ? Math.min(SHIP_TYPES[s.type].cap, Math.max(0, num(s.cargo, 0))) : 0;
      state.ships.push({ id: i, type: s.type, name: String(s.name || SHIP_TYPES[s.type].label), x: num(s.x, 0), y: num(s.y, 0),
        ang: num(s.ang, 0), st: st >= 0 && st <= 3 ? st : 0, target: target < state.bodies.length ? target : -1,
        dest: dest >= 0 && dest < raw.bases.length ? dest : -1, cargo, res, mv: 0 });
    }
    for (const s of state.ships) {            // a ship that needs a target but has none just goes home
      if ((s.st === TO_BODY || s.st === MINING) && s.target < 0) s.st = TO_BASE;
      const body = s.target >= 0 ? state.bodies[s.target] : null;   // cargo that does not fit the target is dropped
      if (body && (s.st === TO_BODY || s.st === MINING) && s.res !== body.res) { s.cargo = 0; s.res = ""; }
    }
    return { ok: true, state };
  }

  return {
    VERSION, WORLD_W, WORLD_H, BASE_R, BASE_GAP, GOAL_BASES, RES, START_STOCK, SHIP_TYPES, BASE_COST,
    IDLE, TO_BODY, MINING, TO_BASE,
    rng, newGame, canAfford, buildShip, addShip, baseSpotProblem, placeBase, checkWin,
    orderShip, recallShip, returnToBase, nearestBase, step, jobText, spawnStress, serialize, deserialize,
  };
});
