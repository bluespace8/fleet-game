"use strict";

// Fleet game logic. No DOM, no timers, no randomness except seeded generators, so it runs
// unchanged in the browser (as the global FleetGame) and under Node (module.exports, see tests.js).
//
// A run is a chain of sectors. Each sector is a new seeded map, further out and harder than the last.
// State is plain data (numbers, strings, arrays), so saving is JSON. Bodies, bases, ships and stars are
// never removed within a sector, so an id is also its index in the array; that keeps the hot loop free
// of lookups. The star bank and the hangar choices live in a separate "profile" object (see below).

(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.FleetGame = factory();
})(typeof self !== "undefined" ? self : this, function () {
  const VERSION = 2;

  // ---------------------------------------------------------------- tuning
  // Every number you might want to change sits in this one table. Sector 1 values are the original
  // game; "perSector" values describe how each later sector differs.
  const TUNING = {
    world: { w: 1600, h: 1000, growPerSector: 0.15, maxScale: 1.6 },   // map size factor = 1 + grow*(n-1), capped
    baseR: 26,                 // drawn and docking radius of a base
    baseGap: 110,              // closest two bases may be
    startStock: { ore: 70, ice: 0, crystal: 0 },
    // speed in world units per second, cap in units, rate in units mined per second.
    ships: {
      miner:  { label: "Miner",  speed: 85,  cap: 20, rate: 5, cost: { ore: 40, ice: 0, crystal: 0 },
                blurb: "Small and cheap. Carries 20." },
      hauler: { label: "Hauler", speed: 135, cap: 60, rate: 4, cost: { ore: 90, ice: 30, crystal: 0 },
                blurb: "Fast and large. Carries 60." },
    },
    baseCost: { ore: 120, ice: 40, crystal: 15 },
    // difficulty by sector (n = 1 is the original game)
    difficulty: {
      goalFirst: 5, goalPerSector: 1, goalMax: 10,   // bases to build to clear the sector
      amountPerSector: 0.12, amountMin: 0.4,         // multiplier on material per body: 1 - per*(n-1), floored
      crystalFirst: 3, crystalDropEvery: 2, crystalMin: 1,   // rare planets: first - floor(n / dropEvery)
      costPerSector: 0.15,                           // build and upgrade costs: x (1 + per*(n-1))
      spreadPerSector: 0.15,                         // minimum distance of bodies from home grows with the map
    },
    // base upgrades, by tier reached. unload = units per second a ship unloads, dock = extra drop-off range
    upgrades: [
      { unload: 30,  dock: 0 },
      { unload: 60,  dock: 12, cost: { ore: 80,  ice: 30, crystal: 0 } },
      { unload: 120, dock: 26, cost: { ore: 160, ice: 70, crystal: 10 } },
    ],
    // ion storms (from firstSector): drift around the map and slow ships inside them
    storms: { firstSector: 2, base: 2, max: 5, rMin: 70, rMax: 120, speedMin: 6, speedMax: 16, slow: 0.45, homeClear: 120 },
    // meteor showers (from firstSector): appear with a short warning, then may knock cargo off ships inside
    showers: { firstSector: 3, radius: 120, warn: 3, dur: 14, firstDelay: 20,
               gapFirst: 40, gapPerSector: 4, gapMin: 16,          // seconds between showers
               hitFirst: 0.5, hitPerSector: 0.05, hitMax: 0.9,      // chance per second for a loaded ship inside
               loss: 0.5, cooldown: 4 },                            // share of cargo lost, seconds before the next hit
    // stars to collect
    stars: { min: 3, max: 6, minHome: 380, edge: 50, bodyClear: 30, apart: 90 },
    score: { value: { ore: 1, ice: 2, crystal: 5 }, base: 100, sector: 400,
             parFirst: 420, parPerSector: 120, timePerSec: 2 },
    endCheckEvery: 1,          // seconds between stranded checks
    bank: { claimedKeep: 400, backups: 3 },
  };

  const T = TUNING;
  const BASE_R = T.baseR;
  const BASE_GAP = T.baseGap;
  const GOAL_BASES = T.difficulty.goalFirst;   // sector 1 goal; goalBases(n) for later ones
  const RES = ["ore", "ice", "crystal"];
  const START_STOCK = T.startStock;
  const SHIP_TYPES = T.ships;
  const BASE_COST = T.baseCost;                // sector 1 cost; baseCost(state) for the current sector
  const MAX_TIER = T.upgrades.length - 1;

  // ship states
  const IDLE = 0, TO_BODY = 1, MINING = 2, TO_BASE = 3, UNLOADING = 4, TO_STAR = 5;

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

  // The same generator, but its position is kept in state.hz so hazards save and load exactly.
  function hrand(state) {
    state.hz = (state.hz + 0x6D2B79F5) >>> 0;
    let t = state.hz;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  const SYL = ["ka", "ve", "lo", "ri", "tan", "mor", "zi", "bel", "or", "ix", "su", "dra", "nem", "pa", "qu", "ul"];
  function makeName(r, kind) {
    if (kind === "asteroid") return "Rock " + (10 + Math.floor(r() * 90));
    let s = "";
    const n = 2 + Math.floor(r() * 2);
    for (let i = 0; i < n; i++) s += SYL[Math.floor(r() * SYL.length)];
    return s[0].toUpperCase() + s.slice(1);
  }

  // ---------------------------------------------------------------- sector rules

  function clampSector(n) { n = Math.floor(typeof n === "number" && isFinite(n) ? n : 1); return Math.max(1, Math.min(999, n)); }
  function mapScale(n) { return Math.min(T.world.maxScale, 1 + T.world.growPerSector * (n - 1)); }
  function worldSize(n) { const k = mapScale(n); return { w: Math.round(T.world.w * k), h: Math.round(T.world.h * k) }; }
  function mapSeed(seed, n) { return n === 1 ? seed >>> 0 : (seed + Math.imul(n, 0x9E3779B1)) >>> 0; }
  function goalBases(n) { const d = T.difficulty; return Math.min(d.goalMax, d.goalFirst + d.goalPerSector * (n - 1)); }
  function amountMult(n) { const d = T.difficulty; return Math.max(d.amountMin, 1 - d.amountPerSector * (n - 1)); }
  function crystalCount(n) { const d = T.difficulty; return Math.max(d.crystalMin, d.crystalFirst - Math.floor(n / d.crystalDropEvery)); }
  function costMult(n) { return 1 + T.difficulty.costPerSector * (n - 1); }
  function stormCount(n) { const S = T.storms; return n < S.firstSector ? 0 : Math.min(S.max, S.base + (n - S.firstSector)); }
  function showersOn(n) { return n >= T.showers.firstSector; }
  function showerGap(n) { const S = T.showers; return Math.max(S.gapMin, S.gapFirst - S.gapPerSector * (n - S.firstSector)); }
  function showerHit(n) { const S = T.showers; return Math.min(S.hitMax, S.hitFirst + S.hitPerSector * (n - S.firstSector)); }
  function parTime(n) { return T.score.parFirst + T.score.parPerSector * (n - 1); }

  function scaleCost(cost, k) {
    const out = {};
    for (const r of RES) out[r] = Math.round((cost[r] || 0) * k);
    return out;
  }
  function baseCost(state) { return scaleCost(T.baseCost, costMult(state.sector)); }
  function shipCost(state, type) { return scaleCost(SHIP_TYPES[type].cost, costMult(state.sector)); }
  function upgradeCost(state, baseId) {
    const b = state.bases[baseId];
    if (!b || (b.tier | 0) >= MAX_TIER) return null;
    return scaleCost(T.upgrades[(b.tier | 0) + 1].cost, costMult(state.sector));
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

  // Further sectors: bodies keep further from home (spread), hold less (amount), crystal is rarer.
  function generateBodies(state, r, n) {
    const spread = 1 + T.difficulty.spreadPerSector * (n - 1), mult = amountMult(n);
    for (const spec of BODY_SPECS) {
      const count = spec.res === "crystal" ? crystalCount(n) : spec.n;
      for (let i = 0; i < count; i++) {
        const rad = spec.r[0] + r() * (spec.r[1] - spec.r[0]);
        const minHome = spec.minHome * spread, maxHome = spec.maxHome ? spec.maxHome * spread : 0;
        let spot = null;
        for (let sep = 46; sep >= 6 && !spot; sep -= 20) spot = pickSpot(r, state, rad, minHome, maxHome, sep);
        if (!spot) spot = pickSpot(r, state, rad, 60, 0, 4);   // very unlikely; keep the count
        if (!spot) continue;
        const amount = Math.round((spec.amt[0] + r() * (spec.amt[1] - spec.amt[0])) * mult);
        state.bodies.push({ id: state.bodies.length, kind: spec.kind, res: spec.res, name: makeName(r, spec.kind),
          x: spot.x, y: spot.y, r: rad, amount, max: amount });
      }
    }
  }

  // Stars use their own generator so they never change where the bodies are.
  function generateStars(state, seed) {
    const S = T.stars, r = rng(seed ^ 0x57A7);
    const home = state.bases[0];
    const count = S.min + Math.floor(r() * (S.max - S.min + 1));
    let minHome = S.minHome * mapScale(state.sector);
    state.stars = [];
    for (let tries = 0; state.stars.length < count && tries < 3000; tries++) {
      if (tries % 400 === 399) minHome *= 0.85;      // crowded map: relax rather than lose a star
      const x = S.edge + r() * (state.w - 2 * S.edge), y = S.edge + r() * (state.h - 2 * S.edge);
      if (Math.hypot(x - home.x, y - home.y) < minHome) continue;
      let ok = true;
      for (let i = 0; i < state.bodies.length && ok; i++) {
        const b = state.bodies[i];
        if (Math.hypot(x - b.x, y - b.y) < b.r + S.bodyClear) ok = false;
      }
      for (let i = 0; i < state.stars.length && ok; i++) {
        if (Math.hypot(x - state.stars[i].x, y - state.stars[i].y) < S.apart) ok = false;
      }
      if (ok) state.stars.push({ id: state.stars.length, x, y, taken: false });
    }
  }

  function generateStorms(state, seed) {
    const S = T.storms, r = rng(seed ^ 0x570A), home = state.bases[0];
    state.storms = [];
    const n = stormCount(state.sector);
    for (let i = 0; i < n; i++) {
      const rad = S.rMin + r() * (S.rMax - S.rMin);
      let x = 0, y = 0;
      for (let tries = 0; tries < 60; tries++) {
        x = rad + r() * (state.w - 2 * rad); y = rad + r() * (state.h - 2 * rad);
        if (Math.hypot(x - home.x, y - home.y) > rad + S.homeClear) break;
      }
      const a = r() * Math.PI * 2, sp = S.speedMin + r() * (S.speedMax - S.speedMin);
      state.storms.push({ x, y, r: rad, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp });
    }
  }

  // Fills in everything that belongs to one sector's map. Ships, stock and score are left alone.
  function buildSector(state, n) {
    const seed = mapSeed(state.seed, n), r = rng(seed), k = mapScale(n), size = worldSize(n);
    state.sector = n;
    state.w = size.w; state.h = size.h;
    state.sectorTime = 0; state.won = false; state.wonAt = 0;
    state.bodies = []; state.bases = []; state.stars = []; state.storms = []; state.showers = [];
    state.bases.push({ id: 0, x: state.w / 2 + (r() - 0.5) * 260 * k, y: state.h / 2 + (r() - 0.5) * 160 * k, home: true, tier: 0 });
    generateBodies(state, r, n);
    generateStars(state, seed);
    generateStorms(state, seed);
    state.hz = (seed ^ 0xA5A5A5A5) >>> 0;
    state.showerIn = showersOn(n) ? T.showers.firstDelay : 0;
  }

  // One shape for a fresh state; deserialize fills the same object so key order (and so JSON) matches.
  function blankState(seed) {
    return {
      ver: VERSION, seed: seed >>> 0, sector: 1, time: 0, sectorTime: 0, w: T.world.w, h: T.world.h,
      bodies: [], bases: [], ships: [], stars: [], storms: [], showers: [], showerIn: 0, hz: 0,
      stock: { ore: START_STOCK.ore, ice: START_STOCK.ice, crystal: START_STOCK.crystal },
      won: false, wonAt: 0, clearInfo: null, over: false, endReason: "", endTimer: T.endCheckEvery, stress: false,
      stats: { ore: 0, ice: 0, crystal: 0, lost: 0 },   // total mined, and cargo knocked off by meteors
      score: { mat: 0, bases: 0, sectors: 0, time: 0 },
      cleared: 0, starsGot: 0, hits: 0,
    };
  }

  function newGame(seed, sector) {
    seed = (seed >>> 0);
    const state = blankState(seed);
    buildSector(state, clampSector(sector));
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

  function parkShip(state, ship) {
    const base = state.bases[0];
    const a = ship.id * 2.399;
    ship.x = base.x + Math.cos(a) * (BASE_R + 12);
    ship.y = base.y + Math.sin(a) * (BASE_R + 12);
    ship.ang = a;
  }

  function addShip(state, type) {
    const id = state.ships.length;
    let count = 1;
    for (let i = 0; i < id; i++) if (state.ships[i].type === type) count++;
    const ship = { id, type, name: SHIP_TYPES[type].label + " " + count,
      x: 0, y: 0, ang: 0,
      st: IDLE, target: -1, dest: -1, star: -1, cargo: 0, res: "", mv: 0, wait: 0, hitCd: 0 };
    state.ships.push(ship);
    parkShip(state, ship);
    return ship;
  }

  function buildShip(state, type) {
    const def = SHIP_TYPES[type];
    if (!def) return { ok: false, reason: "Unknown ship type." };
    if (state.over) return { ok: false, reason: "This run is over." };
    const cost = shipCost(state, type);
    if (!canAfford(state, cost)) return { ok: false, reason: "Not enough materials for a " + def.label.toLowerCase() + "." };
    pay(state, cost);
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
    if (state.over) return { ok: false, reason: "This run is over." };
    const problem = baseSpotProblem(state, x, y);
    if (problem) return { ok: false, reason: problem };
    const cost = baseCost(state);
    if (!canAfford(state, cost)) return { ok: false, reason: "Not enough materials for a base." };
    pay(state, cost);
    const base = { id: state.bases.length, x, y, home: false, tier: 0 };
    state.bases.push(base);
    state.score.bases += T.score.base;
    checkWin(state);
    return { ok: true, base };
  }

  // Each base can be upgraded once per tier. Faster unloading and a longer drop-off range; no other power.
  function upgradeBase(state, baseId) {
    const base = state.bases[baseId];
    if (!base) return { ok: false, reason: "No such base." };
    if (state.over) return { ok: false, reason: "This run is over." };
    if ((base.tier | 0) >= MAX_TIER) return { ok: false, reason: "This base is fully upgraded." };
    const cost = upgradeCost(state, baseId);
    if (!canAfford(state, cost)) return { ok: false, reason: "Not enough materials for the upgrade." };
    pay(state, cost);
    base.tier = (base.tier | 0) + 1;
    return { ok: true, tier: base.tier };
  }

  // Clearing the sector scores a bonus, plus a time bonus for finishing under par. Awarded once.
  function checkWin(state) {
    if (!state.won && state.bases.length - 1 >= goalBases(state.sector)) {
      state.won = true; state.wonAt = state.time;
      const sectorPts = T.score.sector * state.sector;
      const timePts = Math.floor(Math.max(0, parTime(state.sector) - state.sectorTime) * T.score.timePerSec);
      state.score.sectors += sectorPts;
      state.score.time += timePts;
      state.cleared++;
      state.clearInfo = { sector: state.sector, sectorPts, timePts, secs: Math.floor(state.sectorTime) };
    }
    return state.won;
  }

  // Cleared the goal: move the fleet and the stock to a new, harder map one step further out.
  function warpToNextSector(state) {
    if (state.over) return { ok: false, reason: "This run is over." };
    if (!state.won) return { ok: false, reason: "Build " + goalBases(state.sector) + " bases first." };
    for (const s of state.ships) {            // cargo still aboard is handed in before the jump
      if (s.cargo > 0 && s.res) { deliver(state, s.res, s.cargo); }
      s.cargo = 0; s.res = ""; s.st = IDLE; s.target = -1; s.dest = -1; s.star = -1; s.wait = 0; s.hitCd = 0; s.mv = 0;
    }
    buildSector(state, state.sector + 1);
    state.clearInfo = null;
    for (const s of state.ships) parkShip(state, s);
    return { ok: true, sector: state.sector };
  }

  // ---------------------------------------------------------------- orders

  function orderShip(state, shipId, bodyId) {
    const ship = state.ships[shipId], body = state.bodies[bodyId];
    if (!ship || !body) return { ok: false, reason: "No such ship or body." };
    if (body.amount <= 1e-6) return { ok: false, reason: body.name + " is empty." };
    ship.target = bodyId;
    ship.dest = -1;
    ship.star = -1;
    // A loaded ship unloads first if it is already heading home or carries the wrong resource.
    // An empty hold has nothing to unload, so it goes straight to the new target.
    if (ship.cargo > 0 && (ship.st === TO_BASE || ship.res !== body.res)) ship.st = TO_BASE;
    else ship.st = TO_BODY;
    return { ok: true };
  }

  // Send a ship to pick up a star. It keeps any cargo and heads home afterwards.
  function orderShipToStar(state, shipId, starId) {
    const ship = state.ships[shipId], star = state.stars[starId];
    if (!ship || !star) return { ok: false, reason: "No such ship or star." };
    if (star.taken) return { ok: false, reason: "That star is already taken." };
    ship.star = starId;
    ship.target = -1;
    ship.dest = -1;
    ship.st = TO_STAR;
    return { ok: true };
  }

  function recallShip(state, shipId) {
    const ship = state.ships[shipId];
    if (!ship) return { ok: false, reason: "No such ship." };
    ship.target = -1;
    ship.dest = -1;
    ship.star = -1;
    if (ship.st !== IDLE) ship.st = TO_BASE;
    return { ok: true };
  }

  // Like recallShip, but to one chosen base instead of the nearest. An idle ship goes too.
  function returnToBase(state, shipId, baseId) {
    const ship = state.ships[shipId], base = state.bases[baseId];
    if (!ship || !base) return { ok: false, reason: "No such ship or base." };
    ship.target = -1;
    ship.dest = baseId;
    ship.star = -1;
    ship.st = TO_BASE;
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

  // Slowdown for a ship at (x, y): the storm factor inside an ion storm, else 1.
  function speedMult(state, x, y) {
    const s = state.storms;
    for (let i = 0; i < s.length; i++) {
      const dx = x - s[i].x, dy = y - s[i].y;
      if (dx * dx + dy * dy < s[i].r * s[i].r) return T.storms.slow;
    }
    return 1;
  }
  function inStorm(state, x, y) { return speedMult(state, x, y) < 1; }

  // Move toward (tx, ty) at the ship's speed (times mult). Returns true once there.
  function moveTo(ship, tx, ty, dt, mult) {
    const dx = tx - ship.x, dy = ty - ship.y;
    const d = Math.sqrt(dx * dx + dy * dy);
    const step = SHIP_TYPES[ship.type].speed * dt * mult;
    if (d <= step) { ship.x = tx; ship.y = ty; ship.mv = 0; return true; }
    const k = step / d;
    ship.x += dx * k;
    ship.y += dy * k;
    ship.ang = Math.atan2(dy, dx);
    ship.mv = 1;
    return false;
  }

  function deliver(state, res, amount) {
    state.stock[res] += amount;
    state.score.mat += amount * T.score.value[res];
  }

  // After unloading: repeat the run if the body still has something, else go idle.
  function afterUnload(state, ship) {
    const body = ship.target >= 0 ? state.bodies[ship.target] : null;
    if (body && body.amount > 1e-6) ship.st = TO_BODY;
    else { ship.target = -1; ship.st = IDLE; }
  }

  // A loaded ship inside a live meteor shower may lose part of its cargo.
  function meteorCheck(state, ship, dt) {
    if (ship.cargo <= 0 || ship.hitCd > 0) return;
    const S = T.showers, sh = state.showers;
    for (let i = 0; i < sh.length; i++) {
      if (sh[i].age < S.warn) continue;
      const dx = ship.x - sh[i].x, dy = ship.y - sh[i].y;
      if (dx * dx + dy * dy >= sh[i].r * sh[i].r) continue;
      if (hrand(state) < showerHit(state.sector) * dt) {
        const lost = ship.cargo * S.loss;
        ship.cargo -= lost;
        state.stats.lost += lost;
        state.hits++;
        ship.hitCd = S.cooldown;
        return;
      }
    }
  }

  function stepShip(state, ship, dt) {
    const def = SHIP_TYPES[ship.type];
    if (ship.hitCd > 0) ship.hitCd = Math.max(0, ship.hitCd - dt);
    if (state.showers.length) meteorCheck(state, ship, dt);
    if (ship.st === IDLE) { ship.mv = 0; return; }
    if (ship.st === UNLOADING) {
      ship.mv = 0;
      ship.wait -= dt;
      if (ship.wait <= 0) { ship.wait = 0; afterUnload(state, ship); }
      return;
    }
    const mult = state.storms.length ? speedMult(state, ship.x, ship.y) : 1;
    if (ship.st === TO_STAR) {
      const star = state.stars[ship.star];
      if (!star || star.taken) { ship.star = -1; ship.st = TO_BASE; return; }   // someone else got it
      if (moveTo(ship, star.x, star.y, dt, mult)) {
        star.taken = true;
        state.starsGot++;
        ship.star = -1;
        ship.st = TO_BASE;
      }
      return;
    }
    if (ship.st === TO_BODY || ship.st === MINING) {
      const body = state.bodies[ship.target];
      if (!body || body.amount <= 1e-6) {          // emptied before or while we were there
        ship.target = -1;
        ship.st = TO_BASE;
        return;
      }
      if (ship.st === TO_BODY) {
        const a = ship.id * 2.399, stop = body.r + 12;
        if (moveTo(ship, body.x + Math.cos(a) * stop, body.y + Math.sin(a) * stop, dt, mult)) ship.st = MINING;
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
    // TO_BASE: fly to the chosen base (else the nearest) and get within its drop-off range, unload
    // (an upgraded base takes less time), then repeat the run if the body still has something
    const base = state.bases[ship.dest >= 0 && ship.dest < state.bases.length ? ship.dest : nearestBase(state, ship.x, ship.y)];
    const up = T.upgrades[base.tier | 0];
    const a = ship.id * 2.399, stop = BASE_R + 10 + up.dock;
    if (!moveTo(ship, base.x + Math.cos(a) * stop, base.y + Math.sin(a) * stop, dt, mult)) return;
    let wait = 0;
    if (ship.cargo > 0) { wait = ship.cargo / up.unload; deliver(state, ship.res, ship.cargo); ship.cargo = 0; }
    ship.res = "";
    ship.dest = -1;
    if (wait > 0) { ship.wait = wait; ship.st = UNLOADING; }
    else afterUnload(state, ship);
  }

  function stepHazards(state, dt) {
    const w = state.w, h = state.h, storms = state.storms;
    for (let i = 0; i < storms.length; i++) {      // storms drift and bounce off the edges of the map
      const s = storms[i];
      s.x += s.vx * dt; s.y += s.vy * dt;
      if (s.x < 0) { s.x = 0; s.vx = Math.abs(s.vx); } else if (s.x > w) { s.x = w; s.vx = -Math.abs(s.vx); }
      if (s.y < 0) { s.y = 0; s.vy = Math.abs(s.vy); } else if (s.y > h) { s.y = h; s.vy = -Math.abs(s.vy); }
    }
    if (!showersOn(state.sector)) return;
    const S = T.showers, sh = state.showers;
    for (let i = sh.length - 1; i >= 0; i--) {
      sh[i].age += dt;
      if (sh[i].age >= S.warn + S.dur) sh.splice(i, 1);
    }
    state.showerIn -= dt;
    if (state.showerIn <= 0) {
      const m = 80;
      sh.push({ x: m + hrand(state) * (w - 2 * m), y: m + hrand(state) * (h - 2 * m), r: S.radius, age: 0 });
      state.showerIn = showerGap(state.sector) * (0.8 + 0.4 * hrand(state));
    }
  }

  // Stranded: no material left anywhere to mine, nothing in a hold, and not enough for another base.
  // (A new ship would have nothing to mine, so being able to afford one does not count.)
  function isStranded(state) {
    if (state.over || state.won) return false;
    for (let i = 0; i < state.bodies.length; i++) if (state.bodies[i].amount > 1e-6) return false;
    for (let i = 0; i < state.ships.length; i++) if (state.ships[i].cargo > 1e-9) return false;
    return !canAfford(state, baseCost(state));
  }

  function retire(state) {
    if (state.over) return { ok: false, reason: "This run is already over." };
    state.over = true; state.endReason = "retired";
    return { ok: true };
  }

  function step(state, dt) {
    if (state.over) return;
    state.time += dt;
    state.sectorTime += dt;
    if (state.storms.length || state.sector >= T.showers.firstSector) stepHazards(state, dt);
    const ships = state.ships;
    for (let i = 0; i < ships.length; i++) stepShip(state, ships[i], dt);
    state.endTimer -= dt;
    if (state.endTimer <= 0) {
      state.endTimer = T.endCheckEvery;
      if (isStranded(state)) { state.over = true; state.endReason = "stranded"; }
    }
  }

  // ---------------------------------------------------------------- score

  function scoreTotal(state) {
    const s = state.score;
    return Math.floor(s.mat + s.bases + s.sectors + s.time + 1e-6);
  }

  // ---------------------------------------------------------------- text for the mission board

  function r0(n) { return Math.floor(n + 1e-6); }

  function jobText(state, ship) {
    const body = ship.target >= 0 ? state.bodies[ship.target] : null;
    const def = SHIP_TYPES[ship.type];
    switch (ship.st) {
      case TO_BODY: return "Flying to " + (body ? body.name : "target");
      case MINING: return "Mining " + (body ? body.name : "") + " " + r0(ship.cargo) + "/" + def.cap;
      case TO_STAR: return "Flying to a star";
      case UNLOADING: return "Unloading";
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
  function intIn(v, lo, hi, def) { v = Math.floor(num(v, def)); return v < lo ? lo : v > hi ? hi : v; }

  // Returns { ok: true, state, notice? } or { ok: false, error }. Rebuilds the state field by field so a
  // damaged or hand-edited save cannot put NaNs or dangling ids into the game. Saves from the first
  // version (ver 1, one map) load as sector 1 with a notice.
  function deserialize(text) {
    let raw;
    try { raw = JSON.parse(text); } catch (e) { return { ok: false, error: "Save is not valid JSON." }; }
    if (!raw || typeof raw !== "object") return { ok: false, error: "Save is empty." };
    if (raw.ver !== VERSION && raw.ver !== 1) return { ok: false, error: "Save is from a different version." };
    const old = raw.ver === 1;
    if (!Array.isArray(raw.bodies) || !Array.isArray(raw.bases) || !Array.isArray(raw.ships) || !raw.stock) {
      return { ok: false, error: "Save is missing parts." };
    }
    if (!raw.bases.length) return { ok: false, error: "Save has no base." };
    const state = blankState(num(raw.seed, 0));
    const sector = old ? 1 : clampSector(raw.sector);
    const size = worldSize(sector);
    state.sector = sector; state.w = size.w; state.h = size.h;
    state.time = num(raw.time, 0);
    state.sectorTime = old ? state.time : Math.max(0, num(raw.sectorTime, 0));
    state.won = !!raw.won; state.wonAt = num(raw.wonAt, 0);
    state.stress = !!raw.stress;
    for (const k of RES) {
      state.stock[k] = Math.max(0, num(raw.stock[k], 0));
      state.stats[k] = Math.max(0, num(raw.stats && raw.stats[k], 0));
    }
    state.stats.lost = Math.max(0, num(raw.stats && raw.stats.lost, 0));
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
      state.bases.push({ id: i, x: num(b.x, 0), y: num(b.y, 0), home: i === 0, tier: intIn(b.tier, 0, MAX_TIER, 0) });
    }
    const rawStars = !old && Array.isArray(raw.stars) ? raw.stars.slice(0, 12) : null;
    if (rawStars) {
      rawStars.forEach((s, i) => { if (s) state.stars.push({ id: state.stars.length, x: num(s.x, 0), y: num(s.y, 0), taken: !!s.taken }); });
    } else generateStars(state, mapSeed(state.seed, sector));   // old save: the same stars a new game would have
    if (!old) {
      for (const s of (Array.isArray(raw.storms) ? raw.storms.slice(0, 12) : [])) {
        if (!s) continue;
        state.storms.push({ x: num(s.x, 0), y: num(s.y, 0), r: Math.max(10, num(s.r, T.storms.rMin)), vx: num(s.vx, 0), vy: num(s.vy, 0) });
      }
      for (const s of (Array.isArray(raw.showers) ? raw.showers.slice(0, 12) : [])) {
        if (!s) continue;
        state.showers.push({ x: num(s.x, 0), y: num(s.y, 0), r: T.showers.radius, age: Math.max(0, num(s.age, 0)) });
      }
      state.showerIn = num(raw.showerIn, 0);
      state.hz = num(raw.hz, 0) >>> 0;
      const sc = raw.score || {};
      state.score = { mat: Math.max(0, num(sc.mat, 0)), bases: Math.max(0, num(sc.bases, 0)),
        sectors: Math.max(0, num(sc.sectors, 0)), time: Math.max(0, num(sc.time, 0)) };
      state.cleared = intIn(raw.cleared, 0, 999, 0);
      state.starsGot = intIn(raw.starsGot, 0, 99999, 0);
      state.hits = intIn(raw.hits, 0, 99999, 0);
      const ci = raw.clearInfo;
      state.clearInfo = ci && typeof ci === "object" ? { sector: intIn(ci.sector, 1, 999, sector),
        sectorPts: Math.max(0, num(ci.sectorPts, 0)), timePts: Math.max(0, num(ci.timePts, 0)), secs: Math.max(0, num(ci.secs, 0)) } : null;
      state.over = !!raw.over;
      state.endReason = state.over ? (raw.endReason === "stranded" ? "stranded" : "retired") : "";
      state.endTimer = Math.max(0, num(raw.endTimer, T.endCheckEvery));
    } else {
      // an old save has no hazards or score; sector 1 has no hazards, and the score starts from what is built
      state.showerIn = 0;
      state.hz = (mapSeed(state.seed, 1) ^ 0xA5A5A5A5) >>> 0;
      state.score.bases = Math.max(0, raw.bases.length - 1) * T.score.base;
      if (state.won) state.cleared = 1;
    }
    for (let i = 0; i < raw.ships.length; i++) {
      const s = raw.ships[i];
      if (!s || !SHIP_TYPES[s.type]) return { ok: false, error: "Save has a bad ship." };
      const st = intIn(s.st, 0, 5, 0);
      const target = intIn(s.target, -1, 1e9, -1);
      const dest = intIn(s.dest, -1, 1e9, -1);
      const star = intIn(s.star, -1, 1e9, -1);
      const res = RES.indexOf(s.res) >= 0 ? s.res : "";
      const cargo = res ? Math.min(SHIP_TYPES[s.type].cap, Math.max(0, num(s.cargo, 0))) : 0;
      state.ships.push({ id: i, type: s.type, name: String(s.name || SHIP_TYPES[s.type].label), x: num(s.x, 0), y: num(s.y, 0),
        ang: num(s.ang, 0), st, target: target < state.bodies.length ? target : -1,
        dest: dest >= 0 && dest < state.bases.length ? dest : -1,
        star: star < state.stars.length ? star : -1, cargo, res, mv: 0,
        wait: Math.max(0, num(s.wait, 0)), hitCd: Math.max(0, num(s.hitCd, 0)) });
    }
    for (const s of state.ships) {            // a ship that needs a target but has none just goes home
      if ((s.st === TO_BODY || s.st === MINING) && s.target < 0) s.st = TO_BASE;
      if (s.st === TO_STAR && s.star < 0) s.st = TO_BASE;
      const body = s.target >= 0 ? state.bodies[s.target] : null;   // cargo that does not fit the target is dropped
      if (body && (s.st === TO_BODY || s.st === MINING) && s.res !== body.res) { s.cargo = 0; s.res = ""; }
    }
    const out = { ok: true, state };
    if (old) out.notice = "This save is from the first version of Fleet. It was loaded as sector 1.";
    return out;
  }

  // Damaged saves are copied aside so nothing is lost silently. The list keeps the newest few,
  // newest first; the same text twice in a row is not stored twice.
  function addBackup(list, entry, max) {
    const keep = max || T.bank.backups, out = Array.isArray(list) ? list.filter(e => e && typeof e.text === "string") : [];
    if (out.length && out[0].text === entry.text) return out.slice(0, keep);
    out.unshift({ at: String(entry.at || ""), from: String(entry.from || ""), text: String(entry.text) });
    return out.slice(0, keep);
  }

  // ---------------------------------------------------------------- hangar: looks and the star bank
  // The profile is separate from any game: stars saved up, what has been bought, what is chosen, and the
  // best score. Stars buy looks only, never power.

  const LOOKS = {
    ship: [
      { id: "classic", name: "Classic", cost: 0, miner: "#5b9cf0", hauler: "#f0b020" },
      { id: "crimson", name: "Crimson", cost: 2, miner: "#ef5a5a", hauler: "#ffb085" },
      { id: "emerald", name: "Emerald", cost: 3, miner: "#3fd18a", hauler: "#c6f06a" },
      { id: "violet",  name: "Violet",  cost: 4, miner: "#a77cf2", hauler: "#f08cd8" },
      { id: "solar",   name: "Solar",   cost: 5, miner: "#ffd24a", hauler: "#ff8a3a" },
    ],
    base: [
      { id: "teal",  name: "Teal",  cost: 0, main: "#5fd0b0", home: "#a197f2" },
      { id: "amber", name: "Amber", cost: 2, main: "#f0b04a", home: "#ffe08a" },
      { id: "rose",  name: "Rose",  cost: 3, main: "#ee7fa6", home: "#ffc0d6" },
      { id: "sky",   name: "Sky",   cost: 4, main: "#6fb8ff", home: "#c4e2ff" },
      { id: "lime",  name: "Lime",  cost: 5, main: "#9be35a", home: "#dcf7a8" },
    ],
    bg: [   // blobs are [x, y, radius] as fractions of the screen, then a colour
      { id: "deep", name: "Deep space", cost: 0, top: "#03040b", bottom: "#090a1c", blobs: [
        [0.22, 0.28, 0.55, "rgba(98,80,214,0.20)"], [0.82, 0.72, 0.5, "rgba(42,120,214,0.16)"],
        [0.62, 0.12, 0.32, "rgba(232,123,164,0.07)"], [0.1, 0.9, 0.3, "rgba(27,175,122,0.06)"]] },
      { id: "aurora", name: "Aurora", cost: 4, top: "#021012", bottom: "#07182a", blobs: [
        [0.25, 0.2, 0.55, "rgba(40,214,160,0.18)"], [0.8, 0.35, 0.45, "rgba(60,150,230,0.16)"],
        [0.5, 0.9, 0.4, "rgba(120,90,230,0.12)"]] },
      { id: "ember", name: "Ember", cost: 6, top: "#110504", bottom: "#1d0a10", blobs: [
        [0.2, 0.75, 0.55, "rgba(230,90,40,0.18)"], [0.85, 0.25, 0.5, "rgba(200,40,80,0.15)"],
        [0.55, 0.5, 0.3, "rgba(255,170,60,0.06)"]] },
      { id: "void", name: "Void", cost: 8, top: "#000000", bottom: "#050507", blobs: [
        [0.5, 0.5, 0.7, "rgba(120,120,150,0.07)"], [0.15, 0.15, 0.3, "rgba(170,170,200,0.05)"]] },
    ],
    trail: [
      { id: "streak", name: "Streak", cost: 0, note: "A fading line." },
      { id: "spark",  name: "Sparkle", cost: 5, note: "A trail of glowing dots." },
      { id: "ribbon", name: "Ribbon", cost: 8, note: "A wide soft ribbon." },
    ],
  };
  const LOOK_KINDS = ["ship", "base", "bg", "trail"];
  const LOOK_TITLES = { ship: "Ship colours", base: "Base colours", bg: "Backgrounds", trail: "Engine trails" };

  function lookById(kind, id) {
    const list = LOOKS[kind];
    for (let i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }

  function newProfile() {
    const p = { ver: 1, stars: 0, best: 0, owned: {}, pick: {}, claimed: [] };
    for (const k of LOOK_KINDS) { p.owned[k] = [LOOKS[k][0].id]; p.pick[k] = LOOKS[k][0].id; }
    return p;
  }

  // Always returns a usable profile. ok is false (with an error) when the text was damaged; the profile
  // is then whatever could be kept, or a new one.
  function parseProfile(text) {
    const p = newProfile();
    if (text == null || text === "") return { ok: true, profile: p };
    let raw;
    try { raw = JSON.parse(text); } catch (e) { return { ok: false, profile: p, error: "The star bank is not valid JSON." }; }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, profile: p, error: "The star bank is empty." };
    p.stars = intIn(raw.stars, 0, 1e9, 0);
    p.best = intIn(raw.best, 0, 1e12, 0);
    for (const k of LOOK_KINDS) {
      const have = raw.owned && Array.isArray(raw.owned[k]) ? raw.owned[k] : [];
      for (const id of have) if (lookById(k, id) && p.owned[k].indexOf(id) < 0) p.owned[k].push(id);
      const pick = raw.pick && raw.pick[k];
      if (lookById(k, pick) && p.owned[k].indexOf(pick) >= 0) p.pick[k] = pick;
    }
    if (Array.isArray(raw.claimed)) p.claimed = raw.claimed.filter(s => typeof s === "string").slice(-T.bank.claimedKeep);
    return { ok: true, profile: p };
  }

  function serializeProfile(p) { return JSON.stringify(p); }

  function buyLook(p, kind, id) {
    const look = LOOKS[kind] && lookById(kind, id);
    if (!look) return { ok: false, reason: "No such item." };
    if (p.owned[kind].indexOf(id) >= 0) return { ok: false, reason: "You already own " + look.name + "." };
    if (p.stars < look.cost) return { ok: false, reason: "Not enough stars (" + look.cost + " needed)." };
    p.stars -= look.cost;
    p.owned[kind].push(id);
    return { ok: true };
  }

  function chooseLook(p, kind, id) {
    const look = LOOKS[kind] && lookById(kind, id);
    if (!look) return { ok: false, reason: "No such item." };
    if (p.owned[kind].indexOf(id) < 0) return { ok: false, reason: "Buy " + look.name + " first." };
    p.pick[kind] = id;
    return { ok: true };
  }

  // The resolved looks for drawing.
  function currentLooks(p) {
    return { ship: lookById("ship", p.pick.ship), base: lookById("base", p.pick.base),
      bg: lookById("bg", p.pick.bg), trail: lookById("trail", p.pick.trail) };
  }

  function starKey(state, star) { return state.seed + ":" + state.sector + ":" + star.id; }

  // Move newly picked-up stars into the bank. Each star pays once, even if an older save is loaded
  // and the star is picked up again. Returns how many stars were added.
  function claimStars(p, state) {
    let n = 0;
    for (let i = 0; i < state.stars.length; i++) {
      const s = state.stars[i];
      if (!s.taken) continue;
      const key = starKey(state, s);
      if (p.claimed.indexOf(key) >= 0) continue;
      p.claimed.push(key);
      p.stars++;
      n++;
    }
    if (p.claimed.length > T.bank.claimedKeep) p.claimed.splice(0, p.claimed.length - T.bank.claimedKeep);
    return n;
  }

  // After a load: stars the bank has already paid for are not on the map again.
  function syncClaimed(state, p) {
    for (let i = 0; i < state.stars.length; i++) {
      if (!state.stars[i].taken && p.claimed.indexOf(starKey(state, state.stars[i])) >= 0) state.stars[i].taken = true;
    }
  }

  // Keep the best score. Returns true when this one is a new best.
  function recordBest(p, score) {
    score = Math.floor(score);
    if (score > p.best) { p.best = score; return true; }
    return false;
  }

  return {
    VERSION, TUNING, BASE_R, BASE_GAP, GOAL_BASES, RES, START_STOCK, SHIP_TYPES, BASE_COST, MAX_TIER,
    IDLE, TO_BODY, MINING, TO_BASE, UNLOADING, TO_STAR,
    LOOKS, LOOK_KINDS, LOOK_TITLES,
    rng, newGame, canAfford, buildShip, addShip, baseSpotProblem, placeBase, checkWin,
    clampSector, mapScale, worldSize, mapSeed, goalBases, amountMult, crystalCount, costMult, stormCount, showersOn,
    showerGap, showerHit, parTime, baseCost, shipCost, upgradeCost, upgradeBase, warpToNextSector,
    orderShip, orderShipToStar, recallShip, returnToBase, nearestBase, inStorm, step, isStranded, retire, scoreTotal,
    jobText, spawnStress, serialize, deserialize, addBackup,
    newProfile, parseProfile, serializeProfile, buyLook, chooseLook, currentLooks, lookById, claimStars, syncClaimed, recordBest,
  };
});
