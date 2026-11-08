# Fleet

A small browser game in the look of the agent dashboard's Mission view. Start with a home base and two
miners, send them to asteroids, moons and planets, and spend what they bring back on more ships and
new bases. Build the bases a sector asks for, warp further out, and keep going for a high score.

Plain HTML, Canvas and JavaScript. No installs, no build step. The only network call is the optional feedback form, which talks to the local dashboard (127.0.0.1) and nowhere else.

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
   Stress mode never writes to the save, the players, or the logs.

## Sectors, score and the end of a run

- **Sector goal:** build the number of bases shown in the top bar (5 in sector 1, one more each sector,
  up to 10). A "Warp to next sector" button then appears (top bar, and on the sector-cleared card).
  Warping keeps your fleet and your stock, and drops you at a new seeded map, further out.
- **Each sector is harder:** the map is bigger and bodies sit further from home, each body holds less,
  crystal bodies are fewer (but richer; every map still holds at least 1.3 times what its goal costs), and ships, bases and upgrades cost more.
  Difficulty plateaus after sector 10: from there the goal (10 bases), costs and map are the same every sector, so a run can go on as long as you can. Sector 1 plays as the original game.
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
  bank, which is kept between games per player (localStorage key `fleet-game-players-v1`, separate from the saves). Each star
  pays once per save: the save records which stars were paid (`state.starsPaid`), and the star pays whoever is
  playing when it is taken. Another player loading that save is not paid again, and you are not paid again for reloading an older save.
- The Hangar (top bar, and the run-end screen) spends stars on looks only, never power: 5 ship colours,
  5 base colours, 4 map backgrounds and 3 engine-trail styles (the first of each is free). Your choices are
  kept and used in every game. Prices are small (2 to 8 stars), so a few runs unlock most things.
  Backgrounds: the four nebulas plus Deep Black (almost no stars), Asteroid Belt, Galaxy Spiral and Solar System (planets orbit the sun slowly); with reduced motion they stay still.
- Each player's bank also holds their best score.

## Players, scoreboard, stats and history

- **Players:** the top-bar player button (shows the current name) opens the Players dialog: Play (switch),
  Rename, Stats, Clear data (asks first), and Add player. Each player has their own stars, looks and best
  score. Names are 1 to 24 characters, unique ignoring case. Switching mid-run asks first, logs that run
  as "abandoned" and starts a new run for the new player. The first launch after this update moves your
  old best score and stars into "Player 1" and says so. Clearing a player's data removes their runs,
  purchases and best score; their name, stars and owned looks stay.
- **Scores:** the Scores button (top bar and run-end card) shows every player: best, runs, best sector,
  delivered and stars. Click a heading to sort and again to flip; your row is highlighted. Below it are the
  top 10 runs. Click a player for their stats.
- **Stats:** per player, a totals row, every logged run (newest first: date, score, sector, ore, ice and
  crystal delivered, ships, bases, stars, time, result) and their hangar purchases.
- **History:** the Hangar lists the current player's newest 20 purchases.
- **What is logged:** a run is logged when it ends (stranded or retired) or is abandoned (New game, or
  switching player). Runs under 5 seconds with no score are skipped. Loading a save never logs by itself;
  ending a reloaded run again replaces its record. Logs keep the last 500 runs and 500 purchases.
- **Export:** the Export logs button on the Scores dialog downloads `fleet-game-logs-YYYY-MM-DD.json`
  (players, runs, purchases). It is made in the page; nothing is sent anywhere.
- **Storage (localStorage):** `fleet-game-players-v1` (players and their banks), `fleet-game-runs-v1`,
  `fleet-game-purchases-v1`. The old `fleet-game-bank-v1` is only read once for the move to Player 1 and is
  never written again. A damaged players, runs or purchases entry is copied to the damaged-saves list, a
  notice is shown, and play carries on with a fresh one. If storage is full you get a notice and the game
  keeps running. `?stress` writes none of this.
