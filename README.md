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
   localStorage under `fleet-game-damaged-saves-v2`). Esc cancels a selection or placement. Keys: see Keyboard controls.
7. Frame-rate test: open `index.html?stress` for 30 ships mining at once plus 15 alien raiders. The corner shows fps.
   `?stress&sector=4` starts in sector 4 so storms, fog, flares, meteor showers and raids are on screen.
   Stress mode never writes to the save, the players, or the logs.

## Keyboard controls

The mouse always works. These keys add to it.

- **Tab / Shift+Tab** select the next / previous ship (wrapping), with keyboard mode on or off. Tab only does this
  when focus is on the map, or on a top-bar or side-panel button you clicked with the mouse. A button you reached
  with the keyboard keeps the normal Tab walk, and Tab is left alone in every dialog, card and the feedback form.
- **K**, or the **Keyboard** button in the top bar, turns keyboard mode on or off. The choice is kept in the browser
  (localStorage key `fleet-game-keyboard-v1`). A key legend shows while it is on. The keys below need it on.
- **Numbered targets:** every planet, asteroid and star shows a number badge. Press 1-9 (0 is ten) to send the
  selected ship there. Targets above ten take two digits typed within 0.6 s (1 then 2 is 12). The numbers stay the same
  for the whole sector; empty planets and collected stars lose their badge but nobody else's number changes.
  **H** sends the ship to the nearest base. A bad order shows the same message as a bad click.
- **Flying by hand:** **F** takes the selected ship; **WASD** or the arrow keys fly it (8 ways, same speed as an
  auto ship, slowed by ion storms, hit by meteors). **E** near a planet mines it at the normal rate (any steering
  stops it); **E** within reach of a base unloads; **E** again while mining or unloading stops. **F** or **Esc** hands
  the ship back, idle, with its cargo still aboard. Turning keyboard mode off hands every ship back.
- **Repair and warship keys:** **R** repairs the selected ship (it must be at a base); if the ship is fine it repairs the
  base it is at (a ship at a downed base repairs that base first). **R** works with keyboard mode off. **T** opens the tech tree. With a warship selected: **X** attacks the nearest alien (or, with none, the nearest nest or beacon),
  **P** patrols where the ship is now, **G** escorts the nearest miner or hauler. These keys work in keyboard mode, or
  whenever a warship is selected (T works any time). Like every game key they do nothing while a dialog or card is open, or while you
  type in a text box. Tab, the number keys and flying by hand skip lost ships.
- **Credits keys:** **C** moves focus to the credits panel (Pay debt, Sell, Buy). **M** mothballs the selected ship, or wakes
  it if it is mothballed. Both work with keyboard mode off, and, like every game key, do nothing in a dialog or text box.
- **Esc** closes things in this order: feedback form, dialog, Hangar, hand-flown ship, base placement or selection.
- **Base placement:** click the New base button, then the arrow keys move a cursor from the middle of the map
  (Shift moves faster), **Enter** places the base and **Esc** cancels. Moving the mouse takes the ghost back.
- **Build, upgrades and dialogs:** **B** (keyboard mode) puts focus on the Build panel; then Tab, Shift+Tab and Enter work
  the buttons in the side panel and top bar. Space still pauses, so use Enter to press a focused button. Dialogs, the
  Hangar and the win and run-over cards take focus when they open and give it back when they close; the
  scoreboard's sortable headers and rows work with Enter.

## Science and the tech tree

- **Science comes from fighting only**, never from mining, delivering, stars or building. It starts in sector 2: killing a
  raider with a warship (2, a little more in later sectors), a turret kill or a nest guard (1 each), repelling a raid wave
  (3), destroying the derelict **beacon** in sector 2 (8), destroying an alien **nest** from sector 3 (10, plus 4 per later
  sector), and warping with every nest of the sector gone (5, "sector secured"). Raid points are capped per sector; nests, the beacon and "sector secured" are not. The top bar shows
  **Science**, and it pulses and toasts when you earn some.
- **Nests and the beacon** sit on the map (a dark pink hive; a cyan diamond). Nests keep guards (filled dots; hollow dots
  count down to the next one back) and heal while no warship is near. To attack one, select a warship and click it, or press **X**
  when no alien is left (it picks the nearest nest or beacon). The warship flies there and shoots it.
