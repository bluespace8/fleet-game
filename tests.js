"use strict";
// Run with: node tests.js   (no packages needed)

const G = require("./game.js");
const assert = require("assert");

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log("  ok   " + name); }
  catch (e) { failed++; console.log("  FAIL " + name + "\n       " + (e && e.message)); }
}

const DT = 1 / 60;
function run(state, seconds) { for (let i = 0; i < Math.round(seconds / DT); i++) G.step(state, DT); }
function total(state, k) { return state.stock[k] + state.ships.reduce((n, s) => n + (s.res === k ? s.cargo : 0), 0); }
function firstBody(state, res) { return state.bodies.find(b => b.res === res); }
function nearBody(state) { // closest ore body to home, for quick runs
  const h = state.bases[0];
  return state.bodies.filter(b => b.res === "ore").sort((a, b) => Math.hypot(a.x - h.x, a.y - h.y) - Math.hypot(b.x - h.x, b.y - h.y))[0];
}

console.log("map");
test("a new game has one home base, two ships and a starting stock", () => {
  const s = G.newGame(1);
  assert.strictEqual(s.bases.length, 1);
  assert.strictEqual(s.bases[0].home, true);
  assert.strictEqual(s.ships.length, 2);
  assert.strictEqual(s.stock.ore, G.START_STOCK.ore);
});
test("the same seed makes the same map, a different seed a different one", () => {
  assert.strictEqual(G.serialize(G.newGame(42)), G.serialize(G.newGame(42)));
  assert.notStrictEqual(G.serialize(G.newGame(42)), G.serialize(G.newGame(43)));
});
test("bodies have a resource that fits their kind and a finite amount", () => {
  for (let seed = 1; seed <= 25; seed++) {
    const s = G.newGame(seed);
    assert.ok(s.bodies.length >= 15, "seed " + seed + " has " + s.bodies.length + " bodies");
    for (const b of s.bodies) {
      const want = { asteroid: "ore", moon: "ice", iceplanet: "ice", rare: "crystal" }[b.kind];
      assert.strictEqual(b.res, want);
      assert.ok(b.amount > 0 && b.amount === b.max && isFinite(b.amount));
    }
    for (const res of G.RES) assert.ok(s.bodies.some(b => b.res === res), "no " + res);
  }
});
test("bodies stay inside the map, do not overlap, and keep clear of the home base", () => {
  for (let seed = 1; seed <= 25; seed++) {
    const s = G.newGame(seed), h = s.bases[0];
    s.bodies.forEach((a, i) => {
      assert.ok(a.x > 0 && a.y > 0 && a.x < s.w && a.y < s.h);
      assert.ok(Math.hypot(a.x - h.x, a.y - h.y) > a.r + G.BASE_R + 20);
      for (let j = i + 1; j < s.bodies.length; j++) {
        const b = s.bodies[j];
        assert.ok(Math.hypot(a.x - b.x, a.y - b.y) >= a.r + b.r, "overlap on seed " + seed);
      }
    });
  }
});
test("some ore is within easy reach of home", () => {
  for (let seed = 1; seed <= 25; seed++) {
    const s = G.newGame(seed), h = s.bases[0], b = nearBody(s);
    assert.ok(Math.hypot(b.x - h.x, b.y - h.y) < 450);
  }
});

console.log("costs and building");
test("canAfford checks every resource", () => {
  const s = G.newGame(1);
  assert.ok(G.canAfford(s, G.SHIP_TYPES.miner.cost));
  assert.ok(!G.canAfford(s, G.BASE_COST));
  assert.ok(!G.canAfford(s, G.SHIP_TYPES.hauler.cost), "hauler needs ice");
});
test("building a miner pays its cost and adds a ship at home", () => {
  const s = G.newGame(1);
  const before = s.stock.ore;
  const r = G.buildShip(s, "miner");
  assert.ok(r.ok);
  assert.strictEqual(s.ships.length, 3);
  assert.strictEqual(s.stock.ore, before - G.SHIP_TYPES.miner.cost.ore);
  assert.strictEqual(r.ship.name, "Miner 3");
});
test("building without enough materials fails and charges nothing", () => {
  const s = G.newGame(1);
  s.stock.ore = 10;
  const r = G.buildShip(s, "miner");
  assert.ok(!r.ok && r.reason);
  assert.strictEqual(s.ships.length, 2);
  assert.strictEqual(s.stock.ore, 10);
  assert.ok(!G.buildShip(s, "nope").ok);
});
test("the hauler is faster and larger than the miner", () => {
  const m = G.SHIP_TYPES.miner, h = G.SHIP_TYPES.hauler;
  assert.ok(h.speed > m.speed && h.cap > m.cap);
  const s = G.newGame(1);
  s.stock.ore = 500; s.stock.ice = 100;
  assert.ok(G.buildShip(s, "hauler").ok);
  assert.strictEqual(s.stock.ice, 100 - h.cost.ice);
});
test("a base needs materials and a clear spot", () => {
  const s = G.newGame(2), h = s.bases[0];
  let spot = null;
  for (let x = 100; x < 1500 && !spot; x += 25) for (let y = 100; y < 900 && !spot; y += 25) if (!G.baseSpotProblem(s, x, y)) spot = { x, y };
  assert.ok(spot, "found a legal spot");
  s.stock.ore = s.stock.ice = s.stock.crystal = 0;
  const broke = G.placeBase(s, spot.x, spot.y);
  assert.ok(!broke.ok && /materials/.test(broke.reason), "valid spot, no materials");
  assert.strictEqual(s.bases.length, 1);
  s.stock.ore = 1000; s.stock.ice = 1000; s.stock.crystal = 1000;
  assert.ok(!G.placeBase(s, h.x + 20, h.y).ok, "on top of home");
  assert.ok(!G.placeBase(s, 2, 2).ok, "off the edge");
  const b = s.bodies[0];
  assert.ok(!G.placeBase(s, b.x, b.y).ok, "on a planet");
  assert.strictEqual(s.bases.length, 1);
  assert.strictEqual(s.stock.ore, 1000, "failed placements are free");
});
test("placing a base charges the cost and adds a drop-off point", () => {
  const s = G.newGame(2);
  s.stock.ore = 1000; s.stock.ice = 1000; s.stock.crystal = 1000;
  let spot = null;
  for (let x = 100; x < 1500 && !spot; x += 25) for (let y = 100; y < 900 && !spot; y += 25) if (!G.baseSpotProblem(s, x, y)) spot = { x, y };
  assert.ok(spot, "found a legal spot");
  const r = G.placeBase(s, spot.x, spot.y);
  assert.ok(r.ok);
  assert.strictEqual(s.bases.length, 2);
  assert.strictEqual(s.stock.crystal, 1000 - G.BASE_COST.crystal);
  assert.ok(!G.placeBase(s, spot.x + 10, spot.y).ok, "too close to the new base");
});
test("building 5 bases (6 with home) wins the game, 4 built does not", () => {
  const s = G.newGame(3);
  s.stock.ore = s.stock.ice = s.stock.crystal = 5000;
  assert.strictEqual(G.GOAL_BASES, 5);
  let built = 0;
  for (let x = 80; x < 1520 && built < G.GOAL_BASES; x += 40) {
    for (let y = 80; y < 920 && built < G.GOAL_BASES; y += 40) {
      if (G.placeBase(s, x, y).ok) { built++; if (built === G.GOAL_BASES - 1) assert.ok(!s.won, "4 built"); }
    }
  }
  assert.strictEqual(built, G.GOAL_BASES);
  assert.strictEqual(s.bases.length, G.GOAL_BASES + 1);
  assert.ok(s.won);
});

