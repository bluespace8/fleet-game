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
  const VERSION = 3;

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
      miner:  { label: "Miner",  speed: 85,  cap: 20, rate: 5, cost: { ore: 40, ice: 0, crystal: 0 }, hp: 30,
                blurb: "Small and cheap. Carries 20." },
      hauler: { label: "Hauler", speed: 135, cap: 60, rate: 4, cost: { ore: 90, ice: 30, crystal: 0 }, hp: 45,
                blurb: "Fast and large. Carries 60." },
      // A warship carries nothing and mines nothing. It flies orders (patrol, escort, attack) and fires at aliens in range.
      warship: { label: "Warship", speed: 110, cap: 0, rate: 0, cost: { ore: 110, ice: 40, crystal: 0 }, hp: 90, war: true,
                 range: 170, dmg: 9, cd: 0.7, shotSpeed: 420, follow: 46, standoff: 0.7,
                 blurb: "Guards, escorts and hunts aliens. Carries nothing." },
    },
    baseCost: { ore: 120, ice: 40, crystal: 15 },
    // difficulty by sector (n = 1 is the original game)
    difficulty: {
      goalFirst: 5, goalPerSector: 1, goalMax: 10,   // bases to build to clear the sector
      amountPerSector: 0.12, amountMin: 0.6,         // multiplier on material per body: 1 - per*(n-1), floored
      // Ore and ice bodies grow in number with the map's area, so a bigger map holds enough to pay for its
      // own goal. Crystal bodies stay few (rare) but richer: richness tracks goal x cost per crystal body,
      // relative to sector 1 (see crystalRich).
      crystalFirst: 3, crystalDropEvery: 2, crystalMin: 1,   // rare planets: first - floor(n / dropEvery)
      costPerSector: 0.08, costMax: 1.72,          // build and upgrade costs: x (1 + per*(n-1)), capped (sector 10's value)
      spreadPerSector: 0.15, spreadMax: 2.35,      // minimum distance of bodies from home grows with the map, capped
      // Supply stops growing at sector 5 and the goal at sector 6, so costs and spread plateau at sector 10:
      // every later sector is as hard as sector 10, and always clearable.
    },
    // base upgrades, by tier reached. unload = units per second a ship unloads, dock = extra drop-off range
    upgrades: [
      { unload: 30,  dock: 0 },
      { unload: 60,  dock: 12, cost: { ore: 80,  ice: 30, crystal: 0 } },
      { unload: 120, dock: 26, cost: { ore: 160, ice: 70, crystal: 10 } },
    ],
    // ion storms (from firstSector): drift around the map and slow ships inside them
    storms: { firstSector: 2, base: 2, max: 5, rMin: 70, rMax: 120, speedMin: 6, speedMax: 16, slow: 0.45, homeClear: 120 },
    // Event system. Sector 1 is calm. From firstSector one event is rolled every eventGap(n) seconds; each shows a
    // warning (warn seconds) before it takes effect. Kinds unlock by sector (fog and flare here, raid from
    // aliens.firstSector; meteor showers, below, keep their own timer but share the warning, strength and cap rules).
    // Strength rises with the sector and is capped.
    events: { firstSector: 2, warn: 10, firstDelay: 25,
              gapFirst: 42, gapPerSector: 3, gapMin: 18, jitter: 0.4,     // seconds between rolls: falls with the sector, floored
              maxActive: 6, maxRaids: 2, retry: 6,                          // events at once (incl. showers), raids at once; seconds before a retry when full
              weight: { fog: 3, flare: 2 },                                 // share of the non-raid rolls
              raidFirst: 0.25, raidPerSector: 0.05, raidMax: 0.55,          // chance that a roll (aliens unlocked) is a raid
              powerPerSector: 0.15, powerMax: 2 },                          // event strength: 1 + per*(n - firstSector), capped
    // fog (from events.firstSector): ships mine slower inside; the UI hides the map under it
    fog: { margin: 60, rMin: 130, rMax: 210, rPerSector: 8, rCap: 300, dur: 40, mine: 0.5, max: 2 },
    // solar flare (from events.firstSector): map-wide; ships outside a shield generator's range are stunned
    flare: { durFirst: 10, durPerSector: 1, durMax: 20, linger: 1, max: 1 },
    // meteor showers (from firstSector): appear with a warning, then hurt ships and bases inside (and may knock cargo off ships)
    showers: { margin: 80, gapJitter: 0.4, firstSector: 3, radius: 120, radiusPerSector: 4, radiusMax: 170, warn: 10, dur: 14, firstDelay: 20,
               gapFirst: 40, gapPerSector: 4, gapMin: 16,          // seconds between showers (their own timer)
               hitFirst: 0.5, hitPerSector: 0.05, hitMax: 0.9,      // chance per second for a ship inside
               loss: 0.5, cooldown: 4,                              // share of cargo lost, seconds before the next hit
               dmgFirst: 4, dmgPerSector: 1, dmgMax: 12,            // damage per hit to a ship (power)
               baseTick: 2, baseHit: 0.6, baseMult: 1.5, max: 3 },  // seconds between strikes on bases, chance per base, base damage factor, at once
    // aliens (from firstSector): spawn at a warned point on the map edge, chase loaded ships else bases, and shoot
    aliens: { firstSector: 3, r: 11, sense: 330, range: 150, edge: 20, cd: 1.6, shotSpeed: 300,
              stay: 90,                                                    // seconds a raider stays; then it flies to the nearest map edge and is gone
              speedFirst: 55, speedPerSector: 3, speedMax: 85,
              countFirst: 2, countEvery: 2, countMax: 6, capSector: 10,     // count: first + floor((min(n, capSector) - firstSector) / every), capped
              holdFrac: 0.8, offMap: 50, markR: 40,                                   // hold distance as a share of range; shots vanish this far off the map
              hpFirst: 40, hpPerSector: 12, hpMax: 120,
              dmgFirst: 4, dmgPerSector: 1, dmgMax: 10,
              max: 24, score: 25, starChance: 0.12, maxStars: 12 },
    // shots, damage and health
    combat: { maxShots: 90, shotLife: 1.2, shotReach: 1.25, shipR: 9, fxMax: 16, fxLife: 0.4,
              baseHp: 160, homeHp: 300 },
    // base add-ons, bought per base (costs scale with the sector like other costs)
    addons: {
      shield: { label: "Shield", range: 170, cost: { ore: 60, ice: 40, crystal: 0 }, blurb: "Ships near it ignore solar flares." },
      turret: { label: "Turret", range: 190, dmg: 6, cd: 0.6, block: 0.7, shotSpeed: 460,
                cost: { ore: 90, ice: 20, crystal: 0 }, blurb: "Shoots aliens and blocks meteor hits nearby." },
    },
    // repair: cost per HP restored (rounded up per resource), scaled with the sector's cost factor; seconds the ship is held
    repair: { ship: { ore: 0.5, ice: 0, crystal: 0 }, base: { ore: 0.5, ice: 0.15, crystal: 0 }, time: 1 },
    // stars to collect
    stars: { min: 3, max: 6, minHome: 380, edge: 50, bodyClear: 30, apart: 90 },
    score: { value: { ore: 1, ice: 2, crystal: 5 }, base: 100, sector: 400,
             parFirst: 420, parPerSector: 120, timePerSec: 2 },
    endCheckEvery: 1,          // seconds between stranded checks
    bank: { claimedKeep: 400, backups: 3 },
    logs: { runs: 500, buys: 500, players: 50, nameMax: 24, minSecs: 5 },
    msgs: { max: 50 },         // cap on the transient message queue (state.msgs, see emit)
    // ---- credits and running costs (slice b). Per minute unless noted. econScale(n) multiplies maintenance and upkeep.
    econ: {
      credit: { ore: 1, ice: 2, crystal: 5 },            // credits paid per unit delivered
      startCredits: 250, oldSaveCredits: 500,
      scalePerSector: 0.04, scaleMax: 1.36,              // running costs x min(max, 1 + per*(n-1))
      maint:  { miner: 30, hauler: 50, warship: 90, mothball: 0.2, wakeSecs: 10 },   // cr per minute; mothball: share still paid
      upkeep: { home: 0, base: 35, perTier: 10, shield: 20, turret: 20 },            // cr per minute
      debt:   { start: 1500, rate: 0.015, every: 60, dueSector: 3, dueTime: 2700, warnSecs: 300 },
      bankrupt: { floor: -250, grace: 60, blockShipsBelow: 0 },
      timer:  { parMult: 1.5, firstSector: 2, capSector: 10, warnShare: 0.25, warnSecs: 60 },
      exchange: { sell: { ore: 1, ice: 2, crystal: 5 }, buy: { ore: 3, ice: 6 }, step: 10, buyOn: true },
      netWarnSecs: 10,
    },
    // which lose rules are on at the start of a run; copied to state.rules by newGame
    lose: { maintenance: true, upkeep: true, debt: true, timer: false, bankruptcy: true },
    // ---- science from conquest (slice a). Raider, turret and guard kills and wave bonuses share the per-sector cap
    // raidCap + raidCapPerSector * (n - firstSector); nests, beacons and "sector secured" are never capped.
    science: {
      firstSector: 2, raider: 2, raiderEvery: 2, turretKill: 1, guardKill: 1, wave: 3, secured: 5,
      raidCap: 20, raidCapPerSector: 10,
      beacon: { sector: 2, hp: 150, sci: 8 },
      nest: { firstSector: 3, base: 1, every: 2, max: 3, hp: 300, hpPerSector: 0.3, sci: 10, sciPerSector: 4,
              guards: 3, guardRespawn: 20, guardLeash: 250, regen: 2, regenRange: 220, raidBoost: 0.2,
              minHomeShare: 0.6, nearCrystal: 150 },
    },
    techCost: [8, 16, 28, 45],     // science per tier 1-4
    // The tech tree: three branches of four. needs: the node one tier below in the same branch. effects are read with
    // techMult(state, key) (product of mult) and techAdd(state, key) (sum of add).
    tech: [
      { id: "mil_hulls", name: "Hardened hulls", branch: "mil", tier: 1, needs: null, effects: [{ key: "warshipHp", mult: 1.3 }],
        text: "Warship max HP +30% (90 \u2192 117)." },
      { id: "mil_targeting", name: "Targeting computers", branch: "mil", tier: 2, needs: "mil_hulls", effects: [{ key: "warshipDmg", mult: 1.25 }],
        text: "Warship damage +25% (9 \u2192 11.25 per shot)." },
      { id: "mil_contracts", name: "Navy contracts", branch: "mil", tier: 3, needs: "mil_targeting", effects: [{ key: "warshipMaint", mult: 0.6 }],
        text: "Warship maintenance x0.6 (90 \u2192 54 cr/min)." },
      { id: "mil_siege", name: "Siege lances", branch: "mil", tier: 4, needs: "mil_contracts", effects: [{ key: "nestDmg", mult: 2 }],
        text: "Warship damage against nests and beacons x2." },
      { id: "ind_drills", name: "Efficient drills", branch: "ind", tier: 1, needs: null, effects: [{ key: "mineRate", mult: 1.2 }],
        text: "Mining rate +20% (miner 5 \u2192 6/s, hauler 4 \u2192 4.8/s)." },
      { id: "ind_crews", name: "Lean crews", branch: "ind", tier: 2, needs: "ind_drills", effects: [{ key: "shipMaint", mult: 0.7 }],
        text: "Miner and hauler maintenance x0.7 (30 \u2192 21, 50 \u2192 35 cr/min)." },
      { id: "ind_modular", name: "Modular bases", branch: "ind", tier: 3, needs: "ind_crews", effects: [{ key: "baseUpkeep", mult: 0.65 }],
        text: "Base upkeep, tiers and add-ons included, x0.65." },
      { id: "ind_holds", name: "Deep holds", branch: "ind", tier: 4, needs: "ind_modular", effects: [{ key: "cargo", mult: 1.25 }],
        text: "Cargo capacity +25% (miner 20 \u2192 25, hauler 60 \u2192 75)." },
      { id: "log_credit", name: "Credit line", branch: "log", tier: 1, needs: null, effects: [{ key: "overdraft", add: -250 }, { key: "interest", mult: 0.5 }],
        text: "Better credit terms: overdraft floor -250 \u2192 -500, and debt interest x0.5 (1.5% \u2192 0.75%/min)." },
      { id: "log_docks", name: "Quick docks", branch: "log", tier: 2, needs: "log_credit", effects: [{ key: "unload", mult: 1.5 }, { key: "dock", add: 10 }],
        text: "Unload speed x1.5 and drop-off range +10 at every base." },
      { id: "log_engines", name: "Afterburners", branch: "log", tier: 3, needs: "log_docks", effects: [{ key: "shipSpeed", mult: 1.15 }],
        text: "Miner and hauler speed +15%." },
      { id: "log_depots", name: "Forward depots", branch: "log", tier: 4, needs: "log_engines", effects: [{ key: "baseCost", mult: 0.85 }],
        text: "New base cost x0.85 (all materials)." },
    ],
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
  const IDLE = 0, TO_BODY = 1, MINING = 2, TO_BASE = 3, UNLOADING = 4, TO_STAR = 5, MANUAL = 6;
  const MANUAL_SLACK = 10;   // extra reach (world units) for the manual mine and unload actions, on top of the auto stop distance

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

  // ---------------------------------------------------------------- wording
  // The default wording, and per-theme overrides in LOOKS.theme. Text that names a resource, ship, base or
  // hazard takes an optional trailing "labels" argument (from labelsFor); left out, the text is the space wording.
  function deepFreeze(o) { for (const k of Object.keys(o)) if (o[k] && typeof o[k] === "object") deepFreeze(o[k]); return Object.freeze(o); }
  const SPACE_LABELS = deepFreeze({
    id: "space",
    res: { ore: "ore", ice: "ice", crystal: "crystal" },
    resTitle: { ore: "Ore", ice: "Ice", crystal: "Crystal" },
    ship: { miner: "Miner", hauler: "Hauler" }, ships: "Ships",
    base: "base", baseTitle: "Base", bases: "Bases", home: "Home base", newBase: "New base",
    body: { asteroid: "Asteroid", moon: "Moon", iceplanet: "Ice planet", rare: "Rare planet" },
    storm: "Ion storm", shower: "Meteor shower", sector: "Sector", warp: "Warp to next sector",
    edge: "the edge of space",
  });
  function mergeLabels(base, over) {
    const out = {};
    for (const k of Object.keys(base)) {
      const b = base[k], o = over ? over[k] : undefined;
      if (b && typeof b === "object") out[k] = mergeLabels(b, o && typeof o === "object" ? o : null);
      else out[k] = typeof o === "string" && o ? o : b;
    }
    return out;
  }
  function lc(t) { return String(t).toLowerCase(); }
  function an(t) { return (/^[aeiou]/i.test(String(t)) ? "an " : "a ") + t; }   // "a hamster", "an iron vein"

  // ---------------------------------------------------------------- sector rules

  function clampSector(n) { n = Math.floor(typeof n === "number" && isFinite(n) ? n : 1); return Math.max(1, Math.min(999, n)); }
  function mapScale(n) { return Math.min(T.world.maxScale, 1 + T.world.growPerSector * (n - 1)); }
  function worldSize(n) { const k = mapScale(n); return { w: Math.round(T.world.w * k), h: Math.round(T.world.h * k) }; }
  function mapSeed(seed, n) { return n === 1 ? seed >>> 0 : (seed + Math.imul(n, 0x9E3779B1)) >>> 0; }
  function goalBases(n) { const d = T.difficulty; return Math.min(d.goalMax, d.goalFirst + d.goalPerSector * (n - 1)); }
  function amountMult(n) { const d = T.difficulty; return Math.max(d.amountMin, 1 - d.amountPerSector * (n - 1)); }
  function crystalCount(n) { const d = T.difficulty; return Math.max(d.crystalMin, d.crystalFirst - Math.floor(n / d.crystalDropEvery)); }
  function areaMult(n) { const k = mapScale(n); return k * k; }
  function bodyCount(spec, n) { return spec.res === "crystal" ? crystalCount(n) : Math.max(1, Math.round(spec.n * areaMult(n))); }
  function crystalRich(n) { return (goalBases(n) * costMult(n) / crystalCount(n)) / (goalBases(1) * costMult(1) / crystalCount(1)); }
  function costMult(n) { const d = T.difficulty; return Math.min(d.costMax, 1 + d.costPerSector * (n - 1)); }
  function stormCount(n) { const S = T.storms; return n < S.firstSector ? 0 : Math.min(S.max, S.base + (n - S.firstSector)); }
  function showersOn(n) { return n >= T.showers.firstSector; }
  function showerGap(n) { const S = T.showers; return Math.max(S.gapMin, S.gapFirst - S.gapPerSector * (n - S.firstSector)); }
  function showerHit(n) { const S = T.showers; return Math.min(S.hitMax, S.hitFirst + S.hitPerSector * (n - S.firstSector)); }
  // events and combat, by sector
  function eventsOn(n) { return n >= T.events.firstSector; }
  function aliensOn(n) { return n >= T.aliens.firstSector; }
  function eventGap(n) { const E = T.events; return Math.max(E.gapMin, E.gapFirst - E.gapPerSector * (n - E.firstSector)); }
  function eventPower(n) { const E = T.events; return Math.min(E.powerMax, 1 + E.powerPerSector * Math.max(0, n - E.firstSector)); }
  function raidOdds(n) { const E = T.events; return aliensOn(n) ? Math.min(E.raidMax, E.raidFirst + E.raidPerSector * (n - T.aliens.firstSector)) : 0; }
  function fogRadius(n) { const F = T.fog; return Math.min(F.rCap, F.rMax + F.rPerSector * Math.max(0, n - T.events.firstSector)); }
  function flareDur(n) { const F = T.flare; return Math.min(F.durMax, F.durFirst + F.durPerSector * Math.max(0, n - T.events.firstSector)); }
  function showerRadius(n) { const S = T.showers; return Math.min(S.radiusMax, S.radius + S.radiusPerSector * Math.max(0, n - S.firstSector)); }
  function showerDmg(n) { const S = T.showers; return Math.min(S.dmgMax, S.dmgFirst + S.dmgPerSector * Math.max(0, n - S.firstSector)); }
  function alienCount(n) { const A = T.aliens; return Math.min(A.countMax, A.countFirst + Math.floor(Math.max(0, Math.min(n, A.capSector) - A.firstSector) / A.countEvery)); }
  function alienHp(n) { const A = T.aliens; return Math.min(A.hpMax, A.hpFirst + A.hpPerSector * Math.max(0, n - A.firstSector)); }
  function alienDmg(n) { const A = T.aliens; return Math.min(A.dmgMax, A.dmgFirst + A.dmgPerSector * Math.max(0, n - A.firstSector)); }
  function alienSpeed(n) { const A = T.aliens; return Math.min(A.speedMax, A.speedFirst + A.speedPerSector * Math.max(0, n - A.firstSector)); }
  function parTime(n) { return T.score.parFirst + T.score.parPerSector * (n - 1); }

  function scaleCost(cost, k) {
    const out = {};
    for (const r of RES) out[r] = Math.round((cost[r] || 0) * k);
    return out;
  }
  function baseCost(state) { return scaleCost(T.baseCost, costMult(state.sector) * techMult(state, "baseCost")); }   // tech: Forward depots
  function addonCost(state, kind) { return T.addons[kind] ? scaleCost(T.addons[kind].cost, costMult(state.sector)) : null; }
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
    const spread = Math.min(T.difficulty.spreadMax, 1 + T.difficulty.spreadPerSector * (n - 1)), mult = amountMult(n);
    for (const spec of BODY_SPECS) {
      const count = bodyCount(spec, n);
      for (let i = 0; i < count; i++) {
        const rad = spec.r[0] + r() * (spec.r[1] - spec.r[0]);
        const minHome = spec.minHome * spread, maxHome = spec.maxHome ? spec.maxHome * spread : 0;
        let spot = null;
        for (let sep = 46; sep >= 6 && !spot; sep -= 20) spot = pickSpot(r, state, rad, minHome, maxHome, sep);
        if (!spot) spot = pickSpot(r, state, rad, 60, 0, 4);   // very unlikely; keep the count
        if (!spot) continue;
        const amount = Math.round((spec.amt[0] + r() * (spec.amt[1] - spec.amt[0])) * mult * (spec.res === "crystal" ? crystalRich(n) : 1));
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
    state.events = []; state.aliens = []; state.shots = []; state.fx = [];
    state.nests = []; state.waves = {}; state.sciSector = 0;
    state.bases.push(makeBase(0, state.w / 2 + (r() - 0.5) * 260 * k, state.h / 2 + (r() - 0.5) * 160 * k, true));
    generateBodies(state, r, n);
    generateStars(state, seed);
    generateStorms(state, seed);
    api.generateNests(state, seed);
    state.hz = (seed ^ 0xA5A5A5A5) >>> 0;
    state.eventIn = eventsOn(n) ? T.events.firstDelay : 0;
    state.showerIn = showersOn(n) ? T.showers.firstDelay : 0;
  }

  // One shape for a base, whoever makes it. hp/maxHp: health; shield, turret: add-ons; down: out of action at 0 HP
  // (never the home base: losing that ends the run); cd: turret fire cooldown.
  function makeBase(id, x, y, home) {
    const hp = home ? T.combat.homeHp : T.combat.baseHp;
    return { id, x, y, home, tier: 0, hp, maxHp: hp, shield: false, turret: false, down: false, cd: 0 };
  }

  // One shape for a fresh state; deserialize fills the same object so key order (and so JSON) matches.
  function blankState(seed) {
    return {
      ver: VERSION, seed: seed >>> 0, sector: 1, time: 0, sectorTime: 0, w: T.world.w, h: T.world.h,
      bodies: [], bases: [], ships: [], stars: [], storms: [], showers: [], showerIn: 0, hz: 0,
      // hazards: events (fog, flare, raid warnings and live ones; showers keep their own list above and their own timer
      // showerIn, with the same fields), seconds to the next roll, aliens and their ids, shots in flight, and short-lived
      // effects for the UI
      events: [], eventIn: 0, alienSeq: 0, aliens: [], shots: [], fx: [],
      stock: { ore: START_STOCK.ore, ice: START_STOCK.ice, crystal: START_STOCK.crystal },
      won: false, wonAt: 0, clearInfo: null, over: false, endReason: "", endTimer: T.endCheckEvery, stress: false,
      stats: { ore: 0, ice: 0, crystal: 0, lost: 0, kills: 0 },   // total mined, cargo lost (meteors, lost ships), aliens killed
      score: { mat: 0, bases: 0, sectors: 0, time: 0, kills: 0 },
      cleared: 0, starsGot: 0, hits: 0,
      // science (slice a): points now and in total, raid points this sector (for the cap), owned node ids, the beacon and
      // nests, the last raid id, and {alive, escaped} per raid
      science: 0, sciTotal: 0, sciSector: 0, tech: [], nests: [], waveSeq: 0, waves: {},
      // credits and the lose rules (slice b); rules is a copy of TUNING.lose
      credits: T.econ.startCredits, debt: T.econ.debt.start, debtTick: T.econ.debt.every, brokeFor: 0, netNegFor: 0,
      rules: Object.assign({}, T.lose), econStats: { earned: 0, maint: 0, upkeep: 0, interest: 0, repaid: 0 },
      msgs: [],                                         // transient messages for the UI (see emit); never saved
      delivered: { ore: 0, ice: 0, crystal: 0 },        // units handed in, by type
      starsPaid: [],                                    // star keys already paid to someone; each star pays once per save
    };
  }

  function newGame(seed, sector) {
    seed = (seed >>> 0);
    const state = blankState(seed);
    state.rules = Object.assign({}, T.lose);
    buildSector(state, clampSector(sector));
    addShip(state, "miner");
    addShip(state, "miner");
    return state;
  }

  // ---------------------------------------------------------------- contract: messages, run end, tech, hooks
  // Shared plumbing for the science tree (slice a) and the economy and lose rules (slice b). The hook calls that shared
  // functions make go through "api" (the exported object), so a test can swap one of them for a spy.

  // Every way a run can end (state.endReason). deserialize keeps any of these.
  const END_REASONS = ["retired", "stranded", "destroyed", "bankrupt", "debt", "timeout"];

  // Queue a message for the UI and the tests: {type, ...payload}. Capped; never saved.
  function emit(state, type, payload) {
    if (!Array.isArray(state.msgs)) state.msgs = [];
    const e = { type: String(type) };
    if (payload) for (const k of Object.keys(payload)) if (k !== "type") e[k] = payload[k];
    state.msgs.push(e);
    if (state.msgs.length > T.msgs.max) state.msgs.splice(0, state.msgs.length - T.msgs.max);
  }

  // Every queued message, oldest first; the queue is emptied.
  function drainEvents(state) { return Array.isArray(state.msgs) ? state.msgs.splice(0) : []; }

  // End the run for one of END_REASONS (anything else counts as "retired"). The first cause stays; false if already over.
  function endRun(state, cause) {
    if (state.over) return false;
    state.over = true;
    state.endReason = END_REASONS.indexOf(cause) >= 0 ? cause : "retired";
    emit(state, "run:end", { cause: state.endReason });
    return true;
  }

  const TECH_BY_ID = Object.create(null);
  for (const node of T.tech) TECH_BY_ID[node.id] = node;

  function hasTech(state, id) { return !!state.tech && state.tech.indexOf(id) >= 0; }

  // Product of the mult of every owned node's effects with this key; 1 when there are none.
  function techMult(state, key) {
    const list = state.tech;
    let m = 1;
    if (!list || !list.length) return m;
    for (let i = 0; i < list.length; i++) {
      const node = TECH_BY_ID[list[i]];
      if (!node) continue;
      for (const e of node.effects) if (e.key === key && typeof e.mult === "number") m *= e.mult;
    }
    return m;
  }

  // Sum of the add of every owned node's effects with this key; 0 when there are none.
  function techAdd(state, key) {
    const list = state.tech;
    let a = 0;
    if (!list || !list.length) return a;
    for (let i = 0; i < list.length; i++) {
      const node = TECH_BY_ID[list[i]];
      if (!node) continue;
      for (const e of node.effects) if (e.key === key && typeof e.add === "number") a += e.add;
    }
    return a;
  }

  // An alien of a raid is gone from the map: killed, or (escaped) it flew off after its time was up.
  function waveGone(state, a, escaped) {
    const w = a.wave >= 0 && state.waves ? state.waves[a.wave] : null;
    if (!w) return;
    w.alive = Math.max(0, w.alive - 1);
    if (escaped) w.escaped++;
  }

  // Loads the nests of a version 3 save field by field. owner: slice a (keep it in step with any field a nest gains)
  function sanitizeNests(list, state) {
    const out = [];
    for (const n of list.slice(0, 8)) {
      if (!n || (n.kind !== "beacon" && n.kind !== "nest")) continue;
      const max = Math.min(99999, Math.max(1, num(n.max, 1))), hp = Math.min(max, Math.max(0, num(n.hp, max)));
      if (!Number.isInteger(n.id) || n.id < 0 || n.id > NEST_ID_MAX || out.some(o => o.id === n.id)) continue;   // a bad or repeated id drops the entry
      out.push({ id: n.id, kind: n.kind, x: Math.min(state.w, Math.max(0, num(n.x, 0))), y: Math.min(state.h, Math.max(0, num(n.y, 0))),
        hp, max, dead: n.dead === true || hp <= 0,
        guardIn: Array.isArray(n.guardIn) ? n.guardIn.slice(0, 8).map(v => Math.min(600, Math.max(0, num(v, 0)))) : [] });
    }
    return out;
  }

  // ---------------------------------------------------------------- science, nests and the tech tree (slice a)
  // Science comes only from fighting: raider, turret and guard kills and repelled waves (capped per sector), and the
  // sector 2 beacon, alien nests and securing a sector (never capped). Mining, delivering, stars and building give none.

  const NEST_ID_MAX = 999999;        // largest nest id: sanitizeNests and the alien "nest" field in deserialize share this bound
  const NEST_ORDER = 100000000;      // a warship's wt at or above this is an attack order on nest (wt - NEST_ORDER)
  // Geometry of the alien structures (world units): hit radius of a nest and of the beacon, clearance from the map edge,
  // body edges, stars and each other when placing, guard orbit radius, placement tries.
  const NEST_GEO = { nestR: 24, beaconR: 18, edge: 60, bodyClear: 40, starClear: 90, apart: 160, orbit: 70, tries: 240, crystalTries: 80 };
  const CAPPED_SOURCES = { raider: true, turret: true, guard: true, wave: true };   // these share the per-sector raid cap

  function nestById(state, id) {
    const list = state.nests;
    if (!list) return null;
    for (let i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }

  // The nests (not the beacon) still standing.
  function liveNests(state) {
    const out = [];
    if (state.nests) for (let i = 0; i < state.nests.length; i++) if (state.nests[i].kind === "nest" && !state.nests[i].dead) out.push(state.nests[i]);
    return out;
  }

  function nestCount(n) { const N = T.science.nest; return n < N.firstSector ? 0 : Math.min(N.max, N.base + Math.floor((n - N.firstSector) / N.every)); }
  function nestHp(n) { const N = T.science.nest; return Math.round(N.hp * (1 + N.hpPerSector * Math.max(0, n - N.firstSector))); }

  // What a source is worth in sector state.sector, before the cap. source: "raider" (killed by a warship), "turret",
  // "guard", "wave", "beacon", "nest", "secured". 0 for anything else or before the source exists.
  function scienceFor(state, source) {
    const S = T.science, n = state.sector, A = T.aliens.firstSector;
    switch (source) {
      case "raider": return n >= A ? S.raider + Math.floor((n - A) / S.raiderEvery) : 0;
      case "turret": return n >= A ? S.turretKill : 0;
      case "guard": return n >= S.nest.firstSector ? S.guardKill : 0;
      case "wave": return n >= A ? S.wave : 0;
      case "beacon": return n === S.beacon.sector ? S.beacon.sci : 0;
      case "nest": return n >= S.nest.firstSector ? S.nest.sci + S.nest.sciPerSector * (n - S.nest.firstSector) : 0;
      case "secured": return n >= S.nest.firstSector ? S.secured : 0;
    }
    return 0;
  }

  // The most raider, turret and guard kills and wave bonuses can earn in this sector.
  function raidScienceCap(state) {
    const S = T.science;
    return S.raidCap + S.raidCapPerSector * Math.max(0, state.sector - T.aliens.firstSector);
  }

  // Add science. Raid sources are cut to what is left under the sector's cap. Returns the new total (science in hand).
  function awardScience(state, n, source) {
    if (!(n > 0)) return state.science;
    if (CAPPED_SOURCES[source]) {
      n = Math.min(n, Math.max(0, raidScienceCap(state) - state.sciSector));
      if (!(n > 0)) return state.science;
      state.sciSector += n;
    }
    state.science += n;
    state.sciTotal += n;
    emit(state, "science:gain", { amount: n, source, total: state.science });
    return state.science;
  }

  // Called when an alien dies (src: "warship" | "turret" | "alien"). Returns the science it earned. A guard pays its own
  // kill and its nest starts a respawn timer; a raider pays by who killed it; the last raider of a wave (none escaped, no base
  // lost while it lasted) adds the wave bonus.
  function onAlienKilled(state, alien, src) {
    const before = state.science;
    if (alien.nest >= 0) {
      const nest = nestById(state, alien.nest);
      if (nest && !nest.dead) nest.guardIn.push(T.science.nest.guardRespawn);
      awardScience(state, scienceFor(state, "guard"), "guard");
    } else {
      const source = src === "turret" ? "turret" : src === "alien" ? "" : "raider";
      if (source) awardScience(state, scienceFor(state, source), source);
      const w = alien.wave >= 0 && state.waves ? state.waves[alien.wave] : null;
      if (w && w.alive === 0 && w.escaped === 0 && !w.lost && !w.repelled) {
        w.repelled = true;
        emit(state, "wave:repelled", { wave: alien.wave });
        awardScience(state, scienceFor(state, "wave"), "wave");
      }
    }
    return state.science - before;
  }

  // Places the sector's alien structures with their own generator (rng(seed ^ 0x4E57)), so bodies and stars never move:
  // one derelict beacon in sector 2, nests from sector 3. They sit at least minHomeShare of the largest home-to-corner
  // distance from home; the first nest goes within nearCrystal of the richest crystal body in that band, if there is one.
  // Guards are not made here: each nest starts with its guards' timers at 0 and stepNests spawns them.
  function generateNests(state, seed) {
    const S = T.science, G = NEST_GEO, n = state.sector, out = [];
    state.nests = out;
    const beacon = n === S.beacon.sector, count = beacon ? 1 : nestCount(n);
    if (!count || !state.bases.length) return;
    const r = rng(seed ^ 0x4E57), home = state.bases[0], w = state.w, h = state.h;
    let far = 0;
    for (const cx of [0, w]) for (const cy of [0, h]) far = Math.max(far, Math.hypot(cx - home.x, cy - home.y));
    const minHome = far * S.nest.minHomeShare;
    let rich = null;
    for (const b of state.bodies) {
      if (b.res === "crystal" && Math.hypot(b.x - home.x, b.y - home.y) >= minHome && (!rich || b.max > rich.max)) rich = b;
    }
    const fits = (x, y, k) => {
      if (x < G.edge || y < G.edge || x > w - G.edge || y > h - G.edge) return false;
      if (Math.hypot(x - home.x, y - home.y) < minHome) return false;
      for (const b of state.bodies) if (Math.hypot(x - b.x, y - b.y) < b.r + G.bodyClear * k) return false;
      for (const st of state.stars) if (Math.hypot(x - st.x, y - st.y) < G.starClear * k) return false;
      for (const o of out) if (Math.hypot(x - o.x, y - o.y) < G.apart * k) return false;
      return true;
    };
    for (let i = 0; i < count; i++) {
      let spot = null;
      for (let pass = 0; pass < 3 && !spot; pass++) {
        const k = pass === 0 ? 1 : pass === 1 ? 0.5 : 0;
        for (let t = 0; t < G.tries && !spot; t++) {
          let x, y;
          if (i === 0 && rich && t < G.crystalTries) {
            const a = r() * Math.PI * 2, lo = rich.r + G.bodyClear, d = lo + r() * Math.max(0, S.nest.nearCrystal - lo);
            x = rich.x + Math.cos(a) * d; y = rich.y + Math.sin(a) * d;
          } else {
            x = G.edge + r() * (w - 2 * G.edge); y = G.edge + r() * (h - 2 * G.edge);
          }
          if (fits(x, y, k)) spot = { x, y };
        }
      }
      if (!spot) spot = { x: home.x < w / 2 ? w - G.edge : G.edge, y: home.y < h / 2 ? h - G.edge : G.edge };   // the far corner
      const max = beacon ? S.beacon.hp : nestHp(n);
      const guardIn = [];
      if (!beacon) for (let g = 0; g < S.nest.guards; g++) guardIn.push(0);
      out.push({ id: i, kind: beacon ? "beacon" : "nest", x: spot.x, y: spot.y, hp: max, max, dead: false, guardIn });
    }
  }

  function warshipNear(state, x, y, range) {
    const r2 = range * range;
    for (let i = 0; i < state.ships.length; i++) {
      const s = state.ships[i];
      if (s.dead || s.mothballed || !SHIP_TYPES[s.type].war) continue;
      const dx = s.x - x, dy = s.y - y;
      if (dx * dx + dy * dy <= r2) return true;
    }
    return false;
  }

  function spawnGuard(state, nest) {
    const a = state.alienSeq * 2.399, al = makeAlien(state, nest.x + Math.cos(a) * NEST_GEO.orbit, nest.y + Math.sin(a) * NEST_GEO.orbit, state.sector);
    al.nest = nest.id;
    state.aliens.push(al);
  }

  // A nest heals while no warship is near, and brings back each dead guard when its timer runs out. A beacon does neither.
  function stepNests(state, dt) {
    if (!state.nests || !state.nests.length) return;
    const N = T.science.nest;
    for (let k = 0; k < state.nests.length; k++) {
      const nest = state.nests[k];
      if (nest.dead || nest.kind !== "nest") continue;
      if (nest.hp < nest.max && !warshipNear(state, nest.x, nest.y, N.regenRange)) nest.hp = Math.min(nest.max, nest.hp + N.regen * dt);
      for (let i = nest.guardIn.length - 1; i >= 0; i--) {
        nest.guardIn[i] = Math.max(0, nest.guardIn[i] - dt);
        if (nest.guardIn[i] <= 0 && state.aliens.length < T.aliens.max) { nest.guardIn.splice(i, 1); spawnGuard(state, nest); }
      }
    }
  }

  // A guard sits at its orbit spot by the nest. Any live ship within the leash of the nest, warships too, draws it: it
  // closes to its hold distance (never past the leash) and fires like a raider.
  function stepGuard(state, a, nest, dt, sp) {
    const A = T.aliens, leash = T.science.nest.guardLeash, ships = state.ships;
    let tgt = -1, bd = Infinity;
    for (let j = 0; j < ships.length; j++) {
      const s = ships[j];
      if (s.dead || s.mothballed || Math.hypot(s.x - nest.x, s.y - nest.y) > leash) continue;
      const dx = s.x - a.x, dy = s.y - a.y, d2 = dx * dx + dy * dy;
      if (d2 < bd) { bd = d2; tgt = j; }
    }
    a.vx = 0; a.vy = 0;
    if (a.cd > 0) a.cd = Math.max(0, a.cd - dt);
    let gx, gy, hold = 0;
    if (tgt >= 0) { gx = ships[tgt].x; gy = ships[tgt].y; hold = A.range * A.holdFrac; a.tgtKind = "ship"; a.tgt = tgt; }
    else {
      const ang = a.id * 2.399;
      gx = nest.x + Math.cos(ang) * NEST_GEO.orbit; gy = nest.y + Math.sin(ang) * NEST_GEO.orbit;
      a.tgtKind = ""; a.tgt = -1;
    }
    const dx = gx - a.x, dy = gy - a.y, d = Math.sqrt(dx * dx + dy * dy);
    if (d > hold + 1e-6) {
      const k = Math.min(sp, d - hold) / d;
      let nx = a.x + dx * k, ny = a.y + dy * k;
      const ex = nx - nest.x, ey = ny - nest.y, ed = Math.sqrt(ex * ex + ey * ey);
      if (ed > leash) { nx = nest.x + ex / ed * leash; ny = nest.y + ey / ed * leash; }
      a.vx = (nx - a.x) / dt; a.vy = (ny - a.y) / dt;
      a.x = nx; a.y = ny;
    }
    if (tgt >= 0 && a.cd <= 0) {
      const s = ships[tgt], ddx = s.x - a.x, ddy = s.y - a.y;
      if (ddx * ddx + ddy * ddy <= A.range * A.range && fireShot(state, a.x, a.y, s.x, s.y, A.shotSpeed, a.dmg, "them", A.range + BASE_R, "alien")) a.cd = A.cd;
    }
  }

  // Hurt a nest or the beacon. A warship's damage is raised by Siege lances. A kill pays its science, ends the nest's
  // guards (they fall with it), and emits "nest:destroyed". Returns {killed, science}.
  function damageNest(state, id, dmg, by) {
    const nest = nestById(state, id);
    if (!nest || nest.dead || !(dmg > 0)) return { killed: false };
    if (by === "warship") dmg *= techMult(state, "nestDmg");
    nest.hp -= dmg;
    if (nest.hp > 0) return { killed: false };
    nest.hp = 0; nest.dead = true; nest.guardIn = [];
    pushFx(state, "boom", nest.x, nest.y, nest.x, nest.y);
    for (let i = state.aliens.length - 1; i >= 0; i--) {
      const g = state.aliens[i];
      if (g.nest === nest.id) { pushFx(state, "kill", g.x, g.y, g.x, g.y); state.aliens.splice(i, 1); }
    }
    const before = state.science;
    awardScience(state, scienceFor(state, nest.kind), nest.kind);
    emit(state, "nest:destroyed", { id: nest.id, kind: nest.kind, sector: state.sector });
    return { killed: true, science: state.science - before };
  }

  // +5 for warping with every nest of the sector destroyed. Returns the bonus.
  function scienceOnWarp(state) {
    const nests = state.nests ? state.nests.filter(o => o.kind === "nest") : [];
    if (!nests.length || nests.some(o => !o.dead)) return 0;
    const before = state.science;
    awardScience(state, scienceFor(state, "secured"), "secured");
    return state.science - before;
  }

  // ---- the tech tree

  function techCost(node) { return T.techCost[node.tier - 1]; }

  // "owned", "available" (the node below is owned and there is enough science), "short" (the node below is owned,
  // science is not enough) or "locked" (the node below is not owned yet; also for an unknown id).
  function techState(state, id) {
    const node = typeof id === "string" ? TECH_BY_ID[id] : null;
    if (!node) return "locked";
    if (hasTech(state, id)) return "owned";
    if (node.needs && !hasTech(state, node.needs)) return "locked";
    return state.science + 1e-9 >= techCost(node) ? "available" : "short";
  }

  function unlockTech(state, id) {
    const node = typeof id === "string" ? TECH_BY_ID[id] : null;
    if (!node) return { ok: false, reason: "No such tech." };
    if (state.over) return { ok: false, reason: "This run is over." };
    if (hasTech(state, id)) return { ok: false, reason: node.name + " is already yours." };
    if (node.needs && !hasTech(state, node.needs)) return { ok: false, reason: "Needs " + TECH_BY_ID[node.needs].name + "." };
    const cost = techCost(node);
    if (state.science + 1e-9 < cost) return { ok: false, reason: "Need " + Math.ceil(cost - state.science - 1e-9) + " more science." };
    state.science -= cost;
    if (state.science < 0) state.science = 0;
    state.tech.push(id);
    emit(state, "tech:unlock", { id });
    for (const s of state.ships) if (!s.dead && SHIP_TYPES[s.type].war) syncWarshipHp(state, s, SHIP_TYPES[s.type]);
    return { ok: true, cost };
  }

  // ---- what the tree changes in the rules (the economy ones are read in slice b through techMult and techAdd)

  // Cargo a ship holds: Deep holds raises it.
  function cargoCap(state, def) { return def.cap * techMult(state, "cargo"); }
  // Units a base takes in per second, and how far from it a ship can drop off: Quick docks raises both.
  function unloadRate(state, base) { return T.upgrades[base.tier | 0].unload * techMult(state, "unload"); }
  function dockRange(state, base) { return T.upgrades[base.tier | 0].dock + techAdd(state, "dock"); }

  // A warship's maximum HP follows Hardened hulls; the share of health it has stays the same.
  function syncWarshipHp(state, ship, def) {
    const want = Math.round(def.hp * techMult(state, "warshipHp"));
    if (ship.maxHp === want) return;
    const share = ship.maxHp > 0 ? ship.hp / ship.maxHp : 1;
    ship.maxHp = want;
    ship.hp = Math.min(want, share * want);
  }

  // What a warship's attack order points at: {kind: "alien" | "nest", id}, or null when it has none.
  function orderTarget(ship) {
    if (ship.wo !== "attack" || !(ship.wt >= 0)) return null;
    return ship.wt >= NEST_ORDER ? { kind: "nest", id: ship.wt - NEST_ORDER } : { kind: "alien", id: ship.wt };
  }

  // ---- stubs for slice b: neutral until its owner fills them in. Names, arguments and returns are the contract.
  function econScale(n) { return 1; }                                               // owner: slice b
  function econRates(state) { return { maint: 0, upkeep: 0, interest: 0, net: 0 }; }   // owner: slice b (credits per minute)
  function stepEconomy(state, dt) { }                                               // owner: slice b
  function payDebt(state, amount) { return { ok: false, paid: 0, reason: "Credits are not ready yet." }; }   // owner: slice b
  function sellStock(state, res, n) { return { ok: false, reason: "Credits are not ready yet." }; }           // owner: slice b
  function buyStock(state, res, n) { return { ok: false, reason: "Credits are not ready yet." }; }            // owner: slice b
  function setMothball(state, shipId, on) { return { ok: false, reason: "Credits are not ready yet." }; }     // owner: slice b
  function econWarpBlock(state) { return ""; }                                      // owner: slice b ("" or the reason a warp is refused)
  function econOnWarp(state) { }                                                    // owner: slice b (auto-pays the debt at its due point)
  function timeLimit(state) { return 0; }                                           // owner: slice b (seconds, 0 when the timer is off)
  function econWarnings(state) { return []; }                                       // owner: slice b ([{cause, level, secsLeft, text}])

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
    const ship = makeShip(id, type, SHIP_TYPES[type].label + " " + count);
    state.ships.push(ship);
    parkShip(state, ship);
    return ship;
  }

  // One shape for a ship, whoever makes it. ix, iy: manual flight input (runtime only); mm: manual sub-mode 0 flying,
  // 1 mining, 2 unloading. hp/maxHp: health; dead: lost for good (the entry stays so ids hold); stun: flare seconds left;
  // rep: seconds left in a repair. Warship orders: wo "patrol" | "escort" | "attack" | "", wx/wy the patrol point,
  // wt the escort ship id or attack alien id, cd the fire cooldown. mothballed: parked at home on a reduced running cost,
  // wake: seconds left before a woken ship works again (both slice b).
  function makeShip(id, type, name) {
    const hp = SHIP_TYPES[type].hp;
    return { id, type, name,
      x: 0, y: 0, ang: 0,
      st: IDLE, target: -1, dest: -1, star: -1, cargo: 0, res: "", mv: 0, wait: 0, hitCd: 0,
      ix: 0, iy: 0, mm: 0,
      hp, maxHp: hp, dead: false, stun: 0, rep: 0, wo: "", wx: 0, wy: 0, wt: -1, cd: 0, mothballed: false, wake: 0 };
  }

  function makeAlien(state, x, y, n) {
    const hp = alienHp(n);
    return { id: state.alienSeq++, x, y, vx: 0, vy: 0, hp, maxHp: hp, dmg: alienDmg(n), cd: T.aliens.cd, tgtKind: "", tgt: -1, age: 0,
      wave: -1, nest: -1 };   // wave: the raid it came with (state.waves), nest: the nest it guards; -1 for neither
  }

  function buildShip(state, type, labels) {
    const def = SHIP_TYPES[type];
    if (!def) return { ok: false, reason: "Unknown ship type." };
    if (state.over) return { ok: false, reason: "This run is over." };
    const cost = shipCost(state, type);
    if (!canAfford(state, cost)) return { ok: false, reason: "Not enough materials for " + an(lc(labels && labels.ship[type] || def.label)) + "." };
    pay(state, cost);
    return { ok: true, ship: addShip(state, type) };
  }

  // Returns "" when a base can go at (x, y), otherwise the reason it cannot. Allocation free.
  function baseSpotProblem(state, x, y, labels) {
    const m = BASE_R + 6;
    if (!(x >= m && y >= m && x <= state.w - m && y <= state.h - m)) return "Too close to " + (labels ? labels.edge : "the edge of space") + ".";
    for (let i = 0; i < state.bases.length; i++) {
      if (Math.hypot(x - state.bases[i].x, y - state.bases[i].y) < BASE_GAP) return "Too close to another " + (labels ? labels.base : "base") + ".";
    }
    for (let i = 0; i < state.bodies.length; i++) {
      const b = state.bodies[i];
      if (Math.hypot(x - b.x, y - b.y) < b.r + BASE_R + 24) return labels && labels.body.asteroid !== "Asteroid"
        ? "Too close to " + an(lc(labels.body.asteroid)) + " or " + an(lc(labels.body.iceplanet)) + "." : "Too close to a planet or asteroid.";
    }
    return "";
  }

  function placeBase(state, x, y, labels) {
    if (state.over) return { ok: false, reason: "This run is over." };
    const problem = baseSpotProblem(state, x, y, labels);
    if (problem) return { ok: false, reason: problem };
    const cost = baseCost(state);
    if (!canAfford(state, cost)) return { ok: false, reason: "Not enough materials for " + an(labels ? labels.base : "base") + "." };
    pay(state, cost);
    const base = makeBase(state.bases.length, x, y, false);
    state.bases.push(base);
    state.score.bases += T.score.base;
    checkWin(state);
    return { ok: true, base };
  }

  // Each base can be upgraded once per tier. Faster unloading and a longer drop-off range; no other power.
  function upgradeBase(state, baseId, labels) {
    const base = state.bases[baseId], bw = labels ? labels.base : "base";
    if (!base) return { ok: false, reason: "No such " + bw + "." };
    if (state.over) return { ok: false, reason: "This run is over." };
    if (base.down) return { ok: false, reason: "This " + bw + " is down. Repair it first." };
    if ((base.tier | 0) >= MAX_TIER) return { ok: false, reason: "This " + bw + " is fully upgraded." };
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
  function warpToNextSector(state, labels) {
    if (state.over) return { ok: false, reason: "This run is over." };
    if (!state.won) return { ok: false, reason: "Build " + goalBases(state.sector) + " " + lc(labels ? labels.bases : "bases") + " first." };
    const block = api.econWarpBlock(state);       // slice b: e.g. the starting debt cannot be paid
    if (block) return { ok: false, reason: block };
    for (const s of state.ships) {            // cargo still aboard is handed in before the jump
      if (s.cargo > 0 && s.res) { deliver(state, s.res, s.cargo); }
      s.cargo = 0; s.res = ""; s.st = IDLE; s.target = -1; s.dest = -1; s.star = -1; s.wait = 0; s.hitCd = 0; s.mv = 0; s.mm = 0; s.ix = 0; s.iy = 0;
      s.stun = 0; s.rep = 0; s.cd = 0; s.wo = ""; s.wt = -1;   // the new map has no flares, repairs or aliens in progress
    }
    api.scienceOnWarp(state);                    // slice a: the "sector secured" bonus
    api.econOnWarp(state);                       // slice b: the debt is paid at its due point
    buildSector(state, state.sector + 1);
    state.clearInfo = null;
    for (const s of state.ships) parkShip(state, s);
    return { ok: true, sector: state.sector };
  }

  // ---------------------------------------------------------------- orders

  // The reason a ship cannot take an order, or "" when it can. A lost ship takes none; a warship takes no mining orders.
  function lostReason(ship) { return ship.dead ? ship.name + " was lost." : ""; }
  function warReason(ship) { return SHIP_TYPES[ship.type].war ? ship.name + " is a warship. It cannot mine. Give it a patrol, escort or attack order." : ""; }

  // Slice b decides when a ship is out of reach of orders (mothballed, waking); both go through api so a test can swap them.
  function shipAvailable(state, ship) { return !ship.dead; }                         // owner: slice b
  function shipUnavailableReason(state, ship) { return lostReason(ship); }           // owner: slice b
  function unavailable(state, ship) { return api.shipAvailable(state, ship) ? null : { ok: false, reason: api.shipUnavailableReason(state, ship) }; }

  function orderShip(state, shipId, bodyId, labels) {
    const ship = state.ships[shipId], body = state.bodies[bodyId];
    if (!ship || !body) return { ok: false, reason: "No such ship or body." };
    { const u = unavailable(state, ship); if (u) return u; }
    if (SHIP_TYPES[ship.type].war) return { ok: false, reason: warReason(ship) };
    if (body.amount <= 1e-6) return { ok: false, reason: bodyLabel(body, labels) + " is empty." };
    clearManual(ship);
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
    { const u = unavailable(state, ship); if (u) return u; }
    if (SHIP_TYPES[ship.type].war) return { ok: false, reason: warReason(ship) };
    if (star.taken) return { ok: false, reason: "That star is already taken." };
    clearManual(ship);
    ship.star = starId;
    ship.target = -1;
    ship.dest = -1;
    ship.st = TO_STAR;
    return { ok: true };
  }

  function recallShip(state, shipId) {
    const ship = state.ships[shipId];
    if (!ship) return { ok: false, reason: "No such ship." };
    { const u = unavailable(state, ship); if (u) return u; }
    if (SHIP_TYPES[ship.type].war) return guardBase(state, ship, nearestBase(state, ship.x, ship.y));
    clearManual(ship);
    ship.target = -1;
    ship.dest = -1;
    ship.star = -1;
    if (ship.st !== IDLE) ship.st = TO_BASE;
    return { ok: true };
  }

  // A warship told to go home patrols at the base instead (it has no cargo to unload).
  function guardBase(state, ship, baseId) {
    const b = state.bases[baseId], a = ship.id * 2.399;
    clearManual(ship);
    ship.st = IDLE; ship.wo = "patrol"; ship.wt = -1;
    ship.wx = b.x + Math.cos(a) * (BASE_R + 28); ship.wy = b.y + Math.sin(a) * (BASE_R + 28);
    return { ok: true };
  }

  // Like recallShip, but to one chosen base instead of the nearest. An idle ship goes too.
  function returnToBase(state, shipId, baseId, labels) {
    const ship = state.ships[shipId], base = state.bases[baseId];
    if (!ship || !base) return { ok: false, reason: "No such ship or " + (labels ? labels.base : "base") + "." };
    { const u = unavailable(state, ship); if (u) return u; }
    if (SHIP_TYPES[ship.type].war) return guardBase(state, ship, baseId);
    clearManual(ship);
    ship.target = -1;
    ship.dest = baseId;
    ship.star = -1;
    ship.st = TO_BASE;
    return { ok: true };
  }

  function clearManual(ship) { ship.mm = 0; ship.ix = 0; ship.iy = 0; }

  // ---------------------------------------------------------------- manual flying and numbered targets
  // A player can fly one ship by hand (state MANUAL). It moves at the ship's normal speed (storms slow it), mines at the
  // ship's normal rate and unloads like an auto ship; there is no bonus. mm: 0 flying, 1 mining, 2 unloading.

  function takeManual(state, shipId) {
    const ship = state.ships[shipId];
    if (!ship) return { ok: false, reason: "No such ship." };
    if (state.over) return { ok: false, reason: "This run is over." };
    { const u = unavailable(state, ship); if (u) return u; }
    clearManual(ship);
    ship.st = MANUAL;
    ship.target = -1; ship.dest = -1; ship.star = -1; ship.wait = 0; ship.wo = ""; ship.wt = -1;
    return { ok: true };
  }

  function releaseManual(state, shipId) {
    const ship = state.ships[shipId];
    if (!ship) return { ok: false, reason: "No such ship." };
    if (ship.st !== MANUAL) return { ok: false, reason: "Not flying by hand." };
    clearManual(ship);
    ship.st = IDLE; ship.target = -1; ship.wait = 0; ship.mv = 0;
    return { ok: true };
  }

  function clampAxis(v) { return typeof v === "number" && isFinite(v) ? Math.max(-1, Math.min(1, v)) : 0; }

  function setManualInput(state, shipId, ix, iy) {
    const ship = state.ships[shipId];
    if (!ship || ship.st !== MANUAL) return { ok: false, reason: "Not flying by hand." };
    ship.ix = clampAxis(ix); ship.iy = clampAxis(iy);
    return { ok: true };
  }

  // The one action key: unload at a base in reach, else mine a body in reach, else (while mining or unloading) stop.
  function manualAction(state, shipId, labels) {
    const ship = state.ships[shipId];
    if (!ship || ship.st !== MANUAL) return { ok: false, reason: "Not flying by hand." };
    if (state.over) return { ok: false, reason: "This run is over." };
    if (ship.mm === 1 || ship.mm === 2) { ship.mm = 0; ship.wait = 0; ship.target = -1; return { ok: true, did: "stop" }; }
    const def = SHIP_TYPES[ship.type], L = labels || SPACE_LABELS;
    if (def.war) return { ok: false, reason: warReason(ship) };
    if (ship.stun > 0) return { ok: false, reason: ship.name + " is stunned by a solar flare." };
    if (ship.cargo > 0) {
      const base = state.bases[nearestBase(state, ship.x, ship.y)];
      if (Math.hypot(ship.x - base.x, ship.y - base.y) <= BASE_R + 10 + dockRange(state, base) + MANUAL_SLACK) {
        ship.wait = ship.cargo / unloadRate(state, base);
        deliver(state, ship.res, ship.cargo);
        ship.cargo = 0; ship.res = ""; ship.mm = 2;
        return { ok: true, did: "unload" };
      }
    }
    let best = null, bd = Infinity, wrongRes = false;
    for (let i = 0; i < state.bodies.length; i++) {
      const b = state.bodies[i];
      if (b.amount <= 1e-6) continue;
      const d = Math.hypot(ship.x - b.x, ship.y - b.y);
      if (d > b.r + 12 + MANUAL_SLACK) continue;
      if (ship.cargo > 0 && ship.res !== b.res) { wrongRes = true; continue; }   // carrying another resource: keep looking
      if (d < bd) { bd = d; best = b; }
    }
    if (!best && wrongRes) return { ok: false, reason: "Carrying " + (L.res[ship.res] || ship.res) + ". Unload at a " + L.base + " first." };
    if (!best) return { ok: false, reason: "Nothing in reach." };
    if (ship.cargo >= cargoCap(state, def) - 1e-9) return { ok: false, reason: "Full. Unload at a " + L.base + " first." };
    ship.mm = 1; ship.target = best.id; ship.res = best.res;
    return { ok: true, did: "mine" };
  }

  // Every body that still holds something and every star not yet taken, with a stable number: bodies 1..B in index order,
  // then stars B+1.. in index order. Empty bodies and taken stars keep their number but are left out.
  function targetList(state) {
    const out = [], nb = state.bodies.length;
    for (let i = 0; i < nb; i++) if (state.bodies[i].amount > 1e-6) out.push({ n: i + 1, kind: "body", id: i });
    for (let i = 0; i < state.stars.length; i++) if (!state.stars[i].taken) out.push({ n: nb + i + 1, kind: "star", id: i });
    return out;
  }

  // The key for target n: 1-9, 0 for ten, then the plain number (typed as two digits).
  function targetLabel(n) { return n === 10 ? "0" : String(n); }

  // buf is the digits typed so far, count the highest target number. wait is true when a longer number starting with
  // buf could still be typed, so the caller waits a moment for another digit before acting on n.
  function resolveTargetKeys(buf, count) {
    buf = String(buf == null ? "" : buf);
    if (!/^[0-9]+$/.test(buf) || !(count >= 1)) return { n: null, wait: false };
    if (buf === "0") return { n: count >= 10 ? 10 : null, wait: false };
    if (buf[0] === "0") return { n: null, wait: false };
    const v = parseInt(buf, 10);
    return { n: v <= count ? v : null, wait: count >= v * 10 };
  }

  function orderToTarget(state, shipId, n, labels) {
    const ship = state.ships[shipId];
    if (!ship) return { ok: false, reason: "No such ship." };
    { const u = unavailable(state, ship); if (u) return u; }
    const nb = state.bodies.length;
    if (Number.isInteger(n) && n >= 1 && n <= nb) return orderShip(state, shipId, n - 1, labels);
    if (Number.isInteger(n) && n > nb && n - nb <= state.stars.length) return orderShipToStar(state, shipId, n - nb - 1);
    return { ok: false, reason: "No target " + n + "." };
  }

  function orderNearestBase(state, shipId, labels) {
    const ship = state.ships[shipId];
    if (!ship) return { ok: false, reason: "No such ship." };
    { const u = unavailable(state, ship); if (u) return u; }
    return returnToBase(state, shipId, nearestBase(state, ship.x, ship.y), labels);
  }

  // ---------------------------------------------------------------- simulation

  function nearestBase(state, x, y) {
    let best = 0, bd = Infinity;
    for (let i = 0; i < state.bases.length; i++) {
      if (state.bases[i].down) continue;      // a base that is down takes no drop-offs (the home base never goes down)
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

  // Like moveTo, but stops `stop` units short of the point. Returns true once within that distance.
  function moveNear(ship, tx, ty, stop, dt, mult) {
    const dx = tx - ship.x, dy = ty - ship.y;
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d <= stop) { ship.mv = 0; return true; }
    const k = Math.min(SHIP_TYPES[ship.type].speed * dt * mult, d - stop) / d;
    ship.x += dx * k;
    ship.y += dy * k;
    ship.ang = Math.atan2(dy, dx);
    ship.mv = 1;
    return false;
  }

  function deliver(state, res, amount) {
    state.stock[res] += amount;
    state.score.mat += amount * T.score.value[res];
    state.delivered[res] += amount;
  }

  // After unloading: repeat the run if the body still has something, else go idle.
  function afterUnload(state, ship) {
    const body = ship.target >= 0 ? state.bodies[ship.target] : null;
    if (body && body.amount > 1e-6) ship.st = TO_BODY;
    else { ship.target = -1; ship.st = IDLE; }
  }

  // ---- hazards: health, fog, flares, showers

  // A short-lived effect for the UI: kind "block" (a turret stops a meteor: line from the turret x,y to the target x2,y2),
  // "kill" (an alien died at x,y) or "boom" (a ship or base was lost at x,y). age counts up to life, then it is dropped.
  function pushFx(state, kind, x, y, x2, y2) {
    const fx = state.fx;
    if (fx.length >= T.combat.fxMax) fx.shift();
    fx.push({ kind, x, y, x2, y2, age: 0, life: T.combat.fxLife });
  }

  function damageShip(state, ship, dmg) {
    if (ship.dead || !(dmg > 0)) return;
    ship.hp -= dmg;
    if (ship.hp > 0) return;
    ship.hp = 0; ship.dead = true;
    if (ship.cargo > 0) state.stats.lost += ship.cargo;      // the cargo is gone with the ship
    ship.cargo = 0; ship.res = "";
    ship.st = IDLE; ship.target = -1; ship.dest = -1; ship.star = -1; ship.mv = 0; ship.wait = 0; ship.mm = 0; ship.ix = 0; ship.iy = 0;
    ship.stun = 0; ship.rep = 0; ship.wo = ""; ship.wt = -1;
    pushFx(state, "boom", ship.x, ship.y, ship.x, ship.y);
  }

  function damageBase(state, base, dmg) {
    if (base.down || !(dmg > 0)) return;
    base.hp -= dmg;
    if (base.hp > 0) return;
    base.hp = 0;
    pushFx(state, "boom", base.x, base.y, base.x, base.y);
    for (const k of Object.keys(state.waves || {})) if (state.waves[k].alive > 0) state.waves[k].lost = true;   // no wave bonus for a wave that cost a base
    if (base.home) endRun(state, "destroyed");
    else base.down = true;
  }

  // Index of a live turret base that stops a hit at (x, y), else -1. Each turret in range tries once (hrand).
  function turretBlock(state, x, y) {
    const R = T.addons.turret.range, bs = state.bases;
    for (let i = 0; i < bs.length; i++) {
      const b = bs[i];
      if (!b.turret || b.down) continue;
      const dx = x - b.x, dy = y - b.y;
      if (dx * dx + dy * dy > R * R) continue;
      if (hrand(state) < T.addons.turret.block) { pushFx(state, "block", b.x, b.y, x, y); return i; }
    }
    return -1;
  }

  function evWarn(e, dflt) { return typeof e.warn === "number" ? e.warn : dflt; }

  // True inside a live fog bank (not during its warning).
  function fogAt(state, x, y) {
    const ev = state.events;
    for (let i = 0; i < ev.length; i++) {
      const e = ev[i];
      if (e.kind !== "fog" || e.age < evWarn(e, T.events.warn)) continue;
      const dx = x - e.x, dy = y - e.y;
      if (dx * dx + dy * dy < e.r * e.r) return true;
    }
    return false;
  }

  // True when a live, shielded base covers (x, y).
  function shielded(state, x, y) {
    const R = T.addons.shield.range, bs = state.bases;
    for (let i = 0; i < bs.length; i++) {
      const b = bs[i];
      if (!b.shield || b.down) continue;
      const dx = x - b.x, dy = y - b.y;
      if (dx * dx + dy * dy <= R * R) return true;
    }
    return false;
  }

  function flareActive(state) {
    const ev = state.events;
    for (let i = 0; i < ev.length; i++) if (ev[i].kind === "flare" && ev[i].age >= evWarn(ev[i], T.events.warn)) return true;
    return false;
  }

  // Mining speed factor at (x, y): the fog factor inside live fog, else 1.
  function mineMult(state, x, y) { return state.events.length && fogAt(state, x, y) ? T.fog.mine : 1; }

  // A ship inside a live meteor shower may be hit: it loses part of its cargo (if loaded) and takes damage, unless a turret
  // in range blocks the hit. A hit, blocked or not, starts the ship's grace period.
  function meteorCheck(state, ship, dt) {
    if (ship.hitCd > 0) return;
    const S = T.showers, sh = state.showers;
    for (let i = 0; i < sh.length; i++) {
      const e = sh[i];
      if (e.age < evWarn(e, S.warn)) continue;
      const dx = ship.x - e.x, dy = ship.y - e.y;
      if (dx * dx + dy * dy >= e.r * e.r) continue;
      if (hrand(state) < showerHit(state.sector) * dt) {
        ship.hitCd = S.cooldown;
        if (turretBlock(state, ship.x, ship.y) >= 0) return;
        if (ship.cargo > 0) {      // `hits` counts the hits that knocked cargo off, as before; an empty ship still takes the damage
          const lost = ship.cargo * S.loss;
          ship.cargo -= lost;
          state.stats.lost += lost;
          state.hits++;
        }
        damageShip(state, ship, typeof e.power === "number" ? e.power : showerDmg(state.sector));
        return;
      }
    }
  }

  function stepManual(state, ship, dt, mult, def) {
    const cap = cargoCap(state, def), rate = def.rate * techMult(state, "mineRate");   // tech: Deep holds, Efficient drills
    if (ship.mm === 2) {                       // unloading: the delivery was made when it started
      ship.mv = 0;
      ship.wait -= dt;
      if (ship.wait <= 0) { ship.wait = 0; ship.mm = 0; ship.target = -1; }
      return;
    }
    const len = Math.hypot(ship.ix, ship.iy);
    if (ship.mm === 1) {
      if (len > 0) { ship.mm = 0; ship.target = -1; }   // any input cancels mining
      else {
        const body = state.bodies[ship.target];
        ship.mv = 0;
        if (!body || body.amount <= 1e-6) { ship.mm = 0; ship.target = -1; return; }
        const take = Math.min(rate * dt * mineMult(state, ship.x, ship.y), body.amount, cap - ship.cargo);
        body.amount -= take;
        if (body.amount < 1e-6) body.amount = 0;
        ship.cargo += take;
        ship.res = body.res;
        state.stats[body.res] += take;
        if (ship.cargo >= cap - 1e-9 || body.amount === 0) { ship.mm = 0; ship.target = -1; }
        return;
      }
    }
    if (!(len > 0)) { ship.mv = 0; return; }
    const step = def.speed * dt * mult / len;
    ship.x = Math.max(0, Math.min(state.w, ship.x + ship.ix * step));
    ship.y = Math.max(0, Math.min(state.h, ship.y + ship.iy * step));
    ship.ang = Math.atan2(ship.iy, ship.ix);
    ship.mv = 1;
  }

  function stepShip(state, ship, dt) {
    if (ship.dead) return;
    if (ship.mothballed) { ship.mv = 0; return; }
    if (ship.wake > 0) { ship.wake = Math.max(0, ship.wake - dt); ship.mv = 0; return; }
    const def = SHIP_TYPES[ship.type];
    if (ship.hitCd > 0) ship.hitCd = Math.max(0, ship.hitCd - dt);
    if (state.showers.length) { meteorCheck(state, ship, dt); if (ship.dead) return; }
    if (ship.stun > 0) { ship.stun = Math.max(0, ship.stun - dt); ship.mv = 0; return; }   // a flare holds it: no move, no mining
    if (ship.rep > 0) { ship.rep = Math.max(0, ship.rep - dt); ship.mv = 0; return; }      // being repaired
    if (def.war) { stepWarship(state, ship, dt, def); return; }
    if (ship.st === IDLE) { ship.mv = 0; return; }
    if (ship.st === UNLOADING) {
      ship.mv = 0;
      ship.wait -= dt;
      if (ship.wait <= 0) { ship.wait = 0; afterUnload(state, ship); }
      return;
    }
    const mult = (state.storms.length ? speedMult(state, ship.x, ship.y) : 1) * techMult(state, "shipSpeed");   // tech: Afterburners (miners and haulers)
    if (ship.st === MANUAL) { stepManual(state, ship, dt, mult, def); return; }
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
      const cap = cargoCap(state, def);
      const take = Math.min(def.rate * techMult(state, "mineRate") * dt * mineMult(state, ship.x, ship.y), body.amount, cap - ship.cargo);
      body.amount -= take;
      if (body.amount < 1e-6) body.amount = 0;
      ship.cargo += take;
      ship.res = body.res;
      state.stats[body.res] += take;
      if (ship.cargo >= cap - 1e-9 || body.amount === 0) ship.st = TO_BASE;
      return;
    }
    // TO_BASE: fly to the chosen base (else the nearest) and get within its drop-off range, unload
    // (an upgraded base takes less time), then repeat the run if the body still has something
    let base = ship.dest >= 0 && ship.dest < state.bases.length ? state.bases[ship.dest] : null;
    if (!base || base.down) base = state.bases[nearestBase(state, ship.x, ship.y)];   // a base that is down takes no drop-offs
    const a = ship.id * 2.399, stop = BASE_R + 10 + dockRange(state, base);
    if (!moveTo(ship, base.x + Math.cos(a) * stop, base.y + Math.sin(a) * stop, dt, mult)) return;
    let wait = 0;
    if (ship.cargo > 0) { wait = ship.cargo / unloadRate(state, base); deliver(state, ship.res, ship.cargo); ship.cargo = 0; }
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
    const S = T.showers, sh = state.showers, ev = state.events;
    for (let i = sh.length - 1; i >= 0; i--) {      // showers: strike bases once live, expire at the end
      const e = sh[i];
      e.age += dt;
      const warn = evWarn(e, S.warn);
      if (e.age >= warn + (typeof e.dur === "number" ? e.dur : S.dur)) { sh.splice(i, 1); continue; }
      if (e.age < warn) continue;
      e.tick = (typeof e.tick === "number" ? e.tick : 0) - dt;
      if (e.tick > 0) continue;
      e.tick = S.baseTick;
      const power = (typeof e.power === "number" ? e.power : showerDmg(state.sector)) * S.baseMult;
      for (let j = 0; j < state.bases.length; j++) {
        const b = state.bases[j];
        if (b.down) continue;
        const dx = b.x - e.x, dy = b.y - e.y;
        if (dx * dx + dy * dy >= e.r * e.r || hrand(state) >= S.baseHit) continue;
        if (turretBlock(state, b.x, b.y) >= 0) continue;
        damageBase(state, b, power);
      }
    }
    for (let i = ev.length - 1; i >= 0; i--) {      // fog, flares and raids
      const e = ev[i];
      e.age += dt;
      const warn = evWarn(e, T.events.warn);
      if (e.kind === "raid") { if (e.age >= warn) { spawnRaid(state, e); ev.splice(i, 1); } }
      else if (e.age >= warn + e.dur) ev.splice(i, 1);
    }
    if (showersOn(state.sector)) {
      state.showerIn -= dt;
      if (state.showerIn <= 0) {
        if (sh.length + ev.length >= T.events.maxActive || sh.length >= S.max) state.showerIn = T.events.retry;
        else {
          const m = S.margin, n = state.sector;
          sh.push({ kind: "shower", x: m + hrand(state) * (w - 2 * m), y: m + hrand(state) * (h - 2 * m), r: showerRadius(n), age: 0,
            warn: S.warn, dur: S.dur, power: showerDmg(n), tick: 0 });
          state.showerIn = showerGap(n) * (1 - S.gapJitter / 2 + S.gapJitter * hrand(state));
        }
      }
    }
    if (eventsOn(state.sector)) {
      state.eventIn -= dt;
      if (state.eventIn <= 0) rollEvent(state);
    }
    if (ev.length && flareActive(state)) {      // a flare stuns every ship outside a shield's reach
      const ships = state.ships;
      for (let i = 0; i < ships.length; i++) {
        const s = ships[i];
        if (!s.dead && s.stun < T.flare.linger && !shielded(state, s.x, s.y)) s.stun = T.flare.linger;
      }
    }
    if (state.aliens.length) stepAliens(state, dt);
    stepTurrets(state, dt);
    if (state.shots.length) stepShots(state, dt);
    const fx = state.fx;
    for (let i = fx.length - 1; i >= 0; i--) { fx[i].age += dt; if (fx[i].age >= fx[i].life) fx.splice(i, 1); }
  }

  // Roll one event: a raid with chance raidOdds(n), else fog or flare by weight. A full board waits and tries again.
  function rollEvent(state) {
    const E = T.events, n = state.sector, w = state.w, h = state.h, ev = state.events;
    if (ev.length + state.showers.length >= E.maxActive) { state.eventIn = E.retry; return; }
    let kind;
    if (hrand(state) < raidOdds(n)) kind = "raid";
    else kind = hrand(state) * (E.weight.fog + E.weight.flare) < E.weight.fog ? "fog" : "flare";
    const have = k => { let c = 0; for (let i = 0; i < ev.length; i++) if (ev[i].kind === k) c++; return c; };
    if (kind === "flare" && have("flare") >= T.flare.max) kind = "fog";   // one flare at a time
    if ((kind === "fog" && have("fog") >= T.fog.max) || (kind === "raid" && have("raid") >= E.maxRaids)) { state.eventIn = E.retry; return; }
    const power = eventPower(n), e = { kind, x: 0, y: 0, r: 0, age: 0, warn: E.warn, dur: 0, power };
    if (kind === "fog") {
      const F = T.fog, m = F.margin;
      e.r = F.rMin + hrand(state) * (fogRadius(n) - F.rMin);
      e.x = m + hrand(state) * (w - 2 * m); e.y = m + hrand(state) * (h - 2 * m);
      e.dur = F.dur;
    } else if (kind === "flare") {
      e.dur = flareDur(n);
    } else {
      const edge = T.aliens.edge, side = Math.floor(hrand(state) * 4), u = hrand(state);
      e.x = side === 0 ? edge : side === 1 ? w - edge : edge + u * (w - 2 * edge);
      e.y = side === 2 ? edge : side === 3 ? h - edge : edge + u * (h - 2 * edge);
      e.r = T.aliens.markR; e.dur = 0; e.power = alienCount(n);
      const live = liveNests(state);
      if (live.length) {      // a known direction: the map edge nearest one of the live nests (the one picked by the same draw)
        const nest = live[Math.min(live.length - 1, Math.floor(u * live.length))];
        const dl = nest.x, dr = w - nest.x, dt = nest.y, db = h - nest.y, m = Math.min(dl, dr, dt, db);
        e.x = m === dl ? edge : m === dr ? w - edge : Math.max(edge, Math.min(w - edge, nest.x));
        e.y = m === dl || m === dr ? Math.max(edge, Math.min(h - edge, nest.y)) : m === dt ? edge : h - edge;
      }
    }
    ev.push(e);
    state.eventIn = eventGap(n) * (1 - E.jitter / 2 + E.jitter * hrand(state));
    if (kind === "raid") state.eventIn /= 1 + T.science.nest.raidBoost * liveNests(state).length;   // nests shorten the raid gap only
  }

  // The raid arrives: the aliens appear around the warned point at the edge of the map.
  function spawnRaid(state, e) {
    const A = T.aliens, n = state.sector;
    const count = Math.max(1, Math.floor(typeof e.power === "number" ? e.power : alienCount(n)));
    const wave = state.waveSeq + 1;      // one id per raid that brings anyone
    let made = 0;
    for (let i = 0; i < count && state.aliens.length < A.max; i++) {
      const x = Math.max(0, Math.min(state.w, e.x + (hrand(state) - 0.5) * 2 * e.r));
      const y = Math.max(0, Math.min(state.h, e.y + (hrand(state) - 0.5) * 2 * e.r));
      const al = makeAlien(state, x, y, n);
      al.wave = wave;
      state.aliens.push(al);
      made++;
    }
    if (made > 0) { state.waveSeq = wave; state.waves[wave] = { alive: made, escaped: 0 }; }
  }

  function alienById(state, id) {
    const al = state.aliens;
    for (let i = 0; i < al.length; i++) if (al[i].id === id) return al[i];
    return null;
  }

  // Index of the nearest alien within `range` of (x, y), else -1.
  function alienIndexNear(state, x, y, range) {
    const al = state.aliens;
    let best = -1, bd = range * range;
    for (let i = 0; i < al.length; i++) {
      const dx = al[i].x - x, dy = al[i].y - y, d = dx * dx + dy * dy;
      if (d <= bd) { bd = d; best = i; }
    }
    return best;
  }

  // The nearest alien to (x, y) anywhere on the map: its id, or -1 (for the attack key).
  function nearestAlien(state, x, y) {
    const al = state.aliens;
    let best = -1, bd = Infinity;
    for (let i = 0; i < al.length; i++) {
      const dx = al[i].x - x, dy = al[i].y - y, d = dx * dx + dy * dy;
      if (d < bd) { bd = d; best = al[i].id; }
    }
    return best;
  }

  // Fire a shot from (x, y) at (tx, ty) (already led). No-op when the shot list is full.
  function fireShot(state, x, y, tx, ty, speed, dmg, side, range, src) {
    if (state.shots.length >= T.combat.maxShots) return false;
    const dx = tx - x, dy = ty - y, d = Math.sqrt(dx * dx + dy * dy);
    if (!(d > 1e-6)) return false;
    state.shots.push({ x, y, vx: dx / d * speed, vy: dy / d * speed, life: Math.min(T.combat.shotLife, range * T.combat.shotReach / speed), dmg, side,
      src: src || (side === "us" ? "warship" : "alien") });   // src: who fired it, "warship" | "turret" | "alien"
    return true;
  }

  // Fire at alien a from (x, y), leading it by its velocity.
  function fireAtAlien(state, x, y, a, speed, dmg, range, src) {
    const dx = a.x - x, dy = a.y - y, t = Math.sqrt(dx * dx + dy * dy) / speed;
    return fireShot(state, x, y, a.x + a.vx * t, a.y + a.vy * t, speed, dmg, "us", range, src);
  }

  function killAlien(state, index, src) {
    const A = T.aliens, a = state.aliens[index];
    state.score.kills += A.score;
    state.stats.kills++;
    pushFx(state, "kill", a.x, a.y, a.x, a.y);
    if (hrand(state) < A.starChance && state.stars.length < A.maxStars) {      // a star where it fell (ordinary star rules)
      const m = T.stars.edge;
      state.stars.push({ id: state.stars.length, x: Math.max(m, Math.min(state.w - m, a.x)), y: Math.max(m, Math.min(state.h - m, a.y)), taken: false });
    }
    state.aliens.splice(index, 1);
    waveGone(state, a, false);
    api.onAlienKilled(state, a, src || "warship");     // slice a: science for the kill
  }

  function stepAliens(state, dt) {
    const A = T.aliens, al = state.aliens, ships = state.ships, bases = state.bases, sp = alienSpeed(state.sector) * dt;
    const sense2 = A.sense * A.sense;
    for (let i = 0; i < al.length; i++) {
      const a = al[i];
      a.age = (a.age || 0) + dt;
      if (a.nest >= 0) {      // a nest guard: it stays near its nest and shoots any ship that comes close (warships too)
        const nest = nestById(state, a.nest);
        if (!nest || nest.dead) { al.splice(i, 1); i--; continue; }
        stepGuard(state, a, nest, dt, sp);
        continue;
      }
      if (a.age > A.stay) {      // time to go: fly to the nearest map edge and leave (no score)
        const ex = a.x < state.w - a.x ? 0 : state.w, ey = a.y < state.h - a.y ? 0 : state.h;
        const alongX = Math.abs(a.x - ex) <= Math.abs(a.y - ey);
        const gx = alongX ? ex : a.x, gy = alongX ? a.y : ey, dx = gx - a.x, dy = gy - a.y, d = Math.sqrt(dx * dx + dy * dy);
        a.tgtKind = ""; a.tgt = -1;
        if (d <= sp) { waveGone(state, a, true); al.splice(i, 1); i--; continue; }
        a.vx = dx / d * sp / dt; a.vy = dy / d * sp / dt;
        a.x += dx / d * sp; a.y += dy / d * sp;
        continue;
      }
      // target: the nearest loaded ship within sense, else the nearest live base
      let kind = "", tgt = -1, bd = sense2, tx = 0, ty = 0;
      for (let j = 0; j < ships.length; j++) {
        const s = ships[j];
        if (s.dead || !(s.cargo > 0)) continue;
        const dx = s.x - a.x, dy = s.y - a.y, d = dx * dx + dy * dy;
        if (d < bd) { bd = d; tgt = j; kind = "ship"; tx = s.x; ty = s.y; }
      }
      if (tgt < 0) {
        bd = Infinity;
        for (let j = 0; j < bases.length; j++) {
          if (bases[j].down) continue;
          const dx = bases[j].x - a.x, dy = bases[j].y - a.y, d = dx * dx + dy * dy;
          if (d < bd) { bd = d; tgt = j; kind = "base"; tx = bases[j].x; ty = bases[j].y; }
        }
      }
      a.tgtKind = kind; a.tgt = tgt;
      a.vx = 0; a.vy = 0;
      if (tgt < 0) continue;
      const d = Math.sqrt(bd), hold = A.range * A.holdFrac + (kind === "base" ? BASE_R : 0);
      if (d > hold) {
        const k = Math.min(sp, d - hold) / d;
        a.vx = (tx - a.x) * k / dt; a.vy = (ty - a.y) * k / dt;
        a.x += (tx - a.x) * k; a.y += (ty - a.y) * k;
      }
      if (a.cd > 0) a.cd = Math.max(0, a.cd - dt);
      if (a.cd <= 0 && d <= A.range + (kind === "base" ? BASE_R : 0)) {
        if (fireShot(state, a.x, a.y, tx, ty, A.shotSpeed, a.dmg, "them", A.range + BASE_R, "alien")) a.cd = A.cd;
      }
    }
  }

  function stepTurrets(state, dt) {
    const U = T.addons.turret, bases = state.bases;
    for (let i = 0; i < bases.length; i++) {
      const b = bases[i];
      if (!b.turret || b.down) continue;
      if (b.cd > 0) b.cd = Math.max(0, b.cd - dt);
      if (b.cd > 0 || !state.aliens.length) continue;
      const k = alienIndexNear(state, b.x, b.y, U.range);
      if (k >= 0 && fireAtAlien(state, b.x, b.y, state.aliens[k], U.shotSpeed, U.dmg, U.range, "turret")) b.cd = U.cd;
    }
  }

  // Squared distance from point (cx, cy) to the segment (px, py)-(qx, qy).
  function segDist2(px, py, qx, qy, cx, cy) {
    const dx = qx - px, dy = qy - py, len2 = dx * dx + dy * dy;
    let t = len2 > 0 ? ((cx - px) * dx + (cy - py) * dy) / len2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const ex = px + dx * t - cx, ey = py + dy * t - cy;
    return ex * ex + ey * ey;
  }

  // Shots fly in a line; a hit is checked along the whole step so a fast shot or a long step cannot skip a target.
  function stepShots(state, dt) {
    const shots = state.shots, A = T.aliens, al = state.aliens, ships = state.ships, bases = state.bases;
    const ar2 = A.r * A.r, sr2 = T.combat.shipR * T.combat.shipR, br2 = BASE_R * BASE_R;
    for (let i = shots.length - 1; i >= 0; i--) {
      const s = shots[i], nx = s.x + s.vx * dt, ny = s.y + s.vy * dt;
      let hit = false;
      if (s.side === "us") {
        for (let j = 0; j < al.length; j++) {
          if (segDist2(s.x, s.y, nx, ny, al[j].x, al[j].y) > ar2) continue;
          al[j].hp -= s.dmg;
          if (al[j].hp <= 0) killAlien(state, j, s.src);
          hit = true; break;
        }
        for (let j = 0; j < state.nests.length && !hit; j++) {     // a beacon or nest
          const nest = state.nests[j], r = (nest.kind === "beacon" ? NEST_GEO.beaconR : NEST_GEO.nestR);
          if (nest.dead || segDist2(s.x, s.y, nx, ny, nest.x, nest.y) > r * r) continue;
          damageNest(state, nest.id, s.dmg, s.src || "warship");
          hit = true;
        }
      } else {
        for (let j = 0; j < ships.length && !hit; j++) {
          if (ships[j].dead || segDist2(s.x, s.y, nx, ny, ships[j].x, ships[j].y) > sr2) continue;
          damageShip(state, ships[j], s.dmg);
          hit = true;
        }
        for (let j = 0; j < bases.length && !hit; j++) {
          if (bases[j].down || segDist2(s.x, s.y, nx, ny, bases[j].x, bases[j].y) > br2) continue;
          damageBase(state, bases[j], s.dmg);
          hit = true;
        }
      }
      s.x = nx; s.y = ny; s.life -= dt;
      if (hit || s.life <= 0 || nx < -T.aliens.offMap || ny < -T.aliens.offMap || nx > state.w + T.aliens.offMap || ny > state.h + T.aliens.offMap) {
        const last = shots.pop();
        if (i < shots.length) shots[i] = last;
      }
    }
  }

  // ---- warships

  // Aliens in range come first (the ordered one before the others); with none in range, a beacon or nest: the ordered
  // one, else the nearest. Damage is raised by Targeting computers.
  function warFire(state, ship, def) {
    if (ship.cd > 0) return;
    const dmg = def.dmg * techMult(state, "warshipDmg");
    if (state.aliens.length) {
      let k = -1;
      if (ship.wo === "attack" && ship.wt < NEST_ORDER) {      // the ordered alien first, when it is in range
        const a = alienById(state, ship.wt);
        if (a) { const dx = a.x - ship.x, dy = a.y - ship.y; if (dx * dx + dy * dy <= def.range * def.range) k = state.aliens.indexOf(a); }
      }
      if (k < 0) k = alienIndexNear(state, ship.x, ship.y, def.range);
      if (k >= 0) {
        if (fireAtAlien(state, ship.x, ship.y, state.aliens[k], def.shotSpeed, dmg, def.range, "warship")) ship.cd = def.cd;
        return;
      }
    }
    if (!state.nests.length) return;
    let nest = ship.wo === "attack" && ship.wt >= NEST_ORDER ? nestById(state, ship.wt - NEST_ORDER) : null;
    if (nest && (nest.dead || Math.hypot(nest.x - ship.x, nest.y - ship.y) > def.range)) nest = null;
    if (!nest) {
      let bd = def.range;
      for (let i = 0; i < state.nests.length; i++) {
        const o = state.nests[i], d = Math.hypot(o.x - ship.x, o.y - ship.y);
        if (!o.dead && d <= bd) { bd = d; nest = o; }
      }
    }
    if (nest && fireShot(state, ship.x, ship.y, nest.x, nest.y, def.shotSpeed, dmg, "us", def.range, "warship")) ship.cd = def.cd;
  }

  function stepWarship(state, ship, dt, def) {
    syncWarshipHp(state, ship, def);      // tech: Hardened hulls
    const mult = state.storms.length ? speedMult(state, ship.x, ship.y) : 1;
    if (ship.cd > 0) ship.cd = Math.max(0, ship.cd - dt);
    if (ship.st === MANUAL) { stepManual(state, ship, dt, mult, def); warFire(state, ship, def); return; }
    ship.st = IDLE;
    if (ship.wo === "patrol") moveTo(ship, ship.wx, ship.wy, dt, mult);
    else if (ship.wo === "escort") {
      const t = ship.wt !== ship.id ? state.ships[ship.wt] : null;
      if (!t || t.dead) { ship.wo = "patrol"; ship.wx = ship.x; ship.wy = ship.y; ship.wt = -1; ship.mv = 0; }
      else moveNear(ship, t.x, t.y, def.follow, dt, mult);
    } else if (ship.wo === "attack") {
      const nestTarget = ship.wt >= NEST_ORDER;
      const a = nestTarget ? nestById(state, ship.wt - NEST_ORDER) : alienById(state, ship.wt);
      if (!a || a.dead) { ship.wo = "patrol"; ship.wx = ship.x; ship.wy = ship.y; ship.wt = -1; ship.mv = 0; }
      else moveNear(ship, a.x, a.y, def.range * def.standoff, dt, mult);
    } else ship.mv = 0;
    warFire(state, ship, def);
  }

  function inMap(state, x, y) { return typeof x === "number" && typeof y === "number" && isFinite(x) && isFinite(y) && x >= 0 && y >= 0 && x <= state.w && y <= state.h; }

  function warOrderGuard(state, shipId) {
    const ship = state.ships[shipId];
    if (!ship) return { ok: false, reason: "No such ship." };
    if (state.over) return { ok: false, reason: "This run is over." };
    { const u = unavailable(state, ship); if (u) return u; }
    if (!SHIP_TYPES[ship.type].war) return { ok: false, reason: ship.name + " is not a warship." };
    return { ok: true, ship };
  }

  function orderPatrol(state, shipId, x, y) {
    const g = warOrderGuard(state, shipId);
    if (!g.ok) return g;
    if (!inMap(state, x, y)) return { ok: false, reason: "That point is off the map." };
    const ship = g.ship;
    clearManual(ship);
    ship.st = IDLE; ship.wo = "patrol"; ship.wx = x; ship.wy = y; ship.wt = -1;
    return { ok: true };
  }

  function orderEscort(state, shipId, targetShipId) {
    const g = warOrderGuard(state, shipId);
    if (!g.ok) return g;
    const t = state.ships[targetShipId];
    if (!t) return { ok: false, reason: "No such ship to escort." };
    if (t.dead) return { ok: false, reason: lostReason(t) };
    if (targetShipId === shipId) return { ok: false, reason: "A ship cannot escort itself." };
    const ship = g.ship;
    clearManual(ship);
    ship.st = IDLE; ship.wo = "escort"; ship.wt = targetShipId;
    return { ok: true };
  }

  // target: an alien id (a number), {kind: "alien", id} or {kind: "nest", id} (a nest or the sector 2 beacon).
  function orderAttack(state, shipId, target) {
    const g = warOrderGuard(state, shipId);
    if (!g.ok) return g;
    let kind = "alien", alienId = target;
    if (target && typeof target === "object") { kind = target.kind === "nest" ? "nest" : "alien"; alienId = target.id; }
    if (kind === "nest") {
      const nest = nestById(state, alienId);
      if (!nest) return { ok: false, reason: "No such nest." };
      if (nest.dead) return { ok: false, reason: "That " + nest.kind + " is already destroyed." };
      const ship = g.ship;
      clearManual(ship);
      ship.st = IDLE; ship.wo = "attack"; ship.wt = NEST_ORDER + nest.id;
      return { ok: true };
    }
    if (!alienById(state, alienId)) return { ok: false, reason: "No such alien." };
    const ship = g.ship;
    clearManual(ship);
    ship.st = IDLE; ship.wo = "attack"; ship.wt = alienId;
    return { ok: true };
  }

  // ---- add-ons and repair

  function buildAddon(state, baseId, kind, labels) {
    const base = state.bases[baseId], bw = labels ? labels.base : "base", def = T.addons[kind];
    if (!base) return { ok: false, reason: "No such " + bw + "." };
    if (!def || !Object.prototype.hasOwnProperty.call(T.addons, kind)) return { ok: false, reason: "Unknown add-on." };
    if (state.over) return { ok: false, reason: "This run is over." };
    if (base.down) return { ok: false, reason: "This " + bw + " is down. Repair it first." };
    if (base[kind]) return { ok: false, reason: "This " + bw + " already has " + an(lc(def.label)) + "." };
    const cost = addonCost(state, kind);
    if (!canAfford(state, cost)) return { ok: false, reason: "Not enough materials for " + an(lc(def.label)) + "." };
    pay(state, cost);
    base[kind] = true;
    return { ok: true };
  }

  function repairCost(state, kind, id) {
    const k = costMult(state.sector);
    const thing = kind === "ship" ? state.ships[id] : kind === "base" ? state.bases[id] : null;
    const per = kind === "ship" ? T.repair.ship : T.repair.base;
    const out = { ore: 0, ice: 0, crystal: 0 };
    if (!thing || thing.dead) return out;
    const missing = Math.max(0, thing.maxHp - thing.hp);
    if (missing <= 1e-9) return out;
    for (const r of RES) out[r] = per[r] ? Math.ceil(per[r] * missing * k - 1e-9) : 0;
    return out;
  }

  function repairShip(state, shipId, labels) {
    const ship = state.ships[shipId], bw = labels ? labels.base : "base";
    if (!ship) return { ok: false, reason: "No such ship." };
    if (state.over) return { ok: false, reason: "This run is over." };
    if (ship.dead) return { ok: false, reason: lostReason(ship) };
    if (ship.hp >= ship.maxHp - 1e-9) return { ok: false, reason: ship.name + " is not damaged." };
    const base = state.bases[nearestBase(state, ship.x, ship.y)], up = T.upgrades[base.tier | 0];
    if (Math.hypot(ship.x - base.x, ship.y - base.y) > BASE_R + 10 + up.dock + MANUAL_SLACK) return { ok: false, reason: "Fly " + ship.name + " to a " + bw + " first." };
    const cost = repairCost(state, "ship", shipId);
    if (!canAfford(state, cost)) return { ok: false, reason: "Not enough materials to repair " + ship.name + "." };
    pay(state, cost);
    ship.hp = ship.maxHp; ship.rep = T.repair.time;
    return { ok: true };
  }

  function repairBase(state, baseId, labels) {
    const base = state.bases[baseId], bw = labels ? labels.base : "base";
    if (!base) return { ok: false, reason: "No such " + bw + "." };
    if (state.over) return { ok: false, reason: "This run is over." };
    if (base.hp >= base.maxHp - 1e-9) return { ok: false, reason: "This " + bw + " is not damaged." };
    const cost = repairCost(state, "base", baseId);
    if (!canAfford(state, cost)) return { ok: false, reason: "Not enough materials to repair this " + bw + "." };
    pay(state, cost);
    base.hp = base.maxHp; base.down = false;
    return { ok: true };
  }

  // The warnings to show: every event (and shower) still in its warning phase, with the seconds left (whole, rounded up).
  function eventWarnings(state) {
    const out = [];
    const add = (list, dflt) => {
      for (let i = 0; i < list.length; i++) {
        const e = list[i], warn = evWarn(e, dflt);
        if (e.age < warn) out.push({ kind: e.kind || "shower", secs: Math.max(1, Math.ceil(warn - e.age - 1e-9)), x: e.x, y: e.y, r: e.r });
      }
    };
    add(state.events, T.events.warn);
    add(state.showers, T.showers.warn);
    return out;
  }

  // Stranded: no material left anywhere to mine, nothing in a hold, and not enough for another base.
  // (A new ship would have nothing to mine, so being able to afford one does not count.)
  function isStranded(state) {
    if (state.over || state.won) return false;
    let crew = false;      // every miner and hauler lost and no stock for a new miner: nothing can ever be mined again
    for (let i = 0; i < state.ships.length && !crew; i++) crew = !state.ships[i].dead && !SHIP_TYPES[state.ships[i].type].war;
    if (!crew && !canAfford(state, shipCost(state, "miner"))) return true;
    for (let i = 0; i < state.bodies.length; i++) if (state.bodies[i].amount > 1e-6) return false;
    for (let i = 0; i < state.ships.length; i++) if (state.ships[i].cargo > 1e-9) return false;
    return !canAfford(state, baseCost(state));
  }

  function retire(state) {
    if (state.over) return { ok: false, reason: "This run is already over." };
    endRun(state, "retired");
    return { ok: true };
  }

  function step(state, dt) {
    if (state.over || !(dt > 0)) return;
    state.time += dt;
    state.sectorTime += dt;
    stepHazards(state, dt);
    api.stepNests(state, dt);
    const ships = state.ships;
    for (let i = 0; i < ships.length; i++) stepShip(state, ships[i], dt);
    api.stepEconomy(state, dt);
    state.endTimer -= dt;
    if (state.endTimer <= 0) {
      state.endTimer = T.endCheckEvery;
      if (isStranded(state)) endRun(state, "stranded");
    }
  }

  // ---------------------------------------------------------------- score

  function scoreTotal(state) {
    const s = state.score;
    return Math.floor(s.mat + s.bases + s.sectors + s.time + (s.kills || 0) + 1e-6);
  }

  // ---------------------------------------------------------------- text for the mission board

  function r0(n) { return Math.floor(n + 1e-6); }

  // A body is stored with a generated name ("Rock 42", "Kavelo"). In a theme it is shown with one of the theme's own
  // names for that kind of body, picked by body id so it is the same every frame and in every save. Space and any
  // unknown theme show the stored name.
  function bodyLabel(body, labels) {
    if (!body) return "";
    const theme = labels && labels.id && labels.id !== "space" ? lookById("theme", labels.id) : null;
    const pool = theme && theme.names && theme.names[body.kind];
    if (!pool || !pool.length) return String(body.name);
    const id = Math.max(0, Math.floor(Number(body.id) || 0)), n = Math.floor(id / pool.length);
    return pool[id % pool.length] + (n ? " " + (n + 1) : "");
  }

  function jobText(state, ship, labels) {
    const L = labels || SPACE_LABELS;
    const body = ship.target >= 0 ? state.bodies[ship.target] : null;
    const def = SHIP_TYPES[ship.type];
    if (ship.dead) return "Lost";
    if (ship.stun > 0) return "Stunned by a solar flare";
    if (ship.rep > 0) return "Repairing";
    if (def.war && ship.st !== MANUAL) {
      if (ship.wo === "patrol") return "Patrolling";
      if (ship.wo === "escort") { const t = state.ships[ship.wt]; return "Escorting " + (t ? shipLabel(t, labels) : "a ship"); }
      if (ship.wo === "attack") {
        if (ship.wt >= NEST_ORDER) { const n = nestById(state, ship.wt - NEST_ORDER); return n && n.kind === "beacon" ? "Attacking a beacon" : "Attacking a nest"; }
        return "Attacking an alien";
      }
      return "On guard. Select it, then give an order.";
    }
    switch (ship.st) {
      case TO_BODY: return "Flying to " + (body ? bodyLabel(body, L) : "target");
      case MINING: return "Mining " + (body ? bodyLabel(body, L) : "") + " " + r0(ship.cargo) + "/" + r0(cargoCap(state, def));
      case TO_STAR: return "Flying to a star";
      case UNLOADING: return "Unloading";
      case MANUAL: return ship.mm === 1 ? "Manual: mining " + (body ? bodyLabel(body, L) : "") : ship.mm === 2 ? "Manual: unloading" : "Manual";
      case TO_BASE:
        return ship.cargo > 0 ? "Hauling " + r0(ship.cargo) + " " + (L.res[ship.res] || ship.res) + " home"
          : (body ? "Back to " + L.base + ", then " + bodyLabel(body, L) : "Returning to " + L.base);
      default: return "Idle. Select it, then pick a target.";
    }
  }

  // A stored ship name is "<type label> <n>" (e.g. "Miner 3"). Shown in a theme's wording; any other name stays as it is.
  function shipLabel(ship, labels) {
    const isObj = ship && typeof ship === "object";
    const name = isObj ? String(ship.name == null ? "" : ship.name) : String(ship == null ? "" : ship);
    if (!labels || !labels.ship) return name;
    const m = /^(.+) (\d+)$/.exec(name);
    if (!m) return name;
    let type = isObj && Object.prototype.hasOwnProperty.call(SHIP_TYPES, ship.type) ? ship.type : null;
    if (type && SHIP_TYPES[type].label !== m[1]) type = null;
    if (!type) for (const t of Object.keys(SHIP_TYPES)) if (SHIP_TYPES[t].label === m[1]) { type = t; break; }
    return type && labels.ship[type] ? labels.ship[type] + " " + m[2] : name;
  }

  // ---------------------------------------------------------------- stress test helper

  // Top the fleet up to `total` ships for free and send them all mining. Bodies get 8x the stuff so
  // the ships stay busy for the whole test. Deterministic for a given state.
  function spawnStress(state, total, aliens) {
    if (!state.stress) {
      state.stress = true;
      for (const k of Object.keys(state.rules)) state.rules[k] = false;   // the test fleet runs with every lose rule off
      for (const b of state.bodies) { b.amount *= 8; b.max *= 8; }
    }
    const r = rng(state.seed ^ 0x5eed);
    while (state.ships.length < total) addShip(state, state.ships.length % 3 === 2 ? "hauler" : "miner");
    for (const ship of state.ships) {
      const b = state.bodies[Math.floor(r() * state.bodies.length)];
      if (b && !ship.dead && !SHIP_TYPES[ship.type].war) orderShip(state, ship.id, b.id);
    }
    // `aliens` more aliens from the edges, as in a raid (even in sector 1, where none come by themselves)
    const want = Math.min(T.aliens.max, Math.max(0, Math.floor(num(aliens, 0))));
    while (state.aliens.length < want) {
      const side = Math.floor(hrand(state) * 4), u = hrand(state), e = T.aliens.edge;
      const x = side === 0 ? e : side === 1 ? state.w - e : e + u * (state.w - 2 * e);
      const y = side === 2 ? e : side === 3 ? state.h - e : e + u * (state.h - 2 * e);
      state.aliens.push(makeAlien(state, x, y, Math.max(state.sector, T.aliens.firstSector)));
    }
    return state;
  }

  // ---------------------------------------------------------------- save / load

  // Everything but the transient message queue.
  function serialize(state) {
    return JSON.stringify(Object.assign({}, state, { msgs: undefined }));
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
    if (raw.ver !== VERSION && raw.ver !== 2 && raw.ver !== 1) return { ok: false, error: "Save is from a different version." };
    const old = raw.ver === 1;
    const pre3 = raw.ver < 3;          // before the credits, science and tech fields: they get their defaults
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
    state.stats.kills = intIn(raw.stats && raw.stats.kills, 0, 1e9, 0);
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
      const base = makeBase(i, num(b.x, 0), num(b.y, 0), i === 0);
      base.tier = intIn(b.tier, 0, MAX_TIER, 0);
      base.maxHp = base.hp;      // a missing hp (older save) means a full one
      base.hp = Math.min(base.maxHp, Math.max(0, num(b.hp, base.maxHp)));
      base.shield = b.shield === true; base.turret = b.turret === true;
      base.cd = Math.min(60, Math.max(0, num(b.cd, 0)));
      if (base.home) base.hp = Math.max(1, base.hp);           // the home base at 0 HP would have ended the run
      else if (base.hp <= 0 || b.down === true) { base.hp = 0; base.down = true; }
      state.bases.push(base);
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
        state.showers.push({ kind: "shower", x: num(s.x, 0), y: num(s.y, 0), r: Math.min(600, Math.max(10, num(s.r, T.showers.radius))),
          age: Math.max(0, num(s.age, 0)), warn: Math.min(60, Math.max(0, num(s.warn, T.showers.warn))),
          dur: Math.min(300, Math.max(0, num(s.dur, T.showers.dur))), power: Math.min(99, Math.max(0, num(s.power, showerDmg(sector)))),
          tick: Math.min(30, Math.max(0, num(s.tick, 0))) });
      }
      state.showerIn = Math.min(3600, num(raw.showerIn, 0));
      state.hz = num(raw.hz, 0) >>> 0;
      for (const e of (Array.isArray(raw.events) ? raw.events.slice(0, T.events.maxActive * 2) : [])) {
        if (!e || (e.kind !== "fog" && e.kind !== "flare" && e.kind !== "raid")) continue;
        state.events.push({ kind: e.kind, x: Math.min(state.w, Math.max(0, num(e.x, 0))), y: Math.min(state.h, Math.max(0, num(e.y, 0))),
          r: Math.min(600, Math.max(0, num(e.r, 0))), age: Math.max(0, num(e.age, 0)), warn: Math.min(60, Math.max(0, num(e.warn, T.events.warn))),
          dur: Math.min(300, Math.max(0, num(e.dur, 0))), power: Math.min(99, Math.max(0, num(e.power, 1))) });
      }
      state.eventIn = typeof raw.eventIn === "number" ? Math.min(3600, Math.max(0, num(raw.eventIn, 0))) : eventsOn(sector) ? T.events.firstDelay : 0;
      for (const a of (Array.isArray(raw.aliens) ? raw.aliens.slice(0, T.aliens.max) : [])) {
        if (!a) continue;
        const maxHp = Math.min(9999, Math.max(1, num(a.maxHp, alienHp(sector)))), hp = Math.min(maxHp, num(a.hp, maxHp));
        if (!(hp > 0)) continue;
        const kind = a.tgtKind === "ship" || a.tgtKind === "base" ? a.tgtKind : "";
        state.aliens.push({ id: intIn(a.id, 0, 1e9, 0), x: Math.min(state.w, Math.max(0, num(a.x, 0))), y: Math.min(state.h, Math.max(0, num(a.y, 0))),
          vx: Math.min(500, Math.max(-500, num(a.vx, 0))), vy: Math.min(500, Math.max(-500, num(a.vy, 0))), hp, maxHp,
          dmg: Math.min(999, Math.max(0, num(a.dmg, alienDmg(sector)))), cd: Math.min(60, Math.max(0, num(a.cd, 0))),
          tgtKind: kind, tgt: kind ? intIn(a.tgt, -1, 1e9, -1) : -1, age: Math.min(3600, Math.max(0, num(a.age, 0))),
          wave: intIn(a.wave, -1, 1e9, -1), nest: intIn(a.nest, -1, NEST_ID_MAX, -1) });
      }
      const seen = Object.create(null);
      let topId = -1;
      for (const a of state.aliens) { while (seen[a.id]) a.id++; seen[a.id] = true; topId = Math.max(topId, a.id); }   // ids stay unique
      state.alienSeq = Math.max(topId + 1, intIn(raw.alienSeq, 0, 1e9, 0));
      for (const s of (Array.isArray(raw.shots) ? raw.shots.slice(0, T.combat.maxShots) : [])) {
        if (!s || (s.side !== "us" && s.side !== "them")) continue;
        const shot = { x: num(s.x, 0), y: num(s.y, 0), vx: Math.min(2000, Math.max(-2000, num(s.vx, 0))), vy: Math.min(2000, Math.max(-2000, num(s.vy, 0))),
          life: Math.min(10, Math.max(0, num(s.life, 0))), dmg: Math.min(999, Math.max(0, num(s.dmg, 0))), side: s.side };
        if (s.src === "warship" || s.src === "turret" || s.src === "alien") shot.src = s.src;   // an older save's shots have none: counted as the side's default
        state.shots.push(shot);
      }
      for (const f of (Array.isArray(raw.fx) ? raw.fx.slice(0, T.combat.fxMax) : [])) {
        if (!f || (f.kind !== "block" && f.kind !== "kill" && f.kind !== "boom")) continue;
        state.fx.push({ kind: f.kind, x: num(f.x, 0), y: num(f.y, 0), x2: num(f.x2, 0), y2: num(f.y2, 0),
          age: Math.max(0, num(f.age, 0)), life: Math.min(5, Math.max(0.05, num(f.life, T.combat.fxLife))) });
      }
      const sc = raw.score || {};
      state.score = { mat: Math.max(0, num(sc.mat, 0)), bases: Math.max(0, num(sc.bases, 0)),
        sectors: Math.max(0, num(sc.sectors, 0)), time: Math.max(0, num(sc.time, 0)), kills: Math.max(0, num(sc.kills, 0)) };
      state.cleared = intIn(raw.cleared, 0, 999, 0);
      state.starsGot = intIn(raw.starsGot, 0, 99999, 0);
      state.hits = intIn(raw.hits, 0, 99999, 0);
      const ci = raw.clearInfo;
      state.clearInfo = ci && typeof ci === "object" ? { sector: intIn(ci.sector, 1, 999, sector),
        sectorPts: Math.max(0, num(ci.sectorPts, 0)), timePts: Math.max(0, num(ci.timePts, 0)), secs: Math.max(0, num(ci.secs, 0)) } : null;
      state.over = !!raw.over;
      state.endReason = state.over ? (END_REASONS.indexOf(raw.endReason) >= 0 ? raw.endReason : "retired") : "";
      if (state.endReason === "destroyed") state.bases[0].hp = 0;
      state.endTimer = Math.max(0, num(raw.endTimer, T.endCheckEvery));
    } else {
      // an old save has no hazards or score; sector 1 has no hazards, and the score starts from what is built
      state.showerIn = 0;
      state.hz = (mapSeed(state.seed, 1) ^ 0xA5A5A5A5) >>> 0;
      state.score.bases = Math.max(0, raw.bases.length - 1) * T.score.base;
      if (state.won) { state.cleared = 1; state.score.sectors = T.score.sector; }   // a cleared sector 1 earns its points
    }
    if (Array.isArray(raw.starsPaid)) {
      state.starsPaid = raw.starsPaid.filter(k => typeof k === "string" && k.length <= 64).slice(-T.bank.claimedKeep);
    } else {
      // a save from before this field: its taken stars were already paid to whoever was playing
      for (const st of state.stars) if (st.taken) state.starsPaid.push(starKey(state, st));
    }
    state.tech = [];      // read before the ships: their caps (Deep holds, Hardened hulls) depend on it
    if (Array.isArray(raw.tech)) for (const id of raw.tech.slice(0, 64)) if (typeof id === "string" && TECH_BY_ID[id] && state.tech.indexOf(id) < 0) state.tech.push(id);
    for (let i = 0; i < raw.ships.length; i++) {
      const s = raw.ships[i];
      if (!s || typeof s.type !== "string" || !Object.prototype.hasOwnProperty.call(SHIP_TYPES, s.type)) return { ok: false, error: "Save has a bad ship." };
      const stRaw = Math.floor(num(s.st, 0));
      const st = stRaw >= 0 && stRaw <= MANUAL ? stRaw : 0;                     // anything else: idle
      const mmRaw = Math.floor(num(s.mm, 0));
      const mm = st === MANUAL && mmRaw >= 0 && mmRaw <= 2 ? mmRaw : 0;
      const target = intIn(s.target, -1, 1e9, -1);
      const dest = intIn(s.dest, -1, 1e9, -1);
      const star = intIn(s.star, -1, 1e9, -1);
      const res = RES.indexOf(s.res) >= 0 ? s.res : "";
      const cargo = res ? Math.min(cargoCap(state, SHIP_TYPES[s.type]), Math.max(0, num(s.cargo, 0))) : 0;
      const ship = makeShip(i, s.type, String(s.name || SHIP_TYPES[s.type].label));
      Object.assign(ship, { x: num(s.x, 0), y: num(s.y, 0),
        ang: num(s.ang, 0), st, target: target < state.bodies.length ? target : -1,
        dest: dest >= 0 && dest < state.bases.length ? dest : -1,
        star: star < state.stars.length ? star : -1, cargo, res, mv: 0,
        wait: Math.max(0, num(s.wait, 0)), hitCd: Math.max(0, num(s.hitCd, 0)), ix: 0, iy: 0, mm });
      // health and hazards (absent in older saves: full health, nothing in progress)
      ship.maxHp = SHIP_TYPES[s.type].war ? Math.round(SHIP_TYPES[s.type].hp * techMult(state, "warshipHp")) : SHIP_TYPES[s.type].hp;
      ship.hp = Math.min(ship.maxHp, Math.max(0, num(s.hp, ship.maxHp)));
      if (s.dead === true || ship.hp <= 0) {      // a lost ship stays lost: empty, still, no orders
        Object.assign(ship, { hp: 0, dead: true, st: IDLE, target: -1, dest: -1, star: -1, cargo: 0, res: "", mm: 0, wait: 0 });
      } else if (SHIP_TYPES[s.type].war) {
        ship.cargo = 0; ship.res = ""; ship.mm = 0;
        if (ship.st !== MANUAL) ship.st = IDLE;
        ship.target = -1; ship.dest = -1; ship.star = -1;
        const wo = s.wo === "patrol" || s.wo === "escort" || s.wo === "attack" ? s.wo : "";
        ship.wo = ship.st === MANUAL ? "" : wo;
        ship.wx = Math.min(state.w, Math.max(0, num(s.wx, ship.x))); ship.wy = Math.min(state.h, Math.max(0, num(s.wy, ship.y)));
        ship.wt = intIn(s.wt, -1, 1e9, -1);
        if (ship.wo === "escort" && ship.wt >= raw.ships.length) ship.wo = "";
        if (ship.wo === "") ship.wt = -1;
      }
      if (!ship.dead) { ship.stun = Math.min(60, Math.max(0, num(s.stun, 0))); ship.rep = Math.min(10, Math.max(0, num(s.rep, 0))); }
      ship.cd = Math.min(60, Math.max(0, num(s.cd, 0)));
      if (!ship.dead) { ship.mothballed = s.mothballed === true; ship.wake = Math.min(T.econ.maint.wakeSecs, Math.max(0, num(s.wake, 0))); }
      state.ships.push(ship);
    }
    for (const s of state.ships) {            // a ship that needs a target but has none just goes home
      if ((s.st === TO_BODY || s.st === MINING) && s.target < 0) s.st = TO_BASE;
      if (s.st === TO_STAR && s.star < 0) s.st = TO_BASE;
      if (s.st === MANUAL) {                   // manual flight keeps no order; mining needs a live body that fits the hold
        const mb = s.mm === 1 && s.target >= 0 ? state.bodies[s.target] : null;
        if (s.mm === 1 && !(mb && mb.amount > 1e-6 && (s.cargo <= 0 || s.res === mb.res))) s.mm = 0;
        if (s.mm !== 1) s.target = -1;
        s.dest = -1; s.star = -1;
        if (s.mm !== 2) s.wait = 0;
      }
      const body = s.target >= 0 ? state.bodies[s.target] : null;   // cargo that does not fit the target is dropped
      if (body && (s.st === TO_BODY || s.st === MINING) && s.res !== body.res) { s.cargo = 0; s.res = ""; }
    }
    // science, tech, nests, credits and the lose rules. A save from before version 3 gets the defaults: no science, no
    // tech, nests regenerated from the seed at full health, 500 credits, no debt (so the debt rule is off for that run).
    state.science = Math.max(0, num(raw.science, 0)); state.sciTotal = Math.max(state.science, num(raw.sciTotal, 0));
    state.sciSector = Math.max(0, num(raw.sciSector, 0));
    if (!pre3 && Array.isArray(raw.nests)) state.nests = sanitizeNests(raw.nests, state);
    else api.generateNests(state, mapSeed(state.seed, sector));
    state.waveSeq = intIn(raw.waveSeq, 0, 1e9, 0);
    state.waves = {};
    if (isObj(raw.waves)) {
      for (const key of Object.keys(raw.waves).slice(0, 200)) {
        const w = raw.waves[key];
        if (/^\d+$/.test(key) && isObj(w)) {
          state.waves[key] = { alive: 0, escaped: intIn(w.escaped, 0, 999, 0) };
          if (w.lost === true) state.waves[key].lost = true;
        }
      }
    }
    for (const a of state.aliens) {          // alive is what is really on the map
      if (a.wave < 0) continue;
      if (!state.waves[a.wave]) state.waves[a.wave] = { alive: 0, escaped: 0 };
      state.waves[a.wave].alive++;
    }
    for (const key of Object.keys(state.waves)) state.waveSeq = Math.max(state.waveSeq, Number(key));
    const E = T.econ;
    state.credits = pre3 ? E.oldSaveCredits : Math.min(1e9, Math.max(-1e7, num(raw.credits, E.startCredits)));
    state.debt = pre3 ? 0 : Math.min(1e9, Math.max(0, num(raw.debt, 0)));
    state.debtTick = pre3 ? E.debt.every : Math.min(E.debt.every, Math.max(0, num(raw.debtTick, E.debt.every)));
    state.brokeFor = pre3 ? 0 : Math.min(1e6, Math.max(0, num(raw.brokeFor, 0)));
    state.netNegFor = pre3 ? 0 : Math.min(1e6, Math.max(0, num(raw.netNegFor, 0)));
    const rr = !pre3 && isObj(raw.rules) ? raw.rules : {};
    for (const k of Object.keys(T.lose)) {
      state.rules[k] = state.stress ? false : typeof rr[k] === "boolean" ? rr[k] : pre3 && k === "debt" ? false : T.lose[k];
    }
    const es = !pre3 && isObj(raw.econStats) ? raw.econStats : {};
    for (const k of Object.keys(state.econStats)) state.econStats[k] = Math.min(1e12, Math.max(0, num(es[k], 0)));
    const dv = isObj(raw.delivered) ? raw.delivered : {};
    for (const k of RES) state.delivered[k] = Math.max(0, num(dv[k], 0));
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
    theme: [   // scene: the one sky a theme draws (null = the chosen background); labels: wording overrides
      { id: "space", name: "Space", cost: 0, scene: null, note: "Ships, bases and backgrounds as chosen below.", labels: {} },
      { id: "dwarven", name: "Dwarven", cost: 30, scene: "cavern", note: "Dwarves and mine carts dig ores and gems for forge halls, deep underground.",
        names: {
          asteroid: ["Ironhold Vein", "Deepdelve", "Anvil Seam", "Blackpick", "Stoneback", "Hammerfall", "Coalbeard", "Rustvein", "Ironroot", "Granite Gut"],
          moon: ["Silverglint", "Moonvein", "Argent Seam", "Glimmerdeep", "Starlode", "Pale Seam"],
          iceplanet: ["Argentum", "Brightbeard Lode", "Silverhall", "Bellowdeep", "Quicksilver"],
          rare: ["Ruby Hollow", "Emerald Heart", "Sapphire Vault", "Diamondmaw", "Opal Cleft", "Garnet Grotto"] },
        labels: { id: "dwarven", res: { ore: "iron", ice: "silver", crystal: "gems" }, resTitle: { ore: "Iron", ice: "Silver", crystal: "Gems" },
          ship: { miner: "Dwarf", hauler: "Mine cart" }, ships: "Dwarves",
          base: "forge", baseTitle: "Forge", bases: "Forges", home: "Great hall", newBase: "New forge",
          body: { asteroid: "Iron vein", moon: "Silver seam", iceplanet: "Silver lode", rare: "Gem geode" },
          storm: "Flooded tunnel", shower: "Cave-in", sector: "Depth", warp: "Dig to next depth", edge: "the cavern wall" } },
      { id: "hamster", name: "Hamster", cost: 60, scene: "habitat", note: "Hamsters fetch seeds, nuts and carrots for their running wheels.",
        names: {
          asteroid: ["Sunflower Heap", "Millet Mound", "Oat Hill", "Barley Bank", "Seed Stack", "Pumpkin Pile"],
          moon: ["Walnut Stash", "Peanut Cache", "Hazel Hoard", "Almond Nook", "Pecan Pocket", "Chestnut Hide"],
          iceplanet: ["Big Blue Bowl", "Cashew Dish", "Pistachio Pan", "Brazil Bowl", "Macadamia Mug"],
          rare: ["Carrot Corner", "Baby Carrot Bed", "Orange Row", "Crunchy Patch", "Garden Gold"] },
        labels: { id: "hamster", res: { ore: "seeds", ice: "nuts", crystal: "carrots" }, resTitle: { ore: "Seeds", ice: "Nuts", crystal: "Carrots" },
          ship: { miner: "Hamster", hauler: "Big hamster" }, ships: "Hamsters",
          base: "wheel", baseTitle: "Wheel", bases: "Wheels", home: "Home wheel", newBase: "New wheel",
          body: { asteroid: "Seed pile", moon: "Nut stash", iceplanet: "Nut bowl", rare: "Carrot patch" },
          storm: "Sticky bedding", shower: "Cat swipes", sector: "Cage", warp: "Move to next cage", edge: "the edge of the cage" } },
    ],
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
      { id: "deep", scene: "nebula", name: "Deep space", cost: 0, top: "#03040b", bottom: "#090a1c", blobs: [
        [0.22, 0.28, 0.55, "rgba(98,80,214,0.20)"], [0.82, 0.72, 0.5, "rgba(42,120,214,0.16)"],
        [0.62, 0.12, 0.32, "rgba(232,123,164,0.07)"], [0.1, 0.9, 0.3, "rgba(27,175,122,0.06)"]] },
      { id: "aurora", scene: "nebula", name: "Aurora", cost: 4, top: "#021012", bottom: "#07182a", blobs: [
        [0.25, 0.2, 0.55, "rgba(40,214,160,0.18)"], [0.8, 0.35, 0.45, "rgba(60,150,230,0.16)"],
        [0.5, 0.9, 0.4, "rgba(120,90,230,0.12)"]] },
      { id: "ember", scene: "nebula", name: "Ember", cost: 6, top: "#110504", bottom: "#1d0a10", blobs: [
        [0.2, 0.75, 0.55, "rgba(230,90,40,0.18)"], [0.85, 0.25, 0.5, "rgba(200,40,80,0.15)"],
        [0.55, 0.5, 0.3, "rgba(255,170,60,0.06)"]] },
      { id: "void", scene: "nebula", name: "Void", cost: 8, top: "#000000", bottom: "#050507", blobs: [
        [0.5, 0.5, 0.7, "rgba(120,120,150,0.07)"], [0.15, 0.15, 0.3, "rgba(170,170,200,0.05)"]] },
      { id: "black", name: "Deep Black", cost: 4, scene: "sparse", top: "#000000", bottom: "#000000", blobs: [[0.5, 0.5, 0.01, "rgba(0,0,0,0)"]] },
      { id: "belt", name: "Asteroid Belt", cost: 5, scene: "belt", top: "#05060a", bottom: "#0d0b10", blobs: [
        [0.5, 0.55, 0.6, "rgba(150,120,90,0.07)"]] },
      { id: "spiral", name: "Galaxy Spiral", cost: 7, scene: "spiral", top: "#02030a", bottom: "#070716", blobs: [
        [0.5, 0.5, 0.5, "rgba(130,110,230,0.10)"]] },
      { id: "solarsys", name: "Solar System", cost: 8, scene: "solar", top: "#02030a", bottom: "#05071a", blobs: [
        [0.5, 0.5, 0.35, "rgba(255,200,90,0.05)"]] },
    ],
    trail: [
      { id: "streak", name: "Streak", cost: 0, note: "A fading line." },
      { id: "spark",  name: "Sparkle", cost: 5, note: "A trail of glowing dots." },
      { id: "ribbon", name: "Ribbon", cost: 8, note: "A wide soft ribbon." },
    ],
  };
  const LOOK_KINDS = ["theme", "ship", "base", "bg", "trail"];
  const LOOK_TITLES = { theme: "Theme", ship: "Ship colours", base: "Base colours", bg: "Backgrounds", trail: "Engine trails" };

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

  // The wording for a theme: SPACE_LABELS with the theme's overrides. A fresh object every call; unknown id -> space.
  function labelsFor(themeId) {
    const t = lookById("theme", themeId);
    return mergeLabels(SPACE_LABELS, t ? t.labels : null);
  }

  // The resolved looks for drawing.
  function currentLooks(p) {
    const theme = lookById("theme", p.pick.theme) || LOOKS.theme[0];
    return { theme, ship: lookById("ship", p.pick.ship), base: lookById("base", p.pick.base),
      bg: lookById("bg", p.pick.bg), trail: lookById("trail", p.pick.trail), labels: labelsFor(theme.id) };
  }

  // The one scene the sky draws: the theme's own, else the chosen background's.
  function sceneFor(looks) {
    return (looks.theme && looks.theme.scene) || (looks.bg && looks.bg.scene) || "nebula";
  }

  function starKey(state, star) { return state.seed + ":" + state.sector + ":" + star.id; }

  // Move newly picked-up stars into the bank. Each star pays once, even if an older save is loaded
  // and the star is picked up again. It also pays once per save: state.starsPaid remembers stars paid
  // to any player, so someone who switches in on the same save is not paid again. Returns how many were added.
  function claimStars(p, state) {
    let n = 0;
    if (!Array.isArray(state.starsPaid)) state.starsPaid = [];
    for (let i = 0; i < state.stars.length; i++) {
      const s = state.stars[i];
      if (!s.taken) continue;
      const key = starKey(state, s);
      if (state.starsPaid.indexOf(key) >= 0) continue;
      state.starsPaid.push(key);
      if (p.claimed.indexOf(key) >= 0) continue;
      p.claimed.push(key);
      p.stars++;
      n++;
    }
    if (p.claimed.length > T.bank.claimedKeep) p.claimed.splice(0, p.claimed.length - T.bank.claimedKeep);
    if (state.starsPaid.length > T.bank.claimedKeep) state.starsPaid.splice(0, state.starsPaid.length - T.bank.claimedKeep);
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

  // ---------------------------------------------------------------- players, run log, purchase log
  // Plain data in, plain data out. The UI owns the storage and passes `now` as an ISO string.

  const LG = T.logs;

  function parseJsonText(text) {   // { empty: true } | { err: true } | { raw }
    if (text == null) return { empty: true };
    if (typeof text !== "string") return { err: true };
    if (text.trim() === "") return { empty: true };
    try { return { raw: JSON.parse(text) }; } catch (e) { return { err: true }; }
  }
  function isObj(v) { return !!v && typeof v === "object" && !Array.isArray(v); }
  function cleanName(v) {
    if (typeof v !== "string") return "";
    return v.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim();
  }
  function cleanStr(v, max) { return typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").slice(0, max) : ""; }
  function nat(v, hi) { return intIn(v, 0, hi || 1e12, 0); }
  function cmpText(a, b) { a = String(a).toLowerCase(); b = String(b).toLowerCase(); return a < b ? -1 : a > b ? 1 : 0; }

  function newRoster(now) {
    return { ver: 1, current: "p1", next: 2, players: [{ id: "p1", name: "Player 1", created: String(now || ""), profile: newProfile() }] };
  }

  function parseRoster(text, legacyBankText, now) {
    const j = parseJsonText(text);
    if (j.empty) {
      const roster = newRoster(now);
      let migrated = false;
      if (typeof legacyBankText === "string" && legacyBankText.trim() !== "") {
        const lp = parseProfile(legacyBankText);
        if (lp.ok) { roster.players[0].profile = lp.profile; migrated = true; }
      }
      return { ok: true, roster, migrated };
    }
    const bad = error => ({ ok: false, roster: newRoster(now), migrated: false, error });
    if (j.err) return bad("The players list is not valid JSON.");
    const raw = j.raw;
    if (!isObj(raw) || !Array.isArray(raw.players)) return bad("The players list has the wrong shape.");
    const players = [], ids = Object.create(null), names = Object.create(null);   // no prototype: "constructor" is a fine name
    let maxNum = 0;
    for (const p of raw.players.slice(0, LG.players * 4)) {
      if (players.length >= LG.players) break;
      if (!isObj(p) || typeof p.id !== "string" || !/^[A-Za-z0-9_-]{1,16}$/.test(p.id) || ids[p.id]) continue;
      let name = cleanName(p.name).slice(0, LG.nameMax).trim();
      if (!name) name = "Player " + p.id.replace(/^p/, "");
      if (names[name.toLowerCase()]) {          // keep names unique
        let k = 2, cand;
        do { const suf = " " + k++; cand = name.slice(0, LG.nameMax - suf.length).trim() + suf; } while (names[cand.toLowerCase()]);
        name = cand;
      }
      ids[p.id] = true; names[name.toLowerCase()] = true;
      const m = /^p(\d{1,9})$/.exec(p.id);
      if (m) maxNum = Math.max(maxNum, +m[1]);
      let prof;
      try { prof = parseProfile(JSON.stringify(p.profile)).profile; } catch (e) { prof = newProfile(); }
      players.push({ id: p.id, name, created: cleanStr(p.created, 40), profile: prof });
    }
    if (!players.length) return bad("The players list has no valid player.");
    const current = typeof raw.current === "string" && ids[raw.current] ? raw.current : players[0].id;
    const next = Math.max(maxNum + 1, intIn(raw.next, 1, 1e9, 1));
    return { ok: true, roster: { ver: 1, current, next, players }, migrated: false };
  }

  function serializeRoster(roster) { return JSON.stringify(roster); }

  function currentPlayer(roster) {
    if (!Array.isArray(roster.players)) roster.players = [];
    if (!roster.players.length) roster.players.push({ id: "p1", name: "Player 1", created: "", profile: newProfile() });
    for (const p of roster.players) if (p.id === roster.current) return p;
    roster.current = roster.players[0].id;
    return roster.players[0];
  }

  // The reason text when the name is not allowed, else ""; `selfId` may keep its own name.
  function nameProblem(roster, name, selfId) {
    if (typeof name !== "string") return "Type a name.";
    const n = cleanName(name);
    if (!n) return "Type a name.";
    if (n.length > LG.nameMax) return "Names can be up to " + LG.nameMax + " letters.";
    for (const p of roster.players) if (p.id !== selfId && p.name.toLowerCase() === n.toLowerCase()) return "That name is already used.";
    return "";
  }

  function addPlayer(roster, name, now) {
    if (roster.players.length >= LG.players) return { ok: false, reason: "No more than " + LG.players + " players." };
    const why = nameProblem(roster, name, null);
    if (why) return { ok: false, reason: why };
    let n = Math.max(1, intIn(roster.next, 1, 1e9, 1));
    while (roster.players.some(p => p.id === "p" + n)) n++;
    const player = { id: "p" + n, name: cleanName(name), created: String(now || ""), profile: newProfile() };
    roster.players.push(player);
    roster.next = n + 1;
    return { ok: true, player };
  }

  function renamePlayer(roster, id, name) {
    const p = roster.players.find(q => q.id === id);
    if (!p) return { ok: false, reason: "No such player." };
    const why = nameProblem(roster, name, id);
    if (why) return { ok: false, reason: why };
    p.name = cleanName(name);
    return { ok: true };
  }

  function choosePlayer(roster, id) {
    if (!roster.players.some(q => q.id === id)) return { ok: false, reason: "No such player." };
    roster.current = id;
    return { ok: true };
  }

  // ---- run log

  function newRunLog() { return { ver: 1, runs: [] }; }
  function serializeRunLog(log) { return JSON.stringify(log); }

  function cleanRun(r) {
    if (!isObj(r)) return null;
    if (typeof r.key !== "string" || !r.key || r.key.length > 64) return null;
    if (typeof r.player !== "string" || !r.player || r.player.length > 16) return null;
    if (typeof r.result !== "string" || !/^[a-z]{1,16}$/.test(r.result)) return null;
    if (typeof r.score !== "number" || !isFinite(r.score)) return null;
    const parts = {};
    if (isObj(r.parts)) {
      for (const k of Object.keys(r.parts).slice(0, 24)) if (/^[A-Za-z]{1,16}$/.test(k) && typeof r.parts[k] === "number" && isFinite(r.parts[k])) parts[k] = r.parts[k];
    }
    const d = isObj(r.delivered) ? r.delivered : {};
    return { key: r.key, player: r.player, at: cleanStr(r.at, 40), score: nat(r.score), parts,
      sector: intIn(r.sector, 1, 999, 1), cleared: nat(r.cleared, 999),
      delivered: { ore: nat(d.ore), ice: nat(d.ice), crystal: nat(d.crystal) },
      ships: nat(r.ships, 99999), bases: nat(r.bases, 99999), stars: nat(r.stars, 99999), secs: nat(r.secs), result: r.result };
  }

  function parseRunLog(text) {
    const j = parseJsonText(text);
    if (j.empty) return { ok: true, log: newRunLog(), dropped: 0 };
    if (j.err) return { ok: false, log: newRunLog(), dropped: 0, error: "The run log is not valid JSON." };
    if (!isObj(j.raw) || !Array.isArray(j.raw.runs)) return { ok: false, log: newRunLog(), dropped: 0, error: "The run log has the wrong shape." };
    const all = j.raw.runs, tail = all.length > LG.runs ? all.slice(-LG.runs) : all;
    let dropped = all.length - tail.length;
    const log = newRunLog(), at = Object.create(null);   // no prototype: a "__proto__" key is an ordinary key
    for (const r of tail) {
      const c = cleanRun(r);
      if (!c) { dropped++; continue; }
      if (Object.prototype.hasOwnProperty.call(at, c.key)) { log.runs[at[c.key]] = c; dropped++; continue; }   // same key twice: the later one wins
      at[c.key] = log.runs.length;
      log.runs.push(c);
    }
    return { ok: true, log, dropped };
  }

  function shouldLogRun(state) {
    if (!state || state.stress) return false;
    return !(state.time < LG.minSecs && scoreTotal(state) === 0);
  }

  function runRecord(state, playerId, result, now) {
    const parts = {};
    for (const k of Object.keys(state.score)) if (typeof state.score[k] === "number" && isFinite(state.score[k])) parts[k] = state.score[k];
    const d = state.delivered || {};
    const res = String(result == null ? "" : result).toLowerCase().replace(/[^a-z]/g, "").slice(0, 16) || "retired";
    return { key: state.seed + ":" + playerId, player: playerId, at: String(now || ""), score: scoreTotal(state), parts,
      sector: state.sector, cleared: state.cleared,
      delivered: { ore: r0(num(d.ore, 0)), ice: r0(num(d.ice, 0)), crystal: r0(num(d.crystal, 0)) },
      ships: Math.max(0, state.ships.length - 2), bases: Math.round(state.score.bases / T.score.base),
      stars: state.starsGot, secs: Math.floor(state.time), result: res };
  }

  function addRun(log, run) {
    const i = log.runs.findIndex(r => r.key === run.key);
    if (i >= 0) log.runs[i] = run; else log.runs.push(run);
    if (log.runs.length > LG.runs) log.runs.splice(0, log.runs.length - LG.runs);
    return log;
  }

  // ---- purchase log

  function newBuyLog() { return { ver: 1, buys: [] }; }
  function serializeBuyLog(log) { return JSON.stringify(log); }

  function cleanBuy(b) {
    if (!isObj(b)) return null;
    if (typeof b.player !== "string" || !b.player || b.player.length > 16) return null;
    if (LOOK_KINDS.indexOf(b.kind) < 0 || typeof b.item !== "string" || !b.item || b.item.length > 40) return null;
    if (typeof b.cost !== "number" || !isFinite(b.cost)) return null;
    return { player: b.player, at: cleanStr(b.at, 40), kind: b.kind, item: b.item,
      name: cleanStr(b.name, 40) || b.item, cost: nat(b.cost, 1e9), left: nat(b.left, 1e9) };
  }

  function parseBuyLog(text) {
    const j = parseJsonText(text);
    if (j.empty) return { ok: true, log: newBuyLog(), dropped: 0 };
    if (j.err) return { ok: false, log: newBuyLog(), dropped: 0, error: "The purchase log is not valid JSON." };
    if (!isObj(j.raw) || !Array.isArray(j.raw.buys)) return { ok: false, log: newBuyLog(), dropped: 0, error: "The purchase log has the wrong shape." };
    const all = j.raw.buys, tail = all.length > LG.buys ? all.slice(-LG.buys) : all;
    let dropped = all.length - tail.length;
    const log = newBuyLog();
    for (const b of tail) { const c = cleanBuy(b); if (c) log.buys.push(c); else dropped++; }
    return { ok: true, log, dropped };
  }

  function buyRecord(playerId, kind, id, cost, left, now) {
    const look = LOOKS[kind] ? lookById(kind, id) : null;
    return { player: playerId, at: String(now || ""), kind, item: id, name: look ? look.name : String(id), cost, left };
  }

  function addBuy(log, buy) {
    log.buys.push(buy);
    if (log.buys.length > LG.buys) log.buys.splice(0, log.buys.length - LG.buys);
    return log;
  }

  // ---- reading the logs

  function playerRuns(log, id) { return log.runs.filter(r => r.player === id).reverse(); }
  function playerBuys(log, id) { return log.buys.filter(b => b.player === id).reverse(); }

  function playerTotals(roster, runLog) {
    return roster.players.map(p => {
      const row = { id: p.id, name: p.name, best: p.profile.best, runs: 0, bestSector: 0,
        delivered: { ore: 0, ice: 0, crystal: 0, all: 0 }, stars: 0, bank: p.profile.stars, secs: 0 };
      for (const r of runLog.runs) {
        if (r.player !== p.id) continue;
        row.runs++;
        row.best = Math.max(row.best, r.score);
        row.bestSector = Math.max(row.bestSector, r.sector);
        for (const k of RES) { row.delivered[k] += r.delivered[k]; row.delivered.all += r.delivered[k]; }
        row.stars += r.stars;
        row.secs += r.secs;
      }
      return row;
    });
  }

  const RANK_COLS = ["name", "best", "runs", "bestSector", "delivered", "stars"];
  function rankPlayers(rows, col, dir) {
    if (RANK_COLS.indexOf(col) < 0) col = "best";
    const sign = dir === "asc" ? 1 : -1;
    const val = r => col === "delivered" ? r.delivered.all : r[col];
    return rows.slice().sort((a, b) => {
      const c = col === "name" ? cmpText(a.name, b.name) * sign : (val(a) - val(b)) * sign;
      if (c) return c;
      return (b.best - a.best) || cmpText(a.name, b.name) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    });
  }

  function topRuns(log, n) {
    n = n == null ? 10 : Math.max(0, Math.floor(num(n, 10)));
    return log.runs.slice().sort((a, b) => (b.score - a.score) || (a.at < b.at ? -1 : a.at > b.at ? 1 : 0)).slice(0, n);
  }

  function clearPlayerData(roster, runLog, buyLog, id) {
    const p = roster.players.find(q => q.id === id);
    if (!p) return { ok: false, reason: "No such player." };
    function drop(list) {
      let n = 0;
      for (let i = list.length - 1; i >= 0; i--) if (list[i].player === id) { list.splice(i, 1); n++; }
      return n;
    }
    const runs = drop(runLog.runs), buys = drop(buyLog.buys);
    p.profile.best = 0;
    return { ok: true, runs, buys };
  }

  function exportLogs(roster, runLog, buyLog, now) {
    const rows = playerTotals(roster, runLog);
    return JSON.stringify({ app: "fleet", kind: "fleet-logs", ver: 1, exported: String(now || ""),
      players: rows.map((r, i) => ({ id: r.id, name: r.name, created: roster.players[i].created, best: r.best, bank: r.bank })),
      runs: runLog.runs, purchases: buyLog.buys }, null, 2);
  }

  // ---------------------------------------------------------------- feedback form (no DOM; main.js does the sending)
  // The payload shape is shared with the dashboard's inbox (fleet-feedback/1); do not change it alone.

  const GAME_VERSION = "first-playable";   // build name sent as gameInfo.version (the save VERSION is separate)
  const FEEDBACK_SCHEMA = "fleet-feedback/1";
  const FEEDBACK_TYPES = ["bug", "idea", "balance", "other"];
  const FEEDBACK_MAX = 2000;
  const FEEDBACK_URL = "http://127.0.0.1:8765/api/feedback";
  const FEEDBACK_TIMEOUT_MS = 5000;
  const FEEDBACK_INFO_MAX = 200;
  const FEEDBACK_ID_RE = /^[A-Za-z0-9-]{8,64}$/;

  function pad2(n) { return (n < 10 ? "0" : "") + n; }

  // "fb-YYYYMMDD-HHMMSS-xxxxxx": UTC time plus six lowercase base-36 characters from rand.
  function feedbackId(date, rand) {
    const d = date || new Date(), r = rand || Math.random;
    let tail = "";
    for (let i = 0; i < 6; i++) {
      let v = Number(r());
      if (!(v >= 0)) v = 0;
      tail += "0123456789abcdefghijklmnopqrstuvwxyz".charAt(Math.min(35, Math.floor(v * 36)));
    }
    return "fb-" + d.getUTCFullYear() + pad2(d.getUTCMonth() + 1) + pad2(d.getUTCDate()) + "-" +
      pad2(d.getUTCHours()) + pad2(d.getUTCMinutes()) + pad2(d.getUTCSeconds()) + "-" + tail;
  }

  // The rating as an integer 1-5, null when not given, or NaN when it is not valid.
  function feedbackRating(v) {
    if (v === null || v === undefined) return null;
    if (typeof v === "string") {
      const t = v.trim();
      if (t === "") return null;
      if (!/^[0-9]+$/.test(t)) return NaN;
      v = Number(t);
    }
    if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > 5) return NaN;
    return v;
  }

  function validateFeedback(input) {
    const o = input && typeof input === "object" ? input : {};
    if (FEEDBACK_TYPES.indexOf(o.type) < 0) return { ok: false, field: "type", reason: "Pick a type: Bug, Idea, Balance or Other." };
    if (Number.isNaN(feedbackRating(o.rating))) return { ok: false, field: "rating", reason: "The rating must be a whole number from 1 to 5, or left empty." };
    if (typeof o.message !== "string" || !o.message.trim()) return { ok: false, field: "message", reason: "Write a message first." };
    if (o.message.trim().length > FEEDBACK_MAX) return { ok: false, field: "message", reason: "The message is too long (" + o.message.trim().length + " of " + FEEDBACK_MAX + " characters)." };
    return { ok: true };
  }

  // What the player's game looks like, for the "attach game info" box. state may be null.
  function feedbackGameInfo(state, env) {
    const info = { version: GAME_VERSION };
    const num = (key, v) => { if (typeof v === "number" && isFinite(v)) info[key] = v; };
    if (state) {
      num("sector", state.sector);
      try { num("score", scoreTotal(state)); } catch (e) { /* no score */ }
      if (Array.isArray(state.ships)) num("ships", state.ships.length);
      if (typeof state.time === "number" && isFinite(state.time)) num("playedSeconds", Math.floor(state.time));
    }
    const ua = env && env.userAgent;
    if (typeof ua === "string" && ua) info.userAgent = ua.slice(0, FEEDBACK_INFO_MAX);
    info.version = String(info.version).slice(0, FEEDBACK_INFO_MAX);
    return info;
  }

  function makeFeedback(input, gameInfo, date, rand) {
    const v = validateFeedback(input);
    if (!v.ok) return v;
    const d = date || new Date();
    return { ok: true, payload: {
      schema: FEEDBACK_SCHEMA,
      id: feedbackId(d, rand),
      created: d.toISOString(),
      type: input.type,
      rating: feedbackRating(input.rating),
      message: input.message.trim(),
      gameInfo: gameInfo && typeof gameInfo === "object" ? gameInfo : null,
    } };
  }

  // How main.js treats a reply from the dashboard. Never throws, whatever the body is.
  function feedbackReply(status, bodyText) {
    let body = null;
    try { body = JSON.parse(bodyText); } catch (e) { body = null; }
    if (!body || typeof body !== "object") body = {};
    if (status === 200 && body.ok === true) {
      return { sent: true, duplicate: body.duplicate === true, message: "Sent to the team; the lead will draft a plan for your approval" };
    }
    const said = typeof body.message === "string" && body.message.trim() ? body.message.trim().slice(0, 300) : "";
    const message = said || "Dashboard replied " + (status === 200 ? "200 without ok" : status);
    const retry = !(status === 400 || status === 403 || status === 413);   // only these are final; anything else may work later
    return { sent: false, retry, message };
  }

  function newFeedbackEntry(payload) {
    return { payload, sent: false, sentAt: null, lastError: null };
  }

  // The stored list. Junk gives []; entries with an invalid payload or a bad id are dropped; newest first.
  function parseFeedbackList(text) {
    let raw = null;
    try { raw = JSON.parse(text); } catch (e) { return []; }
    if (!Array.isArray(raw)) return [];
    const out = [], seen = {};
    for (const e of raw) {
      const p = e && typeof e === "object" ? e.payload : null;
      if (!p || typeof p !== "object" || Array.isArray(p)) continue;
      if (typeof p.id !== "string" || !FEEDBACK_ID_RE.test(p.id) || seen[p.id]) continue;
      if (typeof p.created !== "string" || isNaN(Date.parse(p.created))) continue;
      if (!validateFeedback(p).ok) continue;
      const rating = feedbackRating(p.rating);
      if (p.rating !== null && p.rating !== undefined && typeof p.rating !== "number") continue;
      seen[p.id] = true;
      out.push({
        payload: { schema: FEEDBACK_SCHEMA, id: p.id, created: p.created, type: p.type, rating, message: p.message.trim(),
          gameInfo: p.gameInfo && typeof p.gameInfo === "object" && !Array.isArray(p.gameInfo) ? p.gameInfo : null },
        sent: e.sent === true,
        sentAt: e.sent === true && typeof e.sentAt === "string" ? e.sentAt : null,
        lastError: typeof e.lastError === "string" ? e.lastError : null,
      });
    }
    return out.map((e, i) => ({ e, i }))
      .sort((a, b) => (Date.parse(b.e.payload.created) - Date.parse(a.e.payload.created)) || (a.i - b.i))
      .map(x => x.e);
  }

  function serializeFeedbackList(list) {
    return JSON.stringify(Array.isArray(list) ? list : []);
  }

  // Plain text for the Copy button.
  function feedbackText(entry) {
    const p = entry.payload;
    const lines = [
      "Type: " + p.type,
      "Rating: " + (p.rating === null || p.rating === undefined ? "no rating" : p.rating + " of 5"),
      "Created: " + p.created,
      "Id: " + p.id,
      "Status: " + (entry.sent ? "sent" : "not sent"),
      "",
      p.message,
      "",
    ];
    const info = p.gameInfo;
    const keys = info && typeof info === "object" ? Object.keys(info) : [];
    if (!keys.length) lines.push("No game info attached.");
    else for (const k of keys) lines.push(k + ": " + info[k]);
    return lines.join("\n");
  }

  // The Download all file: name uses the local date.
  function feedbackExport(list, date) {
    const d = date || new Date();
    const entries = (Array.isArray(list) ? list : []).map(e => ({ sent: !!e.sent, sentAt: e.sentAt || null, payload: e.payload }));
    return {
      name: "fleet-game-feedback-" + d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate()) + ".json",
      text: JSON.stringify({ schema: "fleet-feedback-export/1", exported: d.toISOString(), entries }, null, 2),
    };
  }

  const api = {
    newRoster, parseRoster, serializeRoster, currentPlayer, addPlayer, renamePlayer, choosePlayer,
    newRunLog, parseRunLog, serializeRunLog, shouldLogRun, runRecord, addRun,
    newBuyLog, parseBuyLog, serializeBuyLog, buyRecord, addBuy,
    playerRuns, playerBuys, playerTotals, rankPlayers, topRuns, clearPlayerData, exportLogs,
    VERSION, TUNING, BASE_R, BASE_GAP, GOAL_BASES, RES, START_STOCK, SHIP_TYPES, BASE_COST, MAX_TIER,
    IDLE, TO_BODY, MINING, TO_BASE, UNLOADING, TO_STAR, MANUAL, MANUAL_SLACK,
    takeManual, releaseManual, setManualInput, manualAction, targetList, targetLabel, resolveTargetKeys, orderToTarget, orderNearestBase,
    LOOKS, LOOK_KINDS, LOOK_TITLES, SPACE_LABELS, labelsFor, sceneFor, shipLabel, bodyLabel,
    rng, newGame, canAfford, buildShip, addShip, baseSpotProblem, placeBase, checkWin,
    clampSector, mapScale, worldSize, mapSeed, goalBases, amountMult, crystalCount, bodyCount, crystalRich, BODY_SPECS, costMult, stormCount, showersOn,
    showerGap, showerHit, parTime, baseCost, shipCost, upgradeCost, upgradeBase, warpToNextSector,
    shipAvailable, shipUnavailableReason, orderShip, orderShipToStar, recallShip, returnToBase, nearestBase, inStorm, step, isStranded, retire, scoreTotal,
    jobText, spawnStress, serialize, deserialize, addBackup,
    hrand, eventsOn, aliensOn, eventGap, eventPower, raidOdds, fogRadius, flareDur, showerRadius, showerDmg,
    alienCount, alienHp, alienDmg, alienSpeed, addonCost, buildAddon, repairCost, repairShip, repairBase,
    orderPatrol, orderEscort, orderAttack, nearestAlien, eventWarnings, fogAt, shielded,
    newProfile, parseProfile, serializeProfile, buyLook, chooseLook, currentLooks, lookById, claimStars, syncClaimed, recordBest,
    GAME_VERSION, FEEDBACK_SCHEMA, FEEDBACK_TYPES, FEEDBACK_MAX, FEEDBACK_URL, FEEDBACK_TIMEOUT_MS,
    feedbackId, validateFeedback, feedbackGameInfo, makeFeedback, feedbackReply, newFeedbackEntry, parseFeedbackList,
    serializeFeedbackList, feedbackText, feedbackExport,
    // science, tech and lose-rule plumbing (see "contract" above)
    END_REASONS, emit, drainEvents, endRun, hasTech, techMult, techAdd,
    scienceFor, awardScience, onAlienKilled, generateNests, stepNests, damageNest, techState, unlockTech, scienceOnWarp,
    raidScienceCap, techCost, cargoCap, unloadRate, dockRange, nestById, liveNests, orderTarget, NEST_ORDER, NEST_GEO,
    econScale, econRates, stepEconomy, payDebt, sellStock, buyStock, setMothball, econWarpBlock, econOnWarp, timeLimit, econWarnings,
  };
  return api;
});
