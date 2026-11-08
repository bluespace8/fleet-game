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
  for (const k of G.LOOK_KINDS) if (k !== "theme") for (const l of G.LOOKS[k]) all += l.cost;   // themes are the long-term goal
  assert.ok(all <= 90, "everything but the themes costs " + all + " stars");
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
    for (const key of Object.keys(l)) assert.ok(["id", "name", "cost", "miner", "hauler", "main", "home", "top", "bottom", "blobs", "note", "scene", "labels", "names"].indexOf(key) >= 0, key);
  }
});

console.log("themes, backgrounds and wording");
const THEMES = ["space", "dwarven", "hamster"];
function sameKeys(want, got, path) {   // every key of want is in got, deep, with a non-empty string at each leaf
  for (const k of Object.keys(want)) {
    assert.ok(Object.prototype.hasOwnProperty.call(got, k), "missing " + path + k);
    if (typeof want[k] === "object") sameKeys(want[k], got[k], path + k + ".");
    else assert.ok(typeof got[k] === "string" && got[k].length > 0, "empty " + path + k);
  }
}
test("themes are the first look kind, priced space 0, dwarven 30, hamster 60", () => {
  assert.deepStrictEqual(G.LOOK_KINDS, ["theme", "ship", "base", "bg", "trail"]);
  assert.strictEqual(G.LOOK_TITLES.theme, "Theme");
  for (const k of G.LOOK_KINDS) assert.ok(G.LOOK_TITLES[k], k);
  assert.deepStrictEqual(G.LOOKS.theme.map(t => [t.id, t.cost, t.scene]), [["space", 0, null], ["dwarven", 30, "cavern"], ["hamster", 60, "habitat"]]);
  for (const t of G.LOOKS.theme) assert.ok(t.note && t.labels && typeof t.labels === "object");
});
test("Hamster is the priciest item of all, Dwarven second", () => {
  const all = [];
  for (const k of G.LOOK_KINDS) for (const l of G.LOOKS[k]) all.push(l);
  all.sort((a, b) => b.cost - a.cost);
  assert.strictEqual(all[0].id, "hamster");
  assert.strictEqual(all[1].id, "dwarven");
  assert.ok(all[2].cost < all[1].cost);
});
test("buying Dwarven or Hamster takes the stars; too few is refused; owned is refused", () => {
  for (const [id, cost] of [["dwarven", 30], ["hamster", 60]]) {
    const p = G.newProfile();
    p.stars = cost - 1;
    const poor = G.buyLook(p, "theme", id);
    assert.ok(!poor.ok && /stars/.test(poor.reason));
    assert.strictEqual(p.stars, cost - 1); assert.ok(p.owned.theme.indexOf(id) < 0);
    p.stars = cost + 5;
    assert.ok(G.buyLook(p, "theme", id).ok);
    assert.strictEqual(p.stars, 5);
    assert.ok(p.owned.theme.indexOf(id) >= 0);
    const again = G.buyLook(p, "theme", id);
    assert.ok(!again.ok && /already own/.test(again.reason));
    assert.strictEqual(p.stars, 5);
  }
});
test("a theme is chosen only once owned, and space can always be chosen again", () => {
  const p = G.newProfile();
  assert.ok(!G.chooseLook(p, "theme", "hamster").ok);
  assert.strictEqual(p.pick.theme, "space");
  p.stars = 500; G.buyLook(p, "theme", "hamster"); G.buyLook(p, "theme", "dwarven");
  assert.ok(G.chooseLook(p, "theme", "hamster").ok);
  assert.strictEqual(G.currentLooks(p).theme.id, "hamster");
  assert.ok(G.chooseLook(p, "theme", "dwarven").ok);
  assert.strictEqual(G.currentLooks(p).theme.id, "dwarven");
  assert.ok(G.chooseLook(p, "theme", "space").ok, "back to space");
  assert.strictEqual(G.currentLooks(p).theme.id, "space");
  const fresh = G.newProfile();
  assert.ok(G.chooseLook(fresh, "theme", "space").ok, "space is owned from the start");
});
test("the theme survives serialize -> parse, and an unknown theme falls back to space", () => {
  const p = G.newProfile();
  p.stars = 200; G.buyLook(p, "theme", "hamster"); G.chooseLook(p, "theme", "hamster");
  const r = G.parseProfile(G.serializeProfile(p));
  assert.ok(r.ok);
  assert.deepStrictEqual(r.profile, p);
  assert.strictEqual(r.profile.pick.theme, "hamster");
  const bad = G.parseProfile(JSON.stringify({ stars: 9, owned: { theme: ["space", "ghost", 4] }, pick: { theme: "ghost" } })).profile;
  assert.strictEqual(bad.pick.theme, "space");
  assert.deepStrictEqual(bad.owned.theme, ["space"]);
  assert.strictEqual(bad.stars, 9);
  const unowned = G.parseProfile(JSON.stringify({ owned: { theme: ["space"] }, pick: { theme: "hamster" } })).profile;
  assert.strictEqual(unowned.pick.theme, "space", "cannot pick a theme that is not owned");
  const odd = G.parseProfile(JSON.stringify({ owned: { theme: "hamster" }, pick: { theme: ["hamster"] } }));
  assert.ok(odd.ok); assert.strictEqual(odd.profile.pick.theme, "space");
});
test("an old profile with no theme loads as space and keeps stars, owned and picks", () => {
  const text = '{"ver":1,"stars":13,"best":4200,"owned":{"ship":["classic","crimson"],"base":["teal"],"bg":["deep","aurora"],"trail":["streak","spark"]},'
    + '"pick":{"ship":"crimson","base":"teal","bg":"aurora","trail":"spark"},"claimed":["5:1:0"]}';
  const r = G.parseProfile(text);
  assert.ok(r.ok);
  const p = r.profile;
  assert.strictEqual(p.ver, 1);
  assert.strictEqual(p.stars, 13); assert.strictEqual(p.best, 4200);
  assert.deepStrictEqual(p.owned.ship, ["classic", "crimson"]);
  assert.deepStrictEqual(p.owned.bg, ["deep", "aurora"]);
  assert.deepStrictEqual(p.owned.trail, ["streak", "spark"]);
  assert.strictEqual(p.pick.ship, "crimson"); assert.strictEqual(p.pick.bg, "aurora"); assert.strictEqual(p.pick.trail, "spark");
  assert.deepStrictEqual(p.owned.theme, ["space"]); assert.strictEqual(p.pick.theme, "space");
  assert.deepStrictEqual(p.claimed, ["5:1:0"]);
  const looks = G.currentLooks(p);
  assert.strictEqual(looks.theme.id, "space"); assert.strictEqual(G.sceneFor(looks), "nebula");
  assert.strictEqual(G.newProfile().ver, 1, "profile version unchanged");
  assert.strictEqual(G.currentLooks({ pick: {} }).theme.id, "space", "a profile with no picks at all still works");
});
test("every theme has every label, with non-empty strings", () => {
  for (const id of THEMES) {
    sameKeys(G.SPACE_LABELS, G.labelsFor(id), id + ":");
    sameKeys(G.labelsFor(id), G.SPACE_LABELS, id + " extra:");   // and nothing extra the space set lacks
  }
  assert.deepStrictEqual(G.labelsFor("space"), G.SPACE_LABELS);
  assert.deepStrictEqual(G.labelsFor("nonsense"), G.SPACE_LABELS);
  assert.deepStrictEqual(G.labelsFor(undefined), G.SPACE_LABELS);
  assert.strictEqual(G.labelsFor("hamster").res.crystal, "carrots");
  assert.strictEqual(G.labelsFor("hamster").ship.hauler, "Big hamster");
  assert.strictEqual(G.labelsFor("dwarven").warp, "Dig to next depth");
  assert.strictEqual(G.labelsFor("dwarven").body.rare, "Gem geode");
});
test("the space labels are the game's current wording", () => {
  assert.deepStrictEqual(JSON.parse(JSON.stringify(G.SPACE_LABELS)), {
    id: "space",
    res: { ore: "ore", ice: "ice", crystal: "crystal" }, resTitle: { ore: "Ore", ice: "Ice", crystal: "Crystal" },
    ship: { miner: "Miner", hauler: "Hauler" }, ships: "Ships",
    base: "base", baseTitle: "Base", bases: "Bases", home: "Home base", newBase: "New base",
    body: { asteroid: "Asteroid", moon: "Moon", iceplanet: "Ice planet", rare: "Rare planet" },
    storm: "Ion storm", shower: "Meteor shower", sector: "Sector", warp: "Warp to next sector",
    edge: "the edge of space" });
  assert.ok(Object.isFrozen(G.SPACE_LABELS) && Object.isFrozen(G.SPACE_LABELS.res), "shared defaults cannot be changed");
});
test("labelsFor returns a fresh object each call", () => {
  for (const id of THEMES) {
    const a = G.labelsFor(id), b = G.labelsFor(id);
    assert.notStrictEqual(a, b); assert.notStrictEqual(a.res, b.res); assert.notStrictEqual(a.body, b.body);
    a.res.ore = "mutated"; a.ship.miner = "mutated"; a.base = "mutated";
    assert.strictEqual(G.labelsFor(id).res.ore, b.res.ore);
    assert.strictEqual(G.SPACE_LABELS.res.ore, "ore");
    assert.strictEqual(G.SPACE_LABELS.base, "base");
  }
  assert.notStrictEqual(G.labelsFor("space"), G.SPACE_LABELS);
  const p = G.newProfile();
  assert.notStrictEqual(G.currentLooks(p).labels, G.currentLooks(p).labels);
});
test("currentLooks adds the theme and its labels", () => {
  const p = G.newProfile(); p.stars = 200; G.buyLook(p, "theme", "dwarven"); G.chooseLook(p, "theme", "dwarven");
  const l = G.currentLooks(p);
  assert.strictEqual(l.theme.id, "dwarven");
  assert.deepStrictEqual(l.labels, G.labelsFor("dwarven"));
  for (const k of ["ship", "base", "bg", "trail"]) assert.ok(l[k] && l[k].id, k);
});
test("every background has a scene; the four new ones exist at 4, 5, 7 and 8 stars", () => {
  for (const b of G.LOOKS.bg) {
    assert.ok(typeof b.scene === "string" && b.scene, b.id + " scene");
    assert.ok(typeof b.top === "string" && typeof b.bottom === "string" && Array.isArray(b.blobs), b.id + " keeps the old drawing fields");
  }
  for (const id of ["deep", "aurora", "ember", "void"]) assert.strictEqual(G.lookById("bg", id).scene, "nebula");
  const want = { black: [4, "sparse"], belt: [5, "belt"], spiral: [7, "spiral"], solarsys: [8, "solar"] };
  for (const id of Object.keys(want)) {
    const b = G.lookById("bg", id);
    assert.ok(b, id);
    assert.strictEqual(b.cost, want[id][0]); assert.strictEqual(b.scene, want[id][1]);
  }
  assert.strictEqual(G.lookById("bg", "solarsys").name, "Solar System");
  assert.ok(G.lookById("bg", "black").blobs.every(bl => bl[3] === "rgba(0,0,0,0)"), "Deep Black has no visible colour");
  for (const b of G.LOOKS.bg) {
    assert.ok(b.blobs.length >= 1, b.id + " has a blob");
    for (const bl of b.blobs) assert.strictEqual(bl.length, 4, b.id + " blob shape");
  }
  assert.deepStrictEqual(G.LOOKS.bg.slice(0, 4).map(b => b.id), ["deep", "aurora", "ember", "void"], "old backgrounds keep their place");
});
test("sceneFor: the theme's scene wins, else the background's, else nebula", () => {
  const space = G.LOOKS.theme[0], dwarven = G.LOOKS.theme[1], hamster = G.LOOKS.theme[2];
  const solar = G.lookById("bg", "solarsys");
  assert.strictEqual(G.sceneFor({ theme: dwarven, bg: solar }), "cavern");
  assert.strictEqual(G.sceneFor({ theme: hamster, bg: solar }), "habitat");
  assert.strictEqual(G.sceneFor({ theme: space, bg: solar }), "solar");
  assert.strictEqual(G.sceneFor({ theme: space, bg: { id: "x" } }), "nebula");
  assert.strictEqual(G.sceneFor({ theme: space, bg: null }), "nebula");
  assert.strictEqual(G.sceneFor({ bg: solar }), "solar");
  assert.strictEqual(G.sceneFor({}), "nebula");
});
test("jobText with no labels is the unchanged wording", () => {
  const s = G.newGame(9), sh = s.ships[0], body = nearBody(s);
  assert.strictEqual(G.jobText(s, sh), "Idle. Select it, then pick a target.");
  G.orderShip(s, 0, body.id);
  assert.strictEqual(G.jobText(s, sh), "Flying to " + body.name);
  for (let i = 0; i < 6000 && sh.st !== G.MINING; i++) G.step(s, DT);
  assert.strictEqual(G.jobText(s, sh), "Mining " + body.name + " " + Math.floor(sh.cargo + 1e-6) + "/20");
  for (let i = 0; i < 6000 && sh.st !== G.TO_BASE; i++) G.step(s, DT);
  assert.strictEqual(G.jobText(s, sh), "Hauling " + Math.floor(sh.cargo + 1e-6) + " " + sh.res + " home");
  sh.cargo = 0; sh.res = "";
  assert.strictEqual(G.jobText(s, sh), "Back to base, then " + body.name);
  sh.target = -1;
  assert.strictEqual(G.jobText(s, sh), "Returning to base");
  sh.st = G.UNLOADING;
  assert.strictEqual(G.jobText(s, sh), "Unloading");
  G.orderShipToStar(s, 0, 0);
  assert.strictEqual(G.jobText(s, sh), "Flying to a star");
});
test("jobText with the space labels is byte-identical to no labels, in every state", () => {
  const { s, sh } = (function () {
    const s = G.newGame(9), sh = s.ships[0], body = nearBody(s), all = [];
    const check = () => { all.push(G.jobText(s, sh)); assert.strictEqual(G.jobText(s, sh, G.labelsFor("space")), G.jobText(s, sh)); assert.strictEqual(G.jobText(s, sh, G.SPACE_LABELS), G.jobText(s, sh)); };
    check(); G.orderShip(s, 0, body.id); check();
    for (let i = 0; i < 6000 && sh.st !== G.MINING; i++) G.step(s, DT);
    check();
    for (let i = 0; i < 6000 && sh.st !== G.TO_BASE; i++) G.step(s, DT);
    check(); sh.cargo = 0; sh.res = ""; check(); sh.target = -1; check(); sh.st = G.UNLOADING; check();
    G.orderShipToStar(s, 0, 0); check();
    assert.strictEqual(new Set(all).size, all.length, "each state reads differently");
    return { s, sh };
  })();
  assert.ok(s && sh);
});
test("jobText with theme labels names the theme's resources and bases", () => {
  const s = G.newGame(9), sh = s.ships[0], body = nearBody(s);
  const ham = G.labelsFor("hamster"), dw = G.labelsFor("dwarven");
  G.orderShip(s, 0, body.id);
  for (let i = 0; i < 6000 && sh.st !== G.TO_BASE; i++) G.step(s, DT);
  assert.strictEqual(sh.res, "ore");
  const n = Math.floor(sh.cargo + 1e-6);
  assert.strictEqual(G.jobText(s, sh, ham), "Hauling " + n + " seeds home");
  assert.strictEqual(G.jobText(s, sh, dw), "Hauling " + n + " iron home");
  sh.res = "crystal"; assert.strictEqual(G.jobText(s, sh, ham), "Hauling " + n + " carrots home");
  sh.res = "ice"; assert.strictEqual(G.jobText(s, sh, dw), "Hauling " + n + " silver home");
  sh.cargo = 0; sh.res = "";
  assert.strictEqual(G.jobText(s, sh, ham), "Back to wheel, then " + G.bodyLabel(body, ham));
  assert.strictEqual(G.jobText(s, sh, dw), "Back to forge, then " + G.bodyLabel(body, dw));
  sh.target = -1;
  assert.strictEqual(G.jobText(s, sh, ham), "Returning to wheel");
  assert.strictEqual(G.jobText(s, sh, dw), "Returning to forge");
  assert.strictEqual(G.jobText(s, sh, ham).indexOf("base"), -1);
});
test("bodyLabel: space keeps the stored name; themes give each body a stable name of its own kind", () => {
  const s = G.newGame(9), sp = G.labelsFor("space"), ham = G.labelsFor("hamster"), dw = G.labelsFor("dwarven");
  for (const b of s.bodies) assert.strictEqual(G.bodyLabel(b, sp), b.name);
  assert.strictEqual(G.bodyLabel(s.bodies[0]), s.bodies[0].name, "no labels: stored name");
  assert.strictEqual(G.bodyLabel(null, dw), "");
  for (const [labels, th] of [[ham, "hamster"], [dw, "dwarven"]]) {
    const theme = G.LOOKS.theme.find(t => t.id === th), seen = {};
    for (const b of s.bodies) {
      const name = G.bodyLabel(b, labels);
      assert.ok(name && name !== b.name && !/^Rock \d+$/.test(name), "themed: " + name);
      assert.strictEqual(name, G.bodyLabel(b, labels), "stable");
      assert.ok(theme.names[b.kind].some(n => name.indexOf(n) === 0), name + " comes from the " + b.kind + " list");
      assert.ok(!seen[name], "unique: " + name); seen[name] = 1;
    }
  }
  const many = { id: 0, kind: "asteroid", name: "Rock 10" }, pool = G.LOOKS.theme[1].names.asteroid;
  assert.strictEqual(G.bodyLabel(many, dw), pool[0]);
  many.id = pool.length; assert.strictEqual(G.bodyLabel(many, dw), pool[0] + " 2");
  assert.strictEqual(G.bodyLabel({ id: 3, kind: "mystery", name: "Zed" }, dw), "Zed", "unknown kind: stored name");
  const poor = G.newGame(9); poor.bodies[0].amount = 0;
  assert.strictEqual(G.orderShip(poor, 0, 0, dw).reason, G.bodyLabel(poor.bodies[0], dw) + " is empty.");
  assert.strictEqual(G.orderShip(poor, 0, 0).reason, poor.bodies[0].name + " is empty.");
});
test("shipLabel renames stored 'Type n' names and leaves anything else alone", () => {
  const s = G.newGame(4); s.stock.ore = s.stock.ice = 500; G.buildShip(s, "hauler"); G.buildShip(s, "miner");
  const ham = G.labelsFor("hamster"), dw = G.labelsFor("dwarven");
  const [m1, m2, h1, m3] = s.ships;
  assert.deepStrictEqual(s.ships.map(x => x.name), ["Miner 1", "Miner 2", "Hauler 1", "Miner 3"]);
  assert.strictEqual(G.shipLabel(m1, ham), "Hamster 1");
  assert.strictEqual(G.shipLabel(m3, ham), "Hamster 3");
  assert.strictEqual(G.shipLabel(h1, ham), "Big hamster 1");
  assert.strictEqual(G.shipLabel(h1, dw), "Mine cart 1");
  assert.strictEqual(G.shipLabel(m2, dw), "Dwarf 2");
  for (const sh of s.ships) {
    assert.strictEqual(G.shipLabel(sh), sh.name, "no labels: unchanged");
    assert.strictEqual(G.shipLabel(sh, G.labelsFor("space")), sh.name, "space labels: unchanged");
  }
  assert.strictEqual(G.shipLabel({ type: "miner", name: "Flagship" }, ham), "Flagship");
  assert.strictEqual(G.shipLabel({ type: "miner", name: "Bob 7" }, ham), "Bob 7");
  assert.strictEqual(G.shipLabel({ type: "miner", name: "Miner" }, ham), "Miner");
  assert.strictEqual(G.shipLabel({ type: "miner", name: "Miner 3 b" }, ham), "Miner 3 b");
  assert.strictEqual(G.shipLabel({ type: "miner", name: "Hauler 2" }, ham), "Big hamster 2", "the name decides when it names another type");
  assert.strictEqual(G.shipLabel({ name: "Hauler 12" }, dw), "Mine cart 12", "no type: matched by name");
  assert.strictEqual(G.shipLabel("Miner 5", ham), "Hamster 5", "a plain name works too");
  assert.strictEqual(G.shipLabel({ type: "miner" }, ham), "");
  assert.strictEqual(m1.name, "Miner 1", "stored names never change");
});
test("error messages that name a ship or base take labels; with none they are unchanged", () => {
  const ham = G.labelsFor("hamster");
  const s = G.newGame(5);
  s.stock.ore = s.stock.ice = s.stock.crystal = 0;
  assert.strictEqual(G.buildShip(s, "miner").reason, "Not enough materials for a miner.");
  assert.strictEqual(G.buildShip(s, "miner", ham).reason, "Not enough materials for a hamster.");
  assert.strictEqual(G.buildShip(s, "hauler", ham).reason, "Not enough materials for a big hamster.");
  const far = { x: s.bases[0].x + 400, y: s.bases[0].y };
  assert.strictEqual(G.placeBase(s, far.x, far.y).reason, "Not enough materials for a base.");
  assert.strictEqual(G.placeBase(s, far.x, far.y, ham).reason, "Not enough materials for a wheel.");
  assert.strictEqual(G.placeBase(s, s.bases[0].x + 20, s.bases[0].y).reason, "Too close to another base.");
  assert.strictEqual(G.placeBase(s, s.bases[0].x + 20, s.bases[0].y, G.labelsFor("dwarven")).reason, "Too close to another forge.");
  assert.strictEqual(G.baseSpotProblem(s, s.bases[0].x + 20, s.bases[0].y, ham), "Too close to another wheel.");
  assert.strictEqual(G.baseSpotProblem(s, 1, 1), "Too close to the edge of space.");
  assert.strictEqual(G.baseSpotProblem(s, 1, 1, ham), "Too close to the edge of the cage.");
  assert.strictEqual(G.baseSpotProblem(s, 1, 1, G.labelsFor("dwarven")), "Too close to the cavern wall.");
  const b = nearBody(s);
  assert.strictEqual(G.baseSpotProblem(s, b.x, b.y), "Too close to a planet or asteroid.");
  assert.ok(/seed pile/.test(G.baseSpotProblem(s, b.x, b.y, ham)));
  const dw = G.labelsFor("dwarven");
  assert.strictEqual(G.baseSpotProblem(s, b.x, b.y, dw), "Too close to an iron vein or a silver lode.");
  assert.strictEqual(G.upgradeBase(s, 9).reason, "No such base.");
  assert.strictEqual(G.upgradeBase(s, 9, ham).reason, "No such wheel.");
  s.stock.ore = s.stock.ice = s.stock.crystal = 9999; G.upgradeBase(s, 0); G.upgradeBase(s, 0);
  assert.strictEqual(G.upgradeBase(s, 0).reason, "This base is fully upgraded.");
  assert.strictEqual(G.upgradeBase(s, 0, ham).reason, "This wheel is fully upgraded.");
  assert.strictEqual(G.warpToNextSector(s).reason, "Build 5 bases first.");
  assert.strictEqual(G.warpToNextSector(s, ham).reason, "Build 5 wheels first.");
  assert.strictEqual(G.warpToNextSector(s, G.labelsFor("dwarven")).reason, "Build 5 forges first.");
  assert.strictEqual(G.returnToBase(s, 99, 0).reason, "No such ship or base.");
  assert.strictEqual(G.returnToBase(s, 99, 0, ham).reason, "No such ship or wheel.");
  assert.ok(G.returnToBase(s, 0, 0, ham).ok && G.placeBase(s, far.x, far.y, ham).ok, "labels never change what works");
});
test("the theme never changes the game: a fixed-seed run is identical whatever theme is picked", () => {
  const texts = [];
  for (const id of THEMES) {
    const p = G.newProfile(); p.stars = 500; G.buyLook(p, "theme", id); G.chooseLook(p, "theme", id);
    const labels = G.currentLooks(p).labels;
    const s = G.newGame(31, 3);
    G.orderShip(s, 0, nearBody(s).id); G.orderShip(s, 1, nearBody(s).id); G.orderShipToStar(s, 1, 0);
    s.stock.ore = s.stock.ice = s.stock.crystal = 900;
    for (let i = 0; i < 4000; i++) {
      G.step(s, DT);
      if (i % 500 === 0) { G.jobText(s, s.ships[0], labels); G.shipLabel(s.ships[1], labels); G.buildShip(s, "miner", labels); G.placeBase(s, 200 + i / 10, 200, labels); }
    }
    texts.push(G.serialize(s) + "|" + G.scoreTotal(s));
  }
  assert.strictEqual(texts[1], texts[0]); assert.strictEqual(texts[2], texts[0]);
  const a = G.newGame(31, 3);
  assert.strictEqual(G.serialize(a), G.serialize(G.newGame(31, 3)), "deterministic");
  assert.ok(!("theme" in a) && !("labels" in a), "no theme in the game state or save");
});
test("game saves from before themes still load and are unchanged by them", () => {
  const s = G.newGame(8); run(s, 20);
  const text = G.serialize(s);
  assert.ok(!/theme|labels|hamster|dwarven/i.test(text));
  assert.strictEqual(G.serialize(G.deserialize(text).state), text);
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
  assert.strictEqual(G.VERSION, 3);
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
test("parseRunLog collapses repeated run keys that are reserved words", () => {
  for (const k of ["__proto__", "constructor", "hasOwnProperty", "toString"]) {
    const p = G.parseRunLog(JSON.stringify({ runs: [mkRun({ key: k, score: 1 }), mkRun({ key: "k", score: 2 }), mkRun({ key: k, score: 3 })] }));
    assert.ok(p.ok);
    assert.strictEqual(p.dropped, 1, "key " + k + " counted once");
    assert.deepStrictEqual(p.log.runs.map(r => r.key), [k, "k"]);
    assert.deepStrictEqual(p.log.runs.map(r => r.score), [3, 2], "key " + k + ": the later one wins");
  }
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
test("feedbackReply: other non-200 statuses (404, 405) can be retried later", () => {
  assert.deepStrictEqual(G.feedbackReply(404, "{}"), { sent: false, retry: true, message: "Dashboard replied 404" });
  assert.deepStrictEqual(G.feedbackReply(405, '{"ok":false,"message":"No"}'), { sent: false, retry: true, message: "No" });
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

// ---------------------------------------------------------------- keyboard: manual flying and numbered targets
console.log("manual flying and numbered targets");
const MANUAL_DT = 1 / 30;
function manualShip(seed, sector) {   // a fresh game with ship 0 taken by hand, parked mid-map
  const s = G.newGame(seed || 1, sector || 1);
  assert.ok(G.takeManual(s, 0).ok);
  s.ships[0].x = s.w / 2; s.ships[0].y = s.h / 2;
  return s;
}
function stepFor(s, secs) { for (let i = 0; i < Math.round(secs / MANUAL_DT); i++) G.step(s, MANUAL_DT); }
function placeBeside(s, ship, body) { ship.x = body.x + body.r + 12; ship.y = body.y; }   // exactly the auto mining stop distance

test("takeManual and releaseManual switch a ship between hand and idle, keeping its cargo", () => {
  const s = G.newGame(1), sh = s.ships[0];
  G.orderShip(s, 0, nearBody(s).id);
  sh.cargo = 7; sh.res = "ore";
  assert.deepStrictEqual(G.takeManual(s, 0), { ok: true });
  assert.strictEqual(sh.st, G.MANUAL); assert.strictEqual(G.MANUAL, 6);
  assert.strictEqual(sh.mm, 0); assert.strictEqual(sh.target, -1); assert.strictEqual(sh.cargo, 7);
  assert.ok(G.releaseManual(s, 0).ok);
  assert.strictEqual(sh.st, G.IDLE); assert.strictEqual(sh.cargo, 7); assert.strictEqual(sh.res, "ore");
  assert.strictEqual(G.releaseManual(s, 0).ok, false, "not manual any more");
  assert.strictEqual(G.takeManual(s, 99).ok, false);
  s.over = true;
  const r = G.takeManual(s, 1);
  assert.strictEqual(r.ok, false); assert.ok(/over/.test(r.reason));
});
test("setManualInput clamps its input and only works on a manual ship", () => {
  const s = G.newGame(1);
  assert.strictEqual(G.setManualInput(s, 0, 1, 0).ok, false);
  G.takeManual(s, 0);
  assert.ok(G.setManualInput(s, 0, 5, -9).ok);
  assert.strictEqual(s.ships[0].ix, 1); assert.strictEqual(s.ships[0].iy, -1);
  G.setManualInput(s, 0, NaN, "x");
  assert.strictEqual(s.ships[0].ix, 0); assert.strictEqual(s.ships[0].iy, 0);
});
test("thrust moves the ship at its normal speed, diagonals no faster", () => {
  const s = manualShip(1), sh = s.ships[0], spec = G.SHIP_TYPES.miner;
  const x0 = sh.x, y0 = sh.y;
  G.setManualInput(s, 0, 1, 0);
  stepFor(s, 1);
  assert.ok(Math.abs(sh.x - x0 - spec.speed) < 1e-6, "moved " + (sh.x - x0)); assert.strictEqual(sh.y, y0);
  assert.strictEqual(sh.ang, 0); assert.strictEqual(sh.mv, 1);
  const x1 = sh.x, y1 = sh.y;
  G.setManualInput(s, 0, -1, -1);
  stepFor(s, 1);
  assert.ok(Math.abs(Math.hypot(sh.x - x1, sh.y - y1) - spec.speed) < 1e-6);
  G.setManualInput(s, 0, 0, 0);
  const x2 = sh.x; stepFor(s, 1);
  assert.strictEqual(sh.x, x2); assert.strictEqual(sh.mv, 0);
});
test("a hauler flies at hauler speed by hand", () => {
  const s = G.newGame(1); const h = G.addShip(s, "hauler");
  G.takeManual(s, h.id); h.x = s.w / 2; h.y = s.h / 2;
  G.setManualInput(s, h.id, 0, 1);
  const y0 = h.y; stepFor(s, 1);
  assert.ok(Math.abs(h.y - y0 - G.SHIP_TYPES.hauler.speed) < 1e-6);
});
test("an ion storm slows a ship flown by hand", () => {
  const s = manualShip(1, 2), sh = s.ships[0];
  s.storms[0].x = sh.x; s.storms[0].y = sh.y; s.storms[0].r = 600; s.storms[0].vx = 0; s.storms[0].vy = 0;
  assert.ok(G.inStorm(s, sh.x, sh.y));
  G.setManualInput(s, 0, 1, 0);
  const x0 = sh.x; stepFor(s, 1);
  assert.ok(Math.abs(sh.x - x0 - G.SHIP_TYPES.miner.speed * G.TUNING.storms.slow) < 1e-6, "moved " + (sh.x - x0));
});
test("a ship flown by hand stays inside the map", () => {
  const s = manualShip(1), sh = s.ships[0];
  G.setManualInput(s, 0, 1, 1);
  stepFor(s, 60);
  assert.strictEqual(sh.x, s.w); assert.strictEqual(sh.y, s.h);
  G.setManualInput(s, 0, -1, -1);
  stepFor(s, 60);
  assert.strictEqual(sh.x, 0); assert.strictEqual(sh.y, 0);
});
test("manual mining in reach runs at the ship's normal rate and matches an auto miner", () => {
  const s = manualShip(1), sh = s.ships[0], body = nearBody(s), rate = G.SHIP_TYPES.miner.rate;
  placeBeside(s, sh, body);
  const amount0 = body.amount;
  assert.deepStrictEqual(G.manualAction(s, 0), { ok: true, did: "mine" });
  assert.strictEqual(sh.mm, 1); assert.strictEqual(sh.target, body.id);
  stepFor(s, 2);
  assert.ok(Math.abs(sh.cargo - rate * 2) < 1e-6, "cargo " + sh.cargo);
  assert.ok(Math.abs(amount0 - body.amount - rate * 2) < 1e-6);
  assert.strictEqual(sh.res, body.res);
  assert.ok(/Manual: mining/.test(G.jobText(s, sh)));
  // an auto miner on the same body, parked at the same spot, gains the same per second
  const t = G.newGame(1), tb = nearBody(t); t.ships[0].x = tb.x + tb.r + 12; t.ships[0].y = tb.y; t.ships[0].st = G.MINING; t.ships[0].target = tb.id;
  stepFor(t, 2);
  assert.ok(Math.abs(t.ships[0].cargo - sh.cargo) < 1e-6);
});
test("manual mining stops by itself when the hold is full, and when the body runs dry", () => {
  const s = manualShip(1), sh = s.ships[0], body = nearBody(s), cap = G.SHIP_TYPES.miner.cap;
  placeBeside(s, sh, body);
  G.manualAction(s, 0);
  stepFor(s, 10);
  assert.ok(Math.abs(sh.cargo - cap) < 1e-6); assert.strictEqual(sh.mm, 0); assert.strictEqual(sh.st, G.MANUAL);
  const t = manualShip(1), ts = t.ships[0], tb = nearBody(t);
  tb.amount = 3; placeBeside(t, ts, tb);
  G.manualAction(t, 0); stepFor(t, 3);
  assert.strictEqual(tb.amount, 0); assert.ok(Math.abs(ts.cargo - 3) < 1e-6); assert.strictEqual(ts.mm, 0);
});
test("manual mining is refused out of reach, on an empty body, with the wrong cargo or a full hold", () => {
  const s = manualShip(1), sh = s.ships[0], body = nearBody(s);
  sh.x = body.x + body.r + 80; sh.y = body.y;
  let r = G.manualAction(s, 0);
  assert.strictEqual(r.ok, false); assert.strictEqual(r.reason, "Nothing in reach.");
  placeBeside(s, sh, body);
  sh.cargo = 5; sh.res = "ice";
  r = G.manualAction(s, 0);
  assert.strictEqual(r.ok, false); assert.ok(/ice/.test(r.reason)); assert.strictEqual(sh.mm, 0);
  sh.res = body.res; sh.cargo = G.SHIP_TYPES.miner.cap;
  r = G.manualAction(s, 0);
  assert.strictEqual(r.ok, false); assert.ok(/Full/.test(r.reason));
  sh.cargo = 0; sh.res = ""; body.amount = 0;
  assert.strictEqual(G.manualAction(s, 0).ok, false, "empty body is out of reach");
  assert.strictEqual(G.manualAction(s, 1).ok, false, "ship 1 is not manual");
});
test("manual mining skips an empty or other-resource body when a usable one is in reach", () => {
  const s = manualShip(1), sh = s.ships[0], a = s.bodies[0], b = s.bodies[1], c = s.bodies[2];
  a.res = "ore"; b.res = "ice"; c.res = "ore";
  for (const o of [a, b, c]) { o.r = 20; o.amount = 100; }
  sh.x = 500; sh.y = 500;
  a.x = 500; a.y = 501; b.x = 500; b.y = 505; c.x = 512; c.y = 500;
  a.amount = 0;                                   // nearest is empty
  sh.cargo = 5; sh.res = "ore";                   // next nearest is ice, wrong resource
  assert.deepStrictEqual(G.manualAction(s, 0), { ok: true, did: "mine" });
  assert.strictEqual(sh.target, c.id); assert.strictEqual(sh.res, "ore");
  const t = manualShip(1), ts = t.ships[0], tb = t.bodies[0], tc = t.bodies[1];
  tb.res = "ice"; tc.res = "ore"; tb.r = tc.r = 20; tb.amount = 100; tc.amount = 0;
  ts.x = 500; ts.y = 500; tb.x = 500; tb.y = 505; tc.x = 505; tc.y = 500;
  ts.cargo = 5; ts.res = "ore";
  const r = G.manualAction(t, 0);
  assert.strictEqual(r.ok, false); assert.ok(/ore/i.test(r.reason) && !/Nothing/.test(r.reason), "wrong-resource reason: " + r.reason);
  assert.strictEqual(ts.mm, 0);
});
test("manual mining clears the target whenever it ends", () => {
  const body = s => nearBody(s);
  let s = manualShip(1), sh = s.ships[0], b = body(s);
  placeBeside(s, sh, b); b.amount = 3; G.manualAction(s, 0); stepFor(s, 3);
  assert.strictEqual(sh.mm, 0); assert.strictEqual(sh.target, -1, "body ran dry");
  s = manualShip(1); sh = s.ships[0]; b = body(s);
  placeBeside(s, sh, b); G.manualAction(s, 0); stepFor(s, 10);
  assert.strictEqual(sh.mm, 0); assert.strictEqual(sh.target, -1, "hold full");
  s = manualShip(1); sh = s.ships[0]; b = body(s);
  placeBeside(s, sh, b); G.manualAction(s, 0); G.setManualInput(s, 0, 1, 0); stepFor(s, 1);
  assert.strictEqual(sh.target, -1, "input cancels");
  s = manualShip(1); sh = s.ships[0]; b = body(s);
  placeBeside(s, sh, b); G.manualAction(s, 0); G.manualAction(s, 0);
  assert.strictEqual(sh.target, -1, "stop action");
  s = manualShip(1); sh = s.ships[0]; sh.target = 3;
  sh.x = s.bases[0].x + G.BASE_R + 15; sh.y = s.bases[0].y; sh.cargo = 10; sh.res = "ore";
  G.manualAction(s, 0); stepFor(s, 3);
  assert.strictEqual(sh.mm, 0); assert.strictEqual(sh.target, -1, "unload done");
});
test("any input cancels manual mining; the same action stops it too", () => {
  const s = manualShip(1), sh = s.ships[0], body = nearBody(s);
  placeBeside(s, sh, body);
  G.manualAction(s, 0); stepFor(s, 1);
  const c = sh.cargo; assert.ok(c > 0);
  G.setManualInput(s, 0, 0, -1);
  const y0 = sh.y; stepFor(s, 1);
  assert.strictEqual(sh.mm, 0); assert.ok(sh.y < y0, "flies off"); assert.ok(Math.abs(sh.cargo - c) < 5 / 30 + 1e-9, "at most one step of mining");
  G.setManualInput(s, 0, 0, 0);
  placeBeside(s, sh, body);
  G.manualAction(s, 0);
  assert.deepStrictEqual(G.manualAction(s, 0), { ok: true, did: "stop" });
  assert.strictEqual(sh.mm, 0);
});
test("manual unloading in reach of a base delivers like an auto ship", () => {
  const s = manualShip(1), sh = s.ships[0], home = s.bases[0], ore0 = s.stock.ore, mat0 = s.score.mat;
  sh.x = home.x + G.BASE_R + 10 + 5; sh.y = home.y; sh.cargo = 20; sh.res = "ore";
  const r = G.manualAction(s, 0);
  assert.deepStrictEqual(r, { ok: true, did: "unload" });
  assert.strictEqual(s.stock.ore, ore0 + 20); assert.strictEqual(s.score.mat, mat0 + 20); assert.strictEqual(s.delivered.ore, 20);
  assert.strictEqual(sh.cargo, 0); assert.strictEqual(sh.res, ""); assert.strictEqual(sh.mm, 2);
  assert.ok(Math.abs(sh.wait - 20 / G.TUNING.upgrades[0].unload) < 1e-9);
  assert.strictEqual(G.jobText(s, sh), "Manual: unloading");
  stepFor(s, 1);
  assert.strictEqual(sh.mm, 0); assert.strictEqual(sh.st, G.MANUAL); assert.strictEqual(G.jobText(s, sh), "Manual");
  // far from any base nothing happens
  sh.x = 5; sh.y = 5; sh.cargo = 5; sh.res = "ore";   // a corner: no base or body within reach
  const far = G.manualAction(s, 0);
  assert.strictEqual(far.ok, false); assert.strictEqual(sh.cargo, 5);
});
test("an upgraded base takes manual ships from further away and unloads faster", () => {
  const s = manualShip(1), sh = s.ships[0], home = s.bases[0];
  sh.x = home.x + G.BASE_R + 10 + 20; sh.y = home.y; sh.cargo = 10; sh.res = "ore";
  assert.strictEqual(G.manualAction(s, 0).ok, false, "tier 0 reach is shorter");
  s.stock.ore = 999; s.stock.ice = 999; s.stock.crystal = 999;
  assert.ok(G.upgradeBase(s, 0).ok);
  assert.strictEqual(G.manualAction(s, 0).did, "unload");
  assert.ok(Math.abs(sh.wait - 10 / G.TUNING.upgrades[1].unload) < 1e-9);
});
test("meteors still hit a loaded ship flown by hand", () => {
  const s = manualShip(1, 3), sh = s.ships[0];
  sh.cargo = 20; sh.res = "ore";
  s.showers = [{ x: sh.x, y: sh.y, r: 120, age: G.TUNING.showers.warn }]; s.showerIn = 1e6;   // live: past the (now 10 s) warning
  stepFor(s, 8);
  assert.ok(s.hits > 0, "hit"); assert.ok(sh.cargo < 20); assert.ok(s.stats.lost > 0);
});
test("a mouse order releases a ship flown by hand", () => {
  const s = manualShip(1), sh = s.ships[0], body = nearBody(s);
  G.setManualInput(s, 0, 1, 0);
  assert.ok(G.orderShip(s, 0, body.id).ok);
  assert.strictEqual(sh.st, G.TO_BODY); assert.strictEqual(sh.mm, 0); assert.strictEqual(sh.ix, 0);
  G.takeManual(s, 0);
  G.recallShip(s, 0);
  assert.strictEqual(sh.st, G.TO_BASE); assert.strictEqual(sh.mm, 0);
  G.takeManual(s, 0);
  assert.ok(G.returnToBase(s, 0, 0).ok); assert.strictEqual(sh.st, G.TO_BASE);
});

test("targetList numbers bodies then stars and keeps the numbers when targets go", () => {
  const s = G.newGame(5), nb = s.bodies.length, ns = s.stars.length;
  let list = G.targetList(s);
  assert.strictEqual(list.length, nb + ns);
  assert.deepStrictEqual(list[0], { n: 1, kind: "body", id: 0 });
  assert.deepStrictEqual(list[nb - 1], { n: nb, kind: "body", id: nb - 1 });
  assert.deepStrictEqual(list[nb], { n: nb + 1, kind: "star", id: 0 });
  s.bodies[2].amount = 0; s.stars[1].taken = true;
  list = G.targetList(s);
  assert.strictEqual(list.length, nb + ns - 2);
  assert.ok(!list.some(t => t.kind === "body" && t.id === 2));
  assert.ok(!list.some(t => t.kind === "star" && t.id === 1));
  assert.ok(list.some(t => t.kind === "body" && t.id === 3 && t.n === 4), "later bodies keep their number");
  assert.ok(list.some(t => t.kind === "star" && t.id === 2 && t.n === nb + 3), "later stars keep their number");
  for (let i = 1; i < list.length; i++) assert.ok(list[i].n > list[i - 1].n);
});
test("targetLabel gives 1-9, 0 for ten, then the plain number", () => {
  assert.deepStrictEqual([1, 2, 9, 10, 11, 25, 100].map(G.targetLabel), ["1", "2", "9", "0", "11", "25", "100"]);
});
test("resolveTargetKeys maps typed digits to a target and says when to wait for another", () => {
  assert.deepStrictEqual(G.resolveTargetKeys("5", 14), { n: 5, wait: false });
  assert.deepStrictEqual(G.resolveTargetKeys("1", 14), { n: 1, wait: true }, "10-14 exist");
  assert.deepStrictEqual(G.resolveTargetKeys("1", 5), { n: 1, wait: false });
  assert.deepStrictEqual(G.resolveTargetKeys("0", 14), { n: 10, wait: false });
  assert.deepStrictEqual(G.resolveTargetKeys("0", 9), { n: null, wait: false });
  assert.deepStrictEqual(G.resolveTargetKeys("12", 14), { n: 12, wait: false });
  assert.deepStrictEqual(G.resolveTargetKeys("15", 14), { n: null, wait: false });
  assert.deepStrictEqual(G.resolveTargetKeys("7", 5), { n: null, wait: false });
  assert.deepStrictEqual(G.resolveTargetKeys("2", 25), { n: 2, wait: true });
  assert.deepStrictEqual(G.resolveTargetKeys("3", 25), { n: 3, wait: false });
  assert.deepStrictEqual(G.resolveTargetKeys("", 14), { n: null, wait: false });
  assert.deepStrictEqual(G.resolveTargetKeys("x", 14), { n: null, wait: false });
  assert.deepStrictEqual(G.resolveTargetKeys("05", 14), { n: null, wait: false });
});
test("orderToTarget sends a ship to a numbered body or star, and refuses bad numbers like a bad click", () => {
  const s = G.newGame(5), nb = s.bodies.length;
  assert.deepStrictEqual(G.orderToTarget(s, 0, 3), { ok: true });
  assert.strictEqual(s.ships[0].st, G.TO_BODY); assert.strictEqual(s.ships[0].target, 2);
  assert.deepStrictEqual(G.orderToTarget(s, 1, nb + 2), { ok: true });
  assert.strictEqual(s.ships[1].st, G.TO_STAR); assert.strictEqual(s.ships[1].star, 1);
  for (const n of [0, -1, nb + s.stars.length + 1, 1.5, NaN, "3", undefined]) {
    const r = G.orderToTarget(s, 0, n);
    assert.strictEqual(r.ok, false); assert.strictEqual(r.reason, "No target " + n + ".");
  }
  s.bodies[4].amount = 0; s.stars[0].taken = true;
  const e = G.orderToTarget(s, 0, 5), t = G.orderToTarget(s, 0, nb + 1);
  assert.deepStrictEqual(e, G.orderShip(s, 0, 4)); assert.ok(/empty/.test(e.reason));
  assert.deepStrictEqual(t, G.orderShipToStar(s, 0, 0)); assert.ok(/taken/.test(t.reason));
  assert.strictEqual(G.orderToTarget(s, 9, 1).ok, false);
  const m = manualShip(5);
  assert.ok(G.orderToTarget(m, 0, 1).ok); assert.strictEqual(m.ships[0].st, G.TO_BODY); assert.strictEqual(m.ships[0].mm, 0);
});
test("orderNearestBase sends any ship to the closest base", () => {
  const s = G.newGame(1); s.stock.ore = 9999; s.stock.ice = 9999; s.stock.crystal = 9999;
  const home = s.bases[0];
  let spot = null;
  for (let x = 120; x < s.w - 120 && !spot; x += 40) for (let y = 120; y < s.h - 120 && !spot; y += 40) if (!G.baseSpotProblem(s, x, y) && Math.hypot(x - home.x, y - home.y) > 300) spot = { x, y };
  assert.ok(G.placeBase(s, spot.x, spot.y).ok);
  const sh = s.ships[0]; sh.x = spot.x + 40; sh.y = spot.y;
  assert.deepStrictEqual(G.orderNearestBase(s, 0), { ok: true });
  assert.strictEqual(sh.st, G.TO_BASE); assert.strictEqual(sh.dest, 1);
  sh.x = home.x - 20; sh.y = home.y;
  G.orderNearestBase(s, 0);
  assert.strictEqual(sh.dest, 0);
  assert.strictEqual(G.orderNearestBase(s, 9).ok, false);
  const m = manualShip(1);
  G.orderNearestBase(m, 0);
  assert.strictEqual(m.ships[0].st, G.TO_BASE); assert.strictEqual(m.ships[0].mm, 0);
});

test("a save made mid-manual-flight loads and runs the same", () => {
  for (const mode of [0, 1, 2]) {
    const s = manualShip(9), sh = s.ships[0], body = nearBody(s);
    if (mode === 1) { placeBeside(s, sh, body); G.manualAction(s, 0); stepFor(s, 1); }
    if (mode === 2) { const h = s.bases[0]; sh.x = h.x + 40; sh.y = h.y; sh.cargo = 20; sh.res = "ore"; G.manualAction(s, 0); }
    if (mode === 0) { G.setManualInput(s, 0, 1, 0); stepFor(s, 1); }
    const r = G.deserialize(G.serialize(s));
    assert.ok(r.ok);
    assert.strictEqual(r.state.ships[0].st, G.MANUAL); assert.strictEqual(r.state.ships[0].mm, mode);
    assert.strictEqual(r.state.ships[0].ix, 0); assert.strictEqual(r.state.ships[0].iy, 0);
    G.setManualInput(s, 0, 0, 0);
    stepFor(s, 3); stepFor(r.state, 3);
    assert.strictEqual(G.serialize(r.state), G.serialize(s), "mode " + mode);
  }
});
test("old saves without manual fields load, and bad st or mm values fall back safely", () => {
  const raw = JSON.parse(G.serialize(G.newGame(3)));
  for (const sh of raw.ships) { delete sh.mm; delete sh.ix; delete sh.iy; }
  const old = G.deserialize(JSON.stringify(raw));
  assert.ok(old.ok); assert.strictEqual(old.state.ships[0].mm, 0); assert.strictEqual(old.state.ships[0].ix, 0);
  const bad = JSON.parse(G.serialize(G.newGame(3)));
  bad.ships[0].st = 99; bad.ships[0].mm = 2;
  bad.ships[1].st = 6; bad.ships[1].mm = "junk";
  let r = G.deserialize(JSON.stringify(bad));
  assert.ok(r.ok); assert.strictEqual(r.state.ships[0].st, G.IDLE); assert.strictEqual(r.state.ships[0].mm, 0);
  assert.strictEqual(r.state.ships[1].st, G.MANUAL); assert.strictEqual(r.state.ships[1].mm, 0);
  bad.ships[0].st = -3; bad.ships[1].mm = 7;
  r = G.deserialize(JSON.stringify(bad));
  assert.strictEqual(r.state.ships[0].st, G.IDLE); assert.strictEqual(r.state.ships[1].mm, 0);
  bad.ships[1].st = 6; bad.ships[1].mm = 1; bad.ships[1].target = 9999; bad.ships[1].ix = 1;   // mining nothing
  r = G.deserialize(JSON.stringify(bad));
  assert.ok(r.ok); assert.strictEqual(r.state.ships[1].mm, 0); assert.strictEqual(r.state.ships[1].ix, 0);
  bad.ships[1].st = 3; bad.ships[1].mm = 2;
  r = G.deserialize(JSON.stringify(bad));
  assert.strictEqual(r.state.ships[1].mm, 0, "mm only counts while manual");
  const v1 = JSON.parse(G.serialize(G.newGame(3))); v1.ver = 1;
  assert.ok(G.deserialize(JSON.stringify(v1)).ok);
});
test("a warp hands every ship back from manual flight", () => {
  const s = manualShip(1);
  s.won = true;
  assert.ok(G.warpToNextSector(s).ok);
  assert.strictEqual(s.ships[0].st, G.IDLE); assert.strictEqual(s.ships[0].mm, 0);
});
test("main.js has one key guard, and never cancels Tab inside a dialog", () => {
  const src = require("fs").readFileSync(__dirname + "/main.js", "utf8");
  const g = /function keyActive\(ev\) \{[\s\S]*?\n  \}/.exec(src);
  assert.ok(g, "keyActive exists");
  for (const w of ["ui.feedback", "ui.hangar", "ui.dlg.length", "ui.winOpen", "ui.endOpen", "INPUT", "TEXTAREA", "SELECT"]) assert.ok(g[0].indexOf(w) >= 0, w);
  const t = /function onTab\(ev\) \{[\s\S]*?\n  \}/.exec(src);
  assert.ok(t && /if \(!keyActive\(ev\)\) return;[\s\S]*preventDefault/.test(t[0]), "Tab is only handled when keyActive");
  assert.ok(/function typeDigit[\s\S]*resolveTargetKeys/.test(src));
});

// ---------------------------------------------------------------------------------------------------------------
console.log("hazards and defense: events, fog, flares, showers");
const HDT = 1 / 30;
function hrun(s, secs) { for (let i = 0; i < Math.round(secs / HDT); i++) G.step(s, HDT); }
function quiet(s) { s.showerIn = 3000; s.eventIn = 3000; return s; }       // no new showers or events
function hgame(seed, sector) { return quiet(G.newGame(seed, sector)); }
function liveEvent(s, kind, o) {   // an event already past its warning
  const e = Object.assign({ kind, x: s.w / 2, y: s.h / 2, r: 150, age: G.TUNING.events.warn, warn: G.TUNING.events.warn, dur: 30, power: 1 }, o || {});
  s.events.push(e); return e;
}
function liveShower(s, o) {
  const W = G.TUNING.showers, e = Object.assign({ kind: "shower", x: s.w / 2, y: s.h / 2, r: 150, age: W.warn, warn: W.warn, dur: 60, power: 10, tick: 0 }, o || {});
  s.showers.push(e); return e;
}
function giveAll(s) { s.stock.ore = s.stock.ice = s.stock.crystal = 5000; }
function withTuning(obj, key, val, fn) { const old = obj[key]; obj[key] = val; try { fn(); } finally { obj[key] = old; } }
function noMv(text) { const o = JSON.parse(text); for (const x of o.ships) x.mv = 0; return JSON.stringify(o); }
function mid(s, ship) { ship.x = s.w / 2; ship.y = s.h / 2; return ship; }

test("TUNING has the new sub-tables and every number the rules use", () => {
  const T = G.TUNING;
  for (const k of ["events", "fog", "flare", "showers", "aliens", "combat", "addons", "repair"]) assert.ok(T[k] && typeof T[k] === "object", k);
  assert.ok(T.ships.warship && T.ships.warship.war && T.ships.warship.cap === 0 && T.ships.warship.rate === 0);
  assert.strictEqual(T.showers.warn, 10, "the shower warning is 10 s now");
  assert.strictEqual(T.events.warn, 10);
  assert.ok(T.addons.shield.range > 0 && T.addons.turret.range > 0 && T.fog.mine > 0 && T.fog.mine < 1);
});
test("blankState puts the new fields before delivered and starsPaid, which stay last", () => {
  const keys = Object.keys(G.newGame(1));
  assert.deepStrictEqual(keys.slice(-2), ["delivered", "starsPaid"]);
  for (const k of ["events", "eventIn", "alienSeq", "aliens", "shots", "fx"]) assert.ok(keys.indexOf(k) >= 0 && keys.indexOf(k) < keys.length - 2, k);
  const s = G.newGame(1);
  assert.strictEqual(s.score.kills, 0); assert.strictEqual(s.stats.kills, 0);
  assert.strictEqual(s.ships[0].hp, G.SHIP_TYPES.miner.hp); assert.strictEqual(s.ships[0].dead, false);
  assert.strictEqual(s.bases[0].hp, G.TUNING.combat.homeHp); assert.strictEqual(s.bases[0].shield, false);
});
test("sector 1 is calm: ten minutes bring no event, shower, alien or damage", () => {
  const s = G.newGame(3);
  assert.strictEqual(s.eventIn, 0);
  for (const sh of s.ships) G.orderShip(s, sh.id, nearBody(s).id);
  hrun(s, 600);
  assert.strictEqual(s.events.length, 0); assert.strictEqual(s.showers.length, 0); assert.strictEqual(s.aliens.length, 0);
  assert.strictEqual(s.hz, G.newGame(3).hz, "hrand was never used");
  assert.ok(s.ships.every(x => x.hp === x.maxHp) && s.bases[0].hp === s.bases[0].maxHp);
  assert.ok(!G.eventsOn(1) && !G.aliensOn(2) && G.aliensOn(3));
});
test("events start in sector 2 after the first delay, and warn for 10 seconds before they take effect", () => {
  const s = G.newGame(5, 2);
  assert.strictEqual(s.eventIn, G.TUNING.events.firstDelay);
  hrun(s, G.TUNING.events.firstDelay - 1);
  assert.strictEqual(s.events.length, 0, "nothing before the first delay");
  hrun(s, 2);
  assert.strictEqual(s.events.length, 1);
  const e = s.events[0], w = G.eventWarnings(s);
  assert.ok(e.age < e.warn && e.warn === 10);
  assert.strictEqual(w.length, 1);
  assert.strictEqual(w[0].kind, e.kind);
  assert.ok(w[0].secs >= 9 && w[0].secs <= 10, "10 s countdown, was " + w[0].secs);
  assert.ok(["x", "y", "r"].every(k => isFinite(w[0][k])));
  hrun(s, 5);
  assert.ok(G.eventWarnings(s)[0].secs <= 5);
  hrun(s, 6);
  assert.strictEqual(G.eventWarnings(s).filter(x => x.kind === e.kind).length, 0, "the warning is over");
});
test("sector 2 has only fog and flares, never showers, raids or aliens", () => {
  const s = G.newGame(8, 2), kinds = {};
  s.showerIn = 1e9;
  for (let i = 0; i < 30 * 900; i++) { G.step(s, HDT); for (const e of s.events) kinds[e.kind] = true; }
  assert.ok(Object.keys(kinds).length >= 1);
  assert.ok(Object.keys(kinds).every(k => k === "fog" || k === "flare"), Object.keys(kinds).join());
  assert.strictEqual(s.aliens.length, 0); assert.strictEqual(s.showers.length, 0);
});
test("from sector 3 raids come too, and the event kinds all show up over a long run", () => {
  const s = G.newGame(9, 3), kinds = {};
  s.showerIn = 20;
  s.bases[0].hp = s.bases[0].maxHp = 1e9;      // outlast the raids: this test is about what gets rolled
  for (let i = 0; i < 30 * 1500; i++) { G.step(s, HDT); for (const e of s.events) kinds[e.kind] = true; if (s.showers.length) kinds.shower = true; if (s.over) break; }
  assert.ok(kinds.fog && kinds.flare && kinds.raid && kinds.shower, Object.keys(kinds).join());
});
test("the gap between events falls with the sector and is floored; strength rises and is capped", () => {
  let prev = Infinity;
  for (let n = 2; n <= 12; n++) { const g = G.eventGap(n); assert.ok(g <= prev && g >= G.TUNING.events.gapMin); prev = g; }
  assert.strictEqual(G.eventGap(12), G.TUNING.events.gapMin);
  for (const f of [G.eventPower, G.raidOdds, G.alienCount, G.alienHp, G.alienDmg, G.alienSpeed, G.showerDmg, G.showerRadius, G.fogRadius, G.flareDur]) {
    let last = -1;
    for (let n = 1; n <= 30; n++) { const v = f(n); assert.ok(v >= last - 1e-9, f.name + " never falls"); last = v; }
    assert.ok(f(30) === f(60), f.name + " is capped");
  }
  assert.ok(G.eventPower(4) > G.eventPower(2) && G.eventPower(2) === 1);
  assert.strictEqual(G.raidOdds(1), 0); assert.strictEqual(G.raidOdds(2), 0); assert.ok(G.raidOdds(3) > 0);
  assert.ok(G.alienHp(6) > G.alienHp(3) && G.alienDmg(6) > G.alienDmg(3), "tougher each sector");
  assert.ok(G.alienCount(10) > G.alienCount(3));
  assert.strictEqual(G.alienCount(11), G.alienCount(10), "raiders plateau at sector 10");
  assert.strictEqual(G.alienCount(50), G.alienCount(10));
  assert.strictEqual(G.alienCount(10), 5);
});
test("events are deterministic from the seed, with the same warnings and effects", () => {
  const a = G.newGame(12, 3), b = G.newGame(12, 3);
  hrun(a, 200); hrun(b, 200);
  assert.strictEqual(G.serialize(a), G.serialize(b));
  assert.notStrictEqual(G.serialize(a), G.serialize(G.newGame(13, 3)));
});
test("rolling events does not need random numbers outside hrand (the seed fixes the whole run)", () => {
  const src = require("fs").readFileSync(__dirname + "/game.js", "utf8");
  const stepArea = src.slice(src.indexOf("// ---- hazards: health"), src.indexOf("function isStranded"));
  assert.ok(stepArea.length > 5000, "found the hazard code");
  assert.ok(!/Math\.random|rng\(/.test(stepArea), "hazards use hrand(state) only");
  const hz = src.slice(src.indexOf("function stepHazards"), src.indexOf("function isStranded"));
  assert.ok(!/Math\.(cos|sin|tan|atan2)\(/.test(hz), "no trig in the hazard step (vector maths instead)");
});
test("fog slows mining inside it, not outside, and not during its warning", () => {
  const mk = (fog) => {
    const s = hgame(4, 2), b = nearBody(s);
    if (fog) liveEvent(s, "fog", { x: b.x, y: b.y, r: 400 });
    G.orderShip(s, 0, b.id); G.orderShip(s, 1, b.id);
    return s;
  };
  const clear = mk(false), fogged = mk(true);
  hrun(clear, 20); hrun(fogged, 20);
  assert.ok(clear.stats.ore > 0 && fogged.stats.ore > 0);
  assert.ok(fogged.stats.ore < clear.stats.ore * 0.8, fogged.stats.ore + " vs " + clear.stats.ore);
  const s = hgame(4, 2), b = nearBody(s);
  assert.ok(!G.fogAt(s, b.x, b.y));
  const e = liveEvent(s, "fog", { x: b.x, y: b.y, r: 50, age: 0 });
  assert.ok(!G.fogAt(s, b.x, b.y), "still warning");
  e.age = e.warn;
  assert.ok(G.fogAt(s, b.x, b.y) && G.fogAt(s, b.x + 49, b.y) && !G.fogAt(s, b.x + 60, b.y));
});
test("fog slows a ship mined by hand too", () => {
  const mk = (fog) => {
    const s = hgame(2, 2), b = nearBody(s);
    G.takeManual(s, 0); placeBeside(s, s.ships[0], b);
    if (fog) liveEvent(s, "fog", { x: b.x, y: b.y, r: 300 });
    assert.strictEqual(G.manualAction(s, 0).did, "mine");
    return s;
  };
  const a = mk(false), f = mk(true);
  hrun(a, 2); hrun(f, 2);
  assert.ok(Math.abs(f.stats.ore - a.stats.ore * G.TUNING.fog.mine) < 1e-6, f.stats.ore + " vs " + a.stats.ore);
});
test("a flare stuns exposed ships (manual ones too) and a live shield generator protects ships near it", () => {
  const s = hgame(6, 2);
  const b = nearBody(s);
  G.orderShip(s, 0, b.id);
  G.takeManual(s, 1); mid(s, s.ships[1]); G.setManualInput(s, 1, 1, 0);
  const x0 = s.ships[1].x, d0 = Math.hypot(s.ships[0].x - s.bases[0].x, s.ships[0].y - s.bases[0].y);
  liveEvent(s, "flare", { r: 0 });
  hrun(s, 2);
  assert.ok(s.ships[0].stun > 0 && s.ships[1].stun > 0);
  assert.strictEqual(s.ships[1].x, x0, "a stunned manual ship does not move");
  assert.ok(Math.abs(Math.hypot(s.ships[0].x - s.bases[0].x, s.ships[0].y - s.bases[0].y) - d0) < 1e-6, "nor an auto ship");
  assert.strictEqual(G.jobText(s, s.ships[0]), "Stunned by a solar flare");
  assert.strictEqual(G.manualAction(s, 1).ok, false);
  // shielded: next to a shielded base
  const t = hgame(6, 2); giveAll(t);
  assert.ok(G.buildAddon(t, 0, "shield").ok);
  const home = t.bases[0];
  t.ships[0].x = home.x + 60; t.ships[0].y = home.y;
  t.ships[1].x = home.x + G.TUNING.addons.shield.range + 40; t.ships[1].y = home.y;
  assert.ok(G.shielded(t, t.ships[0].x, t.ships[0].y) && !G.shielded(t, t.ships[1].x, t.ships[1].y));
  G.orderShip(t, 0, nearBody(t).id); G.orderShip(t, 1, nearBody(t).id);
  liveEvent(t, "flare", { r: 0 });
  hrun(t, 0.5);
  assert.strictEqual(t.ships[0].stun, 0, "protected");
  assert.ok(t.ships[1].stun > 0, "outside the range");
  t.bases[0].down = true;     // a down base protects nobody
  assert.ok(!G.shielded(t, t.ships[0].x, t.ships[0].y));
});
test("a flare is harmless in its warning and ends: the stun wears off", () => {
  const s = hgame(6, 2);
  liveEvent(s, "flare", { r: 0, age: 0, dur: 5 });
  hrun(s, 5);
  assert.ok(s.ships.every(x => x.stun === 0), "warning only");
  hrun(s, 6);
  assert.ok(s.ships.every(x => x.stun <= G.TUNING.flare.linger));
  hrun(s, 12);
  assert.strictEqual(s.events.length, 0, "the flare is over");
  assert.ok(s.ships.every(x => x.stun === 0), "nobody is still stunned");
});
test("a shower damages ships and bases inside, and nothing outside, once its warning is over", () => {
  const s = hgame(4, 3);
  const home = s.bases[0];
  liveShower(s, { x: home.x, y: home.y, r: 200, power: 10 });
  s.ships[0].x = home.x + 100; s.ships[0].y = home.y;           // inside
  s.ships[1].x = home.x + 600; s.ships[1].y = home.y;           // outside
  hrun(s, 12);
  assert.ok(s.ships[0].hp < s.ships[0].maxHp, "ship hurt");
  assert.strictEqual(s.ships[1].hp, s.ships[1].maxHp);
  assert.ok(s.bases[0].hp < s.bases[0].maxHp, "base hurt");
  const w = hgame(4, 3);
  const e = liveShower(w, { x: w.bases[0].x, y: w.bases[0].y, r: 300, age: 0 });
  w.ships[0].x = w.bases[0].x; w.ships[0].y = w.bases[0].y;
  for (let i = 0; i < 30 * 9; i++) { e.age = Math.min(e.age, e.warn - 0.5); G.step(w, HDT); }
  assert.strictEqual(w.ships[0].hp, w.ships[0].maxHp); assert.strictEqual(w.bases[0].hp, w.bases[0].maxHp);
});
test("a shower's damage grows with the sector and is capped", () => {
  assert.ok(G.showerDmg(6) > G.showerDmg(3));
  assert.strictEqual(G.showerDmg(40), G.TUNING.showers.dmgMax);
  const s = hgame(4, 5);
  s.showerIn = 0.01; s.showers = [];
  hrun(s, 1);
  assert.strictEqual(s.showers.length, 1);
  assert.strictEqual(s.showers[0].power, G.showerDmg(5));
  assert.strictEqual(s.showers[0].warn, 10);
  assert.strictEqual(s.showers[0].kind, "shower");
  assert.strictEqual(G.eventWarnings(s)[0].kind, "shower");
});
test("a live turret blocks shower hits in range (with a tracer), and a down one does not", () => {
  const run1 = (turret, down) => {
    const s = hgame(4, 3);
    giveAll(s);
    if (turret) { assert.ok(G.buildAddon(s, 0, "turret").ok); s.bases[0].down = !!down; }
    const home = s.bases[0];
    liveShower(s, { x: home.x, y: home.y, r: 200, power: 10, dur: 40 });
    s.ships[0].x = home.x + 80; s.ships[0].y = home.y;
    let blocks = 0;
    for (let i = 0; i < 30 * 30; i++) { G.step(s, HDT); for (const f of s.fx) if (f.kind === "block" && f.age < HDT * 1.5) blocks++; }
    return { s, blocks };
  };
  const bare = run1(false), guarded = run1(true);
  assert.strictEqual(bare.blocks, 0);
  assert.ok(guarded.blocks > 0, "a tracer was exposed");
  assert.ok(guarded.s.bases[0].hp > bare.s.bases[0].hp, "base took less: " + guarded.s.bases[0].hp + " vs " + bare.s.bases[0].hp);
  withTuning(G.TUNING.addons.turret, "block", 1, () => {
    const all = run1(true);
    assert.strictEqual(all.s.bases[0].hp, all.s.bases[0].maxHp, "block chance 1 stops everything");
    assert.strictEqual(all.s.ships[0].hp, all.s.ships[0].maxHp);
    assert.strictEqual(all.s.hits, 0);
  });
  withTuning(G.TUNING.addons.turret, "block", 1, () => {      // a turret that is down blocks nothing
    const s = hgame(4, 3); giveAll(s); buildGoal(s);
    assert.ok(G.buildAddon(s, 1, "turret").ok);
    const b = s.bases[1], sh = s.ships[0];
    b.down = true; b.hp = 0;
    sh.x = b.x + 30; sh.y = b.y;
    liveShower(s, { x: b.x, y: b.y, r: 80, power: 5, dur: 60 });
    hrun(s, 30);
    assert.ok(sh.hp < sh.maxHp, "nothing stopped the meteors");
  });
});
test("a shower still knocks cargo off a loaded ship and the loss is counted", () => {
  const s = hgame(4, 3);
  liveShower(s, { r: 200, power: 1 });
  const sh = s.ships[0]; mid(s, sh); sh.cargo = 20; sh.res = "ore"; sh.st = G.IDLE;
  hrun(s, 30);
  assert.ok(s.hits > 0 && sh.cargo < 20 && s.stats.lost > 0);
});

// ---------------------------------------------------------------------------------------------------------------
console.log("hazards and defense: ships, health, add-ons, repair");
test("a ship at 0 HP is dead for good: it drops its cargo, takes no orders and is skipped", () => {
  const s = hgame(4, 3);
  const sh = s.ships[0], lost0 = s.stats.lost;
  sh.cargo = 15; sh.res = "ore"; sh.st = G.IDLE;
  liveShower(s, { x: sh.x, y: sh.y, r: 100, power: 99 });
  for (let i = 0; i < 30 * 20 && !sh.dead; i++) G.step(s, HDT);
  assert.ok(sh.dead && sh.hp === 0 && sh.cargo === 0 && sh.res === "" && sh.st === G.IDLE);
  assert.ok(s.stats.lost >= lost0 + 7.4, "the cargo counts as lost");
  assert.strictEqual(s.ships.length, 2, "the entry stays so ids hold");
  assert.strictEqual(G.orderShip(s, 0, nearBody(s).id).ok, false);
  assert.ok(/lost/.test(G.orderShip(s, 0, nearBody(s).id).reason));
  for (const f of [() => G.takeManual(s, 0), () => G.recallShip(s, 0), () => G.returnToBase(s, 0, 0), () => G.orderShipToStar(s, 0, 0),
    () => G.orderToTarget(s, 0, 1), () => G.orderNearestBase(s, 0), () => G.repairShip(s, 0)]) assert.strictEqual(f().ok, false);
  const x = sh.x, y = sh.y;
  s.showers = [];
  hrun(s, 5);
  assert.strictEqual(sh.x, x); assert.strictEqual(sh.y, y);
  assert.strictEqual(G.jobText(s, sh), "Lost");
  assert.deepStrictEqual(G.repairCost(s, "ship", 0), { ore: 0, ice: 0, crystal: 0 });
  assert.ok(G.deserialize(G.serialize(s)).state.ships[0].dead);
});
test("mined material is conserved when ships die: stock + cargo + lost", () => {
  const s = hgame(6, 3);
  const before = total(s, "ore");
  for (const sh of s.ships) G.orderShip(s, sh.id, nearBody(s).id);
  liveShower(s, { x: s.bases[0].x, y: s.bases[0].y, r: 5000, power: 12, dur: 1000 });
  hrun(s, 120);
  assert.ok(s.ships.some(x => x.dead), "someone died");
  assert.ok(Math.abs(total(s, "ore") + s.stats.lost - before - s.stats.ore) < 1e-6);
});
test("add-ons cost the scaled price, once per base, and need a standing base", () => {
  const s = hgame(2, 3);
  const T = G.TUNING.addons;
  const cs = G.addonCost(s, "shield"), ct = G.addonCost(s, "turret");
  assert.deepStrictEqual(cs, { ore: Math.round(T.shield.cost.ore * G.costMult(3)), ice: Math.round(T.shield.cost.ice * G.costMult(3)), crystal: 0 });
  assert.ok(ct.ore > 0);
  s.stock.ore = s.stock.ice = s.stock.crystal = 0;
  const r0 = G.buildAddon(s, 0, "turret");
  assert.ok(!r0.ok && /Not enough/.test(r0.reason) && !s.bases[0].turret);
  giveAll(s);
  const ore0 = s.stock.ore, ice0 = s.stock.ice;
  assert.ok(G.buildAddon(s, 0, "turret").ok && s.bases[0].turret);
  assert.strictEqual(s.stock.ore, ore0 - ct.ore); assert.strictEqual(s.stock.ice, ice0 - ct.ice);
  assert.ok(!G.buildAddon(s, 0, "turret").ok, "only one of each");
  assert.ok(G.buildAddon(s, 0, "shield").ok && s.bases[0].shield);
  assert.ok(!G.buildAddon(s, 0, "laser").ok); assert.ok(!G.buildAddon(s, 0, "constructor").ok); assert.ok(!G.buildAddon(s, 9, "shield").ok);
  buildGoal(s);
  const b = s.bases[1];
  b.down = true; b.hp = 0;
  assert.ok(!G.buildAddon(s, 1, "shield").ok, "a down base takes none");
  assert.ok(G.costMult(8) > G.costMult(3) && G.addonCost(hgame(2, 8), "turret").ore > ct.ore, "costs scale with the sector");
  const o = hgame(2, 3); G.retire(o); giveAll(o);
  assert.ok(!G.buildAddon(o, 0, "shield").ok);
});
test("repair: ships must be at a base, cost per HP scaled by the sector, and are held a moment", () => {
  const s = hgame(2, 3), sh = s.ships[0], home = s.bases[0];
  assert.ok(!G.repairShip(s, 0).ok, "not damaged");
  sh.hp = sh.maxHp - 10;
  const c = G.repairCost(s, "ship", 0);
  assert.strictEqual(c.ore, Math.ceil(10 * G.TUNING.repair.ship.ore * G.costMult(3) - 1e-9));
  sh.x = home.x + 400; sh.y = home.y;
  const far = G.repairShip(s, 0);
  assert.ok(!far.ok && /base/.test(far.reason));
  sh.x = home.x + G.BASE_R + 10; sh.y = home.y;
  s.stock.ore = c.ore - 1;
  assert.ok(!G.repairShip(s, 0).ok, "too little ore");
  assert.strictEqual(sh.hp, sh.maxHp - 10);
  s.stock.ore = c.ore + 5;
  assert.ok(G.repairShip(s, 0).ok);
  assert.strictEqual(s.stock.ore, 5); assert.strictEqual(sh.hp, sh.maxHp);
  assert.strictEqual(G.jobText(s, sh), "Repairing");
  hrun(s, G.TUNING.repair.time + 0.5);
  assert.ok(sh.rep === 0 && G.jobText(s, sh) !== "Repairing");
  const bigger = hgame(2, 9); bigger.ships[0].hp = bigger.ships[0].maxHp - 10;
  assert.ok(G.repairCost(bigger, "ship", 0).ore > c.ore);
});
test("a base that reaches 0 HP goes down (not home): no drop-off, no add-ons, still counted; repair brings it back", () => {
  const s = hgame(2, 3);
  giveAll(s); buildGoal(s);
  const b = s.bases[1];
  assert.ok(G.buildAddon(s, 1, "turret").ok && G.buildAddon(s, 1, "shield").ok);
  const goal = s.bases.length - 1;
  liveShower(s, { x: b.x, y: b.y, r: 40, power: 99, dur: 100 });
  hrun(s, 20);
  assert.ok(b.down && b.hp === 0, "down");
  assert.strictEqual(s.bases.length - 1, goal, "still counts toward the goal"); assert.ok(s.won);
  assert.ok(!s.over, "only the home base ends the run");
  assert.ok(!G.shielded(s, b.x, b.y));
  assert.notStrictEqual(G.nearestBase(s, b.x + 1, b.y), 1, "no drop-offs at a down base");
  const c = G.repairCost(s, "base", 1);
  assert.strictEqual(c.ore, Math.ceil(b.maxHp * G.TUNING.repair.base.ore * G.costMult(3) - 1e-9));
  assert.strictEqual(c.ice, Math.ceil(b.maxHp * G.TUNING.repair.base.ice * G.costMult(3) - 1e-9));
  s.showers = [];
  s.stock.ore = c.ore - 1; s.stock.ice = 999;
  assert.ok(!G.repairBase(s, 1).ok && b.down);
  s.stock.ore = c.ore + 3;
  assert.ok(G.repairBase(s, 1).ok);
  assert.ok(!b.down && b.hp === b.maxHp && b.turret && b.shield, "back, add-ons intact");
  assert.strictEqual(s.stock.ore, 3);
  assert.ok(!G.repairBase(s, 1).ok, "not damaged");
  // a ship heading for a down base's drop-off goes to a live one
  b.down = true; b.hp = 0;
  const sh = s.ships[0]; sh.cargo = 10; sh.res = "ore"; sh.st = G.TO_BASE; sh.dest = 1; sh.x = b.x + 30; sh.y = b.y;
  hrun(s, 40);
  assert.strictEqual(sh.cargo, 0, "it unloaded somewhere");
});
test("the home base at 0 HP ends the run as destroyed", () => {
  const s = hgame(2, 3), home = s.bases[0];
  home.hp = 5;
  liveShower(s, { x: home.x, y: home.y, r: 100, power: 99, dur: 100 });
  hrun(s, 20);
  assert.ok(s.over && s.endReason === "destroyed" && home.hp === 0 && !home.down);
  const t = s.time;
  hrun(s, 5);
  assert.strictEqual(s.time, t, "the sim stops");
  assert.ok(!G.buildAddon(s, 0, "turret").ok && !G.repairBase(s, 0).ok);
  const back = G.deserialize(G.serialize(s)).state;
  assert.ok(back.over && back.endReason === "destroyed" && back.bases[0].hp === 0);
  assert.strictEqual(G.serialize(back), G.serialize(s));
});
test("health is capped and a garbage-hp ship or base loads clamped", () => {
  const s = hgame(2, 3), raw = JSON.parse(G.serialize(s));
  raw.ships[0].hp = 99999; raw.ships[1].hp = "x"; raw.bases[0].hp = -50; raw.bases[0].shield = "yes"; raw.bases[0].turret = 1;
  const r = G.deserialize(JSON.stringify(raw)).state;
  assert.strictEqual(r.ships[0].hp, r.ships[0].maxHp); assert.strictEqual(r.ships[1].hp, r.ships[1].maxHp);
  assert.strictEqual(r.bases[0].hp, 1, "a home base cannot sit at 0 HP in a running game");
  assert.strictEqual(r.bases[0].shield, false); assert.strictEqual(r.bases[0].turret, false);
});

// ---------------------------------------------------------------------------------------------------------------
console.log("hazards and defense: aliens");
function raid(s, o) {   // a live raid warning with a chosen point; it spawns after the warning
  const e = { kind: "raid", x: 20, y: 300, r: 40, age: 0, warn: G.TUNING.events.warn, dur: 0, power: G.alienCount(s.sector) };
  Object.assign(e, o || {}); s.events.push(e); return e;
}
function alien(s, x, y) {
  const al = { id: s.alienSeq++, x, y, vx: 0, vy: 0, hp: G.alienHp(s.sector), maxHp: G.alienHp(s.sector), dmg: G.alienDmg(s.sector), cd: 0.5, tgtKind: "", tgt: -1 };
  s.aliens.push(al); return al;
}
test("aliens never come before sector 3, however long you wait", () => {
  for (const n of [1, 2]) {
    const s = G.newGame(14, n);
    s.showerIn = 1e9;
    for (let i = 0; i < 30 * 900; i++) { G.step(s, HDT); assert.strictEqual(s.aliens.length, 0); for (const e of s.events) assert.notStrictEqual(e.kind, "raid"); }
  }
});
test("a raid warns for 10 s at an edge point, then spawns the sector's count of aliens there", () => {
  const s = hgame(5, 3);
  raid(s);
  assert.strictEqual(G.eventWarnings(s)[0].kind, "raid");
  hrun(s, 9);
  assert.strictEqual(s.aliens.length, 0);
  hrun(s, 2);
  assert.strictEqual(s.aliens.length, G.alienCount(3));
  assert.strictEqual(s.events.length, 0, "the raid event is spent");
  for (const a of s.aliens) {
    assert.ok(a.hp === G.alienHp(3) && a.maxHp === a.hp && a.dmg === G.alienDmg(3));
    assert.ok(a.x >= 0 && a.x <= s.w && a.y >= 0 && a.y <= s.h);
  }
  assert.deepStrictEqual(s.aliens.map(a => a.id), s.aliens.map((a, i) => i), "ids from alienSeq");
  assert.strictEqual(s.alienSeq, G.alienCount(3));
  // rolled raids sit on an edge
  const t = G.newGame(21, 4); t.showerIn = 1e9;
  let seen = 0;
  for (let i = 0; i < 30 * 2000 && seen < 3; i++) {
    G.step(t, HDT);
    for (const ev of t.events) if (ev.kind === "raid" && ev.age < HDT * 1.5) {
      seen++;
      assert.ok(ev.x === G.TUNING.aliens.edge || ev.x === t.w - G.TUNING.aliens.edge || ev.y === G.TUNING.aliens.edge || ev.y === t.h - G.TUNING.aliens.edge, "edge");
      assert.strictEqual(ev.power, G.alienCount(4));
    }
  }
  assert.ok(seen >= 1, "a raid was rolled");
});
test("the alien count is capped by TUNING.aliens.max", () => {
  const s = hgame(5, 10);
  s.aliens = []; for (let i = 0; i < G.TUNING.aliens.max - 1; i++) alien(s, 5, 5);
  raid(s, { age: 10 });
  hrun(s, 0.2);
  assert.strictEqual(s.aliens.length, G.TUNING.aliens.max);
});
test("an alien chases the nearest loaded ship in sense range, else the nearest base, and shoots", () => {
  const s = hgame(5, 3), home = s.bases[0], A = G.TUNING.aliens;
  const a = alien(s, home.x + 800, home.y);
  s.ships[0].x = home.x + 800 - 200; s.ships[0].y = home.y; s.ships[0].cargo = 10; s.ships[0].res = "ore";   // loaded, in sense
  s.ships[1].x = home.x + 800 - 100; s.ships[1].y = home.y;                                                      // empty and nearer
  s.ships[0].st = G.IDLE;
  G.step(s, HDT);
  assert.strictEqual(a.tgtKind, "ship"); assert.strictEqual(a.tgt, 0, "the loaded one, not the nearer empty one");
  const d0 = Math.hypot(a.x - s.ships[0].x, a.y - s.ships[0].y);
  hrun(s, 1);
  assert.ok(Math.hypot(a.x - s.ships[0].x, a.y - s.ships[0].y) < d0, "closing in");
  s.ships[0].cargo = 0;                         // now nothing loaded: it heads for the base
  G.step(s, HDT);
  assert.strictEqual(a.tgtKind, "base"); assert.strictEqual(a.tgt, 0);
  const far = alien(s, home.x + 1200, home.y + 300);
  s.ships[0].cargo = 10; s.ships[0].x = home.x; s.ships[0].y = home.y;      // loaded but outside sense
  G.step(s, HDT);
  assert.strictEqual(far.tgtKind, "base");
  assert.ok(A.sense < 1200);
  // it stops at range and fires
  const t = hgame(5, 3), h2 = t.bases[0];
  for (const sh of t.ships) { sh.x = 5; sh.y = 5; }        // keep the ships out of the line of fire
  const b = alien(t, h2.x + 400, h2.y);
  hrun(t, 12);
  const d = Math.hypot(b.x - h2.x, b.y - h2.y);
  assert.ok(d < A.range + G.BASE_R + 5 && d > 50, "holds at range, was " + d);
  assert.ok(h2.hp < h2.maxHp, "it hurt the base");
});
test("alien shots hurt ships, a shot is removed when it hits, and the shot list is capped", () => {
  const s = hgame(5, 3), A = G.TUNING.aliens;
  const a = alien(s, 400, 400);
  const sh = s.ships[0]; sh.x = 500; sh.y = 400; sh.cargo = 10; sh.res = "ore"; sh.st = G.IDLE;
  const hp0 = sh.hp;
  a.cd = 0;
  hrun(s, 3);
  assert.ok(sh.hp < hp0 || sh.dead, "ship took damage");
  const c = hgame(5, 3);
  for (let i = 0; i < G.TUNING.combat.maxShots; i++) c.shots.push({ x: 5, y: 5, vx: 0, vy: 0, life: 100, dmg: 1, side: "them" });
  const al = alien(c, 600, 600); al.cd = 0;
  c.bases[0].x = 650; c.bases[0].y = 600;
  hrun(c, 1);
  assert.strictEqual(c.shots.length, G.TUNING.combat.maxShots, "a full list takes no more shots");
  assert.strictEqual(al.cd, 0, "and the alien holds its fire for the next chance");
  const raw = JSON.parse(G.serialize(c));
  for (let i = 0; i < 200; i++) raw.shots.push({ x: 5, y: 5, vx: 0, vy: 0, life: 100, dmg: 1, side: "them" });
  const r = G.deserialize(JSON.stringify(raw)).state;
  assert.ok(r.shots.length <= G.TUNING.combat.maxShots, "loaded shots are capped");
});
test("a turret shoots aliens in range; a kill scores points and counts, and may leave a star", () => {
  const s = hgame(7, 3); giveAll(s);
  G.buildAddon(s, 0, "turret");
  const home = s.bases[0], T = G.TUNING.addons.turret;
  const a = alien(s, home.x + 120, home.y); a.hp = 20; a.maxHp = 20; a.cd = 100;
  const stars0 = s.stars.length, sc0 = G.scoreTotal(s);
  withTuning(G.TUNING.aliens, "starChance", 1, () => hrun(s, 4));
  assert.strictEqual(s.aliens.length, 0, "dead");
  assert.strictEqual(s.stats.kills, 1); assert.strictEqual(s.score.kills, G.TUNING.aliens.score);
  assert.strictEqual(G.scoreTotal(s) - sc0, G.TUNING.aliens.score, "scoreTotal adds the kills");
  assert.strictEqual(s.stars.length, stars0 + 1, "a star where it fell");
  const st = s.stars[stars0];
  assert.ok(!st.taken && st.id === stars0 && st.x > 0 && st.x < s.w && Math.abs(st.x - (home.x + 120)) < 60);
  assert.ok(T.range > 120);
  // chance zero: no star; out of range: no shot
  const t = hgame(7, 3); giveAll(t); G.buildAddon(t, 0, "turret");
  const b = alien(t, t.bases[0].x + T.range + 200, t.bases[0].y); b.hp = 1; b.cd = 100; b.vx = 0;
  withTuning(G.TUNING.aliens, "starChance", 0, () => hrun(t, 0.5));
  assert.strictEqual(t.shots.filter(x => x.side === "us").length, 0, "out of range, no shooting");
  const u = hgame(7, 3); giveAll(u); G.buildAddon(u, 0, "turret");
  const c = alien(u, u.bases[0].x + 100, u.bases[0].y); c.hp = 1; c.cd = 100;
  const n0 = u.stars.length;
  withTuning(G.TUNING.aliens, "starChance", 0, () => hrun(u, 3));
  assert.strictEqual(u.aliens.length, 0); assert.strictEqual(u.stars.length, n0);
  // a star picked up from a kill pays like any star
  const k = hgame(7, 3); giveAll(k); G.buildAddon(k, 0, "turret");
  const d = alien(k, k.bases[0].x + 100, k.bases[0].y); d.hp = 1; d.cd = 100;
  withTuning(G.TUNING.aliens, "starChance", 1, () => hrun(k, 3));
  const star = k.stars[k.stars.length - 1];
  assert.ok(G.orderShipToStar(k, 0, star.id).ok);
  hrun(k, 60);
  assert.ok(star.taken);
  const p = G.newProfile(); assert.ok(G.claimStars(p, k) >= 1);
});
test("kills survive a save; score.kills is part of the total", () => {
  const s = hgame(7, 3); s.score.kills = 75; s.stats.kills = 3;
  const r = G.deserialize(G.serialize(s)).state;
  assert.strictEqual(r.score.kills, 75); assert.strictEqual(r.stats.kills, 3);
  assert.strictEqual(G.scoreTotal(r), G.scoreTotal(s));
  assert.strictEqual(G.runRecord(r, "p1", "retired", NOW).parts.kills, 75);
  const raw = JSON.parse(G.serialize(s)); raw.score.kills = "x"; raw.stats.kills = -5;
  const b = G.deserialize(JSON.stringify(raw)).state;
  assert.strictEqual(b.score.kills, 0); assert.strictEqual(b.stats.kills, 0);
});

// ---------------------------------------------------------------------------------------------------------------
console.log("hazards and defense: warships");
function warship(s) { giveAll(s); const r = G.buildShip(s, "warship"); assert.ok(r.ok, r.reason); return r.ship; }
test("a warship costs the scaled price, carries nothing and has its own health", () => {
  const s = hgame(3, 3);
  const c = G.shipCost(s, "warship");
  assert.ok(c.ore > 0);
  s.stock.ore = c.ore - 1; s.stock.ice = 999;
  assert.ok(!G.buildShip(s, "warship").ok);
  s.stock.ore = c.ore;
  const r = G.buildShip(s, "warship");
  assert.ok(r.ok && r.ship.name === "Warship 1" && r.ship.hp === G.SHIP_TYPES.warship.hp && r.ship.wo === "");
  assert.strictEqual(r.ship.id, 2);
  assert.strictEqual(G.shipLabel(r.ship, G.labelsFor("hamster")), "Warship 1");
  assert.strictEqual(G.jobText(s, r.ship).indexOf("On guard"), 0);
});
test("a warship refuses every mining order with a clear reason", () => {
  const s = hgame(3, 3), w = warship(s), b = nearBody(s);
  for (const f of [() => G.orderShip(s, w.id, b.id), () => G.orderToTarget(s, w.id, 1), () => G.orderShipToStar(s, w.id, 0),
    () => G.orderToTarget(s, w.id, s.bodies.length + 1)]) {
    const r = f(); assert.strictEqual(r.ok, false); assert.ok(/warship/i.test(r.reason) && /mine/.test(r.reason), r.reason);
  }
  assert.ok(G.takeManual(s, w.id).ok, "may be hand-flown");
  mid(s, w); placeBeside(s, w, b);
  const m = G.manualAction(s, w.id);
  assert.strictEqual(m.ok, false); assert.ok(/mine/.test(m.reason));
  assert.strictEqual(w.mm, 0); assert.strictEqual(w.cargo, 0);
  w.x = mid(s, w).x; G.setManualInput(s, w.id, 1, 0);
  const x0 = w.x;
  hrun(s, 1);
  assert.ok(w.x > x0 + 50, "flies by hand");
  assert.ok(!G.orderPatrol(s, 0, 100, 100).ok, "a miner takes no warship orders");
  assert.ok(!G.orderEscort(s, 0, 1).ok && !G.orderAttack(s, 0, 0).ok);
});
test("patrol: the warship flies to the point and holds; recall sends it to guard the base", () => {
  const s = hgame(3, 3), w = warship(s), home = s.bases[0];
  assert.ok(G.orderPatrol(s, w.id, home.x + 300, home.y + 100).ok);
  assert.strictEqual(w.wo, "patrol"); assert.strictEqual(G.jobText(s, w), "Patrolling");
  hrun(s, 6);
  assert.ok(Math.hypot(w.x - (home.x + 300), w.y - (home.y + 100)) < 1, "arrived");
  const x = w.x; hrun(s, 2); assert.strictEqual(w.x, x);
  assert.ok(!G.orderPatrol(s, w.id, -5, 10).ok && !G.orderPatrol(s, w.id, NaN, 10).ok && !G.orderPatrol(s, w.id, 10, s.h + 5).ok);
  assert.ok(G.recallShip(s, w.id).ok && w.wo === "patrol");
  hrun(s, 8);
  assert.ok(Math.hypot(w.x - home.x, w.y - home.y) < 80);
  assert.ok(G.orderNearestBase(s, w.id).ok);
});
test("escort: the warship follows its ship; if that ship is lost it holds where it is", () => {
  const s = hgame(3, 3), w = warship(s);
  const m = s.ships[0]; G.orderShip(s, 0, nearBody(s).id);
  assert.ok(G.orderEscort(s, w.id, 0).ok && w.wo === "escort" && w.wt === 0);
  assert.ok(/Escorting Miner 1/.test(G.jobText(s, w)));
  hrun(s, 20);
  assert.ok(Math.hypot(w.x - m.x, w.y - m.y) < G.SHIP_TYPES.warship.follow + 40, "stays close");
  assert.ok(!G.orderEscort(s, w.id, w.id).ok && !G.orderEscort(s, w.id, 99).ok);
  m.dead = true; m.hp = 0;
  assert.ok(!G.orderEscort(s, w.id, 0).ok, "cannot escort a lost ship");
  hrun(s, 1);
  assert.strictEqual(w.wo, "patrol");
  const x = w.x; hrun(s, 2); assert.strictEqual(w.x, x);
});
test("attack: the warship hunts the ordered alien, shoots it down, and fires automatically at others in range", () => {
  const s = hgame(3, 3), w = warship(s), home = s.bases[0];
  const a = alien(s, home.x + 500, home.y); a.cd = 1000;
  assert.ok(!G.orderAttack(s, w.id, 99).ok);
  assert.strictEqual(G.nearestAlien(s, w.x, w.y), a.id);
  assert.ok(G.orderAttack(s, w.id, a.id).ok && w.wo === "attack" && w.wt === a.id);
  assert.ok(/Attacking/.test(G.jobText(s, w)));
  hrun(s, 40);
  assert.strictEqual(s.aliens.length, 0, "killed");
  assert.strictEqual(s.stats.kills, 1);
  assert.strictEqual(w.wo, "patrol", "then it holds its position");
  assert.strictEqual(G.nearestAlien(s, 0, 0), -1);
  // auto-fire without an order, only inside the range
  const t = hgame(3, 3), w2 = warship(t), h2 = t.bases[0];
  w2.x = h2.x + 60; w2.y = h2.y; w2.st = G.IDLE;
  assert.strictEqual(w2.wo, "");
  const near = alien(t, h2.x + 260, h2.y); near.cd = 1000;
  hrun(t, 15);
  assert.strictEqual(t.aliens.length, 0, "shot without any order, as it came to the base");
  assert.strictEqual(t.stats.kills, 1);
  const u = hgame(3, 3), w3 = warship(u);
  w3.x = 800; w3.y = 500;
  const farA = alien(u, 800 + G.SHIP_TYPES.warship.range + 100, 500); farA.cd = 1000;
  u.bases[0].x = 3000; u.bases[0].y = 3000;
  hrun(u, 0.3);
  assert.strictEqual(u.shots.filter(x => x.side === "us").length, 0, "out of range: no shot");
  // hand-flown warships fire too
  const m = hgame(3, 3), w4 = warship(m);
  G.takeManual(m, w4.id); w4.x = 700; w4.y = 500;
  const na = alien(m, 760, 500); na.cd = 1000;
  hrun(m, 6);
  assert.ok(na.hp < na.maxHp || m.aliens.length === 0, "it fired without any order");
});
test("a warship is stunned by flares like any ship, and a down order target is dropped", () => {
  const s = hgame(3, 3), w = warship(s);
  G.orderPatrol(s, w.id, 100, 100);
  const x0 = w.x;
  liveEvent(s, "flare", { r: 0 });
  hrun(s, 1);
  assert.ok(w.stun > 0 && w.x === x0);
  const t = hgame(3, 3), w2 = warship(t);
  assert.ok(t.ships.length === 3);
  G.orderAttack(t, w2.id, alien(t, 900, 900).id);
  t.aliens.length = 0;
  hrun(t, 0.2);
  assert.strictEqual(w2.wo, "patrol", "its target is gone");
});
test("a warship can be lost like any ship, and then takes no orders", () => {
  const s = hgame(3, 3), w = warship(s);
  G.orderPatrol(s, w.id, 700, 500);
  hrun(s, 10);
  liveShower(s, { x: 700, y: 500, r: 100, power: 99 });
  hrun(s, 15);
  assert.ok(w.dead && w.wo === "" && G.jobText(s, w) === "Lost");
  for (const f of [() => G.orderPatrol(s, w.id, 100, 100), () => G.orderEscort(s, w.id, 0), () => G.orderAttack(s, w.id, 0)]) assert.strictEqual(f().ok, false);
  assert.ok(G.deserialize(G.serialize(s)).state.ships[w.id].dead);
});

// ---------------------------------------------------------------------------------------------------------------
console.log("hazards and defense: save and load");
test("a save in the middle of a raid round-trips exactly and plays on identically", () => {
  const a = G.newGame(17, 3);
  giveAll(a); G.buildAddon(a, 0, "turret"); G.buildAddon(a, 0, "shield"); warship(a);
  G.orderPatrol(a, 2, a.bases[0].x + 200, a.bases[0].y);
  for (const sh of a.ships) if (!sh.dead && sh.type !== "warship") G.orderShip(a, sh.id, nearBody(a).id);
  a.events.push({ kind: "raid", x: 20, y: 400, r: 40, age: 6, warn: 10, dur: 0, power: 3 });
  a.events.push({ kind: "fog", x: 500, y: 400, r: 150, age: 12, warn: 10, dur: 40, power: 1 });
  a.events.push({ kind: "flare", x: 0, y: 0, r: 0, age: 3, warn: 10, dur: 12, power: 1 });
  alien(a, 900, 500); alien(a, 950, 520);
  hrun(a, 20);
  assert.ok(a.aliens.length >= 2 && a.shots.length + a.fx.length >= 0);
  const text = G.serialize(a);
  const r = G.deserialize(text);
  assert.ok(r.ok, r.error);
  assert.strictEqual(noMv(G.serialize(r.state)), noMv(text), "identical state (mv, the draw-only moving flag, is not saved)");
  hrun(a, 60); hrun(r.state, 60);
  assert.strictEqual(noMv(G.serialize(a)), noMv(G.serialize(r.state)), "and the same future");
});
test("a save with shots in flight, dead ships, down bases and add-ons round-trips", () => {
  const s = hgame(18, 3); giveAll(s); buildGoal(s);
  G.buildAddon(s, 1, "turret");
  s.bases[2].down = true; s.bases[2].hp = 0;
  s.ships[1].dead = true; s.ships[1].hp = 0;
  s.shots.push({ x: 100, y: 100, vx: 50, vy: -20, life: 0.5, dmg: 4, side: "them" });
  s.fx.push({ kind: "block", x: 1, y: 2, x2: 3, y2: 4, age: 0.1, life: 0.4 });
  const w = warship(s); G.orderEscort(s, w.id, 0);
  const r = G.deserialize(G.serialize(s)).state;
  assert.strictEqual(G.serialize(r), G.serialize(s));
  assert.ok(r.bases[2].down && r.bases[1].turret && r.ships[1].dead && r.ships[w.id].wo === "escort");
});
test("an old save (before this branch) loads with full health, no add-ons and no hazards in progress", () => {
  const s = G.newGame(23, 3);
  const raw = JSON.parse(G.serialize(s));
  for (const k of ["events", "eventIn", "alienSeq", "aliens", "shots", "fx"]) delete raw[k];
  delete raw.score.kills; delete raw.stats.kills;
  for (const b of raw.bases) for (const k of ["hp", "maxHp", "shield", "turret", "down", "cd"]) delete b[k];
  for (const x of raw.ships) for (const k of ["hp", "maxHp", "dead", "stun", "rep", "wo", "wx", "wy", "wt", "cd"]) delete x[k];
  raw.showerIn = 17; raw.showers = [{ x: 400, y: 300, r: 120, age: 4 }];
  const r = G.deserialize(JSON.stringify(raw));
  assert.ok(r.ok, r.error);
  const o = r.state;
  assert.ok(o.ships.every(x => x.hp === x.maxHp && !x.dead && x.stun === 0 && x.wo === ""));
  assert.ok(o.bases.every(b => b.hp === b.maxHp && !b.shield && !b.turret && !b.down));
  assert.strictEqual(o.bases[0].maxHp, G.TUNING.combat.homeHp);
  assert.strictEqual(o.aliens.length, 0); assert.strictEqual(o.shots.length, 0); assert.strictEqual(o.events.length, 0);
  assert.strictEqual(o.score.kills, 0); assert.strictEqual(o.stats.kills, 0);
  assert.strictEqual(o.showerIn, 17); assert.strictEqual(o.showers[0].age, 4);
  assert.strictEqual(o.showers[0].warn, 10, "an old shower now warns for the new 10 s");
  assert.strictEqual(o.eventIn, G.TUNING.events.firstDelay);
  assert.strictEqual(o.ver, G.VERSION);
  hrun(o, 30);
  for (const x of o.ships) assert.ok(isFinite(x.x) && isFinite(x.hp));
  const v1 = oldSave();
  const l1 = G.deserialize(JSON.stringify(v1));
  assert.ok(l1.ok && l1.state.bases[0].hp === G.TUNING.combat.homeHp && l1.state.eventIn === 0 && l1.state.ships[0].hp > 0);
  assert.strictEqual(Object.keys(l1.state).join(), Object.keys(G.newGame(1)).join(), "same key order as a fresh state");
});
test("damaged hazard data in a save clamps or is dropped, and never throws", () => {
  const good = JSON.parse(G.serialize((() => { const s = G.newGame(24, 3); alien(s, 100, 100); s.events.push({ kind: "fog", x: 5, y: 5, r: 100, age: 1, warn: 10, dur: 40, power: 1 }); return s; })()));
  const junk = [null, 5, "x", [], {}, NaN, -1, 1e12, true];
  for (const key of ["events", "eventIn", "alienSeq", "aliens", "shots", "fx", "showers"]) {
    for (const v of junk) {
      const c = JSON.parse(JSON.stringify(good)); c[key] = v;
      const r = G.deserialize(JSON.stringify(c));
      assert.ok(typeof r.ok === "boolean");
      if (r.ok) { hrun(r.state, 3); for (const x of r.state.ships) assert.ok(isFinite(x.x)); for (const a of r.state.aliens) assert.ok(isFinite(a.x) && isFinite(a.hp)); }
    }
  }
  const c = JSON.parse(JSON.stringify(good));
  c.aliens = [null, { id: 1, x: "a", y: 1e9, hp: -5 }, { id: 7, x: 10, y: 10, hp: 999999, maxHp: 50, dmg: -4, tgtKind: "zzz", tgt: 5 }, { id: 7, x: 20, y: 20, hp: 5, maxHp: 5 }];
  c.events = [{ kind: "meteor" }, { kind: "fog", x: -50, y: 1e9, r: 1e9, age: -3, warn: -4, dur: 1e9, power: -2 }, null, 4];
  c.shots = [{ side: "x" }, { side: "us", x: 1, y: 1, vx: 1e9, life: 1e9, dmg: 1e9 }, null];
  c.ships[0].hp = -3; c.ships[1].stun = 1e9; c.ships[1].wo = "attack"; c.ships[1].rep = -4;
  c.bases[0].hp = "x";
  const r = G.deserialize(JSON.stringify(c));
  assert.ok(r.ok, r.error);
  const o = r.state;
  assert.strictEqual(o.aliens.length, 2, "the dead-on-arrival and the empty entries are dropped");
  assert.strictEqual(new Set(o.aliens.map(a => a.id)).size, 2, "ids stay unique");
  assert.ok(o.alienSeq > Math.max(...o.aliens.map(a => a.id)));
  assert.ok(o.aliens.every(a => a.hp <= a.maxHp && a.dmg >= 0 && (a.tgtKind === "" || a.tgtKind === "ship" || a.tgtKind === "base")));
  assert.strictEqual(o.events.length, 1);
  assert.ok(o.events[0].x === 0 && o.events[0].y === o.h && o.events[0].r <= 600 && o.events[0].age === 0 && o.events[0].dur <= 300);
  assert.strictEqual(o.shots.length, 1); assert.ok(Math.abs(o.shots[0].vx) <= 2000 && o.shots[0].life <= 10);
  assert.ok(o.ships[0].dead, "hp <= 0 means lost"); assert.ok(o.ships[1].stun <= 60 && o.ships[1].rep === 0 && o.ships[1].wo === "");
  assert.strictEqual(o.bases[0].hp, o.bases[0].maxHp);
  hrun(o, 5);
});

// ---------------------------------------------------------------------------------------------------------------
console.log("hazards and defense: balance and cost");
// A simple scripted player: keep every miner mining (ice when it is short, else ore), buy a turret, a shield and
// one warship in that order when affordable (all in the first minutes of sector 3), park the warship at home, repair what
// is damaged when it can. Returns the finished state.
function scripted(seed, secs, defend) {
  const s = G.newGame(seed, 3);
  let warId = -1;
  const pick = (res, ship) => {
    let best = null, bd = Infinity;
    for (const b of s.bodies) {
      if (b.res !== res || b.amount <= 1e-6) continue;
      const d = Math.hypot(b.x - ship.x, b.y - ship.y);
      if (d < bd) { bd = d; best = b; }
    }
    return best;
  };
  const brain = () => {
    const iceNeed = defend ? 40 * 3 : 0;
    let n = 0;
    for (const sh of s.ships) {
      if (sh.dead || sh.type === "warship") continue;
      if (sh.st === G.IDLE) {
        const wantIce = s.stock.ice < iceNeed && n % 2 === 1;
        const b = (wantIce && pick("ice", sh)) || pick("ore", sh) || pick("ice", sh);
        if (b) G.orderShip(s, sh.id, b.id);
      }
      n++;
    }
    if (defend) {
      if (!s.bases[0].turret) G.buildAddon(s, 0, "turret");
      else if (!s.bases[0].shield) G.buildAddon(s, 0, "shield");
      else if (warId < 0) { const r = G.buildShip(s, "warship"); if (r.ok) { warId = r.ship.id; G.orderPatrol(s, warId, s.bases[0].x + 70, s.bases[0].y + 40); } }
      else if (s.bases[0].hp < s.bases[0].maxHp * 0.6) G.repairBase(s, 0);
    }
    for (const sh of s.ships) if (!sh.dead && sh.hp < sh.maxHp * 0.5 && sh.st === G.IDLE) G.repairShip(s, sh.id);
  };
  for (let i = 0; i < Math.round(secs * 30); i++) {
    if (i % 30 === 0) brain();
    G.step(s, HDT);
    if (s.over) break;
  }
  return s;
}
test("balance: a sensible run (auto-mine, turret + shield + one warship) survives 5 minutes of sector 3", () => {
  let spawned = 0, raided = 0;
  for (const seed of [1, 2, 3, 4, 5, 6]) {
    const s = scripted(seed, 300, true);
    spawned += s.alienSeq; if (s.alienSeq > 0) raided++;
    assert.ok(!s.over && s.bases[0].hp > 0, "seed " + seed + " lost the home base at " + Math.floor(s.time) + " s");
    assert.ok(s.bases[0].turret && s.bases[0].shield, "seed " + seed + " bought its defenses");
    assert.ok(s.ships.some(x => x.type === "warship"), "seed " + seed + " bought a warship");
    assert.ok(s.stats.ore > 100, "and mined");
  }
  assert.ok(spawned > 0, "the sim really saw aliens");
  assert.ok(raided >= 3, "at least half the seeds saw a raid (" + raided + " of 6)");
});
test("raiders leave: an un-fought raid flies to the nearest edge after 'stay' and is gone, with no score", () => {
  const A = G.TUNING.aliens;
  assert.strictEqual(A.stay, 90);
  const s = hgame(2, 3);
  s.bases[0].hp = s.bases[0].maxHp = 1e9;
  const a = alien(s, 300, 600), b = alien(s, s.w - 100, 700);
  a.age = 0; b.age = 0;
  const score0 = s.score.kills, kills0 = s.stats.kills;
  hrun(s, A.stay - 2);
  assert.strictEqual(s.aliens.length, 2, "still here before stay");
  hrun(s, 4);
  assert.ok(s.aliens.every(x => x.tgtKind === ""), "no longer chasing");
  for (const x of s.aliens) assert.ok(x.vx !== 0 || x.vy !== 0, "moving off");
  hrun(s, 15);
  assert.strictEqual(s.aliens.length, 0, "gone");
  assert.strictEqual(s.score.kills, score0); assert.strictEqual(s.stats.kills, kills0);
  assert.ok(!s.over);
});
test("an old alien does not shoot while leaving, and age is saved and loaded (old saves default 0)", () => {
  const s = hgame(2, 3);
  s.bases[0].hp = s.bases[0].maxHp = 1e9;
  const a = alien(s, s.bases[0].x + 100, s.bases[0].y); a.age = 100; a.cd = 0;
  hrun(s, 1);
  assert.strictEqual(s.shots.length, 0);
  const t = hgame(2, 3), b = alien(t, 500, 500); b.age = 33;
  const r = G.deserialize(G.serialize(t));
  assert.ok(r.ok); assert.strictEqual(r.state.aliens[0].age, 33);
  const raw = JSON.parse(G.serialize(t)); delete raw.aliens[0].age;
  const o = G.deserialize(JSON.stringify(raw));
  assert.ok(o.ok); assert.strictEqual(o.state.aliens[0].age, 0);
  raw.aliens[0].age = "x";
  assert.strictEqual(G.deserialize(JSON.stringify(raw)).state.aliens[0].age, 0);
});
test("balance: with no defence the home base can still be standing at 5 minutes (raiders leave)", () => {
  let alive = 0;
  for (let seed = 1; seed <= 12; seed++) {
    const s = scripted(seed, 300, false);
    if (!s.over && s.bases[0].hp > 0) alive++;
  }
  console.log("      no-defence survivors: " + alive + " of 12");
  assert.ok(alive >= 1, "at least one seed survives undefended");
});
test("step with a zero, negative or NaN dt changes nothing and leaves no NaN", () => {
  const s = hgame(2, 3);
  const a = alien(s, 600, 600); alien(s, 700, 650);
  s.shots.push({ x: 5, y: 5, vx: 1, vy: 1, life: 1, dmg: 1, side: "them" });
  hrun(s, 3);
  const before = G.serialize(s);
  for (const dt of [0, -1, NaN, undefined, Infinity * 0]) G.step(s, dt);
  assert.strictEqual(G.serialize(s), before);
  for (const x of s.aliens) assert.ok(isFinite(x.x) && isFinite(x.y) && isFinite(x.vx) && isFinite(x.vy));
  for (const x of s.shots) assert.ok(isFinite(x.x) && isFinite(x.vx));
  assert.ok(G.deserialize(G.serialize(s)).ok);
  assert.ok(a.age > 0);
});
test("upgradeBase refuses a down base, like buildAddon", () => {
  const s = hgame(2, 3);
  s.stock.ore = s.stock.ice = s.stock.crystal = 99999;
  s.bases[0].down = true;
  const stock = JSON.stringify(s.stock), tier = s.bases[0].tier;
  const r = G.upgradeBase(s, 0);
  assert.ok(!r.ok && /down/i.test(r.reason) && /Repair/.test(r.reason));
  assert.strictEqual(r.reason, G.buildAddon(s, 0, "turret").reason);
  assert.strictEqual(JSON.stringify(s.stock), stock); assert.strictEqual(s.bases[0].tier, tier);
  s.bases[0].down = false;
  assert.ok(G.upgradeBase(s, 0).ok);
});
test("balance: aliens are a real threat, an undefended base can fall to a long raid", () => {
  const s = hgame(2, 3);
  for (let i = 0; i < 4; i++) alien(s, s.bases[0].x + 200 + i * 10, s.bases[0].y);
  hrun(s, 120);
  assert.ok(s.over && s.endReason === "destroyed", "four aliens beat an undefended home base");
});
test("losing every miner with no stock for a new one strands the run; with stock it plays on", () => {
  const s = hgame(26, 3);
  for (const sh of s.ships) { sh.dead = true; sh.hp = 0; }
  s.stock.ore = G.shipCost(s, "miner").ore;
  assert.ok(!G.isStranded(s), "can still buy a miner");
  s.stock.ore = G.shipCost(s, "miner").ore - 1;
  assert.ok(G.isStranded(s));
  hrun(s, 3);
  assert.ok(s.over && s.endReason === "stranded");
  const t = hgame(26, 3);
  t.ships[0].dead = true; t.ships[0].hp = 0; t.stock.ore = 0;
  assert.ok(!G.isStranded(t), "one miner left");
});
test("stress: 30 ships and 15 aliens stay cheap and finite", () => {
  const s = G.spawnStress(G.newGame(7, 3), 30, 15);
  assert.strictEqual(s.ships.length, 30); assert.strictEqual(s.aliens.length, 15);
  assert.ok(s.stress && s.ships.every(x => x.st === G.TO_BODY));
  assert.deepStrictEqual(G.spawnStress(s, 30, 15).aliens.length, 15, "topping up twice adds none");
  const t0 = Date.now();
  for (let i = 0; i < 60 * 60; i++) G.step(s, DT);
  const ms = Date.now() - t0;
  assert.ok(ms < 2500, "60 simulated seconds took " + ms + " ms");
  assert.ok(s.shots.length <= G.TUNING.combat.maxShots);
  for (const x of s.ships) assert.ok(isFinite(x.x) && isFinite(x.y) && isFinite(x.hp));
  for (const a of s.aliens) assert.ok(isFinite(a.x) && isFinite(a.y));
  const only = G.spawnStress(G.newGame(7), 30);
  assert.strictEqual(only.aliens.length, 0, "the old call has no aliens");
  const one = G.spawnStress(G.newGame(7), 4, 2);
  assert.strictEqual(one.aliens.length, 2, "even in sector 1, for ?stress");
  assert.strictEqual(G.serialize(G.spawnStress(G.newGame(7), 30, 15)), G.serialize(G.spawnStress(G.newGame(7), 30, 15)), "deterministic");
});
test("everything main.js takes from FleetGame (G.name) and from the game state still exists", () => {
  const src = require("fs").readFileSync(__dirname + "/main.js", "utf8");
  const names = new Set([...src.matchAll(/\bG\.([A-Za-z_]+)/g)].map(m => m[1]));
  assert.ok(names.size > 40);
  for (const n of names) assert.ok(n in G, "G." + n);
  const s = G.newGame(1, 3), fields = new Set([...src.matchAll(/\bgame\.([A-Za-z_]+)/g)].map(m => m[1]));
  fields.delete("js");
  for (const f of fields) assert.ok(f in s, "game." + f);
});
test("a quiet sector 1 costs nothing extra per step", () => {
  const s = G.spawnStress(G.newGame(7), 30);
  const t0 = Date.now();
  for (let i = 0; i < 60 * 30; i++) G.step(s, DT);
  assert.ok(Date.now() - t0 < 1000);
});
test("warping to the next sector clears events, aliens and shots and keeps lost ships lost", () => {
  const s = hgame(25, 3);
  buildGoal(s);
  alien(s, 100, 100); s.shots.push({ x: 1, y: 1, vx: 1, vy: 1, life: 1, dmg: 1, side: "them" });
  liveEvent(s, "fog"); s.ships[1].dead = true; s.ships[1].hp = 0; s.ships[0].stun = 3;
  const w = warship(s); G.orderPatrol(s, w.id, 100, 100);
  assert.ok(G.warpToNextSector(s).ok);
  assert.strictEqual(s.sector, 4);
  assert.strictEqual(s.aliens.length + s.shots.length + s.events.length + s.fx.length, 0);
  assert.ok(s.ships[1].dead && s.ships[0].stun === 0 && s.ships[w.id].wo === "");
  assert.ok(s.bases.length === 1 && s.bases[0].hp === s.bases[0].maxHp);
  assert.strictEqual(s.eventIn, G.TUNING.events.firstDelay);
});

// ---------------------------------------------------------------------------------------------------------------
// ---- contract tests ----
// The shared plumbing for the science tree and the economy and lose rules: save version 3, run end, messages, tech
// lookups, kill attribution, raid waves, hook wiring and the neutral stubs. Nothing here needs a slice's rules.
console.log("contract: save version 3, run end, messages, tech, waves, hooks");
function withSpy(name, make, fn) {   // swap one exported function for a spy while fn runs
  const old = G[name], calls = [];
  G[name] = make ? (...a) => { calls.push(a); return make(...a); } : (...a) => { calls.push(a); };
  try { fn(calls); } finally { G[name] = old; }
}
function shotOn(s, a, src, dmg) { s.shots.push({ x: a.x - 2, y: a.y, vx: 100, vy: 0, life: 1, dmg: dmg || 1, side: "us", src }); }
const NEW_FIELDS = ["science", "sciTotal", "sciSector", "tech", "nests", "waveSeq", "waves", "credits", "debt", "debtTick", "brokeFor", "netNegFor", "rules", "econStats", "msgs"];

test("VERSION is 3 and a new game has every contract field, in front of delivered and starsPaid", () => {
  assert.strictEqual(G.VERSION, 3);
  const s = G.newGame(1), keys = Object.keys(s);
  for (const f of NEW_FIELDS) assert.ok(keys.indexOf(f) >= 0 && keys.indexOf(f) < keys.indexOf("delivered"), f);
  assert.ok(keys.indexOf("delivered") < keys.indexOf("starsPaid"));
  assert.strictEqual(s.science, 0); assert.strictEqual(s.sciTotal, 0); assert.strictEqual(s.sciSector, 0);
  assert.deepStrictEqual(s.tech, []); assert.deepStrictEqual(s.nests, []); assert.deepStrictEqual(s.waves, {}); assert.strictEqual(s.waveSeq, 0);
  assert.strictEqual(s.credits, 250); assert.strictEqual(s.debt, 1500); assert.strictEqual(s.debtTick, 60);
  assert.strictEqual(s.brokeFor, 0); assert.strictEqual(s.netNegFor, 0);
  assert.deepStrictEqual(s.econStats, { earned: 0, maint: 0, upkeep: 0, interest: 0, repaid: 0 });
  for (const sh of s.ships) { assert.strictEqual(sh.mothballed, false); assert.strictEqual(sh.wake, 0); }
});
test("a version 3 save round-trips every contract field exactly", () => {
  const s = hgame(5, 3);
  Object.assign(s, { science: 12, sciTotal: 30, sciSector: 4, tech: ["ind_drills", "log_credit"], credits: -100, debt: 900, debtTick: 33, brokeFor: 5, netNegFor: 2, waveSeq: 3 });
  s.rules.timer = true; s.rules.upkeep = false; s.econStats.earned = 7; s.econStats.repaid = 600.5;
  s.nests = [{ id: 0, kind: "nest", x: 400, y: 300, hp: 120, max: 390, dead: false, guardIn: [0, 12.5, 3] }, { id: 1, kind: "beacon", x: 50, y: 60, hp: 0, max: 150, dead: true, guardIn: [] }];
  s.waves = { 2: { alive: 0, escaped: 1 } };
  s.ships[1].mothballed = true; s.ships[1].wake = 4;
  const text = G.serialize(s), raw = JSON.parse(text);
  assert.strictEqual(raw.ver, 3);
  const r = G.deserialize(text);
  assert.ok(r.ok, r.error);
  assert.strictEqual(G.serialize(r.state), text);
  const o = r.state;
  assert.strictEqual(o.credits, -100); assert.strictEqual(o.debt, 900); assert.strictEqual(o.debtTick, 33); assert.deepStrictEqual(o.tech, ["ind_drills", "log_credit"]);
  assert.strictEqual(o.rules.timer, true); assert.strictEqual(o.rules.upkeep, false); assert.strictEqual(o.rules.debt, true);
  assert.deepStrictEqual(o.nests, s.nests); assert.deepStrictEqual(o.waves, { 2: { alive: 0, escaped: 1 } });
  assert.ok(o.ships[1].mothballed && o.ships[1].wake === 4 && !o.ships[0].mothballed);
  assert.strictEqual(o.science, 12); assert.strictEqual(o.sciTotal, 30); assert.strictEqual(o.sciSector, 4); assert.strictEqual(o.waveSeq, 3);
});
test("the save leaves out the message queue, and a loaded game starts with an empty one", () => {
  const s = G.newGame(2);
  G.emit(s, "x", { n: 1 });
  assert.strictEqual(s.msgs.length, 1);
  const text = G.serialize(s);
  assert.ok(!("msgs" in JSON.parse(text)), "not saved");
  assert.strictEqual(s.msgs.length, 1, "serialize does not touch the live queue");
  assert.deepStrictEqual(G.deserialize(text).state.msgs, []);
});
test("a version 2 save loads with the listed defaults: 500 credits, no debt, debt rule off, no science or tech", () => {
  const s = G.newGame(8, 3);
  const raw = JSON.parse(G.serialize(s));
  raw.ver = 2;
  for (const k of NEW_FIELDS) delete raw[k];
  for (const sh of raw.ships) { delete sh.mothballed; delete sh.wake; }
  const r = G.deserialize(JSON.stringify(raw));
  assert.ok(r.ok, r.error);
  const o = r.state;
  assert.strictEqual(o.credits, 500); assert.strictEqual(o.debt, 0); assert.strictEqual(o.debtTick, 60);
  assert.deepStrictEqual(o.rules, { maintenance: true, upkeep: true, debt: false, timer: false, bankruptcy: true });
  assert.strictEqual(o.science, 0); assert.strictEqual(o.sciTotal, 0); assert.deepStrictEqual(o.tech, []); assert.deepStrictEqual(o.waves, {});
  assert.strictEqual(o.brokeFor, 0); assert.strictEqual(o.netNegFor, 0);
  assert.deepStrictEqual(o.econStats, { earned: 0, maint: 0, upkeep: 0, interest: 0, repaid: 0 });
  assert.ok(o.ships.every(x => x.mothballed === false && x.wake === 0));
  assert.strictEqual(o.sector, 3);
  assert.strictEqual(G.serialize(G.deserialize(G.serialize(o)).state), G.serialize(o), "and it is a version 3 save from then on");
});
test("a version 1 save loads with the same defaults", () => {
  const raw = JSON.parse(G.serialize(G.newGame(3))); raw.ver = 1;
  for (const k of NEW_FIELDS) delete raw[k];
  const r = G.deserialize(JSON.stringify(raw));
  assert.ok(r.ok, r.error);
  assert.strictEqual(r.state.credits, 500); assert.strictEqual(r.state.debt, 0); assert.strictEqual(r.state.rules.debt, false); assert.strictEqual(r.state.rules.maintenance, true);
  assert.strictEqual(r.state.sector, 1); assert.deepStrictEqual(r.state.tech, []);
  assert.ok(!G.deserialize(JSON.stringify(Object.assign({}, raw, { ver: 4 }))).ok, "a newer version is still refused");
});
test("old saves regenerate their nests from the map seed, a version 3 save keeps its own", () => {
  const s = G.newGame(8, 3), raw = JSON.parse(G.serialize(s));
  raw.ver = 2; delete raw.nests;
  withSpy("generateNests", st => { st.nests = []; }, calls => {
    assert.ok(G.deserialize(JSON.stringify(raw)).ok);
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0][1], G.mapSeed(8, 3), "the seed of the saved sector's map");
    const v3 = JSON.parse(G.serialize(s)); v3.nests = [{ kind: "nest", x: 10, y: 10, hp: 5, max: 10 }];
    const r = G.deserialize(JSON.stringify(v3));
    assert.strictEqual(calls.length, 1, "not called again");
    assert.deepStrictEqual(r.state.nests, [{ id: 0, kind: "nest", x: 10, y: 10, hp: 5, max: 10, dead: false, guardIn: [] }]);
    delete v3.nests;
    G.deserialize(JSON.stringify(v3));
    assert.strictEqual(calls.length, 2, "a version 3 save with no nests list is regenerated too");
  });
});
test("damaged contract data in a save clamps or is dropped, and never throws", () => {
  const base = JSON.parse(G.serialize(hgame(4, 3)));
  const load = patch => { const raw = JSON.parse(JSON.stringify(base)); patch(raw); const r = G.deserialize(JSON.stringify(raw)); assert.ok(r.ok, r.error); return r.state; };
  let o = load(raw => { raw.tech = ["ind_drills", "ind_drills", "nope", 5, null, "constructor", "log_credit"]; });
  assert.deepStrictEqual(o.tech, ["ind_drills", "log_credit"], "unknown ids and repeats dropped");
  o = load(raw => { raw.tech = "all"; raw.science = "lots"; raw.sciTotal = -4; raw.credits = null; raw.debt = -5; raw.debtTick = 9999; raw.brokeFor = NaN; });
  assert.deepStrictEqual(o.tech, []); assert.strictEqual(o.science, 0); assert.strictEqual(o.credits, 250); assert.strictEqual(o.debt, 0);
  assert.strictEqual(o.debtTick, 60); assert.strictEqual(o.brokeFor, 0); assert.strictEqual(o.sciTotal, 0);
  o = load(raw => { raw.rules = { maintenance: "yes", upkeep: false, timer: 1 }; raw.econStats = { earned: -5, maint: "x" }; });
  assert.deepStrictEqual(o.rules, { maintenance: true, upkeep: false, debt: true, timer: false, bankruptcy: true });
  assert.strictEqual(o.econStats.earned, 0); assert.strictEqual(o.econStats.maint, 0);
  o = load(raw => { raw.rules = 7; raw.econStats = []; raw.waves = [1, 2]; raw.nests = "x"; });
  assert.deepStrictEqual(o.rules, G.TUNING.lose);
  o = load(raw => { raw.nests = [null, 4, { kind: "tower", x: 1, y: 1 }, { kind: "nest", x: -50, y: 1e9, hp: 9999, max: 100, guardIn: [5, "x", -3, 1e9] }, { kind: "beacon", hp: 0, max: 150, x: 5, y: 5 }]; });
  assert.strictEqual(o.nests.length, 2);
  assert.deepStrictEqual(o.nests[0], { id: 0, kind: "nest", x: 0, y: o.h, hp: 100, max: 100, dead: false, guardIn: [5, 0, 0, 600] });
  assert.ok(o.nests[1].dead && o.nests[1].id === 1);
  o = load(raw => { raw.ships[0].mothballed = "yes"; raw.ships[0].wake = 999; raw.ships[1].mothballed = true; raw.ships[1].wake = -3; });
  assert.strictEqual(o.ships[0].mothballed, false); assert.strictEqual(o.ships[0].wake, G.TUNING.econ.maint.wakeSecs);
  assert.strictEqual(o.ships[1].mothballed, true); assert.strictEqual(o.ships[1].wake, 0);
});
test("state.rules is a copy of TUNING.lose at newGame, and every rule is off in stress mode", () => {
  const s = G.newGame(1);
  assert.deepStrictEqual(s.rules, { maintenance: true, upkeep: true, debt: true, timer: false, bankruptcy: true });
  assert.deepStrictEqual(s.rules, G.TUNING.lose); assert.notStrictEqual(s.rules, G.TUNING.lose);
  s.rules.timer = true;
  assert.strictEqual(G.TUNING.lose.timer, false, "the table is not shared");
  assert.strictEqual(G.newGame(2, 4).rules.maintenance, true);
  const t = G.spawnStress(G.newGame(1), 30, 5);
  assert.ok(Object.keys(t.rules).length === 5 && Object.keys(t.rules).every(k => t.rules[k] === false));
  const back = G.deserialize(G.serialize(t)).state;
  assert.ok(Object.keys(back.rules).every(k => back.rules[k] === false), "and a stress save loads that way");
  const old = JSON.parse(G.serialize(t)); old.ver = 2; delete old.rules;
  const lo = G.deserialize(JSON.stringify(old)).state;
  assert.ok(Object.keys(lo.rules).every(k => lo.rules[k] === false), "even a version 2 stress save");
});

test("END_REASONS lists every cause, deserialize keeps each, and a bad one falls back to retired", () => {
  assert.deepStrictEqual(G.END_REASONS, ["retired", "stranded", "destroyed", "bankrupt", "debt", "timeout"]);
  for (const why of G.END_REASONS) {
    const s = G.newGame(6); s.over = true; s.endReason = why;
    if (why === "destroyed") s.bases[0].hp = 0;      // as a lost home base always is
    const r = G.deserialize(G.serialize(s));
    assert.ok(r.ok);
    assert.ok(r.state.over && r.state.endReason === why, why);
    assert.strictEqual(G.serialize(r.state), G.serialize(s), why + " round-trips");
  }
  for (const bad of ["lost", "", 7, null, "Retired"]) {
    const raw = JSON.parse(G.serialize(G.newGame(6))); raw.over = true; raw.endReason = bad;
    assert.strictEqual(G.deserialize(JSON.stringify(raw)).state.endReason, "retired", String(bad));
  }
  const live = JSON.parse(G.serialize(G.newGame(6))); live.endReason = "debt";
  assert.strictEqual(G.deserialize(JSON.stringify(live)).state.endReason, "", "a run that is not over has no reason");
});
test("endRun ends the run once, with its cause, and says so", () => {
  const s = G.newGame(1);
  assert.strictEqual(G.endRun(s, "bankrupt"), true);
  assert.ok(s.over && s.endReason === "bankrupt");
  assert.deepStrictEqual(G.drainEvents(s), [{ type: "run:end", cause: "bankrupt" }]);
  assert.strictEqual(G.endRun(s, "debt"), false);
  assert.strictEqual(s.endReason, "bankrupt", "the first cause stays");
  assert.strictEqual(G.drainEvents(s).length, 0);
  const t = G.newGame(1); G.endRun(t, "mystery");
  assert.ok(t.over && t.endReason === "retired", "an unknown cause counts as retired");
  for (const why of G.END_REASONS) { const u = G.newGame(1); G.endRun(u, why); assert.strictEqual(u.endReason, why); }
  const stopped = G.newGame(1); G.endRun(stopped, "timeout");
  const before = G.serialize(stopped); G.step(stopped, 1); assert.strictEqual(G.serialize(stopped), before, "a finished run does not step");
});
test("the existing end sites go through endRun: retire, stranded and a lost home base", () => {
  const a = G.newGame(1);
  assert.ok(G.retire(a).ok);
  assert.ok(a.over && a.endReason === "retired");
  assert.deepStrictEqual(G.drainEvents(a), [{ type: "run:end", cause: "retired" }]);
  assert.ok(!G.retire(a).ok); assert.strictEqual(G.drainEvents(a).length, 0);
  const b = hgame(26, 3);
  for (const sh of b.ships) { sh.dead = true; sh.hp = 0; }
  b.stock.ore = G.shipCost(b, "miner").ore - 1;
  hrun(b, 3);
  assert.ok(b.over && b.endReason === "stranded");
  assert.deepStrictEqual(G.drainEvents(b), [{ type: "run:end", cause: "stranded" }]);
  const c = hgame(2, 3);
  for (let i = 0; i < 4; i++) alien(c, c.bases[0].x + 200 + i * 10, c.bases[0].y);
  hrun(c, 120);
  assert.ok(c.over && c.endReason === "destroyed");
  assert.deepStrictEqual(G.drainEvents(c), [{ type: "run:end", cause: "destroyed" }], "once, however many shots landed");
});

test("emit queues {type, ...payload}, capped at 50 with the newest kept; drainEvents returns them and empties the queue", () => {
  const s = G.newGame(1);
  G.emit(s, "science:gain", { amount: 2, source: "raider", total: 5 });
  G.emit(s, "tech:unlock");
  G.emit(s, "odd", { type: "ignored", k: 1 });
  assert.deepStrictEqual(s.msgs, [{ type: "science:gain", amount: 2, source: "raider", total: 5 }, { type: "tech:unlock" }, { type: "odd", k: 1 }]);
  assert.deepStrictEqual(G.drainEvents(s).map(e => e.type), ["science:gain", "tech:unlock", "odd"]);
  assert.deepStrictEqual(G.drainEvents(s), []); assert.deepStrictEqual(s.msgs, []);
  for (let i = 0; i < 80; i++) G.emit(s, "n", { i });
  assert.strictEqual(s.msgs.length, 50); assert.strictEqual(s.msgs[0].i, 30); assert.strictEqual(s.msgs[49].i, 79);
  assert.strictEqual(G.TUNING.msgs.max, 50);
  const bare = { }; G.emit(bare, "x"); assert.strictEqual(bare.msgs.length, 1);
  assert.deepStrictEqual(G.drainEvents({}), []);
});
test("a long run never grows the message queue past its cap", () => {
  const s = hgame(5, 3);
  for (let i = 0; i < 400; i++) { G.emit(s, "n", { i }); G.step(s, HDT); }
  assert.ok(s.msgs.length <= 50);
});

test("the tree is fully defined in TUNING: 12 nodes, 3 branches of 4 tiers, costs 8/16/28/45, corrected numbers", () => {
  const nodes = G.TUNING.tech;
  assert.strictEqual(nodes.length, 12);
  assert.deepStrictEqual(G.TUNING.techCost, [8, 16, 28, 45]);
  assert.strictEqual(new Set(nodes.map(n => n.id)).size, 12);
  const keys = new Set(["warshipHp", "warshipDmg", "warshipMaint", "nestDmg", "mineRate", "shipMaint", "baseUpkeep", "cargo", "overdraft", "interest", "unload", "dock", "shipSpeed", "baseCost"]);
  const used = new Set();
  for (const branch of ["mil", "ind", "log"]) {
    const col = nodes.filter(n => n.branch === branch);
    assert.deepStrictEqual(col.map(n => n.tier), [1, 2, 3, 4], branch);
    col.forEach((n, i) => assert.strictEqual(n.needs, i ? col[i - 1].id : null, n.id + " needs the node below it"));
  }
  for (const n of nodes) {
    assert.ok(typeof n.name === "string" && n.name && typeof n.text === "string" && n.text, n.id);
    assert.ok(Array.isArray(n.effects) && n.effects.length >= 1, n.id);
    for (const e of n.effects) {
      assert.ok(keys.has(e.key), n.id + " " + e.key); used.add(e.key);
      assert.ok(typeof e.mult === "number" || typeof e.add === "number", n.id);
    }
    assert.ok(G.TUNING.techCost[n.tier - 1] > 0);
  }
  assert.strictEqual(used.size, keys.size, "every effect key is used by some node");
  const by = id => nodes.find(n => n.id === id);
  assert.ok(/117/.test(by("mil_hulls").text) && /90/.test(by("mil_hulls").text) && !/156|120/.test(by("mil_hulls").text), by("mil_hulls").text);
  assert.ok(/11\.25/.test(by("mil_targeting").text) && !/15\/s/.test(by("mil_targeting").text), by("mil_targeting").text);
  assert.strictEqual(G.SHIP_TYPES.warship.hp * 1.3, 117); assert.strictEqual(G.SHIP_TYPES.warship.dmg * 1.25, 11.25);
  assert.deepStrictEqual(by("log_credit").effects, [{ key: "overdraft", add: -250 }, { key: "interest", mult: 0.5 }]);
});
test("the balance table has every econ, lose and science key, with the re-run changes", () => {
  const E = G.TUNING.econ;
  assert.deepStrictEqual(E.credit, G.TUNING.score.value);
  assert.deepStrictEqual(Object.keys(E).sort(), ["bankrupt", "credit", "debt", "exchange", "maint", "netWarnSecs", "oldSaveCredits", "scaleMax", "scalePerSector", "startCredits", "timer", "upkeep"]);
  assert.deepStrictEqual(E.maint, { miner: 30, hauler: 50, warship: 90, mothball: 0.2, wakeSecs: 10 });
  assert.deepStrictEqual(E.upkeep, { home: 0, base: 35, perTier: 10, shield: 20, turret: 20 });
  assert.deepStrictEqual(E.debt, { start: 1500, rate: 0.015, every: 60, dueSector: 3, dueTime: 2700, warnSecs: 300 });
  assert.deepStrictEqual(E.bankrupt, { floor: -250, grace: 60, blockShipsBelow: 0 });
  assert.deepStrictEqual(E.timer, { parMult: 1.5, firstSector: 2, capSector: 10, warnShare: 0.25, warnSecs: 60 });
  assert.deepStrictEqual(E.exchange, { sell: { ore: 1, ice: 2, crystal: 5 }, buy: { ore: 3, ice: 6 }, step: 10, buyOn: true });
  assert.strictEqual(E.startCredits, 250); assert.strictEqual(E.oldSaveCredits, 500); assert.strictEqual(E.netWarnSecs, 10);
  assert.strictEqual(E.scalePerSector, 0.04); assert.strictEqual(E.scaleMax, 1.36);
  assert.deepStrictEqual(G.TUNING.lose, { maintenance: true, upkeep: true, debt: true, timer: false, bankruptcy: true });
  const S = G.TUNING.science;
  assert.deepStrictEqual(Object.keys(S).sort(), ["beacon", "firstSector", "guardKill", "nest", "raidCap", "raidCapPerSector", "raider", "raiderEvery", "secured", "turretKill", "wave"]);
  assert.strictEqual(S.nest.guards, 3); assert.strictEqual(S.nest.guardRespawn, 20);
  assert.strictEqual(S.raidCap, 20); assert.strictEqual(S.raidCapPerSector, 10);
  assert.deepStrictEqual(S.beacon, { sector: 2, hp: 150, sci: 8 });
  assert.deepStrictEqual(S.nest, { firstSector: 3, base: 1, every: 2, max: 3, hp: 300, hpPerSector: 0.3, sci: 10, sciPerSector: 4, guards: 3, guardRespawn: 20,
    guardLeash: 250, regen: 2, regenRange: 220, raidBoost: 0.2, minHomeShare: 0.6, nearCrystal: 150 });
});

test("hasTech, techMult and techAdd read state.tech directly: product of mults (1 if none), sum of adds (0 if none)", () => {
  const s = G.newGame(1);
  for (const k of ["shipMaint", "interest", "mineRate", "baseCost", "nope"]) assert.strictEqual(G.techMult(s, k), 1, k);
  for (const k of ["overdraft", "dock", "nope"]) assert.strictEqual(G.techAdd(s, k), 0, k);
  assert.ok(!G.hasTech(s, "ind_crews"));
  s.tech = ["ind_crews"];
  assert.strictEqual(G.techMult(s, "shipMaint"), 0.7); assert.ok(G.hasTech(s, "ind_crews") && !G.hasTech(s, "ind_drills"));
  assert.strictEqual(G.techMult(s, "mineRate"), 1, "other keys untouched");
  s.tech = ["log_credit"];
  assert.strictEqual(G.techAdd(s, "overdraft"), -250); assert.strictEqual(G.techMult(s, "interest"), 0.5);
  assert.strictEqual(G.techMult(s, "overdraft"), 1, "an add is not a mult"); assert.strictEqual(G.techAdd(s, "interest"), 0);
  s.tech = ["log_docks"];
  assert.strictEqual(G.techMult(s, "unload"), 1.5); assert.strictEqual(G.techAdd(s, "dock"), 10);
  s.tech = ["mil_hulls", "mil_targeting", "mil_contracts", "mil_siege", "ind_drills", "ind_crews", "ind_modular", "ind_holds", "log_credit", "log_docks", "log_engines", "log_depots", "ghost"];
  const want = { warshipHp: 1.3, warshipDmg: 1.25, warshipMaint: 0.6, nestDmg: 2, mineRate: 1.2, shipMaint: 0.7, baseUpkeep: 0.65, cargo: 1.25, interest: 0.5, unload: 1.5, shipSpeed: 1.15, baseCost: 0.85 };
  for (const k of Object.keys(want)) assert.ok(Math.abs(G.techMult(s, k) - want[k]) < 1e-12, k);
  assert.strictEqual(G.techAdd(s, "overdraft"), -250); assert.strictEqual(G.techAdd(s, "dock"), 10);
  assert.ok(!G.hasTech({}, "x") && G.techMult({}, "cargo") === 1 && G.techAdd({}, "dock") === 0, "a state without tech is fine");
});

test("shots carry who fired them: warship, turret or alien", () => {
  const s = hgame(3, 3), w = warship(s), home = s.bases[0];
  G.buildAddon(s, 0, "turret");
  const a = alien(s, home.x + 100, home.y); a.hp = 1e6; a.maxHp = 1e6;
  const seen = { us: new Set(), them: new Set() };
  for (let i = 0; i < 90; i++) { G.step(s, HDT); for (const x of s.shots) seen[x.side].add(x.src); }
  assert.deepStrictEqual([...seen.them], ["alien"]);
  assert.deepStrictEqual([...seen.us].sort(), ["turret", "warship"]);
  const t = hgame(3, 3); const w2 = warship(t);
  alien(t, w2.x + 100, w2.y).hp = 1e6;
  G.step(t, HDT); G.step(t, HDT);
  assert.ok(t.shots.length && t.shots.every(x => x.side === "us" ? x.src === "warship" : x.src === "alien"));
});
test("a shot's src survives a save; an older save's shots have none and still count as the side's default", () => {
  const s = hgame(3, 3);
  s.shots.push({ x: 5, y: 5, vx: 1, vy: 1, life: 1, dmg: 2, side: "us", src: "turret" });
  s.shots.push({ x: 6, y: 6, vx: 1, vy: 1, life: 1, dmg: 2, side: "them", src: "alien" });
  s.shots.push({ x: 7, y: 7, vx: 1, vy: 1, life: 1, dmg: 2, side: "us", src: "wizard" });
  const o = G.deserialize(G.serialize(s)).state;
  assert.deepStrictEqual(o.shots.map(x => x.src), ["turret", "alien", undefined]);
  withSpy("onAlienKilled", () => 0, calls => {
    const a = alien(o, 300, 300); o.shots.length = 0;
    o.shots.push({ x: 298, y: 300, vx: 100, vy: 0, life: 1, dmg: 9999, side: "us" });
    G.step(o, HDT);
    assert.strictEqual(calls.length, 1); assert.strictEqual(calls[0][2], "warship", "a shot with no src counts as a warship's");
  });
});

test("onAlienKilled is called once per alien death, with the alien and who killed it", () => {
  withSpy("onAlienKilled", () => 0, calls => {
    const s = hgame(3, 3), w = warship(s);
    const a = alien(s, w.x + 100, w.y); a.cd = 1000;
    hrun(s, 10);
    assert.strictEqual(s.aliens.length, 0);
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0][0], s); assert.strictEqual(calls[0][1], a); assert.strictEqual(calls[0][2], "warship");
    const t = hgame(3, 3); giveAll(t); assert.ok(G.buildAddon(t, 0, "turret").ok);
    const b = alien(t, t.bases[0].x + 120, t.bases[0].y); b.cd = 1000;
    calls.length = 0;
    hrun(t, 15);
    assert.strictEqual(t.aliens.length, 0);
    assert.deepStrictEqual(calls.map(c => [c[1].id, c[2]]), [[b.id, "turret"]]);
    const u = hgame(3, 3), x = alien(u, 300, 300), y = alien(u, 600, 300);
    calls.length = 0;
    shotOn(u, x, "turret", 9999); shotOn(u, x, "warship", 9999); shotOn(u, y, "warship", 9999);
    G.step(u, HDT);
    assert.deepStrictEqual(calls.map(c => c[1].id).sort(), [x.id, y.id].sort(), "two shots on one alien kill it once");
    assert.ok(calls.every(c => c[2] === "warship" || c[2] === "turret") && calls.find(c => c[1] === y)[2] === "warship");
    assert.strictEqual(u.stats.kills, 2);
    G.step(u, HDT); G.step(u, HDT);
    assert.strictEqual(calls.length, 2, "and nothing more later");
  });
});
test("a kill still scores and may drop a star exactly as before the hook", () => {
  const s = hgame(3, 3), a = alien(s, 300, 300);
  shotOn(s, a, "warship", 9999);
  G.step(s, HDT);
  assert.strictEqual(s.stats.kills, 1); assert.strictEqual(s.score.kills, G.TUNING.aliens.score);
  assert.strictEqual(G.onAlienKilled(s, a, "warship"), 0, "the stub gives no science");
  assert.strictEqual(s.science, 0);
});

test("raid aliens carry their wave, and state.waves counts alive and escaped", () => {
  const s = hgame(5, 3), A = G.TUNING.aliens;
  assert.deepStrictEqual(s.waves, {}); assert.strictEqual(s.waveSeq, 0);
  liveEvent(s, "raid", { x: 100, y: 100, r: 40, power: 3 });
  G.step(s, HDT);
  assert.strictEqual(s.aliens.length, 3);
  assert.ok(s.aliens.every(a => a.wave === 1 && a.nest === -1));
  assert.deepStrictEqual(s.waves, { 1: { alive: 3, escaped: 0 } }); assert.strictEqual(s.waveSeq, 1);
  liveEvent(s, "raid", { x: s.w - 100, y: 100, r: 40, power: 2 });
  G.step(s, HDT);
  assert.strictEqual(s.aliens.length, 5);
  assert.deepStrictEqual(s.aliens.map(a => a.wave), [1, 1, 1, 2, 2]);
  assert.deepStrictEqual(s.waves, { 1: { alive: 3, escaped: 0 }, 2: { alive: 2, escaped: 0 } });
  withSpy("onAlienKilled", () => 0, calls => {
    const a = s.aliens[0]; shotOn(s, a, "warship", 9999);
    G.step(s, HDT);
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0][1].wave, 1, "the alien it is called with still names its wave");
    assert.deepStrictEqual(s.waves[1], { alive: 2, escaped: 0 });
    for (const x of s.aliens) x.age = A.stay + 1;      // time is up: they fly off
    hrun(s, 30);
    assert.strictEqual(s.aliens.length, 0);
    assert.deepStrictEqual(s.waves, { 1: { alive: 0, escaped: 2 }, 2: { alive: 0, escaped: 2 } }, "leaving raiders are escaped, not killed");
    assert.strictEqual(calls.length, 1, "leaving is not a kill");
    assert.strictEqual(s.stats.kills, 1);
  });
  assert.strictEqual(s.waveSeq, 2);
});
test("a raid that finds no room brings no wave; aliens made any other way have no wave", () => {
  const s = hgame(5, 3);
  for (let i = 0; i < G.TUNING.aliens.max; i++) alien(s, 50, 50);
  liveEvent(s, "raid", { x: 100, y: 100, r: 40, power: 3 });
  G.step(s, HDT);
  assert.deepStrictEqual(s.waves, {}); assert.strictEqual(s.waveSeq, 0);
  const t = G.spawnStress(G.newGame(7, 3), 4, 6);
  assert.strictEqual(t.aliens.length, 6);
  assert.ok(t.aliens.every(a => a.wave === -1 && a.nest === -1)); assert.deepStrictEqual(t.waves, {});
  const old = alien(hgame(5, 3), 1, 1); assert.strictEqual(old.wave, undefined, "test helpers that omit it are tolerated");
  const u = hgame(5, 3); const a = alien(u, 300, 300); shotOn(u, a, "warship", 9999); G.step(u, HDT); assert.strictEqual(u.aliens.length, 0);
});
test("waves and their aliens survive a save; alive is recounted from the map; a warp starts the next sector clean", () => {
  const s = hgame(5, 3);
  liveEvent(s, "raid", { x: 100, y: 100, r: 40, power: 4 });
  G.step(s, HDT);
  const a = s.aliens[0]; shotOn(s, a, "warship", 9999); G.step(s, HDT);
  s.waves[1].escaped = 1;
  const text = G.serialize(s), o = G.deserialize(text).state;
  assert.strictEqual(G.serialize(o), text);
  assert.deepStrictEqual(o.waves, { 1: { alive: 3, escaped: 1 } }); assert.ok(o.aliens.every(x => x.wave === 1));
  const raw = JSON.parse(text); raw.waves = { 1: { alive: 99, escaped: 1 }, 7: { alive: 5, escaped: 2 }, x: { alive: 1 } }; raw.waveSeq = 0; raw.aliens[0].wave = -9; raw.aliens[1].nest = 500;
  const r = G.deserialize(JSON.stringify(raw)).state;
  assert.strictEqual(r.aliens[0].wave, -1); assert.strictEqual(r.aliens[1].nest, 99);
  assert.deepStrictEqual(r.waves, { 1: { alive: 2, escaped: 1 }, 7: { alive: 0, escaped: 2 } });
  assert.strictEqual(r.waveSeq, 7, "ids are never reused");
  buildGoal(s); s.aliens.length = 0;
  assert.ok(G.warpToNextSector(s).ok);
  assert.deepStrictEqual(s.waves, {}); assert.strictEqual(s.waveSeq, 1, "the counter carries on");
  liveEvent(s, "raid", { x: 100, y: 100, r: 40, power: 2 }); G.step(s, HDT);
  assert.deepStrictEqual(Object.keys(s.waves), ["2"]);
});

test("step calls stepNests with dt, and stepEconomy after the ships have moved", () => {
  const s = hgame(5, 1), b = nearBody(s);
  G.orderShip(s, 0, b.id);
  for (let i = 0; i < 60; i++) G.step(s, DT);
  let nests = 0, econ = 0, order = [];
  const sh = s.ships[0];
  withSpy("stepNests", null, nc => withSpy("stepEconomy", null, ec => {
    const moved = () => sh.x * 1000 + sh.y + sh.cargo * 1e6;
    const before = moved();
    let seen = null;
    G.stepEconomy = (st, dt) => { ec.push([st, dt]); seen = moved(); };
    G.step(s, DT);
    nests = nc.length; econ = ec.length;
    assert.strictEqual(nc[0][0], s); assert.strictEqual(nc[0][1], DT); assert.strictEqual(ec[0][1], DT);
    assert.notStrictEqual(seen, before, "the ship had already moved when the economy ran");
  }));
  assert.strictEqual(nests, 1); assert.strictEqual(econ, 1);
  withSpy("stepNests", null, nc => withSpy("stepEconomy", null, ec => {
    for (const dt of [0, -1, NaN]) G.step(s, dt);
    G.endRun(s, "retired"); G.step(s, DT);
    assert.strictEqual(nc.length + ec.length, 0, "no hooks when the step does nothing");
  }));
});
test("buildSector asks generateNests for this sector's map seed; the stub leaves no nests", () => {
  withSpy("generateNests", st => { st.nests = []; }, calls => {
    const s = G.newGame(9, 3);
    assert.strictEqual(calls.length, 1); assert.strictEqual(calls[0][0], s); assert.strictEqual(calls[0][1], G.mapSeed(9, 3));
    s.nests = [{ id: 0 }]; s.waves = { 4: { alive: 1, escaped: 0 } }; s.sciSector = 7;
    buildGoal(s);
    assert.ok(G.warpToNextSector(s).ok);
    assert.strictEqual(calls.length, 2); assert.strictEqual(calls[1][1], G.mapSeed(9, 4)); assert.strictEqual(s.sector, 4, "called for the new sector");
    assert.deepStrictEqual(s.nests, []); assert.strictEqual(s.sciSector, 0);
  });
  assert.deepStrictEqual(G.newGame(9, 5).nests, []);
});
test("warpToNextSector asks econWarpBlock first: a reason refuses the warp and changes nothing", () => {
  const s = hgame(25, 3);
  buildGoal(s);
  s.ships[0].cargo = 5; s.ships[0].res = "ore";
  const before = G.serialize(s);
  withSpy("econWarpBlock", () => "Pay the debt first.", calls => withSpy("scienceOnWarp", () => 0, sc => withSpy("econOnWarp", null, ec => {
    const r = G.warpToNextSector(s);
    assert.deepStrictEqual(r, { ok: false, reason: "Pay the debt first." });
    assert.strictEqual(calls.length, 1); assert.strictEqual(calls[0][0], s);
    assert.strictEqual(G.serialize(s), before, "nothing moved, delivered or reset");
    assert.strictEqual(sc.length + ec.length, 0);
  })));
  withSpy("econWarpBlock", () => "", calls => assert.ok(G.warpToNextSector(s).ok && calls.length === 1));
  assert.strictEqual(s.sector, 4);
  const t = hgame(25, 3);
  withSpy("econWarpBlock", () => "no", calls => { assert.ok(!G.warpToNextSector(t).ok); assert.strictEqual(calls.length, 0, "the sector must be cleared before the block is asked"); });
});
test("warpToNextSector calls scienceOnWarp and econOnWarp once, with the old sector still in place", () => {
  const s = hgame(25, 3);
  buildGoal(s);
  s.ships[1].cargo = 7; s.ships[1].res = "ore";
  const ore = s.stock.ore;
  const log = [];
  withSpy("scienceOnWarp", st => { log.push(["sci", st.sector]); return 0; }, sc => withSpy("econOnWarp", st => { log.push(["econ", st.sector, st.stock.ore]); }, ec => {
    assert.ok(G.warpToNextSector(s).ok);
    assert.strictEqual(sc.length, 1); assert.strictEqual(ec.length, 1);
  }));
  assert.deepStrictEqual(log, [["sci", 3], ["econ", 3, ore + 7]], "after the cargo is handed in, before the new map");
  assert.strictEqual(s.sector, 4);
  const w = hgame(25, 3);
  withSpy("scienceOnWarp", () => 0, sc => { assert.ok(!G.warpToNextSector(w).ok); assert.strictEqual(sc.length, 0, "not when the warp is refused"); });
});

test("every stub is exported with the contract's signature and returns a neutral value", () => {
  const sig = { scienceFor: 2, awardScience: 3, onAlienKilled: 3, generateNests: 2, stepNests: 2, damageNest: 4, techState: 2, unlockTech: 2, scienceOnWarp: 1,
    econScale: 1, econRates: 1, stepEconomy: 2, payDebt: 2, sellStock: 3, buyStock: 3, setMothball: 3, econWarpBlock: 1, econOnWarp: 1, timeLimit: 1, econWarnings: 1,
    emit: 3, drainEvents: 1, endRun: 2, hasTech: 2, techMult: 2, techAdd: 2 };
  for (const k of Object.keys(sig)) { assert.strictEqual(typeof G[k], "function", k); assert.strictEqual(G[k].length, sig[k], k + " takes " + sig[k]); }
  const s = hgame(4, 3), before = G.serialize(s);
  assert.strictEqual(G.scienceFor(s, "raider"), 0); assert.strictEqual(G.awardScience(s, 5, "raider"), 0);
  assert.strictEqual(G.onAlienKilled(s, alien(s, 1, 1), "warship"), 0); s.aliens.length = 0; s.alienSeq = 0;
  G.stepNests(s, 1); G.stepEconomy(s, 1); G.econOnWarp(s);
  assert.deepStrictEqual(G.damageNest(s, 0, 5, "warship"), { killed: false });
  assert.strictEqual(G.techState(s, "mil_hulls"), "locked");
  assert.strictEqual(G.unlockTech(s, "mil_hulls").ok, false); assert.ok(typeof G.unlockTech(s, "mil_hulls").reason === "string");
  assert.strictEqual(G.scienceOnWarp(s), 0); assert.strictEqual(G.econScale(5), 1);
  assert.deepStrictEqual(G.econRates(s), { maint: 0, upkeep: 0, interest: 0, net: 0 });
  assert.strictEqual(G.payDebt(s, 10).ok, false); assert.strictEqual(G.payDebt(s, 10).paid, 0);
  assert.strictEqual(G.sellStock(s, "ore", 10).ok, false); assert.strictEqual(G.buyStock(s, "ore", 10).ok, false); assert.strictEqual(G.setMothball(s, 0, true).ok, false);
  assert.strictEqual(G.econWarpBlock(s), ""); assert.strictEqual(G.timeLimit(s), 0); assert.deepStrictEqual(G.econWarnings(s), []);
  G.generateNests(s, 1); assert.deepStrictEqual(s.nests, []);
  assert.strictEqual(G.serialize(s), before, "no stub changes the game");
});
test("with the stubs the game plays as before: no credits drain, no science, no nests, no deaths from money", () => {
  const s = G.newGame(12, 3);
  s.showerIn = 3000; s.eventIn = 3000;
  const b = nearBody(s); G.orderShip(s, 0, b.id); G.orderShip(s, 1, b.id);
  for (let i = 0; i < 30 * 600; i++) G.step(s, HDT);
  assert.ok(!s.over);
  assert.strictEqual(s.credits, 250); assert.strictEqual(s.debt, 1500); assert.strictEqual(s.debtTick, 60);
  assert.strictEqual(s.science, 0); assert.strictEqual(s.sciTotal, 0); assert.deepStrictEqual(s.nests, []); assert.deepStrictEqual(s.tech, []);
  assert.strictEqual(s.msgs.length, 0);
  assert.ok(s.stats.ore > 0, "and the miners worked");
});
test("main.js has the contract's placeholders: pins in index.html, hook functions, keys through keyActive, the tech shell", () => {
  const fs = require("fs"), js = fs.readFileSync(__dirname + "/main.js", "utf8"), html = fs.readFileSync(__dirname + "/index.html", "utf8");
  for (const id of ["sci", "credits", "debt", "timeleft", "warnbar", "b-tech", "econ", "econ-body", "tech", "t-body", "t-close"]) {
    assert.ok(new RegExp('id="' + id + '"').test(html), "#" + id);
  }
  for (const id of ["sci", "credits", "debt", "timeleft", "warnbar", "b-tech", "econ", "tech"]) assert.ok(new RegExp('id="' + id + '"[^>]*hidden').test(html), "#" + id + " starts hidden");
  assert.ok(/id="t-body"><\/div>/.test(html) && /id="econ-body"><\/div>/.test(html), "and empty");
  assert.ok(/id="tech" role="dialog" aria-modal="true"/.test(html));
  for (const f of ["openTech", "focusEcon", "toggleMothball", "shipRowExtra", "drawNests", "closeTech"]) assert.ok(new RegExp("function " + f + "\\(").test(js), f);
  assert.ok(/function shipRowExtra\(ship\) \{ return null; \}/.test(js) && /shipRowExtra\(s\)/.test(js), "the board row asks for its extra");
  assert.ok(/function frame\(dt\)[\s\S]*?drawNests\(\);[\s\S]*?\n  \}/.test(js), "frame draws the nests");
  const g = /function keyActive\(ev\) \{[\s\S]*?\n  \}/.exec(js);
  assert.ok(g && g[0].indexOf("ui.tech") >= 0, "keyActive stops for the tech window");
  assert.ok(/function syncInert\(\) \{[\s\S]*?ui\.tech[\s\S]*?\n  \}/.test(js), "and so does inert");
  assert.ok(/const modal = \(\) => [^;]*ui\.tech/.test(js), "and pause");
  assert.ok(/if \(ui\.tech\) return closeTech\(\);/.test(js), "Esc closes it");
  for (const [k, f] of [["t", "openTech"], ["c", "focusEcon"], ["m", "toggleMothball"]]) {
    assert.ok(new RegExp('if \\(lk === "' + k + '"\\) \\{ ' + f + "\\(\\); return; \\}").test(js), k + " calls " + f);
    assert.ok(new RegExp('\\["' + k.toUpperCase() + '", "').test(js), k + " is in the legend");
  }
  const key = /window\.addEventListener\("keydown", ev => \{\s*if \(!game \|\| !ev\.key\) return;[\s\S]*?\n  \}\);/.exec(js)[0];
  assert.ok(key.indexOf("if (!keyActive(ev)) return;") < key.indexOf('lk === "t"'), "the keys sit behind keyActive");
  for (const k of ["t", "c", "m"]) assert.strictEqual(key.split('lk === "' + k + '"').length - 1, 1, k + " is handled in one place");
  const END = /const END_TEXT = \{([\s\S]*?)\n  \};/.exec(js)[1];
  for (const why of G.END_REASONS) assert.ok(new RegExp("\\b" + why + ": \\{").test(END), "END_TEXT has " + why);
});

// ---- contract hook tests ----
test("a mothballed ship does not move, and a waking ship counts down without moving", () => {
  const s = G.newGame(5, 1), sh = s.ships[0];
  G.orderShip(s, 0, 0);
  const x = sh.x, y = sh.y;
  sh.mothballed = true;
  for (let i = 0; i < 60; i++) G.step(s, 1 / 30);
  assert.strictEqual(sh.x, x); assert.strictEqual(sh.y, y); assert.strictEqual(sh.mv, 0);
  sh.mothballed = false; sh.wake = 1;
  for (let i = 0; i < 15; i++) G.step(s, 1 / 30);
  assert.strictEqual(sh.x, x); assert.ok(Math.abs(sh.wake - 0.5) < 1e-9, "wake counts down: " + sh.wake);
  for (let i = 0; i < 30; i++) G.step(s, 1 / 30);
  assert.strictEqual(sh.wake, 0);
  for (let i = 0; i < 60; i++) G.step(s, 1 / 30);
  assert.ok(sh.x !== x || sh.y !== y, "it moves again once awake");
});
test("every order function asks shipAvailable and shipUnavailableReason", () => {
  const s = G.newGame(5, 1);
  const w = G.addShip(s, "warship", 0); const wid = w.ok === false ? s.ships.length - 1 : (w.id != null ? w.id : s.ships.length - 1);
  const calls = [];
  const oa = G.shipAvailable, or = G.shipUnavailableReason;
  G.shipAvailable = (st, sh) => { calls.push(sh.id); return false; };
  G.shipUnavailableReason = (st, sh) => "parked " + sh.id;
  try {
    const res = [
      G.orderShip(s, 0, 0), G.orderShipToStar(s, 0, 0), G.orderToTarget(s, 0, 1), G.recallShip(s, 0), G.returnToBase(s, 0, 0),
      G.orderNearestBase(s, 0), G.takeManual(s, 0),
      G.orderPatrol(s, wid, 100, 100), G.orderEscort(s, wid, 0), G.orderAttack(s, wid, 0), G.recallShip(s, wid),
    ];
    res.forEach((r, i) => { assert.strictEqual(r.ok, false, "order " + i); assert.ok(/^parked [0-9]+$/.test(r.reason), "reason " + i + ": " + r.reason); });
    assert.ok(calls.length >= res.length);
    assert.notStrictEqual(s.ships[0].st, G.MANUAL);
  } finally { G.shipAvailable = oa; G.shipUnavailableReason = or; }
  s.ships[0].dead = true;
  assert.strictEqual(G.orderShip(s, 0, 0).reason, s.ships[0].name + " was lost.", "a lost ship keeps its reason");
});
test("saved nest ids are kept when valid and unique; duplicates and invalid ones drop", () => {
  const s = G.newGame(8, 3), raw = JSON.parse(G.serialize(s));
  const n = (id, x) => ({ id, kind: "nest", x, y: 10, hp: 5, max: 10 });
  raw.nests = [n(7, 1), n(3, 2), n(7, 3), { id: 4, kind: "bogus", x: 4, y: 4 }, n(-1, 5), n("x", 6), n(undefined, 7)];
  const r = G.deserialize(JSON.stringify(raw));
  assert.ok(r.ok);
  const got = r.state.nests;
  assert.deepStrictEqual(got.slice(0, 2).map(q => [q.id, q.x]), [[7, 1], [3, 2]]);
  const ids = got.map(q => q.id);
  assert.strictEqual(new Set(ids).size, ids.length, "ids are unique");
  assert.ok(!got.some(q => q.x === 3 || q.x === 4), "the duplicate and the bad kind are gone");
});

// ---- science-tree tests ----
// (slice a adds its tests here, and only here)

// ---- economy-lose tests ----
// (slice b adds its tests here, and only here)

console.log("\n" + passed + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