console.log("mining and cargo");
test("a ship flies to a body, mines, returns and unloads", () => {
  const s = G.newGame(1), body = nearBody(s), ship = s.ships[0];
  const start = body.amount;
  assert.ok(G.orderShip(s, ship.id, body.id).ok);
  assert.strictEqual(ship.st, G.TO_BODY);
  const ore0 = s.stock.ore;
  let sawMining = false, sawHaul = false;
  for (let i = 0; i < 60 * 120 && s.stock.ore === ore0; i++) {
    G.step(s, DT);
    if (ship.st === G.MINING) sawMining = true;
    if (ship.st === G.TO_BASE && ship.cargo > 0) sawHaul = true;
  }
  assert.ok(sawMining && sawHaul);
  assert.ok(s.stock.ore > ore0, "ore arrived");
  assert.ok(Math.abs(s.stock.ore - ore0 - G.SHIP_TYPES.miner.cap) < 1e-6, "one full load");
  assert.ok(Math.abs(body.amount - (start - G.SHIP_TYPES.miner.cap)) < 1e-6);
});
test("cargo never exceeds the ship's capacity", () => {
  const s = G.newGame(1), body = nearBody(s);
  s.stock.ore = 1000; s.stock.ice = 100;
  G.buildShip(s, "hauler");
  for (const sh of s.ships) G.orderShip(s, sh.id, body.id);
  for (let i = 0; i < 60 * 60; i++) {
    G.step(s, DT);
    for (const sh of s.ships) assert.ok(sh.cargo <= G.SHIP_TYPES[sh.type].cap + 1e-9);
  }
});
test("ships repeat the run until the body is empty, then go idle at a base", () => {
  const s = G.newGame(1), body = nearBody(s);
  body.amount = body.max = 70;                       // 3.5 loads for one miner
  const ship = s.ships[0];
  const ore0 = s.stock.ore;
  G.orderShip(s, ship.id, body.id);
  run(s, 400);
  assert.strictEqual(body.amount, 0);
  assert.strictEqual(ship.st, G.IDLE);
  assert.strictEqual(ship.target, -1);
  assert.strictEqual(ship.cargo, 0);
  assert.ok(Math.abs(s.stock.ore - ore0 - 70) < 1e-6, "all 70 delivered");
  assert.ok(Math.hypot(ship.x - s.bases[0].x, ship.y - s.bases[0].y) < G.BASE_R + 15);
});
test("mining is conserved: what leaves a body shows up in stock or cargo", () => {
  const s = G.newGame(5);
  const ore0 = total(s, "ore");
  const start = s.bodies.filter(b => b.res === "ore").reduce((n, b) => n + b.amount, 0);
  for (const sh of s.ships) G.orderShip(s, sh.id, nearBody(s).id);
  run(s, 90);
  const left = s.bodies.filter(b => b.res === "ore").reduce((n, b) => n + b.amount, 0);
  assert.ok(Math.abs((start - left) - (total(s, "ore") - ore0)) < 1e-6);
  assert.ok(Math.abs(s.stats.ore - (start - left)) < 1e-6);
});
test("a ship ordered to ice brings ice, not ore", () => {
  const s = G.newGame(1), ice = firstBody(s, "ice");
  G.orderShip(s, 0, ice.id);
  run(s, 300);
  assert.ok(s.stock.ice > 0);
});
test("an empty body cannot be ordered", () => {
  const s = G.newGame(1), body = nearBody(s);
  body.amount = 0;
  const r = G.orderShip(s, 0, body.id);
  assert.ok(!r.ok);
  assert.strictEqual(s.ships[0].st, G.IDLE);
});
test("a body emptied by another ship sends the late ship home", () => {
  const s = G.newGame(1), body = nearBody(s);
  G.orderShip(s, 0, body.id);
  body.amount = 0;
  run(s, 60);
  assert.strictEqual(s.ships[0].st, G.IDLE);
});
test("ships unload at the nearest base, not the home base", () => {
  const s = G.newGame(2), body = nearBody(s);
  s.bases.push({ id: 1, x: body.x + body.r + 60, y: body.y, home: false });   // right beside the body
  const ship = s.ships[0];
  G.orderShip(s, ship.id, body.id);
  let unloadedAt = null;
  for (let i = 0; i < 60 * 120 && !unloadedAt; i++) {
    const before = s.stock.ore;
    G.step(s, DT);
    if (s.stock.ore > before) unloadedAt = { x: ship.x, y: ship.y };
  }
  assert.ok(unloadedAt, "unloaded");
  assert.ok(Math.hypot(unloadedAt.x - s.bases[1].x, unloadedAt.y - s.bases[1].y) < G.BASE_R + 15);
});
test("a hauler delivers a bigger load per trip than a miner", () => {
  const s = G.newGame(1); s.stock.ore = 500; s.stock.ice = 100;
  const h = G.buildShip(s, "hauler").ship, body = nearBody(s);
  G.orderShip(s, h.id, body.id);
  const ore0 = s.stock.ore;
  for (let i = 0; i < 60 * 200 && s.stock.ore === ore0; i++) G.step(s, DT);
  assert.ok(Math.abs(s.stock.ore - ore0 - G.SHIP_TYPES.hauler.cap) < 1e-6);
});
test("nearestBase picks the closest base", () => {
  const s = G.newGame(1);
  s.bases.push({ id: 1, x: 100, y: 100, home: false });
  assert.strictEqual(G.nearestBase(s, 90, 90), 1);
  assert.strictEqual(G.nearestBase(s, s.bases[0].x + 5, s.bases[0].y), 0);
});
test("recall sends a working ship home and clears its target", () => {
  const s = G.newGame(1);
  G.orderShip(s, 0, nearBody(s).id);
  run(s, 3);
  G.recallShip(s, 0);
  assert.strictEqual(s.ships[0].target, -1);
  run(s, 200);
  assert.strictEqual(s.ships[0].st, G.IDLE);
  assert.ok(!G.recallShip(s, 99).ok);
});
test("a recalled ship with an empty hold goes straight to a new target", () => {
  const s = G.newGame(1), b = nearBody(s);
  G.orderShip(s, 0, b.id);
  run(s, 1);
  G.recallShip(s, 0);
  assert.strictEqual(s.ships[0].st, G.TO_BASE);
  assert.strictEqual(s.ships[0].cargo, 0);
  G.orderShip(s, 0, b.id);
  assert.strictEqual(s.ships[0].st, G.TO_BODY);
  s.ships[0].cargo = 5; s.ships[0].res = b.res; s.ships[0].st = G.TO_BASE;   // loaded: still unloads first
  G.orderShip(s, 0, b.id);
  assert.strictEqual(s.ships[0].st, G.TO_BASE);
});
test("returnToBase sends a ship to the chosen base, not the nearest", () => {
  const s = G.newGame(1), home = s.bases[0];
  let spot = null;
  for (let x = 100; x < 1500 && !spot; x += 25) for (let y = 100; y < 900 && !spot; y += 25) {
    if (!G.baseSpotProblem(s, x, y) && Math.hypot(x - home.x, y - home.y) > 400) spot = { x, y };
  }
  assert.ok(spot);
  s.stock.ore = s.stock.ice = s.stock.crystal = 1000;
  assert.ok(G.placeBase(s, spot.x, spot.y).ok);
  const far = s.bases[1], ship = s.ships[0];
  G.orderShip(s, 0, nearBody(s).id);
  run(s, 1);
  assert.strictEqual(G.nearestBase(s, ship.x, ship.y), 0, "home is the nearest");
  assert.ok(G.returnToBase(s, 0, 1).ok);
  assert.strictEqual(ship.target, -1);
  run(s, 100);
  assert.strictEqual(ship.st, G.IDLE);
  assert.ok(Math.hypot(ship.x - far.x, ship.y - far.y) < G.BASE_R + 12, "docked at the far base");
  assert.ok(!G.returnToBase(s, 0, 9).ok);
  assert.ok(!G.returnToBase(s, 99, 0).ok);
});
test("re-ordering a loaded ship to a different resource unloads first", () => {
  const s = G.newGame(1), ore = nearBody(s), ice = firstBody(s, "ice");
  G.orderShip(s, 0, ore.id);
  for (let i = 0; i < 60 * 100 && s.ships[0].cargo < 5; i++) G.step(s, DT);
  assert.ok(s.ships[0].cargo > 0);
  G.orderShip(s, 0, ice.id);
  assert.strictEqual(s.ships[0].st, G.TO_BASE);
  run(s, 400);
  assert.ok(s.stock.ice > 0);
});
test("jobText describes each state", () => {
  const s = G.newGame(1), sh = s.ships[0];
  assert.ok(/Idle/.test(G.jobText(s, sh)));
  G.orderShip(s, 0, nearBody(s).id);
  assert.ok(/Flying to/.test(G.jobText(s, sh)));
  for (let i = 0; i < 60 * 100 && sh.st !== G.MINING; i++) G.step(s, DT);
  assert.ok(/Mining/.test(G.jobText(s, sh)));
  for (let i = 0; i < 60 * 100 && sh.st !== G.TO_BASE; i++) G.step(s, DT);
  assert.ok(/Hauling/.test(G.jobText(s, sh)));
});

console.log("save and load");
test("save then load gives back the same game", () => {
  const s = G.newGame(9);
  G.orderShip(s, 0, nearBody(s).id);
  run(s, 12);
  const r = G.deserialize(G.serialize(s));
  assert.ok(r.ok);
  assert.strictEqual(G.serialize(r.state), G.serialize(s));
});
test("a loaded game keeps running identically to the original", () => {
  const s = G.newGame(9);
  for (const sh of s.ships) G.orderShip(s, sh.id, nearBody(s).id);
  run(s, 10);
  const copy = G.deserialize(G.serialize(s)).state;
  run(s, 30); run(copy, 30);
  assert.strictEqual(G.serialize(copy), G.serialize(s));
});
test("bad saves are rejected, not half loaded", () => {
  assert.ok(!G.deserialize("not json").ok);
  assert.ok(!G.deserialize("null").ok);
  assert.ok(!G.deserialize("{}").ok);
  assert.ok(!G.deserialize(JSON.stringify({ ver: 99 })).ok);
  const good = JSON.parse(G.serialize(G.newGame(1)));
  good.bases = [];
  assert.ok(!G.deserialize(JSON.stringify(good)).ok);
  const bad = JSON.parse(G.serialize(G.newGame(1)));
  bad.ships[0].type = "dreadnought";
  assert.ok(!G.deserialize(JSON.stringify(bad)).ok);
});
test("damaged numbers and dangling targets are repaired on load", () => {
  const raw = JSON.parse(G.serialize(G.newGame(1)));
  raw.stock.ore = "lots";
  raw.stock.ice = -5;
  raw.ships[0].x = null;
  raw.ships[0].st = 1;
  raw.ships[0].target = 9999;
  raw.ships[1].cargo = 9999; raw.ships[1].res = "ore";
  const r = G.deserialize(JSON.stringify(raw));
  assert.ok(r.ok);
  assert.strictEqual(r.state.stock.ore, 0);
  assert.strictEqual(r.state.stock.ice, 0);
  assert.strictEqual(r.state.ships[0].x, 0);
  assert.strictEqual(r.state.ships[0].st, G.TO_BASE);
  assert.strictEqual(r.state.ships[1].cargo, G.SHIP_TYPES.miner.cap);
  run(r.state, 5);                                   // and it still runs
  for (const sh of r.state.ships) assert.ok(isFinite(sh.x) && isFinite(sh.y));
});
test("cargo that does not match the target body is dropped on load", () => {
  const s = G.newGame(1), ice = firstBody(s, "ice");
  const raw = JSON.parse(G.serialize(s));
  raw.ships[0].st = G.MINING; raw.ships[0].target = ice.id; raw.ships[0].res = "ore"; raw.ships[0].cargo = 10;
  raw.ships[1].st = G.MINING; raw.ships[1].target = ice.id; raw.ships[1].res = "ice"; raw.ships[1].cargo = 10;
  const r = G.deserialize(JSON.stringify(raw));
  assert.ok(r.ok);
  assert.strictEqual(r.state.ships[0].cargo, 0);
  assert.strictEqual(r.state.ships[0].res, "");
  assert.strictEqual(r.state.ships[1].cargo, 10, "matching cargo is kept");
});
test("won state and bases survive a round trip", () => {
  const s = G.newGame(3);
  s.won = true; s.wonAt = 12.5;
  s.bases.push({ id: 1, x: 300, y: 300, home: false });
  const r = G.deserialize(G.serialize(s)).state;
  assert.ok(r.won);
  assert.strictEqual(r.wonAt, 12.5);
  assert.strictEqual(r.bases.length, 2);
  assert.strictEqual(r.bases[0].home, true);
});

// ---------------------------------------------------------------- follow-ups from the first version

console.log("follow-ups");
test("an idle ship accepts a base click and flies there", () => {
  const s = G.newGame(1), home = s.bases[0];
  let spot = null;
  for (let x = 100; x < 1500 && !spot; x += 25) for (let y = 100; y < 900 && !spot; y += 25) {
    if (!G.baseSpotProblem(s, x, y) && Math.hypot(x - home.x, y - home.y) > 300) spot = { x, y };
  }
  s.stock.ore = s.stock.ice = s.stock.crystal = 1000;
  assert.ok(G.placeBase(s, spot.x, spot.y).ok);
  const ship = s.ships[0];
  assert.strictEqual(ship.st, G.IDLE);
  assert.ok(G.returnToBase(s, 0, 1).ok);
  assert.strictEqual(ship.st, G.TO_BASE);
  run(s, 60);
  assert.strictEqual(ship.st, G.IDLE);
  assert.ok(Math.hypot(ship.x - s.bases[1].x, ship.y - s.bases[1].y) < G.BASE_R + 12);
});
test("damaged-save backups keep the newest three, newest first, without repeats", () => {
  let list = [];
  for (const t of ["a", "b", "b", "c", "d"]) list = G.addBackup(list, { at: "t", from: "x", text: t });
  assert.deepStrictEqual(list.map(e => e.text), ["d", "c", "b"]);
  assert.deepStrictEqual(G.addBackup(null, { text: "z" }).map(e => e.text), ["z"]);
  assert.strictEqual(G.addBackup([{ text: "1" }, { text: "2" }], { text: "3" }, 2).length, 2);
});

// ---------------------------------------------------------------- sectors