- **Tech tree:** the **Tech** button or **T** opens a window (the game pauses) with three branches of four tiers: Military,
  Industry, Logistics. A node needs the one below it in its branch and costs 8, 16, 28 or 45 science by tier. Each shows its cost, its
  effect and its state: Owned, Available, Not enough science, or Locked. **Arrow keys** move between nodes, **Enter** (or a click)
  buys, and a refused buy says why. **Esc** or **T** closes the window and focus goes back where it was.

## Sectors, score and the end of a run

- **Sector goal:** build the number of bases shown in the top bar (5 in sector 1, one more each sector,
  up to 10). A "Warp to next sector" button then appears (top bar, and on the sector-cleared card).
  Warping keeps your fleet and your stock, and drops you at a new seeded map, further out.
- **Each sector is harder:** the map is bigger and bodies sit further from home, each body holds less,
  crystal bodies are fewer (but richer; every map still holds at least 1.3 times what its goal costs), and ships, bases and upgrades cost more.
  Difficulty plateaus after sector 10: from there the goal (10 bases), costs and map are the same every sector, so a run can go on as long as you can. Sector 1 plays as the original game.
- **Ion storms (from sector 2):** drifting clouds that slow ships passing through.
- **Meteor showers (from sector 3):** a dashed warning ring for 10 seconds, then streaks. A ship
  inside can be hit (with a short grace period after a hit): it takes damage, and a loaded one loses half its cargo.
  Bases inside are hit too.

## Hazards and defences

Sector 1 is calm. Every warning shows in the top-left with a 10 second countdown, and on the map.

- **Fog (from sector 2):** a grey cloud that hides everything under it (planets, labels, number badges, ships show
  as a small dot) and halves mining speed inside.
- **Solar flare (from sector 2):** map-wide. While it runs (a tinted screen and a banner) every ship that is not
  within range of a **Shield** is stunned: it neither moves nor mines. Stun ends about a second after the flare.
- **Alien raids (from sector 3):** an arrow and countdown mark the edge point first, then raiders arrive. They go for
  the nearest loaded ship within their sense range, else the nearest working base, shoot at range, and leave on their own
  after 90 seconds. They get tougher each sector (see numbers below).
- **Health:** every ship and base has HP; a bar shows only when it is hurt. A ship at 0 HP is lost for good, with its
  cargo. A base at 0 HP (not home) goes **down**: greyed out, no drop-off, shield or turret, but it still counts
  towards the sector goal; repair brings it back. If the **home base** falls the run ends ("Your home base was destroyed.").
- **Defences (Bases panel, per base):** **Shield** (flares do not stun ships within its range), **Turret** (shoots
  aliens in range and blocks meteor hits nearby; a blocked hit draws a short tracer). **Repair** restores a damaged
  base for materials. Ships are repaired from the Mission board button or **R** while at a base.
- **Warships (Build panel):** carry nothing and mine nothing, fire at aliens in range on their own, and take orders:
  click an alien to attack, click empty space to patrol there, **Shift+click** another ship to escort it, or click
  a base to guard it. They can also be flown by hand (F). Mining orders are refused with a message.
- **Combat numbers** (all in `TUNING`): ships have 30 (miner), 45 (hauler) or 90 (warship) HP; bases 160, home 300.
  Turret 6 damage every 0.6 s, range 190, blocks 70 percent of meteor hits. Warship 9 damage every 0.7 s, range 170.
  Shield range 170. Repair costs 0.5 ore per HP of ship (bases also 0.15 ice), scaled by the sector's cost factor.
  Raiders: sector 3 brings 2 with 40 HP and 4 damage per shot; sector 6, 3 with 76 HP and 7 damage; sector 10 and later,
  5 with 120 HP and 10 damage (all capped at sector 10, so later sectors bring the same raid). An alien kill scores 25 and sometimes drops a star.
- Saves from before this update load with full health, no add-ons and no hazards running. In a theme the new
  units keep the space look; their words follow the theme where the rules provide them.
