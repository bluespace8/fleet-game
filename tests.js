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

// ---------------------------------------------------------------- feedback form
console.log("feedback");
const FB_DATE = new Date(Date.UTC(2026, 10, 7, 22, 45, 1, 123));
const fbOk = { type: "bug", rating: 4, message: "  The warp button is stuck.  " };
const fbMake = (over, info) => G.makeFeedback(Object.assign({}, fbOk, over), info === undefined ? null : info, FB_DATE, () => 0.5);

test("feedback constants match the shared contract", () => {
  assert.strictEqual(G.FEEDBACK_SCHEMA, "fleet-feedback/1");
  assert.deepStrictEqual(G.FEEDBACK_TYPES, ["bug", "idea", "balance", "other"]);
  assert.strictEqual(G.FEEDBACK_MAX, 2000);
  assert.strictEqual(G.FEEDBACK_URL, "http://127.0.0.1:8765/api/feedback");
  assert.strictEqual(G.FEEDBACK_TIMEOUT_MS, 5000);
  assert.strictEqual(G.GAME_VERSION, "first-playable");
});
test("a good feedback input validates, with or without a rating", () => {
  assert.deepStrictEqual(G.validateFeedback(fbOk), { ok: true });
  for (const r of [null, undefined, "", 1, 5, "3", " 2 "]) assert.strictEqual(G.validateFeedback({ type: "idea", rating: r, message: "x" }).ok, true, String(r));
  assert.strictEqual(G.validateFeedback({ type: "other", message: "x".repeat(2000) }).ok, true);
});
test("an empty or whitespace-only message is refused", () => {
  for (const m of ["", "   ", "\n\t ", undefined, null, 5]) {
    const r = G.validateFeedback({ type: "bug", rating: null, message: m });
    assert.strictEqual(r.ok, false); assert.strictEqual(r.field, "message"); assert.ok(r.reason.length > 0);
  }
});
test("a message over 2000 characters is refused, 2000 after trimming is fine", () => {
  const r = G.validateFeedback({ type: "bug", message: "x".repeat(2001) });
  assert.strictEqual(r.ok, false); assert.strictEqual(r.field, "message");
  assert.strictEqual(G.validateFeedback({ type: "bug", message: "  " + "x".repeat(2000) + "  " }).ok, true);
});
test("a bad type is refused", () => {
  for (const t of ["", "Bug", "praise", undefined, null, 3]) {
    const r = G.validateFeedback({ type: t, message: "x" });
    assert.strictEqual(r.ok, false); assert.strictEqual(r.field, "type");
  }
  assert.strictEqual(G.validateFeedback(null).ok, false);
});
test("a bad rating is refused (0, 6, 2.5, text, negative)", () => {
  for (const v of [0, 6, 2.5, "x", "2.5", -1, "0", "6", NaN, Infinity, true, {}]) {
    const r = G.validateFeedback({ type: "bug", rating: v, message: "x" });
    assert.strictEqual(r.ok, false, String(v)); assert.strictEqual(r.field, "rating");
  }
});
test("game info with no game has only the version and the user agent", () => {
  assert.deepStrictEqual(G.feedbackGameInfo(null, { userAgent: "UA/1" }), { version: "first-playable", userAgent: "UA/1" });
  assert.deepStrictEqual(G.feedbackGameInfo(null, null), { version: "first-playable" });
});
test("game info reads sector, score, ships and whole played seconds", () => {
  const s = G.newGame(3, 2);
  s.time = 612.9;
  const i = G.feedbackGameInfo(s, { userAgent: "UA" });
  assert.strictEqual(i.sector, 2); assert.strictEqual(i.score, G.scoreTotal(s));
  assert.strictEqual(i.ships, s.ships.length); assert.strictEqual(i.playedSeconds, 612);
  assert.deepStrictEqual(Object.keys(i), ["version", "sector", "score", "ships", "playedSeconds", "userAgent"]);
});
test("game info cuts strings to 200 characters and drops non-finite numbers", () => {
  const s = G.newGame(3);
  s.time = NaN; s.sector = Infinity;
  const i = G.feedbackGameInfo(s, { userAgent: "u".repeat(500) });
  assert.strictEqual(i.userAgent.length, 200);
  assert.ok(!("playedSeconds" in i) && !("sector" in i));
  assert.ok("score" in i && "ships" in i);
});
test("feedbackId has the expected shape, is UTC, and always passes the dashboard pattern", () => {
  assert.strictEqual(G.feedbackId(FB_DATE, () => 0), "fb-20261107-224501-000000");
  assert.strictEqual(G.feedbackId(FB_DATE, () => 0.9999999), "fb-20261107-224501-zzzzzz");
  for (const r of [() => -1, () => NaN, () => 5, Math.random]) assert.ok(/^[A-Za-z0-9-]{8,64}$/.test(G.feedbackId(FB_DATE, r)));
  assert.ok(/^fb-\d{8}-\d{6}-[0-9a-z]{6}$/.test(G.feedbackId()));
  const seq = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6]; let k = 0;
  assert.strictEqual(G.feedbackId(FB_DATE, () => seq[k++]), "fb-20261107-224501-37aeil");
});
test("makeFeedback builds exactly the contract keys in order, trims, and keeps a null rating", () => {
  const r = fbMake({});
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(Object.keys(r.payload), ["schema", "id", "created", "type", "rating", "message", "gameInfo"]);
  assert.strictEqual(r.payload.schema, "fleet-feedback/1");
  assert.strictEqual(r.payload.created, "2026-11-07T22:45:01.123Z");
  assert.strictEqual(r.payload.message, "The warp button is stuck.");
  assert.strictEqual(r.payload.rating, 4); assert.strictEqual(r.payload.gameInfo, null);
  assert.strictEqual(fbMake({ rating: "" }).payload.rating, null);
  assert.strictEqual(fbMake({ rating: undefined }).payload.rating, null);
  assert.strictEqual(fbMake({ rating: "3" }).payload.rating, 3);
  const info = { version: "first-playable", ships: 2 };
  assert.deepStrictEqual(fbMake({}, info).payload.gameInfo, info);
});
test("makeFeedback passes the validation failure through and makes no payload", () => {
  const r = fbMake({ message: " " });
  assert.strictEqual(r.ok, false); assert.strictEqual(r.field, "message"); assert.ok(!("payload" in r));
});
test("feedbackReply: 200 ok is sent, duplicate or not", () => {
  const a = G.feedbackReply(200, '{"ok":true,"file":"x.json","duplicate":false}');
  const b = G.feedbackReply(200, '{"ok":true,"file":"x.json","duplicate":true}');
  assert.strictEqual(a.sent, true); assert.strictEqual(a.duplicate, false);
  assert.strictEqual(b.sent, true); assert.strictEqual(b.duplicate, true);
  assert.strictEqual(a.message, "Sent to the team; the lead will draft a plan for your approval");
});
test("feedbackReply: 400, 403 and 413 show the server's message and do not retry", () => {
  for (const st of [400, 403, 413]) {
    const r = G.feedbackReply(st, JSON.stringify({ ok: false, message: "No: " + st }));
    assert.deepStrictEqual(r, { sent: false, retry: false, message: "No: " + st });
  }
});
test("feedbackReply: 429 and 5xx can be retried later", () => {
  assert.deepStrictEqual(G.feedbackReply(429, '{"ok":false,"message":"Inbox full"}'), { sent: false, retry: true, message: "Inbox full" });
  assert.deepStrictEqual(G.feedbackReply(500, "{}"), { sent: false, retry: true, message: "Dashboard replied 500" });
  assert.strictEqual(G.feedbackReply(503, "").retry, true);
});
test("feedbackReply never throws on bad bodies and does not call a 200 without ok:true sent", () => {
  for (const body of ["", "not json", "null", "[1]", "42", undefined, null, '{"ok":false}', '{"message":5}']) {
    const r = G.feedbackReply(400, body);
    assert.strictEqual(r.sent, false); assert.strictEqual(typeof r.message, "string");
  }
  assert.strictEqual(G.feedbackReply(200, "oops").sent, false);
  assert.strictEqual(G.feedbackReply(200, '{"ok":"yes"}').sent, false);
  assert.strictEqual(G.feedbackReply(400, "oops").message, "Dashboard replied 400");
});
test("newFeedbackEntry starts not sent", () => {
  const p = fbMake({}).payload;
  assert.deepStrictEqual(G.newFeedbackEntry(p), { payload: p, sent: false, sentAt: null, lastError: null });
});
test("the stored list survives a round trip, newest first", () => {
  const mk = (sec, over) => G.newFeedbackEntry(G.makeFeedback(Object.assign({}, fbOk, over), null, new Date(Date.UTC(2026, 10, 7, 22, 0, sec)), () => sec / 100).payload);
  const a = mk(1, { message: "old" }), b = mk(30, { message: "new" });
  b.sent = true; b.sentAt = "2026-11-07T22:01:00.000Z"; a.lastError = "Inbox full";
  const back = G.parseFeedbackList(G.serializeFeedbackList([a, b]));
  assert.deepStrictEqual(back.map(e => e.payload.message), ["new", "old"]);
  assert.deepStrictEqual(back[0], b); assert.deepStrictEqual(back[1], a);
  assert.deepStrictEqual(Object.keys(back[0].payload), ["schema", "id", "created", "type", "rating", "message", "gameInfo"]);
});
test("parsing the stored list never throws on junk and drops invalid entries", () => {
  for (const t of [null, undefined, "", "junk", "{", "{}", "null", "42", '"x"', '[1,null,"a",[]]']) assert.deepStrictEqual(G.parseFeedbackList(t), []);
  const good = G.newFeedbackEntry(fbMake({}).payload);
  const bad = f => { const e = JSON.parse(JSON.stringify(good)); f(e.payload); return e; };
  const list = [good,
    bad(p => { p.id = "short"; }), bad(p => { p.id = "has space in it"; }), bad(p => { p.id = "x".repeat(65); }), bad(p => { p.id = 12345678; }),
    bad(p => { p.message = ""; }), bad(p => { p.message = "x".repeat(2001); }), bad(p => { p.type = "nope"; }),
    bad(p => { p.rating = 9; }), bad(p => { p.rating = "3"; }), bad(p => { p.created = "yesterday"; }),
    { sent: true }, { payload: null }, { payload: [] }];
  const back = G.parseFeedbackList(JSON.stringify(list));
  assert.strictEqual(back.length, 1);
  assert.strictEqual(back[0].payload.id, good.payload.id);
});
test("parsing the stored list ignores a repeated id and bad sent/lastError values", () => {
  const e = G.newFeedbackEntry(fbMake({}).payload);
  const back = G.parseFeedbackList(JSON.stringify([Object.assign({}, e, { sent: "yes", sentAt: 5, lastError: 7 }), e]));
  assert.strictEqual(back.length, 1);
  assert.strictEqual(back[0].sent, false); assert.strictEqual(back[0].sentAt, null); assert.strictEqual(back[0].lastError, null);
});
test("feedbackText lists type, rating, time, id, status, message and game info", () => {
  const e = G.newFeedbackEntry(fbMake({ type: "idea" }, { version: "first-playable", sector: 3 }).payload);
  const t = G.feedbackText(e);
  assert.ok(/Type: idea/.test(t) && /Rating: 4/.test(t) && /Created: 2026-11-07T22:45:01.123Z/.test(t));
  assert.ok(t.indexOf("Id: " + e.payload.id) >= 0 && /Status: not sent/.test(t));
  assert.ok(t.indexOf("The warp button is stuck.") >= 0);
  assert.ok(/^sector: 3$/m.test(t) && /^version: first-playable$/m.test(t));
  e.sent = true;
  assert.ok(/Status: sent/.test(G.feedbackText(e)));
});
test("feedbackText says so when there is no rating or no game info", () => {
  const t = G.feedbackText(G.newFeedbackEntry(fbMake({ rating: null }).payload));
  assert.ok(/no rating/.test(t) && /No game info attached\./.test(t));
});
test("feedbackExport names the file by local date and wraps the entries", () => {
  const e = G.newFeedbackEntry(fbMake({}).payload); e.sent = true; e.sentAt = "2026-11-07T22:50:00.000Z";
  const d = new Date(2026, 0, 5, 12, 0, 0);
  const x = G.feedbackExport([e], d);
  assert.strictEqual(x.name, "fleet-game-feedback-2026-01-05.json");
  const o = JSON.parse(x.text);
  assert.strictEqual(o.schema, "fleet-feedback-export/1"); assert.strictEqual(o.exported, d.toISOString());
  assert.deepStrictEqual(Object.keys(o.entries[0]), ["sent", "sentAt", "payload"]);
  assert.deepStrictEqual(o.entries[0].payload, e.payload); assert.strictEqual(o.entries[0].sent, true);
  assert.ok(x.text.indexOf("\n  ") > 0, "pretty printed");
  assert.deepStrictEqual(JSON.parse(G.feedbackExport([], d).text).entries, []);
});
test("main.js sends feedback only to FEEDBACK_URL, with only the one header", () => {
  const src = require("fs").readFileSync(__dirname + "/main.js", "utf8");
  assert.strictEqual((src.match(/\bfetch\(/g) || []).length, 1);
  assert.ok(/fetch\(G\.FEEDBACK_URL, \{ method: "POST", headers: \{ "Content-Type": "text\/plain;charset=UTF-8" \}, body: JSON\.stringify\(payload\)/.test(src));
  assert.ok(!/credentials|XMLHttpRequest|sendBeacon|WebSocket|https?:\/\//.test(src));
});

console.log("\n" + passed + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