console.log("sectors and difficulty");
function legalSpot(s, minFromHome) {
  const h = s.bases[0];
  for (let x = 100; x < s.w - 100; x += 25) for (let y = 100; y < s.h - 100; y += 25) {
    if (!G.baseSpotProblem(s, x, y) && Math.hypot(x - h.x, y - h.y) > (minFromHome || 0)) return { x, y };
  }
  return null;
}
function buildGoal(s) {   // build the sector's bases for free
  s.stock.ore = s.stock.ice = s.stock.crystal = 99999;
  let built = 0;
  for (let x = 80; x < s.w - 80 && built < G.goalBases(s.sector); x += 40) {
    for (let y = 80; y < s.h - 80 && built < G.goalBases(s.sector); y += 40) if (G.placeBase(s, x, y).ok) built++;
  }
  return built;
}
test("a new game is sector 1, sized and costed as before", () => {
  const s = G.newGame(1);
  assert.strictEqual(s.sector, 1);
  assert.strictEqual(s.w, 1600); assert.strictEqual(s.h, 1000);
  assert.deepStrictEqual(G.baseCost(s), G.BASE_COST);
  assert.deepStrictEqual(G.shipCost(s, "miner"), G.SHIP_TYPES.miner.cost);
  assert.strictEqual(G.goalBases(1), 5);
  assert.strictEqual(G.amountMult(1), 1);
  assert.strictEqual(G.crystalCount(1), 3);
  assert.strictEqual(G.stormCount(1), 0);
  assert.ok(!G.showersOn(1));
  assert.strictEqual(s.storms.length, 0);
});
test("the goal opens the warp, not before", () => {
  const s = G.newGame(3);
  assert.ok(!G.warpToNextSector(s).ok);
  assert.strictEqual(s.sector, 1);
  assert.strictEqual(buildGoal(s), G.goalBases(1));
  assert.ok(s.won);
  const r = G.warpToNextSector(s);
  assert.ok(r.ok && r.sector === 2);
  assert.strictEqual(s.sector, 2);
});
test("warping makes a new, bigger map and keeps ships, stock and score", () => {
  const s = G.newGame(3);
  const oldBodies = JSON.stringify(s.bodies);
  buildGoal(s);
  s.stock.ore = 777;
  s.ships[0].cargo = 5; s.ships[0].res = "ice"; s.ships[0].st = G.TO_BASE;
  const score0 = G.scoreTotal(s), ice0 = s.stock.ice;
  assert.ok(G.warpToNextSector(s).ok);
  assert.strictEqual(s.bases.length, 1);
  assert.ok(s.w > 1600 && s.h > 1000);
  assert.notStrictEqual(JSON.stringify(s.bodies), oldBodies);
  assert.strictEqual(s.ships.length, 2);
  assert.ok(s.ships.every(sh => sh.st === G.IDLE && sh.cargo === 0));
  assert.strictEqual(s.stock.ore, 777);
  assert.strictEqual(s.stock.ice, ice0 + 5, "cargo is handed in");
  assert.ok(G.scoreTotal(s) >= score0);
  assert.ok(!s.won);
  assert.strictEqual(s.sectorTime, 0);
  for (const sh of s.ships) assert.ok(Math.hypot(sh.x - s.bases[0].x, sh.y - s.bases[0].y) < G.BASE_R + 20);
  run(s, 5);   // the new map runs
});
test("each sector is a deterministic map of its own", () => {
  const a = G.newGame(8, 3), b = G.newGame(8, 3), c = G.newGame(8, 2);
  assert.strictEqual(G.serialize(a), G.serialize(b));
  assert.notStrictEqual(G.serialize(a), G.serialize(c));
  const s = G.newGame(8); buildGoal(s); G.warpToNextSector(s);
  assert.strictEqual(JSON.stringify(s.bodies), JSON.stringify(G.newGame(8, 2).bodies), "warp lands on the sector 2 map");
});
test("difficulty rises: more bases, less material, rarer crystal, dearer builds, bigger map", () => {
  for (let n = 2; n <= 8; n++) {
    assert.ok(G.goalBases(n) >= G.goalBases(n - 1));
    assert.ok(G.amountMult(n) <= G.amountMult(n - 1));
    assert.ok(G.crystalCount(n) <= G.crystalCount(n - 1));
    assert.ok(G.costMult(n) > G.costMult(n - 1));
    assert.ok(G.mapScale(n) >= G.mapScale(n - 1));
  }
  assert.ok(G.goalBases(2) > G.goalBases(1) && G.amountMult(2) < 1 && G.crystalCount(4) < G.crystalCount(1));
  assert.ok(G.mapScale(3) > 1);
  const s1 = G.newGame(5, 1), s4 = G.newGame(5, 4);
  assert.ok(G.baseCost(s4).ore > G.baseCost(s1).ore && G.shipCost(s4, "miner").ore > G.shipCost(s1, "miner").ore);
  const mean = s => s.bodies.reduce((n, b) => n + b.max, 0) / s.bodies.length;
  let m1 = 0, m5 = 0;
  for (let seed = 1; seed <= 12; seed++) { m1 += mean(G.newGame(seed, 1)); m5 += mean(G.newGame(seed, 5)); }
  assert.ok(m5 < m1 * 0.8, "bodies hold less further out");
  const crystals = s => s.bodies.filter(b => b.res === "crystal").length;
  assert.ok(crystals(G.newGame(5, 5)) < crystals(G.newGame(5, 1)));
});
test("every sector's own map holds enough to pay for its goal, with a margin, forever, and the ore margin never loosens", () => {
  const MARGIN = 1.3, prev = {};
  for (let n = 1; n <= 30; n++) {
    const low = { ore: Infinity, ice: Infinity, crystal: Infinity };
    for (let seed = 1; seed <= 40; seed++) {
      const s = G.newGame(seed, n), cost = G.baseCost(s), goal = G.goalBases(n);
      const supply = { ore: 0, ice: 0, crystal: 0 };
      for (const b of s.bodies) supply[b.res] += b.max;
      for (const r of G.RES) {
        const need = goal * cost[r];   // the fleet is carried over from earlier sectors, so only the bases count
        assert.ok(supply[r] >= need * MARGIN, "sector " + n + " seed " + seed + ": " + supply[r] + " " + r + " for " + need + " needed");
        low[r] = Math.min(low[r], supply[r] / need);
      }
    }
    // Until sector 10 the margin tightens. After that nothing changes except which random map each sector gets,
    // so the worst seed may wobble a little (by under 10%); it must not drift looser.
    if (n === 10) prev.ore10 = low.ore;
    if (n > 1) assert.ok(low.ore <= (n <= 10 ? prev.ore + 1e-9 : prev.ore10 * 1.1), "ore margin does not loosen at sector " + n);
    prev.ore = low.ore;
  }
});
test("difficulty plateaus: costs stop rising, and the crystal planet stays far out in late sectors", () => {
  assert.strictEqual(G.costMult(10), G.costMult(30));
  assert.ok(G.costMult(10) > G.costMult(9));
  const crystalDist = n => {
    let min = Infinity;
    for (let seed = 1; seed <= 15; seed++) {
      const s = G.newGame(seed, n), h = s.bases[0];
      for (const b of s.bodies) if (b.res === "crystal") min = Math.min(min, Math.hypot(b.x - h.x, b.y - h.y));
    }
    return min;
  };
  const d10 = crystalDist(10);
  for (const n of [14, 18, 22, 30]) assert.ok(crystalDist(n) >= d10 * 0.9, "sector " + n + ": " + crystalDist(n) + " vs " + d10);
});
test("bodies sit further from home in later sectors", () => {
  const avg = n => {
    let t = 0, c = 0;
    for (let seed = 1; seed <= 12; seed++) { const s = G.newGame(seed, n), h = s.bases[0]; for (const b of s.bodies) { t += Math.hypot(b.x - h.x, b.y - h.y); c++; } }
    return t / c;
  };
  assert.ok(avg(4) > avg(1) * 1.1, avg(1) + " vs " + avg(4));
});
test("later sectors still make a full, legal map", () => {
  for (let n = 2; n <= 7; n++) for (let seed = 1; seed <= 6; seed++) {
    const s = G.newGame(seed, n);
    assert.ok(s.bodies.length >= 12, "sector " + n + " seed " + seed + " has " + s.bodies.length);
    for (const res of G.RES) assert.ok(s.bodies.some(b => b.res === res), "no " + res);
    s.bodies.forEach((a, i) => {
      assert.ok(a.x > 0 && a.y > 0 && a.x < s.w && a.y < s.h);
      for (let j = i + 1; j < s.bodies.length; j++) assert.ok(Math.hypot(a.x - s.bodies[j].x, a.y - s.bodies[j].y) >= a.r + s.bodies[j].r);
    });
  }
});
test("the goal grows with the sector", () => {
  const s = G.newGame(3, 2);
  s.stock.ore = s.stock.ice = s.stock.crystal = 99999;
  assert.strictEqual(buildGoal(s), G.goalBases(2));
  assert.strictEqual(G.goalBases(2), 6);
  assert.ok(s.won);
});

console.log("hazards");
test("ion storms appear from sector 2 and not in sector 1", () => {
  assert.strictEqual(G.newGame(4, 1).storms.length, 0);
  for (let n = 2; n <= 6; n++) {
    const s = G.newGame(4, n);
    assert.ok(s.storms.length >= 1 && s.storms.length === G.stormCount(n));
    for (const st of s.storms) assert.ok(Math.hypot(st.x - s.bases[0].x, st.y - s.bases[0].y) > st.r, "not on top of home");
  }
  assert.ok(G.stormCount(5) > G.stormCount(2));
});
test("storms drift and stay inside the map", () => {
  const s = G.newGame(4, 3), x0 = s.storms.map(t => t.x + "," + t.y).join();
  run(s, 120);
  assert.notStrictEqual(s.storms.map(t => t.x + "," + t.y).join(), x0);
  for (const t of s.storms) assert.ok(t.x >= 0 && t.x <= s.w && t.y >= 0 && t.y <= s.h);
});
test("a ship inside an ion storm is slowed", () => {
  const s = G.newGame(4, 2);
  const body = nearBody(s);
  s.storms.forEach(t => { t.vx = t.vy = 0; t.x = -9999; });
  const free = G.newGame(4, 2); free.storms.forEach(t => { t.vx = t.vy = 0; t.x = -9999; });
  s.storms[0].x = s.bases[0].x; s.storms[0].y = s.bases[0].y; s.storms[0].r = 4000;   // covers everything
  assert.ok(G.inStorm(s, s.ships[0].x, s.ships[0].y) && !G.inStorm(free, free.ships[0].x, free.ships[0].y));
  G.orderShip(s, 0, body.id); G.orderShip(free, 0, nearBody(free).id);
  const d = (st, sh) => Math.hypot(sh.x - st.bases[0].x, sh.y - st.bases[0].y);
  for (let i = 0; i < 60; i++) { G.step(s, DT); G.step(free, DT); }
  const slow = d(s, s.ships[0]), fast = d(free, free.ships[0]);
  assert.ok(slow < fast * 0.6 && slow > 0, slow + " vs " + fast);
});
test("storms do not touch ships in sector 1", () => {
  const s = G.newGame(1);
  assert.ok(!G.inStorm(s, s.ships[0].x, s.ships[0].y));
});
test("meteor showers start in sector 3, not before", () => {
  assert.ok(!G.showersOn(2) && G.showersOn(3));
  const s2 = G.newGame(4, 2); run(s2, 200); assert.strictEqual(s2.showers.length, 0);
  const s3 = G.newGame(4, 3); let seen = 0;
  for (let i = 0; i < 60 * 60; i++) { G.step(s3, DT); seen = Math.max(seen, s3.showers.length); }
  assert.ok(seen >= 1, "a shower appeared");
  assert.ok(G.showerGap(5) <= G.showerGap(3) && G.showerHit(5) >= G.showerHit(3));
});
test("a loaded ship inside a shower can lose cargo, an empty one cannot", () => {
  const s = G.newGame(4, 3);
  s.showers.push({ x: 500, y: 500, r: 120, age: T().warn });
  s.ships[0].x = 500; s.ships[0].y = 500; s.ships[0].cargo = 20; s.ships[0].res = "ore"; s.ships[0].st = G.TO_BASE;
  s.ships[1].x = 505; s.ships[1].y = 505; s.ships[1].cargo = 0;
  s.showerIn = 1e9;
  let guard = 0;
  while (s.hits === 0 && guard++ < 60 * 60) { s.showers[0].age = T().warn; s.ships[0].x = 500; s.ships[0].y = 500; G.step(s, DT); }
  assert.ok(s.hits > 0, "hit eventually");
  assert.ok(s.ships[0].cargo < 20 && s.ships[0].cargo > 0);
  assert.ok(Math.abs(s.stats.lost - (20 - s.ships[0].cargo)) < 1e-6);
  assert.ok(s.ships[0].hitCd > 0, "then a short grace period");
});
test("a shower is harmless during its warning", () => {
  const s = G.newGame(4, 3);
  s.showers.push({ x: 500, y: 500, r: 120, age: 0 });
  s.showerIn = 1e9;
  s.ships[0].x = 500; s.ships[0].y = 500; s.ships[0].cargo = 20; s.ships[0].res = "ore"; s.ships[0].st = G.IDLE;
  for (let i = 0; i < 60; i++) { s.showers[0].age = Math.min(s.showers[0].age, T().warn - 0.5); G.step(s, DT); }
  assert.strictEqual(s.hits, 0);
});
test("mined material is conserved with meteors: stock + cargo + lost", () => {
  const s = G.newGame(6, 3);
  const before = total(s, "ore");
  for (const sh of s.ships) G.orderShip(s, sh.id, nearBody(s).id);
  s.showers.push({ x: s.bases[0].x, y: s.bases[0].y, r: 5000, age: T().warn });
  s.showerIn = 1e9;
  for (let i = 0; i < 60 * 80; i++) { if (s.showers[0]) s.showers[0].age = Math.max(s.showers[0].age, T().warn); G.step(s, DT); }
  assert.ok(s.stats.lost > 0);
  assert.ok(Math.abs(total(s, "ore") + s.stats.lost - before - s.stats.ore) < 1e-6);
});
test("hazards are deterministic and survive save and load", () => {
  const a = G.newGame(11, 3);
  for (const sh of a.ships) G.orderShip(a, sh.id, nearBody(a).id);
  run(a, 40);
  const b = G.deserialize(G.serialize(a)).state;
  run(a, 60); run(b, 60);
  assert.strictEqual(G.serialize(a), G.serialize(b));
});
function T() { return G.TUNING.showers; }

