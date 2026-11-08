# Fleet

A small browser game in the look of the agent dashboard's Mission view. Start with a home base and two
miners, send them to asteroids, moons and planets, and spend what they bring back on more ships and
new bases. Build the bases a sector asks for, warp further out, and keep going for a high score.

Plain HTML, Canvas and JavaScript. No installs, no build step, no network calls.

## How to play

1. Double-click `index.html`.
2. Click a ship (on the map or in the Mission board), then click a planet or asteroid. The ship flies
   there, mines until full, flies to the nearest base, unloads, and repeats until the body is empty.
   Click a base instead to send the ship to that base (an idle ship goes too). Click a star to send it
   to collect the star.
3. Spend materials in the Build panel: Miner (small, cheap), Hauler (faster, carries 60), and New base
   (click the button, then empty space; bases are drop-off points).
4. Resources: ore (asteroids), ice (moons and ice planets), crystal (rare planets). Each body is finite.
5. Upgrade bases in the Bases panel, twice each, for materials: faster unloading and a wider drop-off
   range. An upgraded base looks different (extra rings, more arms, a brighter core).
6. Top bar: Pause (or Space), Save, Load, New game, Retire, Hangar. Save keeps your own save. The game also
   autosaves every 10 seconds to a separate slot, and resumes from the newest save when you reopen the
   page. Load uses your own save first, then the autosave. If a save is damaged, the notice stays up
   with the "Loaded" message, and a copy of the damaged save is kept (the last 3, newest first, in
   localStorage under `fleet-game-damaged-saves-v2`). Esc cancels a selection or placement.
7. Frame-rate test: open `index.html?stress` for 30 ships mining at once. The corner shows fps.
   `?stress&sector=4` starts in sector 4 so storms (and, from sector 3, meteor showers) are on screen.
   Stress mode never writes to the save or the star bank.

## Sectors, score and the end of a run

- **Sector goal:** build the number of bases shown in the top bar (5 in sector 1, one more each sector,
  up to 10). A "Warp to next sector" button then appears (top bar, and on the sector-cleared card).
  Warping keeps your fleet and your stock, and drops you at a new seeded map, further out.
- **Each sector is harder:** the map is bigger and bodies sit further from home, each body holds less,
  crystal is rarer, and ships, bases and upgrades cost more. Sector 1 plays as the original game.
- **Ion storms (from sector 2):** drifting clouds that slow ships passing through.
- **Meteor showers (from sector 3):** a dashed warning ring for 3 seconds, then streaks. A loaded ship
  inside can lose half its cargo (with a short grace period after a hit).
- **Score:** points for materials delivered (ore 1, ice 2, crystal 5 each), bases built (100), sectors
  cleared (400 x sector number) and a time bonus for clearing a sector under par. Shown live, with your best.
- **A run ends** when you retire, or when you are stranded: nothing left to mine anywhere, nothing in any
  hold, and not enough materials for another base. The run-end screen shows the score breakdown and the
  best score so far.

## Stars and the Hangar

- 3 to 6 stars sit in each sector, away from home. Send a ship to one to pick it up; it goes into the star
  bank, which is kept between games (localStorage key `fleet-game-bank-v1`, separate from the saves). A star
  pays once, even if you reload an older save.
- The Hangar (top bar, and the run-end screen) spends stars on looks only, never power: 5 ship colours,
  5 base colours, 4 map backgrounds and 3 engine-trail styles (the first of each is free). Your choices are
  kept and used in every game. Prices are small (2 to 8 stars), so a few runs unlock most things.
- The bank also holds your best score.

## Old saves

Saves from the first version (`first-playable`) load as sector 1, with a notice. Stars for that map are
made from its seed.

## Files

- `game.js`: all rules (maps from a seed, sectors and difficulty, hazards, upgrades, score, stars, the
  bank and hangar unlocks, costs, mining, cargo, save format). No DOM; works in the browser as
  `FleetGame` and in Node via `module.exports`. Every number you might tune is in the `TUNING` table at
  the top, and the hangar items are in `LOOKS`.
- `main.js`: drawing, input, panels, the Hangar screen, and the loop (fixed 30 Hz update, drawn on
  requestAnimationFrame).
- `index.html`, `style.css`: page and layout.
- `tests.js`: tests for `game.js`.

## How to test

    node tests.js

Prints each test and a `N passed, M failed` line; exits non-zero on failure. No packages needed. Without
Node installed, VS Code's bundled runtime runs the same file:

    ELECTRON_RUN_AS_NODE=1 "E:\Evan\Programs\VSCode\Code.exe" tests.js
