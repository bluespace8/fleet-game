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

console.log("\n" + passed + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