console.log("base upgrades");
test("a base can be upgraded twice, for materials, then no more", () => {
  const s = G.newGame(2);
  s.stock.ore = s.stock.ice = s.stock.crystal = 0;
  assert.ok(!G.upgradeBase(s, 0).ok, "no materials");
  s.stock.ore = s.stock.ice = s.stock.crystal = 1000;
  const c1 = G.upgradeCost(s, 0);
  assert.ok(G.upgradeBase(s, 0).ok);
  assert.strictEqual(s.bases[0].tier, 1);
  assert.strictEqual(s.stock.ore, 1000 - c1.ore);
  const c2 = G.upgradeCost(s, 0);
  assert.ok(c2.ore > c1.ore, "tier 2 costs more");
  assert.ok(G.upgradeBase(s, 0).ok);
  assert.strictEqual(s.bases[0].tier, G.MAX_TIER);
  assert.strictEqual(G.MAX_TIER, 2);
  const left = s.stock.ore;
  const r = G.upgradeBase(s, 0);
  assert.ok(!r.ok && r.reason);
  assert.strictEqual(s.stock.ore, left, "a refused upgrade is free");
  assert.strictEqual(G.upgradeCost(s, 0), null);
  assert.ok(!G.upgradeBase(s, 9).ok);
});
test("upgrade costs rise with the sector", () => {
  assert.ok(G.upgradeCost(G.newGame(2, 4), 0).ore > G.upgradeCost(G.newGame(2, 1), 0).ore);
});
test("upgrading one base does not change another", () => {
  const s = G.newGame(2); s.stock.ore = s.stock.ice = s.stock.crystal = 5000;
  const spot = legalSpot(s, 300);
  assert.ok(G.placeBase(s, spot.x, spot.y).ok);
  G.upgradeBase(s, 1);
  assert.strictEqual(s.bases[0].tier, 0); assert.strictEqual(s.bases[1].tier, 1);
});
function deliverTime(tier) {   // seconds from arriving with a hauler load to being free again
  const s = G.newGame(1); s.stock.ore = s.stock.ice = s.stock.crystal = 5000;
  s.bases[0].tier = tier;
  const sh = G.buildShip(s, "hauler").ship;
  sh.cargo = 60; sh.res = "ore"; sh.st = G.TO_BASE;
  let t = 0, arrived = -1;
  while (t < 60) {
    G.step(s, DT); t += DT;
    if (arrived < 0 && s.stock.ore > 5000 - 90) arrived = t;
    if (arrived >= 0 && sh.st === G.IDLE) return { total: t, wait: t - arrived, dock: Math.hypot(sh.x - s.bases[0].x, sh.y - s.bases[0].y) };
  }
  return null;
}
test("upgraded bases unload faster", () => {
  const a = deliverTime(0), b = deliverTime(1), c = deliverTime(2);
  assert.ok(a.wait > b.wait + 0.2 && b.wait > c.wait + 0.2, [a.wait, b.wait, c.wait].join(" "));
});
test("upgraded bases accept ships from further out", () => {
  const a = deliverTime(0), c = deliverTime(2);
  assert.ok(c.dock > a.dock + 15, a.dock + " vs " + c.dock);
});
test("unloading takes time but the delivery counts at once, so sector 1 timing is close to before", () => {
  const a = deliverTime(0);
  assert.ok(a.wait > 0.5 && a.wait < 4);
});
test("an order given while unloading is obeyed", () => {
  const s = G.newGame(1), sh = s.ships[0];
  sh.cargo = 20; sh.res = "ore"; sh.st = G.TO_BASE;
  for (let i = 0; i < 60 * 60 && sh.st !== G.UNLOADING; i++) G.step(s, DT);
  assert.strictEqual(sh.st, G.UNLOADING);
  assert.ok(G.orderShip(s, 0, nearBody(s).id).ok);
  assert.strictEqual(sh.st, G.TO_BODY);
});

console.log("score");
test("score counts materials delivered, bases built, sectors cleared and a time bonus", () => {
  const s = G.newGame(1);
  assert.strictEqual(G.scoreTotal(s), 0);
  const ore = nearBody(s);
  G.orderShip(s, 0, ore.id);
  for (let i = 0; i < 60 * 120 && s.stock.ore === G.START_STOCK.ore; i++) G.step(s, DT);
  assert.strictEqual(G.scoreTotal(s), 20 * G.TUNING.score.value.ore, "20 ore delivered");
  const before = G.scoreTotal(s);
  s.stock.ore = s.stock.ice = s.stock.crystal = 9999;
  const spot = legalSpot(s, 0);
  G.placeBase(s, spot.x, spot.y);
  assert.strictEqual(G.scoreTotal(s), before + G.TUNING.score.base);
  assert.strictEqual(s.score.sectors, 0);
});
test("clearing a sector scores once, with a bigger bonus later, and a time bonus for being quick", () => {
  const s = G.newGame(1);
  buildGoal(s);
  assert.strictEqual(s.score.sectors, G.TUNING.score.sector);
  assert.strictEqual(s.score.time, Math.floor(G.parTime(1) * G.TUNING.score.timePerSec), "instant clear gets the whole bonus");
  assert.strictEqual(s.cleared, 1);
  const total0 = G.scoreTotal(s);
  G.checkWin(s); G.checkWin(s);
  assert.strictEqual(G.scoreTotal(s), total0, "no double award");
  G.warpToNextSector(s);
  s.stock.ore = s.stock.ice = s.stock.crystal = 99999;
  const slow = G.newGame(1); run(slow, 1); slow.sectorTime = 1e6; buildGoal(slow);
  assert.strictEqual(slow.score.time, 0, "slow clear gets no time bonus");
  buildGoal(s);
  assert.strictEqual(s.score.sectors, G.TUNING.score.sector * 3, "sector 2 pays twice as much as sector 1: 400 + 800");
});
test("the score total is a whole number", () => {
  const s = G.newGame(1); s.score.mat = 12.7; s.score.bases = 100;
  assert.strictEqual(G.scoreTotal(s), 112);
});

console.log("run end");
test("retiring ends the run and freezes the game", () => {
  const s = G.newGame(1);
  G.orderShip(s, 0, nearBody(s).id);
  assert.ok(G.retire(s).ok);
  assert.ok(s.over && s.endReason === "retired");
  const t = s.time, x = s.ships[0].x;
  run(s, 5);
  assert.strictEqual(s.time, t); assert.strictEqual(s.ships[0].x, x);
  assert.ok(!G.retire(s).ok);
  assert.ok(!G.buildShip(s, "miner").ok);
});
test("stranded: nothing left to mine, nothing aboard, cannot afford a base", () => {
  const s = G.newGame(1);
  assert.ok(!G.isStranded(s));
  for (const b of s.bodies) b.amount = 0;
  s.stock.ore = 10;
  assert.ok(G.isStranded(s));
  s.stock.ore = s.stock.ice = s.stock.crystal = 500;
  assert.ok(!G.isStranded(s), "can still afford a base");
  s.stock.ore = 10;
  s.ships[0].cargo = 5; s.ships[0].res = "ore";
  assert.ok(!G.isStranded(s), "a ship still carries cargo");
  s.ships[0].cargo = 0;
  s.bodies[0].amount = 3;
  assert.ok(!G.isStranded(s), "a ship can still mine");
});
test("the run ends by itself when stranded, and a cleared sector is never stranded", () => {
  const s = G.newGame(1);
  for (const b of s.bodies) b.amount = 0;
  s.stock.ore = s.stock.ice = s.stock.crystal = 0;
  run(s, 3);
  assert.ok(s.over && s.endReason === "stranded");
  const w = G.newGame(1); buildGoal(w);
  for (const b of w.bodies) b.amount = 0;
  w.stock.ore = w.stock.ice = w.stock.crystal = 0;
  run(w, 3);
  assert.ok(!w.over, "can warp instead");
});
test("a normal game is not stranded while ships mine", () => {
  const s = G.newGame(2);
  for (const sh of s.ships) G.orderShip(s, sh.id, nearBody(s).id);
  run(s, 120);
  assert.ok(!s.over);
});

console.log("stars");
test("each sector has 3 to 6 stars, away from home and clear of bodies", () => {
  for (let n = 1; n <= 6; n++) for (let seed = 1; seed <= 15; seed++) {
    const s = G.newGame(seed, n), h = s.bases[0];
    assert.ok(s.stars.length >= 3 && s.stars.length <= 6, "n=" + n + " seed=" + seed + " has " + s.stars.length);
    for (const st of s.stars) {
      assert.ok(Math.hypot(st.x - h.x, st.y - h.y) >= 250, "star too near home");
      assert.ok(st.x > 0 && st.y > 0 && st.x < s.w && st.y < s.h && !st.taken);
      for (const b of s.bodies) assert.ok(Math.hypot(st.x - b.x, st.y - b.y) > b.r + 10);
    }
  }
});
test("stars are the same for the same seed, and do not move the bodies", () => {
  assert.deepStrictEqual(G.newGame(5).stars, G.newGame(5).stars);
  assert.notDeepStrictEqual(G.newGame(5).stars, G.newGame(6).stars);
});
test("a ship sent to a star picks it up and heads home", () => {
  const s = G.newGame(2), star = s.stars[0], sh = s.ships[0];
  const r = G.orderShipToStar(s, 0, star.id);
  assert.ok(r.ok);
  assert.strictEqual(sh.st, G.TO_STAR);
  assert.ok(/star/.test(G.jobText(s, sh)));
  for (let i = 0; i < 60 * 120 && !star.taken; i++) G.step(s, DT);
  assert.ok(star.taken);
  assert.strictEqual(s.starsGot, 1);
  assert.strictEqual(sh.st, G.TO_BASE);
  run(s, 120);
  assert.strictEqual(sh.st, G.IDLE);
  assert.ok(!G.orderShipToStar(s, 0, star.id).ok, "already taken");
  assert.ok(!G.orderShipToStar(s, 0, 99).ok);
  assert.ok(!G.orderShipToStar(s, 99, 0).ok);
});
test("two ships after one star: the second turns back, and the star counts once", () => {
  const s = G.newGame(2), star = s.stars[0];
  G.orderShipToStar(s, 0, star.id); G.orderShipToStar(s, 1, star.id);
  run(s, 200);
  assert.strictEqual(s.starsGot, 1);
  assert.ok(s.ships.every(sh => sh.st === G.IDLE));
});
test("a ship carrying cargo keeps it on the way to a star", () => {
  const s = G.newGame(2), sh = s.ships[0];
  sh.cargo = 10; sh.res = "ore"; sh.st = G.MINING; sh.target = nearBody(s).id;
  G.orderShipToStar(s, 0, s.stars[0].id);
  assert.strictEqual(sh.cargo, 10);
  const ore0 = s.stock.ore;
  run(s, 240);
  assert.strictEqual(s.stock.ore, ore0 + 10, "delivered after the star");
});
test("a recall or a new order cancels the trip to a star", () => {
  const s = G.newGame(2);
  G.orderShipToStar(s, 0, 0);
  G.recallShip(s, 0);
  assert.strictEqual(s.ships[0].star, -1);
  G.orderShipToStar(s, 1, 0);
  G.orderShip(s, 1, nearBody(s).id);
  assert.strictEqual(s.ships[1].st, G.TO_BODY); assert.strictEqual(s.ships[1].star, -1);
});
test("stars survive a save and load, with taken ones still taken", () => {
  const s = G.newGame(2);
  G.orderShipToStar(s, 0, 1);
  run(s, 200);
  assert.ok(s.stars[1].taken);
  const r = G.deserialize(G.serialize(s)).state;
  assert.deepStrictEqual(r.stars, s.stars);
  assert.strictEqual(r.starsGot, 1);
});

