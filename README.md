# Fleet

A small browser game in the look of the agent dashboard's Mission view. Start with a home base and two
miners, send them to asteroids, moons and planets, and spend what they bring back on more ships and
new bases. Build 5 bases (home included) to win.

Plain HTML, Canvas and JavaScript. No installs, no build step, no network calls.

## How to play

1. Double-click `index.html`.
2. Click a ship (on the map or in the Mission board), then click a planet or asteroid. The ship flies
   there, mines until full, flies to the nearest base, unloads, and repeats until the body is empty.
   Click a base instead to send the ship home.
3. Spend materials in the Build panel: Miner (small, cheap), Hauler (faster, carries 60), and New base
   (click the button, then empty space; bases are drop-off points).
4. Resources: ore (asteroids), ice (moons and ice planets), crystal (rare planets). Each body is finite.
5. Top bar: Pause (or Space), Save, Load, New game. The game also saves itself every 10 seconds, and
   resumes from the save when you reopen the page. Esc cancels a selection or placement.
6. Frame-rate test: open `index.html?stress` for 30 ships mining at once. The corner shows fps.
   Stress mode never writes to the save.

## Files

- `game.js`: all rules (map from a seed, costs, mining, cargo, save format). No DOM; works in the
  browser as `FleetGame` and in Node via `module.exports`.
- `main.js`: drawing, input, panels, and the loop (fixed 30 Hz update, drawn on requestAnimationFrame).
- `index.html`, `style.css`: page and layout.
- `tests.js`: tests for `game.js`.

## How to test

    node tests.js

Prints each test and a `N passed, M failed` line; exits non-zero on failure. No packages needed.