- **Score:** points for materials delivered (ore 1, ice 2, crystal 5 each), bases built (100), sectors
  cleared (400 x sector number) and a time bonus for clearing a sector under par. Shown live, with your best.
- **A run ends** when you retire, when your home base is destroyed, or when you are stranded: nothing left to mine anywhere,
  nothing in any hold, and not enough materials for another base (or every miner and hauler is lost and you cannot afford
  another). Alien kills add to the score. The run-end screen shows the score breakdown and the
  best score so far.

## Credits, running costs and the ways to lose

Credits are a second currency. Every unit you deliver also pays credits (ore 1, ice 2, crystal 5); running costs take
them away. Top bar: **credits** with the net rate ("1,240 cr (+180/min)", amber when you have been spending more than
you earn for 10 seconds or are below 0), **Debt** and, if the timer is on, **Time left**. A banner under the top bar
counts down any warning. The **Credits** panel shows the net breakdown, **Pay debt**, and **Sell 10 / Buy 10** for each
material (you cannot buy crystal).

- **Maintenance:** miner 30, hauler 50, warship 90 credits a minute. **Upkeep:** each base besides home 35, plus 10 per tier,
  20 for a shield and 20 for a turret; a home base costs nothing itself. A lost ship or a downed base costs nothing.
  Both grow 4% per sector (capped at x1.36).
- **Mothball:** the Mothball button on a ship's row (or **M**) hands in its cargo, drops its orders and parks it at home
  at once. It then costs 20% of its maintenance. Wake it to work again after 10 seconds. A mothballed or waking
  ship takes no orders.
- **Debt:** you start with a loan of 1,500 that grows 1.5% a minute (compounded every 60 s). It is due when you leave sector 3:
  the warp is refused if credits plus the cargo still aboard fall short (the message says by how much), and paid
  automatically when they cover it. Backstop: still unpaid at 45 minutes (2,700 s) and you cannot pay, the run ends.
- **Bankruptcy:** below -250 credits for 60 seconds in a row ends the run. Getting back above clears the clock.
  Below 0 you cannot build new ships or add-ons (a new base is still allowed).
- **Timer:** a sector must be cleared within 1.5 x its par time (from sector 2; sector 10's limit after that).
  Off by default.
- **Stranded first:** if the run is also stranded, it ends as stranded. Being stranded counts credits at the Buy prices
  (ore 3, ice 6) for ore and ice; crystal only counts from stock.
- **Switches:** `state.rules` has `maintenance`, `upkeep`, `debt`, `bankruptcy` and `timer` (saved with the game).
  A rule that is off never ends a run; with bankruptcy off, credits stop falling at the floor. Stress mode switches all off.
  Tech nodes (Lean crews, Navy contracts, Modular bases, Credit line) soften the costs.

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
  picked. **Dwarven** (30 stars) turns ships into dwarves and mine carts, bases into forges (home is the great
  hall), ore/ice/crystal into iron/silver/gems, hazards into cave-ins and flooded tunnels, in a torch-lit
  cavern. **Hamster** (60 stars) turns ships into hamsters, bases into running wheels (they spin while ships
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
Saves from before credits load with 500 credits, no debt and the debt rule off; the other rules are on.

## Files

- `game.js`: all rules (the feedback payload, maps from a seed, sectors and difficulty, hazards, upgrades, score, stars, the
  bank and hangar unlocks, costs, mining, cargo, save format). No DOM; works in the browser as
  `FleetGame` and in Node via `module.exports`. Every number you might tune is in the `TUNING` table at
  the top, and the hangar items are in `LOOKS`.
- `main.js`: drawing, input, panels, the Hangar, Players, Scores, Stats and Feedback screens, and the loop (fixed 30 Hz update, drawn on
  requestAnimationFrame).
- `index.html`, `style.css`: page and layout.
- `tests.js`: tests for `game.js` (including the feedback payload, replies, saved list, manual flying and numbered targets).

## How to test

    node tests.js

Prints each test and a `N passed, M failed` line; exits non-zero on failure. No packages needed. Without
Node installed, VS Code's bundled runtime runs the same file:

    ELECTRON_RUN_AS_NODE=1 "E:\Evan\Programs\VSCode\Code.exe" tests.js