console.log("star bank and hangar");
test("a new profile has the free looks and no stars", () => {
  const p = G.newProfile();
  assert.strictEqual(p.stars, 0); assert.strictEqual(p.best, 0);
  for (const k of G.LOOK_KINDS) { assert.strictEqual(p.owned[k].length, 1); assert.strictEqual(G.lookById(k, p.pick[k]).cost, 0); }
});
test("the hangar offers enough: 4 ship colours, 4 base colours, 3 backgrounds, 2 trail styles to buy", () => {
  assert.ok(G.LOOKS.ship.length >= 4 && G.LOOKS.base.length >= 4 && G.LOOKS.bg.length >= 3 && G.LOOKS.trail.length >= 2);
  for (const k of G.LOOK_KINDS) {
    const ids = G.LOOKS[k].map(l => l.id);
    assert.strictEqual(new Set(ids).size, ids.length, "unique ids in " + k);
    assert.strictEqual(G.LOOKS[k][0].cost, 0, "first is free");
    for (const l of G.LOOKS[k]) assert.ok(l.name && l.cost >= 0);
  }
});
test("collecting stars fills the bank once each", () => {
  const p = G.newProfile(), s = G.newGame(2);
  s.stars[0].taken = true; s.stars[1].taken = true;
  assert.strictEqual(G.claimStars(p, s), 2);
  assert.strictEqual(p.stars, 2);
  assert.strictEqual(G.claimStars(p, s), 0, "not twice");
  s.stars[2].taken = true;
  assert.strictEqual(G.claimStars(p, s), 1);
  assert.strictEqual(p.stars, 3);
});
test("the bank survives new games and an old save cannot pay a star twice", () => {
  const p = G.newProfile();
  const a = G.newGame(2), saved = G.serialize(a);     // saved before the star was taken
  G.orderShipToStar(a, 0, 0); run(a, 200);
  assert.strictEqual(G.claimStars(p, a), 1);
  const b = G.deserialize(saved).state;               // load the old save: the star is back on the map
  assert.ok(!b.stars[0].taken);
  G.syncClaimed(b, p);
  assert.ok(b.stars[0].taken, "paid already, so it stays gone");
  assert.strictEqual(G.claimStars(p, b), 0);
  assert.strictEqual(G.claimStars(p, G.newGame(3)), 0, "a new game starts with nothing to claim");
  assert.strictEqual(p.stars, 1);
});
test("stars from different sectors of one run are different stars", () => {
  const p = G.newProfile(), s = G.newGame(2);
  s.stars[0].taken = true; G.claimStars(p, s);
  buildGoal(s); G.warpToNextSector(s);
  s.stars[0].taken = true;
  assert.strictEqual(G.claimStars(p, s), 1);
  assert.strictEqual(p.stars, 2);
});
test("a star pays once per save, to whoever took it, not again to another player", () => {
  const a = G.newProfile(), b = G.newProfile(), s = G.newGame(2);
  s.stars[0].taken = true; s.stars[1].taken = true;
  assert.strictEqual(G.claimStars(a, s), 2);
  assert.strictEqual(G.claimStars(b, s), 0, "same state object, other player");
  const t = G.deserialize(G.serialize(s)).state;     // saved and loaded by the other player
  G.syncClaimed(t, b);
  assert.strictEqual(G.claimStars(b, t), 0, "after serialize/deserialize");
  assert.strictEqual(b.stars, 0);
  t.stars[2].taken = true;
  assert.strictEqual(G.claimStars(b, t), 1, "a new star pays the current player");
  assert.strictEqual(G.claimStars(a, t), 0, "and not the first player afterwards");
  assert.strictEqual(b.stars, 1);
  assert.strictEqual(a.stars, 2);
});
test("a save without the paid-stars field still loads and does not pay its taken stars again", () => {
  const s = G.newGame(2); s.stars[0].taken = true;
  const raw = JSON.parse(G.serialize(s)); delete raw.starsPaid;
  const r = G.deserialize(JSON.stringify(raw));
  assert.ok(r.ok);
  assert.strictEqual(r.state.stars[0].taken, true);
  const p = G.newProfile();
  assert.strictEqual(G.claimStars(p, r.state), 0, "already paid under the old rules");
  r.state.stars[1].taken = true;
  assert.strictEqual(G.claimStars(p, r.state), 1);
  const bad = JSON.parse(G.serialize(s)); bad.starsPaid = "x";
  assert.ok(G.deserialize(JSON.stringify(bad)).ok, "a damaged field falls back, not fails");
});
test("player names and ids that are reserved words survive a reload", () => {
  const r = G.newRoster("2026-11-07T10:00:00.000Z");
  assert.ok(G.addPlayer(r, "constructor", "2026-11-07T10:00:00.000Z").ok);
  assert.ok(G.addPlayer(r, "__proto__", "2026-11-07T10:00:00.000Z").ok);
  assert.ok(G.addPlayer(r, "hasOwnProperty", "2026-11-07T10:00:00.000Z").ok);
  const back = G.parseRoster(G.serializeRoster(r), null, "2026-11-07T10:00:00.000Z");
  assert.ok(back.ok);
  assert.deepStrictEqual(back.roster.players.map(p => p.name), ["Player 1", "constructor", "__proto__", "hasOwnProperty"]);
  for (const bad of ["__proto__", "constructor", "hasOwnProperty", "toString"]) {
    const raw = JSON.parse(G.serializeRoster(r)); raw.current = bad;
    const q = G.parseRoster(JSON.stringify(raw), null, "2026-11-07T10:00:00.000Z");
    assert.ok(q.ok);
    assert.strictEqual(q.roster.current, q.roster.players[0].id, "current " + bad + " falls back to the first player");
  }
});
test("buying needs stars, charges once, and unlocks the item", () => {
  const p = G.newProfile();
  const item = G.LOOKS.ship[1];
  const poor = G.buyLook(p, "ship", item.id);
  assert.ok(!poor.ok && /stars/.test(poor.reason));
  p.stars = item.cost + 1;
  assert.ok(G.buyLook(p, "ship", item.id).ok);
  assert.strictEqual(p.stars, 1);
  assert.ok(p.owned.ship.indexOf(item.id) >= 0);
  assert.ok(!G.buyLook(p, "ship", item.id).ok, "no second charge");
  assert.strictEqual(p.stars, 1);
  assert.ok(!G.buyLook(p, "ship", "nope").ok);
  assert.ok(!G.buyLook(p, "wings", "x").ok);
});
test("a look can only be chosen once owned, and the choice is kept", () => {
  const p = G.newProfile(), item = G.LOOKS.bg[1];
  assert.ok(!G.chooseLook(p, "bg", item.id).ok);
  assert.strictEqual(p.pick.bg, G.LOOKS.bg[0].id);
  p.stars = 99; G.buyLook(p, "bg", item.id);
  assert.ok(G.chooseLook(p, "bg", item.id).ok);
  assert.strictEqual(G.currentLooks(p).bg.id, item.id);
  assert.ok(G.chooseLook(p, "bg", G.LOOKS.bg[0].id).ok, "can go back");
});
test("a few runs of stars unlock most of the hangar", () => {
  let all = 0;
  for (const k of G.LOOK_KINDS) for (const l of G.LOOKS[k]) all += l.cost;
  assert.ok(all <= 80, "everything costs " + all + " stars");
});
test("the profile round-trips, and damage is repaired or reported", () => {
  const p = G.newProfile();
  p.stars = 7; p.best = 1234; p.stars = 50;
  G.buyLook(p, "trail", "spark"); G.chooseLook(p, "trail", "spark"); G.buyLook(p, "ship", "crimson"); G.chooseLook(p, "ship", "crimson");
  const r = G.parseProfile(G.serializeProfile(p));
  assert.ok(r.ok);
  assert.deepStrictEqual(r.profile, p);
  assert.ok(G.parseProfile("").ok && G.parseProfile(null).ok, "nothing stored yet is fine");
  assert.ok(!G.parseProfile("{{").ok);
  assert.ok(!G.parseProfile("[1]").ok);
  assert.strictEqual(G.parseProfile("{{").profile.stars, 0);
  const bad = G.parseProfile(JSON.stringify({ stars: -4, best: "x", owned: { ship: ["classic", "ghost"] }, pick: { ship: "violet", bg: 5 }, claimed: [1, "a:1:0"] })).profile;
  assert.strictEqual(bad.stars, 0); assert.strictEqual(bad.best, 0);
  assert.deepStrictEqual(bad.owned.ship, ["classic"]);
  assert.strictEqual(bad.pick.ship, "classic", "cannot pick what is not owned");
  assert.strictEqual(bad.pick.bg, G.LOOKS.bg[0].id);
  assert.deepStrictEqual(bad.claimed, ["a:1:0"]);
});
test("the best score only goes up", () => {
  const p = G.newProfile();
  assert.ok(G.recordBest(p, 500) && p.best === 500);
  assert.ok(!G.recordBest(p, 400) && p.best === 500);
  assert.ok(!G.recordBest(p, 500));
  assert.ok(G.recordBest(p, 900.7) && p.best === 900);
});
test("stars buy looks only: no look carries any gameplay number", () => {
  for (const k of G.LOOK_KINDS) for (const l of G.LOOKS[k]) {
    for (const key of Object.keys(l)) assert.ok(["id", "name", "cost", "miner", "hauler", "main", "home", "top", "bottom", "blobs", "note"].indexOf(key) >= 0, key);
  }
});