- Dialogs pause the game like the Hangar; Esc closes the top one.

## Feedback form

The Feedback button (top bar, paused screen, run-end card and sector-cleared card) opens a form: a type
(Bug, Idea, Balance, Other), an optional 1-5 rating, a message (up to 2000 characters, with a live counter)
and a box, ticked by default, that attaches game info (game version, sector, score, ships, seconds played
and your browser's name string). The game pauses while the form is open and goes back to how it was when
you close it. Tab stays inside the form, Esc closes it, Enter adds a new line and Ctrl+Enter (Cmd+Enter on
a Mac) sends. No game key works while it is open.

- **Sending:** Send to team posts the feedback to the local dashboard at `http://127.0.0.1:8765/api/feedback`
  (nothing else is contacted). "Sent to the team; the lead will draft a plan for your approval" means it
  arrived. If the dashboard refuses it (too long, wrong origin, too large) its message is shown and the form
  stays open so you can fix it. A full inbox (429) or any other reply that may work later (404, 405, 5xx) is
  saved as "not sent" instead. The form is locked while a send is in flight, and the message is cleared only
  once it was sent.
- **Dashboard not running:** if the connection is refused (immediately) or there is no reply within 5 seconds, the feedback is saved in this browser
  (localStorage key `fleet-game-feedback-v1`, kept apart from game saves) as "not sent". Start the dashboard,
  open the form and press **Send** on that entry, or **Send unsent** for all of them. A resend reuses the
  entry's `id`, so sending twice never makes a duplicate.
- **Saved feedback:** each entry shows sent or not sent, with Send, Copy (plain text to the clipboard) and
  Delete (asks first).
- **Exporting:** **Download all** saves every entry as `fleet-game-feedback-YYYY-MM-DD.json`, so feedback
  can be passed on by hand even without the dashboard.

### Themes and backgrounds

- **Themes** are the first section of the Hangar. Space is free and uses the ships, bases and background you
  picked. **Dwarven** (60 stars) turns ships into dwarves and mine carts, bases into forges (home is the great
  hall), ore/ice/crystal into iron/silver/gems, hazards into cave-ins and flooded tunnels, in a torch-lit
  cavern. **Hamster** (120 stars) turns ships into hamsters, bases into running wheels (they spin while ships
  unload), resources into seeds/nuts/carrots, hazards into cat swipes and sticky bedding, in a cage with wood
  shavings. A theme also renames things in every panel and message; stars stay "stars". Ship and base colours
  still tint the themed pictures, and trail styles still apply.
- A non-Space theme brings its own scene, so the Backgrounds section is hidden while it is chosen. Your
  background pick is kept; switch back to Space any time to see it again.
- Themes change looks and wording only, never the rules. With reduced motion, wheels, torches, glints and dust
  motes stay still.

## Old saves

Saves from the first version (`first-playable`) load as sector 1, with a notice. Stars for that map are
made from its seed.

## Files

- `game.js`: all rules (the feedback payload, maps from a seed, sectors and difficulty, hazards, upgrades, score, stars, the
  bank and hangar unlocks, costs, mining, cargo, save format). No DOM; works in the browser as
  `FleetGame` and in Node via `module.exports`. Every number you might tune is in the `TUNING` table at
  the top, and the hangar items are in `LOOKS`.
- `main.js`: drawing, input, panels, the Hangar, Players, Scores, Stats and Feedback screens, and the loop (fixed 30 Hz update, drawn on
  requestAnimationFrame).
- `index.html`, `style.css`: page and layout.
- `tests.js`: tests for `game.js` (including the feedback payload, replies and saved list).

## How to test

    node tests.js

Prints each test and a `N passed, M failed` line; exits non-zero on failure. No packages needed. Without
Node installed, VS Code's bundled runtime runs the same file:

    ELECTRON_RUN_AS_NODE=1 "E:\Evan\Programs\VSCode\Code.exe" tests.js