console.log("old saves");
function oldSave() {   // what the first-playable version wrote
  const s = G.newGame(21);
  const raw = JSON.parse(G.serialize(s));
  raw.ver = 1;
  for (const k of ["sector", "sectorTime", "stars", "storms", "showers", "showerIn", "hz", "clearInfo", "over", "endReason", "endTimer", "score", "cleared", "starsGot", "hits"]) delete raw[k];
  delete raw.stats.lost;
  for (const b of raw.bases) delete b.tier;
  for (const sh of raw.ships) { delete sh.star; delete sh.wait; delete sh.hitCd; }
  return raw;
}
test("a save from first-playable loads as sector 1 with a notice, and plays on", () => {
  const raw = oldSave();
  raw.time = 55;
  const r = G.deserialize(JSON.stringify(raw));
  assert.ok(r.ok, r.error);
  assert.ok(/first version/.test(r.notice));
  const s = r.state;
  assert.strictEqual(s.sector, 1);
  assert.strictEqual(s.w, 1600);
  assert.ok(s.stars.length >= 3 && s.stars.length <= 6, "stars are made up");
  assert.deepStrictEqual(s.stars, G.newGame(21).stars);
  assert.strictEqual(s.bases[0].tier, 0);
  assert.strictEqual(s.storms.length, 0);
  assert.ok(!s.over);
  G.orderShip(s, 0, nearBody(s).id);
  G.orderShipToStar(s, 1, 0);
  run(s, 60);
  for (const sh of s.ships) assert.ok(isFinite(sh.x) && isFinite(sh.y));
  assert.ok(G.deserialize(G.serialize(s)).ok);
  assert.strictEqual(G.deserialize(G.serialize(s)).notice, undefined, "a current save has no notice");
});
test("an old save that had already won stays won and can warp", () => {
  const raw = oldSave();
  raw.won = true; raw.wonAt = 100;
  const s = G.deserialize(JSON.stringify(raw)).state;
  assert.ok(s.won);
  assert.ok(G.warpToNextSector(s).ok);
  assert.strictEqual(s.sector, 2);
  assert.strictEqual(s.cleared, 1);
  assert.strictEqual(s.score.sectors, G.TUNING.score.sector, "the cleared sector earns its points");
});
test("a save whose ship type is an inherited name is refused", () => {
  for (const type of ["constructor", "toString", "__proto__", "hasOwnProperty", 5, null]) {
    const raw = JSON.parse(G.serialize(G.newGame(3)));
    raw.ships[0].type = type;
    const r = G.deserialize(JSON.stringify(raw));
    assert.ok(!r.ok && /bad ship/.test(r.error), String(type));
  }
});
test("a damaged new-format save never throws", () => {
  const good = JSON.parse(G.serialize(G.newGame(3, 3)));
  const junk = [null, 5, "x", [], {}, NaN];
  for (const key of ["stars", "storms", "showers", "score", "clearInfo", "sector", "hz", "showerIn", "over", "cleared"]) {
    for (const v of junk) {
      const c = JSON.parse(JSON.stringify(good));
      c[key] = v;
      const r = G.deserialize(JSON.stringify(c));
      assert.ok(typeof r.ok === "boolean");
      if (r.ok) { run(r.state, 2); for (const sh of r.state.ships) assert.ok(isFinite(sh.x)); }
    }
  }
  const c = JSON.parse(JSON.stringify(good));
  c.sector = 1e9; c.bases[0].tier = 77; c.ships[0].star = 400; c.ships[0].st = 5; c.stars = [null, { x: "a" }];
  const r = G.deserialize(JSON.stringify(c));
  assert.ok(r.ok);
  assert.strictEqual(r.state.sector, 999);
  assert.strictEqual(r.state.bases[0].tier, G.MAX_TIER);
  assert.strictEqual(r.state.ships[0].st, G.TO_BASE, "a star trip to nowhere sends the ship home");
  run(r.state, 3);
});
test("sector, score and run state survive a round trip", () => {
  const s = G.newGame(14);
  buildGoal(s); G.warpToNextSector(s);
  s.stock.ore = s.stock.ice = s.stock.crystal = 5000; G.upgradeBase(s, 0);
  G.orderShipToStar(s, 0, 0);
  run(s, 30);
  G.retire(s);
  const r = G.deserialize(G.serialize(s)).state;
  assert.strictEqual(G.serialize(r), G.serialize(s));
  assert.ok(r.over && r.sector === 2 && r.cleared === 1 && r.bases[0].tier === 1);
});

console.log("stress");
test("spawnStress makes 30 ships, all busy, and the sim stays finite", () => {
  const s = G.spawnStress(G.newGame(7), 30);
  assert.strictEqual(s.ships.length, 30);
  assert.ok(s.ships.every(sh => sh.st === G.TO_BODY));
  run(s, 60);
  for (const sh of s.ships) assert.ok(isFinite(sh.x) && isFinite(sh.y) && sh.cargo <= G.SHIP_TYPES[sh.type].cap + 1e-9);
  assert.ok(s.stock.ore > G.START_STOCK.ore);
});
test("stepping 30 ships is cheap (well under a frame)", () => {
  const s = G.spawnStress(G.newGame(7), 30);
  const t0 = Date.now();
  for (let i = 0; i < 60 * 30; i++) G.step(s, DT);
  const ms = Date.now() - t0;
  assert.ok(ms < 1000, "30 simulated seconds took " + ms + " ms");
});

test("stepping 30 ships through storms and showers is cheap too", () => {
  const s = G.spawnStress(G.newGame(7, 5), 30);
  assert.ok(s.storms.length >= 4 && G.showersOn(s.sector));
  const t0 = Date.now();
  for (let i = 0; i < 60 * 60; i++) G.step(s, DT);
  const ms = Date.now() - t0;
  assert.ok(ms < 1500, "60 simulated seconds took " + ms + " ms");
  for (const sh of s.ships) assert.ok(isFinite(sh.x) && isFinite(sh.y) && sh.cargo <= G.SHIP_TYPES[sh.type].cap + 1e-9);
});

test("main.js writes no damaged-save backup in stress mode", () => {
  const src = require("fs").readFileSync(__dirname + "/main.js", "utf8");
  assert.ok(/function addBackup\(from, text\) \{\s*if \(STRESS\) return;/.test(src));
});

console.log("scoreboard, stats and purchase logs");
const NOW = "2026-11-07T10:00:00.000Z";
function mkRun(over) {
  return Object.assign({ key: "1:p1", player: "p1", at: NOW, score: 100, parts: { mat: 100, bases: 0, sectors: 0, time: 0 },
    sector: 1, cleared: 0, delivered: { ore: 10, ice: 0, crystal: 0 }, ships: 0, bases: 0, stars: 0, secs: 60, result: "retired" }, over || {});
}
function mkBuy(over) { return Object.assign({ player: "p1", at: NOW, kind: "ship", item: "crimson", name: "Crimson", cost: 2, left: 1 }, over || {}); }
const GARBAGE = [null, undefined, "", "   ", "{", "null", "[]", "42", "\"x\"", "{}", "true", 42, {}, [], "{\"players\":5}", "{\"runs\":{}}", "{\"buys\":\"no\"}",
  JSON.stringify({ runs: [null, 1, "x", [], {}, { key: 5 }] }), JSON.stringify({ players: [null, 1, {}, { id: 5 }] })];

test("tuning has the log limits", () => {
  assert.deepStrictEqual(G.TUNING.logs, { runs: 500, buys: 500, players: 50, nameMax: 24, minSecs: 5 });
});
test("delivered counts units by type, including the warp hand-in, and survives a save", () => {
  const s = G.newGame(3);
  assert.deepStrictEqual(s.delivered, { ore: 0, ice: 0, crystal: 0 });
  assert.deepStrictEqual(Object.keys(s).slice(-2), ["delivered", "starsPaid"], "delivered then starsPaid, added last in blankState");
  s.ships[0].res = "ice"; s.ships[0].cargo = 7;
  s.ships[1].res = "crystal"; s.ships[1].cargo = 3;
  buildGoal(s);
  G.warpToNextSector(s);
  assert.strictEqual(s.delivered.ice, 7);
  assert.strictEqual(s.delivered.crystal, 3);
  assert.strictEqual(s.delivered.ore, 0);
  const r = G.deserialize(G.serialize(s));
  assert.ok(r.ok);
  assert.deepStrictEqual(r.state.delivered, s.delivered);
  assert.strictEqual(G.VERSION, 2);
});
test("mining and unloading adds to delivered", () => {
  const s = G.newGame(5);
  G.orderShip(s, 0, nearBody(s).id);
  run(s, 90);
  assert.ok(s.delivered.ore > 0);
  assert.ok(Math.abs(s.delivered.ore - s.score.mat) < 1e-6, "ore only: units equal material points");
});
test("a save without delivered loads with zeros, and a bad value is clamped", () => {
  const o = JSON.parse(G.serialize(G.newGame(9)));
  delete o.delivered;
  let r = G.deserialize(JSON.stringify(o));
  assert.ok(r.ok);
  assert.deepStrictEqual(r.state.delivered, { ore: 0, ice: 0, crystal: 0 });
  o.delivered = { ore: "x", ice: -5, crystal: 4 };
  r = G.deserialize(JSON.stringify(o));
  assert.deepStrictEqual(r.state.delivered, { ore: 0, ice: 0, crystal: 4 });
  o.delivered = 7;
  assert.ok(G.deserialize(JSON.stringify(o)).ok);
});

test("a new roster has Player 1 with a fresh profile", () => {
  const r = G.newRoster(NOW);
  assert.strictEqual(r.players.length, 1);
  assert.strictEqual(r.current, "p1");
  assert.strictEqual(r.next, 2);
  assert.strictEqual(r.players[0].name, "Player 1");
  assert.strictEqual(r.players[0].created, NOW);
  assert.deepStrictEqual(r.players[0].profile, G.newProfile());
});
test("roster round trip", () => {
  const r = G.newRoster(NOW);
  G.addPlayer(r, "Ann", NOW); G.choosePlayer(r, "p2");
  r.players[1].profile.stars = 3; r.players[1].profile.best = 77;
  G.buyLook(r.players[1].profile, "ship", "crimson");
  const p = G.parseRoster(G.serializeRoster(r), null, NOW);
  assert.ok(p.ok && !p.migrated);
  assert.deepStrictEqual(p.roster, r);
});
test("empty roster text migrates the legacy bank once", () => {
  const bank = G.newProfile(); bank.stars = 6; bank.best = 900; G.buyLook(bank, "ship", "crimson");
  const text = G.serializeProfile(bank);
  for (const empty of [null, undefined, ""]) {
    const p = G.parseRoster(empty, text, NOW);
    assert.ok(p.ok && p.migrated);
    assert.deepStrictEqual(p.roster.players[0].profile, G.parseProfile(text).profile);
    assert.strictEqual(p.roster.players[0].profile.best, 900);
  }
  const again = G.parseRoster(G.serializeRoster(G.parseRoster(null, text, NOW).roster), text, NOW);
  assert.ok(again.ok && !again.migrated, "an existing roster is not migrated again");
  const none = G.parseRoster(null, null, NOW);
  assert.ok(none.ok && !none.migrated);
  assert.ok(!G.parseRoster(null, "{broken", NOW).migrated, "a damaged bank is not migrated");
  assert.ok(!G.parseRoster(null, "   ", NOW).migrated);
});
test("a damaged roster gives ok false, a fresh roster, and no re-migration", () => {
  const bank = G.serializeProfile(Object.assign(G.newProfile(), { stars: 9 }));
  for (const t of ["{oops", "[]", "{\"players\":[]}", "{\"players\":[1,null,{}]}", "\"x\"", 12]) {
    const p = G.parseRoster(t, bank, NOW);
    assert.strictEqual(p.ok, false, String(t));
    assert.ok(p.error);
    assert.strictEqual(p.migrated, false);
    assert.strictEqual(p.roster.players.length, 1);
    assert.strictEqual(p.roster.players[0].profile.stars, 0);
  }
});
test("parseRoster rebuilds players field by field", () => {
  const raw = { ver: 1, current: "zz", next: "x", players: [
    null, { id: 3 }, { id: "p4", name: "  Bo\u0000b\n ", created: 5, profile: { stars: "9", best: 12, owned: { ship: ["crimson", "nope"] }, pick: { ship: "crimson" }, junk: 1 }, extra: 1 },
    { id: "p4", name: "dup id" }, { id: "p7", name: "bob" }, { id: "p8", name: "x".repeat(60) }, { id: "p9" }] };
  const p = G.parseRoster(JSON.stringify(raw), null, NOW);
  assert.ok(p.ok);
  const r = p.roster;
  assert.deepStrictEqual(r.players.map(x => x.id), ["p4", "p7", "p8", "p9"]);
  assert.strictEqual(r.players[0].name, "Bo b");
  assert.strictEqual(r.players[0].created, "");
  assert.strictEqual(r.players[0].extra, undefined);
  assert.strictEqual(r.players[0].profile.stars, 0);
  assert.strictEqual(r.players[0].profile.best, 12);
  assert.deepStrictEqual(r.players[0].profile.owned.ship, ["classic", "crimson"]);
  assert.strictEqual(r.players[0].profile.pick.ship, "crimson");
  assert.notStrictEqual(r.players[1].name.toLowerCase(), r.players[0].name.toLowerCase(), "duplicate names are made unique");
  assert.strictEqual(r.players[2].name.length, G.TUNING.logs.nameMax);
  assert.strictEqual(r.players[3].name, "Player 9");
  assert.strictEqual(r.current, "p4", "unknown current falls back to the first player");
  assert.strictEqual(r.next, 10);
  assert.strictEqual(Object.keys(r.players[0]).join(), "id,name,created,profile");
});
test("parseRoster keeps at most 50 players", () => {
  const players = []; for (let i = 1; i <= 80; i++) players.push({ id: "p" + i, name: "N" + i });
  const p = G.parseRoster(JSON.stringify({ ver: 1, current: "p2", next: 81, players }), null, NOW);
  assert.ok(p.ok);
  assert.strictEqual(p.roster.players.length, 50);
  assert.strictEqual(p.roster.current, "p2");
});
test("currentPlayer is always valid", () => {
  const r = G.newRoster(NOW);
  r.current = "gone";
  assert.strictEqual(G.currentPlayer(r).id, "p1");
  assert.strictEqual(r.current, "p1");
  r.players = [];
  assert.ok(G.currentPlayer(r).profile);
});
test("addPlayer: trims, checks length, unique ignoring case, max players, does not switch", () => {
  const r = G.newRoster(NOW);
  const a = G.addPlayer(r, "  Ann  ", NOW);
  assert.ok(a.ok);
  assert.strictEqual(a.player.name, "Ann");
  assert.strictEqual(a.player.id, "p2");
  assert.strictEqual(a.player.created, NOW);
  assert.strictEqual(r.current, "p1");
  assert.strictEqual(r.next, 3);
  for (const bad of ["", "   ", "ANN", "player 1", "x".repeat(25), null, 5, undefined, "\u0001\u0002"]) {
    const x = G.addPlayer(r, bad, NOW);
    assert.strictEqual(x.ok, false, String(bad));
    assert.ok(x.reason);
  }
  assert.ok(G.addPlayer(r, "x".repeat(24), NOW).ok);
  assert.strictEqual(G.addPlayer(r, "a\u0000b", NOW).player.name, "a b");
  while (r.players.length < 50) assert.ok(G.addPlayer(r, "P" + r.players.length + "x", NOW).ok);
  const full = G.addPlayer(r, "One more", NOW);
  assert.strictEqual(full.ok, false);
  assert.strictEqual(r.players.length, 50);
  assert.strictEqual(new Set(r.players.map(p => p.id)).size, 50);
});
test("renamePlayer and choosePlayer", () => {
  const r = G.newRoster(NOW);
  G.addPlayer(r, "Ann", NOW);
  assert.ok(G.renamePlayer(r, "p1", "PLAYER 1").ok, "own name may change case");
  assert.strictEqual(r.players[0].name, "PLAYER 1");
  assert.strictEqual(G.renamePlayer(r, "p1", "ann").ok, false);
  assert.strictEqual(G.renamePlayer(r, "p1", "").ok, false);
  assert.strictEqual(G.renamePlayer(r, "p1", "y".repeat(25)).ok, false);
  assert.strictEqual(G.renamePlayer(r, "nope", "Zed").ok, false);
  assert.strictEqual(r.players[0].name, "PLAYER 1");
  assert.ok(G.choosePlayer(r, "p2").ok);
  assert.strictEqual(G.currentPlayer(r).name, "Ann");
  const bad = G.choosePlayer(r, "nope");
  assert.strictEqual(bad.ok, false);
  assert.ok(bad.reason);
  assert.strictEqual(r.current, "p2");
});

test("run and purchase logs start empty and round trip", () => {
  const rl = G.newRunLog(); G.addRun(rl, mkRun());
  const p = G.parseRunLog(G.serializeRunLog(rl));
  assert.ok(p.ok); assert.strictEqual(p.dropped, 0);
  assert.deepStrictEqual(p.log, rl);
  const bl = G.newBuyLog(); G.addBuy(bl, mkBuy());
  const q = G.parseBuyLog(G.serializeBuyLog(bl));
  assert.ok(q.ok); assert.strictEqual(q.dropped, 0);
  assert.deepStrictEqual(q.log, bl);
  for (const e of [null, undefined, "", "  "]) {
    assert.deepStrictEqual(G.parseRunLog(e), { ok: true, log: { ver: 1, runs: [] }, dropped: 0 });
    assert.deepStrictEqual(G.parseBuyLog(e), { ok: true, log: { ver: 1, buys: [] }, dropped: 0 });
  }
});
test("parsers never throw and give ok false with an empty log for bad shapes", () => {
  for (const g of GARBAGE) {
    const a = G.parseRunLog(g), b = G.parseBuyLog(g), c = G.parseRoster(g, g, NOW);
    assert.ok(Array.isArray(a.log.runs) && Array.isArray(b.log.buys) && c.roster.players.length >= 1);
    if (!a.ok) { assert.ok(a.error); assert.strictEqual(a.log.runs.length, 0); }
    if (!b.ok) { assert.ok(b.error); assert.strictEqual(b.log.buys.length, 0); }
  }
  for (const t of ["{", "[]", "42", "{\"runs\":{}}", 7]) {
    assert.strictEqual(G.parseRunLog(t).ok, false);
    assert.strictEqual(G.parseBuyLog(t).ok, false);
  }
});
test("parseRunLog drops bad entries one by one and rebuilds the good ones", () => {
  const good = mkRun({ key: "2:p1", score: 55.9, junk: 1, delivered: { ore: 3, ice: "x", crystal: -2 }, parts: { mat: 5, aliens: 20, bad: "x", nan: null } });
  const txt = JSON.stringify({ ver: 1, runs: [null, 5, "s", good, mkRun({ key: "" }), mkRun({ result: "Retired" }), mkRun({ result: "x".repeat(17) }),
    mkRun({ score: "5" }), mkRun({ player: 3 }), mkRun({ key: "3:p1" })] });
  const p = G.parseRunLog(txt);
  assert.ok(p.ok);
  assert.strictEqual(p.dropped, 8);
  assert.strictEqual(p.log.runs.length, 2);
  const r = p.log.runs[0];
  assert.strictEqual(r.junk, undefined);
  assert.strictEqual(r.score, 55);
  assert.deepStrictEqual(r.delivered, { ore: 3, ice: 0, crystal: 0 });
  assert.deepStrictEqual(r.parts, { mat: 5, aliens: 20 });
  assert.strictEqual(Object.keys(r).join(), "key,player,at,score,parts,sector,cleared,delivered,ships,bases,stars,secs,result");
});
test("parseRunLog collapses a repeated key and keeps the newest 500", () => {
  const runs = []; for (let i = 0; i < 700; i++) runs.push(mkRun({ key: i + ":p1", score: i }));
  const p = G.parseRunLog(JSON.stringify({ runs }));
  assert.strictEqual(p.log.runs.length, 500);
  assert.strictEqual(p.log.runs[0].key, "200:p1");
  assert.strictEqual(p.log.runs[499].key, "699:p1");
  assert.strictEqual(p.dropped, 200);
  const d = G.parseRunLog(JSON.stringify({ runs: [mkRun({ score: 1 }), mkRun({ key: "k", score: 2 }), mkRun({ score: 3 })] }));
  assert.deepStrictEqual(d.log.runs.map(r => r.score), [3, 2]);
});
test("parseBuyLog drops bad entries and keeps the newest 500", () => {
  const p = G.parseBuyLog(JSON.stringify({ buys: [mkBuy(), null, mkBuy({ kind: "nope" }), mkBuy({ item: 4 }), mkBuy({ cost: "2" }), mkBuy({ player: "" }), mkBuy({ junk: 1, name: 5 })] }));
  assert.ok(p.ok);
  assert.strictEqual(p.dropped, 5);
  assert.strictEqual(p.log.buys.length, 2);
  assert.strictEqual(p.log.buys[1].name, "crimson", "a missing name falls back to the item id");
  assert.strictEqual(p.log.buys[1].junk, undefined);
  const buys = []; for (let i = 0; i < 900; i++) buys.push(mkBuy({ left: i }));
  const q = G.parseBuyLog(JSON.stringify({ buys }));
  assert.strictEqual(q.log.buys.length, 500);
  assert.strictEqual(q.log.buys[0].left, 400);
});
test("huge arrays parse without throwing", () => {
  const runs = new Array(200000).fill(5);
  const p = G.parseRunLog(JSON.stringify({ runs }));
  assert.ok(p.ok); assert.strictEqual(p.log.runs.length, 0); assert.strictEqual(p.dropped, 200000);
  const r = G.parseRoster(JSON.stringify({ players: new Array(100000).fill(null) }), null, NOW);
  assert.strictEqual(r.ok, false);
});

test("shouldLogRun: not for stress, not for a blink-and-gone empty run", () => {
  const s = G.newGame(1);
  assert.strictEqual(G.shouldLogRun(s), false, "0 s and 0 points");
  s.time = 4.9;
  assert.strictEqual(G.shouldLogRun(s), false);
  s.time = 5;
  assert.strictEqual(G.shouldLogRun(s), true);
  s.time = 1; s.score.mat = 3;
  assert.strictEqual(G.shouldLogRun(s), true, "points count even in a short run");
  s.stress = true; s.time = 600;
  assert.strictEqual(G.shouldLogRun(s), false);
  assert.strictEqual(G.shouldLogRun(G.spawnStress(G.newGame(2), 12)), false);
});
test("runRecord copies the state and is pure", () => {
  const s = G.newGame(11);
  G.addShip(s, "miner"); G.addShip(s, "hauler");
  s.time = 125.9; s.sector = 3; s.cleared = 2; s.starsGot = 4;
  s.score = { mat: 250.5, bases: 300, sectors: 800, time: 40, aliens: 60 };
  s.score.bad = NaN; s.score.nope = "x";
  s.delivered = { ore: 100.4, ice: 20, crystal: 3 };
  const before = G.serialize(s);
  const r = G.runRecord(s, "p3", "stranded", NOW);
  assert.strictEqual(G.serialize(s), before, "state untouched");
  assert.strictEqual(r.key, "11:p3");
  assert.strictEqual(r.player, "p3");
  assert.strictEqual(r.at, NOW);
  assert.strictEqual(r.score, G.scoreTotal(s));
  assert.deepStrictEqual(r.parts, { mat: 250.5, bases: 300, sectors: 800, time: 40, aliens: 60 });
  assert.strictEqual(r.sector, 3); assert.strictEqual(r.cleared, 2);
  assert.deepStrictEqual(r.delivered, { ore: 100, ice: 20, crystal: 3 });
  assert.strictEqual(r.ships, 2); assert.strictEqual(r.bases, 3);
  assert.strictEqual(r.stars, 4); assert.strictEqual(r.secs, 125);
  assert.strictEqual(r.result, "stranded");
  assert.strictEqual(G.runRecord(G.newGame(1), "p1", "destroyed", NOW).result, "destroyed");
  assert.strictEqual(G.runRecord(G.newGame(1), "p1", "", NOW).ships, 0);
  assert.ok(/^[a-z]{1,16}$/.test(G.runRecord(G.newGame(1), "p1", "Bad Word 9!!", NOW).result));
  assert.ok(/^[a-z]{1,16}$/.test(G.runRecord(G.newGame(1), "p1", null, NOW).result));
  const log = G.addRun(G.newRunLog(), r);
  assert.ok(G.parseRunLog(G.serializeRunLog(log)).log.runs[0].parts.aliens === 60, "extra parts survive a reload");
});
test("addRun replaces the same key in place, appends otherwise, trims the oldest", () => {
  const log = G.newRunLog();
  G.addRun(log, mkRun({ key: "a:p1", score: 1 }));
  G.addRun(log, mkRun({ key: "b:p1", score: 2 }));
  assert.strictEqual(G.addRun(log, mkRun({ key: "a:p1", score: 9 })), log);
  assert.deepStrictEqual(log.runs.map(r => r.key + "=" + r.score), ["a:p1=9", "b:p1=2"]);
  G.addRun(log, mkRun({ key: "a:p2", score: 4 }));
  assert.strictEqual(log.runs.length, 3, "same seed, other player is a different run");
  for (let i = 0; i < 600; i++) G.addRun(log, mkRun({ key: "n" + i + ":p1" }));
  assert.strictEqual(log.runs.length, 500);
  assert.strictEqual(log.runs[499].key, "n599:p1");
  assert.strictEqual(log.runs[0].key, "n100:p1");
});
test("buyRecord takes the name from the hangar and addBuy caps at 500", () => {
  const b = G.buyRecord("p2", "bg", "aurora", 4, 1, NOW);
  assert.deepStrictEqual(b, { player: "p2", at: NOW, kind: "bg", item: "aurora", name: "Aurora", cost: 4, left: 1 });
  assert.strictEqual(G.buyRecord("p2", "nope", "x", 1, 0, NOW).name, "x");
  const log = G.newBuyLog();
  for (let i = 0; i < 520; i++) G.addBuy(log, mkBuy({ left: i }));
  assert.strictEqual(log.buys.length, 500);
  assert.strictEqual(log.buys[0].left, 20);
  assert.strictEqual(log.buys[499].left, 519);
});
test("playerRuns and playerBuys are newest first and per player", () => {
  const rl = G.newRunLog(), bl = G.newBuyLog();
  G.addRun(rl, mkRun({ key: "1:p1", score: 1 })); G.addRun(rl, mkRun({ key: "1:p2", player: "p2", score: 2 })); G.addRun(rl, mkRun({ key: "2:p1", score: 3 }));
  assert.deepStrictEqual(G.playerRuns(rl, "p1").map(r => r.score), [3, 1]);
  assert.deepStrictEqual(G.playerRuns(rl, "zz"), []);
  G.addBuy(bl, mkBuy({ left: 5 })); G.addBuy(bl, mkBuy({ player: "p2", left: 6 })); G.addBuy(bl, mkBuy({ left: 7 }));
  assert.deepStrictEqual(G.playerBuys(bl, "p1").map(b => b.left), [7, 5]);
  assert.strictEqual(rl.runs.length, 3, "the log itself is not reordered");
});

function scoreFixture() {
  const r = G.newRoster(NOW);
  G.addPlayer(r, "Ann", NOW); G.addPlayer(r, "Cy", NOW);
  const rl = G.newRunLog();
  G.addRun(rl, mkRun({ key: "1:p1", score: 500, sector: 2, stars: 1, secs: 100, delivered: { ore: 10, ice: 5, crystal: 1 } }));
  G.addRun(rl, mkRun({ key: "2:p1", score: 300, sector: 4, stars: 2, secs: 50, delivered: { ore: 1, ice: 1, crystal: 1 } }));
  G.addRun(rl, mkRun({ key: "1:p2", player: "p2", score: 500, sector: 1, stars: 0, secs: 10, delivered: { ore: 20, ice: 0, crystal: 0 } }));
  r.players[2].profile.best = 800; r.players[2].profile.stars = 4;
  return { r, rl };
}
test("playerTotals gives one row per player, with best from the profile or the log", () => {
  const { r, rl } = scoreFixture();
  const rows = G.playerTotals(r, rl);
  assert.deepStrictEqual(rows.map(x => x.id), ["p1", "p2", "p3"]);
  assert.deepStrictEqual(rows[0], { id: "p1", name: "Player 1", best: 500, runs: 2, bestSector: 4,
    delivered: { ore: 11, ice: 6, crystal: 2, all: 19 }, stars: 3, bank: 0, secs: 150 });
  assert.strictEqual(rows[1].best, 500);
  assert.strictEqual(rows[2].best, 800, "profile best with no logged run");
  assert.strictEqual(rows[2].runs, 0);
  assert.strictEqual(rows[2].bank, 4);
  r.players[0].profile.best = 9999;
  assert.strictEqual(G.playerTotals(r, rl)[0].best, 9999);
});
test("rankPlayers sorts by column and direction with tie-breaks, on a copy", () => {
  const { r, rl } = scoreFixture();
  const rows = G.playerTotals(r, rl), copy = rows.slice();
  assert.deepStrictEqual(G.rankPlayers(rows, "best", "desc").map(x => x.id), ["p3", "p2", "p1"], "tie 500 goes to the name Ann first");
  assert.deepStrictEqual(rows, copy);
  assert.notStrictEqual(G.rankPlayers(rows, "best", "desc"), rows);
  assert.deepStrictEqual(G.rankPlayers(rows, "name", "asc").map(x => x.name), ["Ann", "Cy", "Player 1"]);
  assert.deepStrictEqual(G.rankPlayers(rows, "name", "desc").map(x => x.name), ["Player 1", "Cy", "Ann"]);
  assert.deepStrictEqual(G.rankPlayers(rows, "runs", "desc").map(x => x.id), ["p1", "p2", "p3"]);
  assert.deepStrictEqual(G.rankPlayers(rows, "runs", "asc").map(x => x.id), ["p3", "p2", "p1"]);
  assert.deepStrictEqual(G.rankPlayers(rows, "bestSector", "desc").map(x => x.id), ["p1", "p2", "p3"]);
  assert.deepStrictEqual(G.rankPlayers(rows, "delivered", "desc").map(x => x.id), ["p2", "p1", "p3"]);
  assert.deepStrictEqual(G.rankPlayers(rows, "stars", "asc").map(x => x.id), ["p3", "p2", "p1"]);
  assert.deepStrictEqual(G.rankPlayers(rows, "nonsense", "desc").map(x => x.id), ["p3", "p2", "p1"], "unknown column ranks by best");
});
test("rank ties: equal on the column go to best desc, then name", () => {
  const rows = [
    { id: "a", name: "Zed", best: 10, runs: 1, bestSector: 1, delivered: { all: 5 }, stars: 0 },
    { id: "b", name: "amy", best: 10, runs: 1, bestSector: 1, delivered: { all: 5 }, stars: 0 },
    { id: "c", name: "Bob", best: 99, runs: 1, bestSector: 1, delivered: { all: 5 }, stars: 0 }];
  assert.deepStrictEqual(G.rankPlayers(rows, "runs", "asc").map(x => x.id), ["c", "b", "a"]);
  assert.deepStrictEqual(G.rankPlayers(rows, "runs", "desc").map(x => x.id), ["c", "b", "a"]);
  assert.deepStrictEqual(G.rankPlayers(rows, "best", "asc").map(x => x.id), ["b", "a", "c"]);
});
test("topRuns: by score, earlier first on a tie, default 10", () => {
  const log = G.newRunLog();
  for (let i = 0; i < 15; i++) G.addRun(log, mkRun({ key: i + ":p1", score: i * 10, at: "2026-01-" + String(10 + i) }));
  G.addRun(log, mkRun({ key: "t1:p1", score: 140, at: "2026-02-01" }));
  G.addRun(log, mkRun({ key: "t0:p1", score: 140, at: "2026-01-05" }));
  const top = G.topRuns(log);
  assert.strictEqual(top.length, 10);
  assert.deepStrictEqual(top.slice(0, 3).map(r => r.key), ["t0:p1", "14:p1", "t1:p1"]);
  assert.strictEqual(G.topRuns(log, 3).length, 3);
  assert.strictEqual(G.topRuns(log, 0).length, 0);
  assert.strictEqual(log.runs.length, 17, "log not reordered");
});
test("clearPlayerData removes runs, purchases and best, keeps the rest", () => {
  const { r, rl } = scoreFixture();
  const bl = G.newBuyLog();
  G.addBuy(bl, mkBuy()); G.addBuy(bl, mkBuy({ player: "p2" })); G.addBuy(bl, mkBuy({ left: 0 }));
  const p = r.players[0].profile;
  p.stars = 5; p.best = 700; G.buyLook(p, "base", "amber"); G.chooseLook(p, "base", "amber"); p.claimed.push("1:1:0");
  const res = G.clearPlayerData(r, rl, bl, "p1");
  assert.deepStrictEqual(res, { ok: true, runs: 2, buys: 2 });
  assert.deepStrictEqual(rl.runs.map(x => x.player), ["p2"]);
  assert.deepStrictEqual(bl.buys.map(x => x.player), ["p2"]);
  assert.strictEqual(p.best, 0);
  assert.strictEqual(p.stars, 3);
  assert.deepStrictEqual(p.owned.base, ["teal", "amber"]);
  assert.strictEqual(p.pick.base, "amber");
  assert.deepStrictEqual(p.claimed, ["1:1:0"]);
  assert.strictEqual(r.players.length, 3);
  assert.strictEqual(r.players[0].name, "Player 1");
  assert.strictEqual(G.playerTotals(r, rl)[0].best, 0);
  assert.deepStrictEqual(G.clearPlayerData(r, rl, bl, "p1"), { ok: true, runs: 0, buys: 0 });
  const no = G.clearPlayerData(r, rl, bl, "zz");
  assert.strictEqual(no.ok, false); assert.ok(no.reason);
  assert.strictEqual(rl.runs.length, 1);
});
test("exportLogs has the documented shape", () => {
  const { r, rl } = scoreFixture();
  const bl = G.newBuyLog(); G.addBuy(bl, mkBuy());
  const text = G.exportLogs(r, rl, bl, "2026-11-08T00:00:00.000Z");
  assert.strictEqual(typeof text, "string");
  const o = JSON.parse(text);
  assert.deepStrictEqual(Object.keys(o), ["app", "kind", "ver", "exported", "players", "runs", "purchases"]);
  assert.strictEqual(o.app, "fleet"); assert.strictEqual(o.kind, "fleet-logs"); assert.strictEqual(o.ver, 1);
  assert.strictEqual(o.exported, "2026-11-08T00:00:00.000Z");
  assert.deepStrictEqual(o.players[2], { id: "p3", name: "Cy", created: NOW, best: 800, bank: 4 });
  assert.deepStrictEqual(o.players[0], { id: "p1", name: "Player 1", created: NOW, best: 500, bank: 0 });
  assert.strictEqual(o.players.length, 3);
  assert.deepStrictEqual(o.runs, rl.runs);
  assert.deepStrictEqual(o.purchases, bl.buys);
});
test("the new log code uses no DOM, Date, localStorage or Math.random", () => {
  const src = require("fs").readFileSync(__dirname + "/game.js", "utf8");
  const i = src.indexOf("players, run log, purchase log");
  const part = src.slice(i, src.indexOf("return {", i));
  assert.ok(i > 0 && !/document|window|localStorage|Date|Math\.random/.test(part));
});

console.log("\n" + passed + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
