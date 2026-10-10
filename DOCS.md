# DOCS: plan, progress and mistakes

Working notes, one batch of work at a time (newest first). Each batch has its plan, what was done
for each step, and a log of every mistake made along the way (what went wrong, and how it was fixed).

# Batch 12 (10 Oct): security check, and an F1 guide

## Security audit (whole game)

| Area | What I checked | Result |
| --- | --- | --- |
| Dependencies | `npm audit` (production) | 0 known vulnerabilities |
| Passwords | storage | scrypt with a random salt; a dummy hash so usernames can't be probed |
| Sessions | cookie flags | HttpOnly, SameSite=Strict, Secure on HTTPS; expiry and "log out everywhere" |
| Cross-site attacks | API and sockets | requests from other websites refused (Origin check); strict CSP; no framing |
| Rate limits | logins, sign-ups, guests, edits, joins, chat, reports, friends, dev passkey | all limited, per real player IP (the Dockerfile trusts Railway's proxy) |
| Dev cheat passkey | where it's checked | server only, timing-safe compare, never in the page; guesses limited per account and per network |
| Player input | every socket event | parsed and range-checked; movement and shooting run on the server (no speed, teleport or fire-rate hacks) |
| Injection | HTML in the page; database | player text is always shown as text; the only HTML inserted is the game's own fixed drawings; database queries are prepared statements |
| Crashes | junk on every event (new [server/test/fuzz.test.ts](server/test/fuzz.test.ts)) | ~36 events x 30 kinds of junk x 3 forms, in every non-ranked mode: no crash, no uncaught error, no prototype pollution; Railway also restarts on failure |

**Fixed in code:** nothing needed fixing. The new fuzz test now guards against future crash bugs.

**For you to change on Railway (settings, not code):**
1. **`DEV_ACCOUNTS_ONLY=1`.** Right now anyone who guesses the dev passkey gets the dev cheat in public rooms. With this, only your developer account may even try.
2. **A long passkey** (12+ random characters). The server warns about short ones.

**Known limits (by design, worth knowing):**
- In casual modes, every player's position is sent to every client (ranked FaceChiken hides players you can't see), so a modified client could see through walls there.
- Chat has no swear filter or mute button yet.

## F1 guide

- **F1** (anywhere: title screen or in a match) opens **How to play**: first steps, moving, fighting, other keys, every mode with its icon, and good-to-know notes (levels only move in FaceChiken, HvH is the cheats-allowed mode, daily challenges, reporting). F1 again, Esc or ✕ closes it.
- The keys come from your own bindings and the modes from the mode list, so it stays right after rebinding or adding modes. It's also on the title screen ("How to play · F1", replacing the old Controls pop-up) and in the pause menu.
- Code: [client/src/ui/Guide.ts](client/src/ui/Guide.ts); F1 in [client/src/app/App.ts](client/src/app/App.ts) (it also stops the browser's own F1 help page).
- **Checked in the browser:**
  - F1 opens it (6 sections, 13 modes, 18 key rows); F1 again closes it; the title-screen link opens it.
  - In a match, F1 opens it and pauses input, and the pause menu has the button.
  - The phone layout fits, with no errors.
- Typecheck, the build, and three full test runs (425/425) pass.

## Mistakes log (batch 12)

1. **The fuzz test's first run failed on a join.** The storm had used up the player's join rate limit, which is the limit working. **Fix:** a fresh player per mode.
2. **One full test run failed in the Knife Fight bot test.** It's the timing-flaky test noted in batch 1; this batch touched no bot or knife code, and three reruns passed 425/425.

# Batch 11 (10 Oct): Training mode

Solo practice: any gun, any knife, targets that never shoot back, no clock, no score, nothing counted.

Key: **B** is already the action key in ChikenBomb (buy menu), Zombie Apocalypse (shop) and Sandbox (build), but in a Training room it does nothing else, so B opens the weapon menu there.

## The plan

| # | Step | Status |
| --- | --- | --- |
| T1 | Shared: the `training` mode (Casual), its gun and knife lists, training ammo rules, a `trainingGive` request | Done |
| T2 | Server: a `TrainingRoom` (always your own private room); targets: static and slowly strafing dummies that never shoot and respawn 3 s after dying (and heal 3 s after a hit); you take no damage; kills count for nothing; the match never ends; infinite ammo, instant reload, grenade refills | Done |
| T3 | Server checks the weapon menu: only in Training, only known guns/knives | Done |
| T4 | Lobby card: icon, "Solo · practice", description, map choice, Play | Done |
| T5 | Weapon menu (B): every gun, every knife, egg/smoke/flash refills; B or Esc closes; the HUD and pause match (pause says "Back to lobby") | Done |
| T6 | Tests and a live check: starts from the lobby, B menu, every weapon and knife, targets respawn, no timer, can't die, stats unchanged | Done |

## What was done (batch 11)

- **T1 Shared.**
  - [shared/src/modes.ts](shared/src/modes.ts): the `training` mode on Flat, Farm and Town. One human (`maxHumans: 1`), no time or score limit, targets respawn after 3 s, no bots, no drops, no spawn protection.
  - [shared/src/training.ts](shared/src/training.ts): the gun list (Arms Race's ladder order first, then every other gun: 21) and the knife list (every melee weapon: 8). Also the ammo rules (`trainingMods`: infinite ammo, instant reload, infinite flashes) and `trainingLoadout` (one gun + one knife).
  - [shared/src/protocol.ts](shared/src/protocol.ts): the `trainingGive` request.
- **T2 Server room.**
  - [server/src/rooms/TrainingRoom.ts](server/src/rooms/TrainingRoom.ts): 8 brown targets on open ground 7-35 m from your start, a few of them strafing slowly across your view. They turn to face you, never shoot, heal 3 s after a hit and respawn at their spot 3 s after going down.
  - You can't be damaged at all (targets, your own eggs or rockets; the game has no fall damage).
  - Downed targets count no kill and no score (`kill(..., counted = false)`, from the team-switch work).
  - `endMatch` does nothing, and since that is the only place results reach the database, nothing is ever recorded.
  - **Plumbing:** [modes.ts](server/src/rooms/modes.ts) picks the room. [RoomManager.ts](server/src/rooms/RoomManager.ts) always makes your own private room (a random map for "Any map"). [GameRoom.ts](server/src/rooms/GameRoom.ts) only changes `pickSpawn` from private to protected, so Training can choose spawns.
- **T3 Checked by the server.** [server/src/app.ts](server/src/app.ts) answers `trainingGive` only in a Training room, and the room accepts only weapons from the two lists or one of the three grenades.
- **T4 Lobby card** (Casual tab): a drawn target icon, "Solo · practice", the description, the map choice and Play. It has no leaderboard trophy and is not offered in Create room or on the leaderboards ([MainMenu.ts](client/src/ui/MainMenu.ts), [icons.ts](client/src/ui/icons.ts), [Dialogs.ts](client/src/ui/Dialogs.ts)).
- **T5 Weapon menu (B).**
  - [client/src/ui/TrainingMenu.ts](client/src/ui/TrainingMenu.ts): guns and knives shown with their own pictures (the kill-feed silhouettes), plus egg, smoke and flash refills. What you hold is marked; B or Esc closes it.
  - [GameSession.ts](client/src/game/GameSession.ts): opening the menu frees the mouse, and a pick switches you to that weapon.
  - [WeaponController.ts](client/src/game/WeaponController.ts) predicts the same infinite ammo and instant reload, without touching dev code.
  - **HUD:** a practice line, no leaders list, and the hint "B · Weapons · Esc · Back to lobby" ([Hud.ts](client/src/ui/Hud.ts)).
  - **Pause** says **Back to lobby** and hides Report a player ([App.ts](client/src/app/App.ts)). Styles are at the end of [style.css](client/src/style.css).
- **T6 Checked.**
  - **Server tests:** [server/test/training.test.ts](server/test/training.test.ts), 5 tests.
  - **Live from the lobby:**
    - The card shows "Solo · practice"; the room has 8 targets, no timer and no end time.
    - B opens 21 guns, 8 knives and 3 grenades, and all 29 weapons land in your hand. Esc closes.
    - A rifle target went down and came back; the magazine stayed 30/30.
    - You stayed at 100 HP with 0 kills and 0 score. Pause showed Back to lobby, which returned to the title.
    - Coins, rank points, kills, deaths, wins, matches, history and daily progress were identical before and after.
  - Typecheck, all 424 tests and the build pass. No HvH panel or dev mode file changed.

## Mistakes log (batch 11)

1. **The card showed a leaderboard trophy, and "Any map" always picked Flat.** Both spotted in the screenshots and fixed.
2. **Test-script slip:** the pause backdrop blocked a headless click; the script clicks through script. Not a game bug.

# Batch 10 (8 Oct): the dev cheat's anti-aim works again

- **The bug.**
  - In the dev cheat (mega?dev, the L key), Rage > Spin bot and Fake pitch did nothing.
  - An outside PR (mazocracks-pixel, d57df7b, 5 Oct) made the dev cheat's input changes run **only in HvH**. The same day, your rule made the dev cheat **off in HvH**. Together they could never run anywhere.
- **The fix.** One line in [client/src/dev/classic/DevRuntime.ts](client/src/dev/classic/DevRuntime.ts) (`modifyFrame`): the HvH-only check is gone. The dev cheat's own on-switch already keeps it off in HvH and ranked FaceChiken (the server decides that), so nothing else changes.
- **Same cause, also back.** The dev cheat's other input options were blocked by the same line: jump assist, auto strafe, movement assist, and keeping your chicken still during free cam and spectate. Only anti-aim was tested.
- **Checked live.** Two players in a private Team Fight; one turned on the dev cheat with the passkey.
  - The other player saw the body spin, fake pitch Down (-1.2) and Up (1.05), and jitter around backwards.
  - Turned off, everything went back to normal.
  - Walking while spinning went exactly where the camera faces.
- **Test.** [client/test/classic-antiaim.test.ts](client/test/classic-antiaim.test.ts) fails without the fix and passes with it. Typecheck, all 419 tests and the build pass.
- **Mistake.** My first live test showed sideways drift while walking. It was the match-start respawn resetting the camera mid-test, not a bug; the test now waits for the match to start.

# Batch 9 (7 Oct): pitch anti-aim fix

- **The bug.** In the **Skeet** panel, Pitch (Look / Down / Up / Zero) did nothing once **Use state builder** was off: your head always followed your real look. The setting is stored with the state builder, and the server only read it while the builder was on. Skeet has no separate fallback pitch, so nothing applied.
- **The fix.** One line in the shared function the server uses to choose the head pitch (`hvhPitch` in [shared/src/hvh.ts](shared/src/hvh.ts)): Skeet's Pitch now applies with the builder on or off. The Lab panel and bots are unchanged. The hit head still follows the drawn head (the head test checks Down, Look and Up).
- **Checked live.** Two players in one HvH room; one tried every pitch with Lab, Skeet with the builder on, and Skeet with it off, while the other watched. Before the fix, Skeet with the builder off showed -0.15 (the real look) for every choice. After it, every combination is right on the server and on the other player's screen: Down -1.15, Up 0.85, Zero 0, Look the real pitch.
- **Tests.** The pitch test now covers the builder-off case. Typecheck, all 418 tests and the build pass.
- **Mistakes.** Two test-script slips: I asked for a map HvH doesn't use (Flat), and clicked through the setup overlay. Neither was a game bug.

# Batch 8 (7 Oct): no "No matches running"

- The line under the title bar no longer says "No matches running". When nobody is in a match it is hidden; when people are playing it shows "N players in matches" (it refreshes every 20 seconds). "Offline" still shows if the server can't be reached. Code: `refreshLive` in [client/src/ui/MainMenu.ts](client/src/ui/MainMenu.ts).
- Checked in the browser (the row shows Controls and Cookies & privacy); typecheck, all 418 tests and the build pass.
- Mistakes: none.

# Batch 7 (7 Oct): textures and surfaces on the title screen

The title screen's sky and ground are the live 3D Courtyard scene, not a flat page colour, so the sky and ground work happens in the 3D world (only on that map) and the buttons, logo and panels in CSS. The chicken is not touched: no change to its model, run, speed, size or spot, and nothing is drawn on it.

**One style: hand-painted**, like the chicken (soft painted shapes, feather scallops, no outlines), not pixel art. Every texture is painted in code (canvas or tiny inline SVG), so nothing is downloaded and nothing is sharper than the chicken.

## The plan

| # | Step | Status |
| --- | --- | --- |
| AA | Sky: hand-painted puffy clouds at several distances, drifting slowly (they shift against each other as the camera moves: parallax), a fine grain in the sky so it isn't a flat smooth gradient, and a soft warm haze at the horizon. The noise clouds are off here. Reduced motion: the clouds stop | Done |
| AB | Ground: a new "yard" ground of painted packed dirt, sand, pebbles and grass flecks, with large patches of colour across the yard so the repeat doesn't show; a worn dirt track along the chicken's lap; painted grass tufts off the track | Done |
| AC | Buttons: painted wood signs (PLAY in yolk paint over wood grain, nail heads), a stained-plank bottom bar, wooden plaques for the menu buttons. Pressing really pushes them in | Done |
| AD | Logo: painted letters (brush streaks inside the yolk) with a hard offset shadow; the HVH badge as a red painted plank | Done |
| AE | Panels: Today and What's new on dark burlap with a stitched edge; the mode select on paper with fibres | Done |
| AF | Checks: before/after screenshots with the chicken at the same spot on its lap, desktop and phone, textures well under 200 KB, smooth on phones | Done |

## What was done (batch 7)

- **AA. Sky** (Courtyard only: [client/src/game/Sky.ts](client/src/game/Sky.ts), [client/src/game/Yard.ts](client/src/game/Yard.ts)).
  - Twelve painted puffy clouds (round puffs, flat cool-grey bottoms, brushed highlights) at three distances: far ones small and slow, near ones bigger and quicker, so they slide past each other as they drift (parallax).
  - A fine grain over the sky so it isn't a flat smooth gradient, and a warm haze along the horizon.
  - The old noise clouds are hidden on this screen but stay in the baked lighting, so everything is lit exactly as before.
  - With reduced motion turned on, the clouds stand still (checked).
- **AB. Ground.**
  - A new "yard" ground ([client/src/game/textures.ts](client/src/game/textures.ts) `yardTexture`): painted packed dirt and sand, pebbles and grass flecks, in a 512 px tile.
  - The ground's large colour patches break up the repeat. The tile repeats about every 140 m, so no repeat is visible from the title camera.
  - A worn dirt track with ruts and kicked pebbles runs under the chicken's lap, its edges wobbling.
  - About 240 painted grass tufts sit off the track and out of the buildings, all drawn in one call.
- **AC. Buttons.**
  - PLAY is a painted wooden sign: yolk paint over wood grain, two nail heads, and it sinks with a dent when pressed.
  - The bottom bar and the line under it are dark stained planks with seams and nails.
  - Change mode and the menu buttons are small wooden plaques: grain, a lighter top edge and a hard drop. Pressed, they sink and darken.
- **AD. Logo.** Brush streaks of light and dark yolk painted inside the letters, the ink outline, and a hard offset shadow (no blur). The HVH badge is a red-painted plank.
- **AE. Panels.**
  - Today, What's new and your profile tag are dark burlap with a stitched yellow edge and a hard shadow.
  - The mode select and its tickets are paper with faint fibres.
- **AF. Checks.**
  - **The chicken.** No chicken file changed (model, run, speed, size and spot), and nothing is drawn on it. To prove it, before and after were rendered with the chicken pinned at the same spot and stride, and its pixels compared inside its exact silhouette.
    - Phone: 130,537 of 130,537 chicken pixels identical.
    - Desktop High: 99.8% identical. Two renders of the same new scene also differ by about that much (77 pixels), so the rest is High quality's render noise in the test browser, not a change.
  - **Size.** The CSS textures are 6 inline SVGs, 3.3 KB in total; the 3D ones are painted in code when the page loads. Nothing new is downloaded, far under 200 KB.
  - **Cost.** 14 extra draw calls on the title screen only (12 clouds, the tufts, the track). Matches are untouched.
  - **Contrast.** The text is unchanged and keeps its colours. The burlap, grain and fibres are faint.
  - **Tests.** Typecheck, all 418 tests and the build pass (real exit codes, test servers stopped first).

## Mistakes log (batch 7)

1. **Turning off the old clouds changed the chicken's lighting.** I first set the title look's clouds to 0, which also removed them from the baked sky lighting the chicken is lit by. The pixel check caught it. **Fix:** the clouds are hidden only in the visible sky; the lighting keeps them.
2. **Vite hung while I swapped files under it** (setting the changes aside to take "before" shots). **Fix:** stop Vite, swap, start it again.
3. **My first chicken comparison was wrong twice.** A brightness-based mask also caught the pale sky, and the run cycle starts at a random moment. **Fix:** pin the stride, compare inside the chicken's real silhouette, and measure the renderer's own noise.
4. **Shell edits broke again.** An inline `node -e` edit failed because the stash brought the files back with Windows line endings, and a heredoc mangled a template string. **Fix:** file editor only (the rule from batch 1).

# Batch 6 (7 Oct): the menu moves to a bottom bar, and a more serious look

Why the menu was on the left: the running chicken is on the right of the title screen (as asked in an earlier batch), so the menu went on the other side to stay clear of it. Your choice now: **a bar along the bottom**, with the logo top-left and the chicken staying on the right.

## The plan

| # | Step | Status |
| --- | --- | --- |
| Z1 | Title screen: PLAY and every menu button in one dark bar along the bottom (full width), with the online count, controls and privacy in a thin line under it. Today's challenges and what's new move into the empty space on the left. The chicken stays where it is | Done |
| Z2 | More serious: nothing tilted (PLAY, the HVH badge, the cards, the "wins" tag), a calmer logo shadow, darker panels on the title screen | Done |
| Z3 | Plainer wording: "Leaderboard", "Competitive" / "Fun" tabs, "Choose a mode", "No bots", "Resume", "Enter the code", "Wrong code" and similar | Done |
| Z4 | Phone: the same bar at the bottom (PLAY, then a row of icons); check desktop, wide screen and phone | Done |

## What was done (batch 6)

- **Z1. The bottom bar.**
  - **Bar:** PLAY (with your mode, map and bots line) and Change mode on the left; Shop, Friends, Daily, Leaderboard and Settings on the right. It is full width, dark, with a yolk line along its top. A thin line under it shows who is playing, Controls, and Cookies & privacy.
  - **Left side:** Today's challenges and What's new sit in the empty space on the left, on dark panels with a yolk edge.
  - **The chicken** is untouched and keeps the right side. The hide-menu button moved to the top right, under your profile.
  - **How:** the layout is CSS only (the menu's wrapper is set to `display: contents`, so PLAY, the buttons and the cards each take their own row of the title grid). No game logic changed.
- **Z2. More serious.**
  - **Nothing tilted:** the PLAY button, the HVH badge, the What's new card and the winner tag on the match-over screen.
  - **Calmer logo:** a plain dark drop shadow (the red layer is gone), and the HVH badge sits flat.
  - **Darker panels:** the profile tag and the info cards use the same dark ink as the bar. The mode select, dialogs, HUD and keypad keep the batch-3 look.
- **Z3. Plainer wording.**
  - **Title screen:** "Top chickens" is now Leaderboard, "Switch mode" is Change mode, and the online line reads "No matches running" / "N players in matches".
  - **Mode select:** "Pick a fight" is now Choose a mode, "Serious" / "Silly" became Competitive / Fun, and "Humans only" is No bots.
  - **Pause, keypad and HvH:** "Click to jump back in" is now Click to resume; the keypad says "Enter the code", "Wrong code." and "Access granted"; the HvH choice is "Choose your panel". What's new is plainer too.
  - **Server:** its wrong-code reply and the test for it changed to match. The Skeet QA script looks for "Change mode" again.
- **Z4. Phone.** The same dark bar at the bottom: PLAY full width, Change mode, then five big icon buttons, and the status line. The logo and HVH stay on one line. The chicken is clear in the middle.
- **Checked:**
  - Screenshots at 1280x720, 1920x1080 and a phone, plus the mode select. No sideways scrolling, no errors.
  - `check-native-menu.cjs` passes.
  - Typecheck, all 418 tests and the build pass, checked by their real exit codes with the test servers stopped first.
- Code: the end of [client/src/style.css](client/src/style.css) ("Batch 6"), the wording in [client/src/ui/MainMenu.ts](client/src/ui/MainMenu.ts), [client/src/app/App.ts](client/src/app/App.ts), [client/src/ui/HvhSetup.ts](client/src/ui/HvhSetup.ts), [client/src/dev/passkey.ts](client/src/dev/passkey.ts), [server/src/app.ts](server/src/app.ts).

## Mistakes log (batch 6)

1. **First try: the status line sat beside the bar, not under it.** A batch-3 rule placing it (`.main-menu.lobby > .lobby-bottom`) was more specific than the new one, so both landed in one row and the grid grew a second column. **Fix:** the new rows use the same selectors, and the grid has exactly one column.
2. **First try: text wrapped.** "Change mode" and the PLAY mode line broke onto two lines, and on phones "HVH" fell under the logo. **Fix:** no wrapping on those labels, and a slightly smaller phone logo.

# Batch 5 (7 Oct): no names over enemies

| # | Step | Status |
| --- | --- | --- |
| Y | Names above chickens: teammates keep theirs, enemies don't show one. In free-for-all modes everyone is an enemy, so no names | Done |

- One flag on each remote chicken ([client/src/game/RemotePlayers.ts](client/src/game/RemotePlayers.ts)): the tag shows only when that chicken is a teammate. It follows a team switch (M) at once. The scoreboard, kill feed and chat still show every name. The cheat panels' own name ESP is unchanged.
- Checked in a Team Fight with bots: the teammate showed a name, the 2 enemies showed none, and the same held after pressing M. In Against All, 3 enemies, no names. All tests and the build pass.
- Mistakes:
  1. **Pushed while one test had failed.** The first full run said 417 of 418 (my test servers were still running and loading the CPU). The commit went ahead anyway: in `npm test | grep …` the exit status is grep's, not the tests'. Five reruns right after were all 418/418, so it was a timing-sensitive test under load, not this change. **Rule:** read the `fail 0` line before committing, and stop the test servers before the full run.

# Batch 4 (7 Oct): a better chicken, same hitboxes

## The plan

The hitboxes live in shared code (`HITBOX`, `buildHvhMatrix`, `CHICKEN_POSE`) and are not touched; only the drawing in [client/src/game/models/Chicken.ts](client/src/game/models/Chicken.ts) changes. The head stays exactly where its hitbox is (a test checks it), and the new parts stay inside the old outline.

| # | Step | Status |
| --- | --- | --- |
| T | Feathers: a soft feather texture with relief, smooth shading, rounder shapes | Done |
| U | Head: a serrated comb, an upper and a lower beak, two wattles, earlobes (same cartoon eyes) | Done |
| V | Body: a fuller chest, wings made of layered feathers, a tail with two long sickle feathers | Done |
| W | Legs: feathered thighs, thinner shanks, real toes (three forward, one back) | Done |
| X | Checks: shared hitbox code unchanged, the head test passes, the new parts stay inside the old outline, screenshots | Done |

## What was done (batch 4)

- **Hitboxes: unchanged.** Nothing in `shared/` or `server/` changed (`HITBOX`, `buildHvhMatrix`, `CHICKEN_POSE` are as they were). The drawn head is the same sphere in the same place, and the head test still checks it sits exactly on the hit head while walking, aiming and crouching. Body, chest, wings and thighs stay inside the old outline; a wireframe of the real hitboxes over the new model matches as before.
- **T. Feathers.** One small feather-scale texture (rows of rounded tips), used for colour and slight relief and tinted per skin, on smooth, rounder shapes. Metal skins (golden, robot, diamond) stay shiny.
- **U. Head.** A serrated comb (one piece, hidden under hats as before), an upper and a slightly open lower beak (both take the beak cosmetic), two wattles and red earlobes. The cartoon eyes and brows stay.
- **V. Body.** A rounder chest inside the body; wings with a shoulder and three flight feathers; the five-feather tail fan plus two long sickle feathers in the darker wing shade.
- **W. Legs.** Feathered thighs, thinner shanks, and three toes forward plus one back instead of the box foot. Shoes still replace the feet.
- **Cost.** The new parts are merged into a few meshes (tail, sickles, each wing, each foot), so a chicken draws about as many pieces as before (around 40).
- **X. Checked.** A four-side turntable of four skins (white, shadow with helmet and shoes, golden, brown), the hitbox overlay, the title screen on High, and all 418 tests, the typecheck and the build pass.
- Code: [client/src/game/models/Chicken.ts](client/src/game/models/Chicken.ts). The head test's stand-in canvas now accepts any drawing call: [client/test/chicken-pose.test.ts](client/test/chicken-pose.test.ts).

## Mistakes log (batch 4)

1. **First pass looked knitted.** The feather pattern was too dense and too strong. **Fix:** bigger, fainter scales and less relief.
2. **A wing feather poked out below the body at the back, and the comb looked like a stick from the front.** **Fix:** shorter, flatter flight feathers inside the old wing outline, and a thicker comb.
3. **Test-script slip.** I asked for a "gold" skin (it's "golden"), so the first turntable showed white twice. Fixed in the script.

# Batch 3 (7 Oct): a new look for every screen (not the chicken, not the cheat menus)

## The plan

Look: the sky blue `#9fd4f5` as the base, egg-yolk yellow and barn red as accents, dark-brown "ink" outlines, and cream "paper" panels. One bold display font, **Lilita One**, self-hosted, on every title, button and big number. Buttons are chunky, with a thick outline and a hard drop that sinks when you press it. No gradients, glass, glows, soft shadows or emoji icons; icons are drawn as SVG.

| # | Step | Status |
| --- | --- | --- |
| L | The look: colours, font, buttons and panels, scoped to the game's own screens so the Skeet / Lab / mega?dev menus can't change | Done |
| M | Title screen: the running chicken stays exactly as it is; a huge logo, one obvious PLAY, a small menu on the left, nothing over the chicken (phone too) | Done |
| N | Mode select (and the HvH panel choice): bold tabs, mode tickets with drawn icons | Done |
| O | In-match HUD: smaller, tucked into the corners, nothing over the middle | Done |
| P | Match over: a huge score first, then the next-match countdown, then the rest | Done |
| Q | Dev code entry: a keypad with a masked display (the code is never shown) | Done |
| R | Pause and Settings in the same style; big tap targets on phones, no zoom | Done |
| S | Screenshots of every screen, with the chicken and the cheat menus in place | Done |

Notes on the brief: this is a shooter, so the HUD shows health, ammo, kills and the timer (there is no distance). A match ends with an automatic next match, so "retry" is that countdown.

## What was done (batch 3)

- **L. The look.**
  - New section at the end of [client/src/style.css](client/src/style.css) ("Barnyard"). Colours: sky `#9fd4f5`, yolk `#ffc533`, barn red `#b8362b`, ink `#2b1a10`, paper `#fff3d6`.
  - Font: **Lilita One** (`@fontsource/lilita-one`, self-hosted, so the CSP stays `font-src 'self'`) on titles, buttons and big numbers; body text stays plain.
  - Buttons have a 3px ink outline and a hard 4px drop that sinks on press. Panels are paper with a hard offset shadow. Icons are drawn SVG ([client/src/ui/icons.ts](client/src/ui/icons.ts)), replacing every emoji icon on these screens.
  - Everything is scoped to the game's layers with `:where()`, so it stays low-priority there and never reaches `<body>`, where the Skeet, Lab and mega?dev menus live. dev.css is untouched apart from deleting the old passkey dialog's rules.
- **M. Title screen.**
  - The chicken is untouched (sprite, run, speed, position). A big yolk logo with a barn-red HVH stamp, one tilted PLAY with a red play disc, then small paper tags for the rest (Shop, Friends, Daily, Top chickens, Settings).
  - Today's challenges and what's new are two small tickets between the menu and the chicken.
  - On phones the logo sits on top and PLAY plus a row of five big icon buttons at the bottom; the middle stays clear for the chicken.
- **N. Mode select ("Pick a fight")** is a paper board: bold tabs (Casual / Serious / Silly) and mode tickets with drawn icons. Ranked FaceChiken gets a barn-red top edge. The **HvH panel choice** ("Pick your panel") uses the same tiles and fits on a laptop screen.
- **O. HUD.** Smaller, outlined text and dark ink tags in the corners: K/D and leaders top-left, timer and team chips top-centre, health bottom-left, ammo bottom-right. The middle stays clear. On phones the thumbs own the bottom, so health sits under K/D, the ammo under the corner buttons, and the kill feed below it.
- **P. Match over.** The winner line, then your score, huge, counting up (a score tick, instant with reduced motion). Then "Next match in 8" as the retry, "Esc for the menu", then the stats, the final score, MVP, rewards and the table.
- **Q. Dev code.** A keypad: a dark display that only shows dots (never the code), keys 0-9 with Del and OK, and "Type letters" for codes with letters (keyboard typing works too). The server still checks every code. Its wrong-code message is now "Nope. Wrong code." Both menus share one keypad (`client/src/dev/classic/passkey.ts` re-exports it).
- **R. Pause and Settings.** Pause is a paper card with a big "Paused" and one obvious "Click to jump back in". Settings and the other dialogs are paper with yolk tabs (no emoji), and the old grey labels are readable. All taps are at least 44px, fields use 16px text (phones don't zoom), and the page already blocks pinch zoom.
- **S. Checked.**
  - Screenshots of every screen on desktop and phone, the Skeet and Lab menus open in place unchanged, and `check-native-menu.cjs` passes.
  - The keypad test: taps, typing, Del, a wrong code, then the right code; the code never shows.
  - Typecheck, all 400 tests and the build pass.

## Mistakes log (batch 3)

1. **The phone title covered the chicken at first.** The hidden party strip let the grid rows shift, so the menu jumped up under the logo. **Fix:** every part of the title screen has a fixed row.
2. **My HUD corner rules broke the touch layout.** Setting bottom/right on the HUD corners fought the phone rules (which move them to the top), and the ammo box landed mid-screen. **Fix:** only the phone rules position them. (The phone HUD was already crowded before this batch; it is tidied now.)
3. **Settings labels were grey on cream.** The old rules use the dark-theme colour variables. **Fix:** the paper panels redefine those variables, so every old rule follows. The same leftovers caused an old border on the "Match starts" banner and grey tabs in the mode select; both fixed.
4. **I broke the Skeet QA script twice with copy changes.** "Change mode" became "Switch mode", and dropping the emoji left two buttons named exactly "Create room". **Fix:** the script looks for "Switch mode" and clicks Create room inside the dialog. **Rule:** run `check-native-menu.cjs` after any menu wording change.
5. **A keypad bug, caught by its test.** After tapping a key, pressing Enter "clicked" that key again. **Fix:** Enter always submits.
6. **Test-script slips (not game bugs).** My first match-over screenshot was undone by live server updates, and a wait for the keypad was too short for the slow software renderer. Fixed in the scripts.

# Batch 2 (6 Oct): lobby music, a wider lap, a better Skeet panel

## The plan

| # | Step | Status |
| --- | --- | --- |
| G | Lobby music: `CHIKEN_HVHLOBBY` loops on the title screen, fades out when a match starts, has its own volume in Settings | Done |
| H | The title-screen chicken's lap: wider again, still clear of every wall | Done |
| I | Skeet panel (C++ compiled to WebAssembly): install the exact compiler it was built with (Emscripten 4.0.22), check the unchanged source rebuilds and works, then make it better | Done |
| I1 | Tabs: a drawn icon for each tab (crosshair, shield, pistol, eye, gear, paint drop, player) instead of plain text, in the menu colour when selected | Done |
| I2 | Section headings in bold with a divider line; info lines in grey; sliders, lists and buttons lined up with the original Skeet controls | Done |
| I3 | Remove the ~20 "(unavailable)" lines that only cluttered Visuals and Misc | Done |
| I4 | **Menu color** picker (Misc > Settings), like real Skeet: recolours ticks, sliders and the selected tab icon, and is saved with your config | Done |
| I5 | Fixes: the Skins tab's two empty boxes, three buttons all called "Apply", bot names showing "?" (the emoji has no letter in the menu font), and the Legit tab ignoring a click | Done |
| J | (added mid-batch) Bug: holding the Shadow Daggers makes the screen flash blue. Find the cause and fix it | Done |
| K | (added mid-batch) **M** switches your team (Red to Blue, Blue to Red), checked by the server. Not in FaceChiken: ranked teams are random and can't be changed | Done |

Same rules: read first, smallest change that works, test, look at it in the browser, commit only when every test passes.

## What was done (batch 2)

### G. Lobby music
- `CHIKEN_HVHLOBBY.mp3` is in `client/public/sounds/` with its exact name. It loops on the title screen and in the shop, fades in (0.8 s) and fades out when a match starts, and comes back when you return to the menu.
- Checked before adding: the track is 36.6 s long, with 0.2 s of silence at the start, which would leave a gap every loop. It is trimmed when the file loads, so the loop is seamless. It is loud (it peaks at full volume), so it starts at 40% volume.
- Browsers only allow sound after your first click or key press, so the music starts at that moment (any click or key on the page counts).
- **Settings > Sound** has a new **Lobby music** slider (0 turns it off). The main Volume slider also turns it down. It skips the effects compressor, so gunshots in a match never make it "pump".
- Checked in the browser: silent before any click; after a click it plays, looping, at 40%; in a match it stops; back on the menu it plays again; music volume 0 silences it; no errors.
- Code: [client/src/game/Audio.ts](client/src/game/Audio.ts) (`setMusic`), [client/src/app/App.ts](client/src/app/App.ts), [client/src/ui/Dialogs.ts](client/src/ui/Dialogs.ts).

### H. A wider lap
- The title-screen chicken's oval went from 12 x 10 m to 18 x 15 m (half-widths), half as wide again. One lap now takes about 16 seconds.
- Nothing had to move: the test that checks every point of the lap is at least 3 m from any wall, post, palm or hedge still passes, and the pergola and palms now pass right behind the chicken.
- Checked in the browser: four screenshots around the lap, no errors.
- Code: `LOBBY_LAP` in [shared/src/maps/lobby.ts](shared/src/maps/lobby.ts).

### I. The Skeet panel, in its C++
- **The compiler first.** Installed Emscripten 4.0.22 (the version the panel was built with) and rebuilt the *unchanged* C++. The output was byte-for-byte the same as the committed `menu.js` / `menu.wasm`, so any change after that comes only from the edits.
- **Before screenshots of all 7 tabs** showed what to fix: plain-text tabs; section names that looked like ordinary labels; sliders and lists out of line with the original controls; about 20 "(unavailable)" lines; three buttons all called "Apply"; two empty boxes on Skins; bots shown as "? Omelette"; and a click on Legit that did nothing.
- **I1 Tab icons**: drawn in C++ with ImGui shapes (the original icon font is missing): crosshair (Rage), half-filled shield (Anti-aim), pistol (Legit), eye (Visuals), gear (Misc), paint drop (Skins), head and shoulders (Players), with the name underneath. Grey, brighter on hover, and the menu colour when selected.
- **I2 Layout**: section headings are bold with a thin divider; info and status lines are grey, so they read differently from settings; sliders, lists and buttons line up with the names of the ticks, as in the original menu; spacing matches the original boxes.
- **I3**: the ~20 "unavailable" lines (Knifebot, Zeusbot, Ragdoll gravity, Danger Zone, money, hands…) are gone, and so is the dead code behind them.
- **I4 Menu color** (Misc > Settings): one picker recolours every tick, slider and the selected tab. It is saved with the config like every other panel setting (C++ `Config.h` field, the bridge, `nativeFields.ts`). Checked: set to red, everything turned red; picking a colour in the picker wrote it to the config and to storage.
- **I5 Fixes**
  - **The lost click (Legit).** ImGui applies a click over two frames, and the second frame used wherever the mouse was *by then*. Click and move away quickly, or click while the game runs slowly, and the release landed somewhere else, so the click was lost. `browser.cpp` now uses the press position on the press frame and the release position on the release frame.
  - **Duplicates.** Every box called "Other" (in Anti-aim, Legit and Misc) drew the same controls, so the Resolver settings showed up three times. Legit is now one "Triggerbot" box, and Misc's "Other" holds the recipes.
  - Skins is now "Weapon skin" and "Weapon stats", with no empty boxes.
  - The recipe buttons are named: "Apply precision safe points", "Apply ground peek", "Apply state jitter".
  - Bots read "Sunny (bot)": the menu font only has Latin letters, so other symbols are swapped or dropped.
- **Checked**
  - Typecheck, all tests (one new: every saved panel setting has its C++ case, so the two can't drift apart) and the build all pass.
  - `scripts/check-native-menu.cjs` passes: 7 tabs, key binding, colour pickers, save and load, small window, scene effects, reset when you switch panels, and FFA untouched.
  - After screenshots of every tab.
- Code: [client/native/skeet/menu/Menu.cpp](client/native/skeet/menu/Menu.cpp), [client/native/skeet/browser.cpp](client/native/skeet/browser.cpp), [client/src/dev/skeet/NativeMenu.ts](client/src/dev/skeet/NativeMenu.ts), rebuilt [client/public/skeet-native/](client/public/skeet-native/).

### J. Bug: the Shadow Daggers flashed the screen blue
- **Reproduced first.**
  - A test account bought and equipped the Shadow Daggers and played Knife Fight while holding attack.
  - Software rendering (7 fps) never showed it. On the real graphics card (180 fps) on **High** quality, **8 of 30 frames were solid light blue**, with only the HUD left.
  - The same test with the normal Knife: 0 of 30. On Medium and Low: 0 of 30. So it was the daggers, and only with High's bloom.
- **The cause.**
  - Scanning every weapon model for broken numbers found one problem in all 29 guns and knives: the daggers' blade had 42 points with a zero-length normal (84 for the pair).
  - Its short, wide tip with a bevelled edge made 14 zero-area triangles. Zero-area triangles have no direction, and lighting one gives NaN, an invalid number.
  - On High, the bloom blur spreads a single NaN pixel over the whole screen, so the screen showed only the sky colour behind it, which is the blue.
  - Every swing (and holding attack swings again and again) brought those slivers into view: blink, blink.
- **The fix.** The blade builder drops zero-area triangles (`dropFlatTriangles` in [client/src/game/models/Guns.ts](client/src/game/models/Guns.ts)). They are invisible anyway, so the blade looks exactly the same.
- **Checked**
  - The same High test, twice: 0 of 30 blue frames.
  - All 29 models are clean.
  - A new test checks every blade size the knives use has a proper normal on every point.

### K. M switches team
- **M** (rebindable in Settings > Keys) asks the server to move you to the other team. The server decides; the game only explains a "no".
- **Refused** in FaceChiken (ranked, random teams), Zombie Apocalypse (everyone on one side) and modes with no teams. A 5-second cooldown stops hopping back and forth. Teams can't end up more than 2 real players apart.
- **Like CS:** switching while alive costs that life, with no death counted and no penalty, so it can't save you from a fight or revive you. In ChikenBomb during buy time you go straight to your new spawn; mid-round you sit out until the next round.
- **Bots keep it even:** a full team gives up a bot's seat, and a half-full room rebalances (2 v 2 stays 2 v 2).
- Everyone sees "X joined Blue", and your friend/enemy colours flip at once.
- **Checked:** 5 new server tests, plus in the browser: Red to Blue, then the cooldown, then respawned on Blue with teams still 2 v 2; Against All says "This mode has no teams."
- Code: `switchTeam` in [server/src/rooms/GameRoom.ts](server/src/rooms/GameRoom.ts), `teamSwitchBlocked` in [shared/src/modes.ts](shared/src/modes.ts), [client/src/game/GameSession.ts](client/src/game/GameSession.ts).

## Mistakes log (batch 2)

1. **The first compile from PowerShell failed.** With `2>&1`, PowerShell 5.1 treats Emscripten's normal "sanity checks" message (printed on stderr) as an error and stops. Then `emsdk_env.bat` didn't put `em++` on PATH inside a batch file. **Fix:** a small batch file that sets `EM_CONFIG` and PATH itself and calls `em++.bat` by its full path. Written into the Skeet README.
2. **Batch 1 broke the Skeet QA script and I didn't notice.** The lobby redesign moved **Create room** into **Change mode**, and `check-native-menu.cjs` still looked for it on the title screen. It wasn't run after the menu change. **Fix:** the script opens Change mode first. **Rule:** run that script after any main-menu change.
3. **The new bridge test was wrong at first.** It assumed only colours are arrays, but a multi-select (brightness adjustment) is one too, so the test failed on correct code. **Fix:** treat every field whose key ends in `_0`, `_1`… as an array element.
4. **The shell ate a backslash again.** Editing that test with `node -e` in the shell turned `/_\d$/` into `/_d$/`. **Fix:** corrected with the Edit tool. **Rule (again):** edit files with the Edit tool or a .cjs script file, never inline in the shell.
5. **(J) My first guess at the blue flash was wrong.** I thought the slash swung the left dagger into the camera, and said so before checking. Measured, the closest it gets is 15 cm, and nothing covers the screen. **Rule:** measure before naming a cause.
6. **(J) Too long testing at 7 fps.** Software rendering at 7 fps can't show a one-frame flash, and it only happens on High. The first test should have matched how you play: graphics card, High quality, holding attack. That test found it at once.
7. **(K) The new test hung.** I used a Zombie map that doesn't exist ("graveyard"; it's "night"), the test failed, and the room it left open kept the run alive (the same hang as an earlier batch). **Fix:** take the map from the mode's own list, and close every room in a `finally`.
8. **(K) The first version left half-full bot rooms 3 v 1.** It only made room on a full team. The browser test caught it. **Fix:** after a switch, a bot leaves the bigger side and the bot top-up refills the smaller one. A test covers both cases.

# Batch 1 (6 Oct): sounds, scope, kill icons, inspect, gun shapes, main menu

## The plan

| # | Step | Status |
| --- | --- | --- |
| A | Your sounds: `AWP_SOUND` (sniper shot), `SNIPER_ZOOM` (scoping in with the Sniper or Scout), `equip_sound` (switching weapons) | Done |
| B | Scope on every sniper (Sniper and Scout): click once to scope, it stays; click again to zoom in further; a third click leaves the scope. No more scroll wheel | Done |
| C | Kill feed icons: a silhouette for every single gun, not one per gun family | Done |
| D | Better inspect (F): longer, smoother, a different move per kind of weapon | Done |
| E | More detailed gun shapes | Done |
| F | Main menu: look and feel like a game, not an app, with new features; checked in the browser | Done |

Rules for every step: read the code it touches first, change as little as works, test it, look at it
in the browser, then commit. Nothing is pushed if a test fails.

## What was done

### A. Your sounds
- The three files are in `client/public/sounds/` with their exact names: `AWP_SOUND.mp3`, `SNIPER_ZOOM.mp3`, `equip_sound.mp3` (the server is case sensitive, so the names in the code match the files letter for letter).
- **AWP_SOUND** plays for every Sniper and Scout shot (both use the game's "sniper" shot sound), yours and other players'. It goes through the normal sound chain, so a far-away shot is quieter and comes from the left or right.
- **SNIPER_ZOOM** plays when you scope in and when you zoom further, with the Sniper or the Scout.
- **equip_sound** plays when you switch weapons (the old click is kept for build mode).
- Checked before adding: `equip_sound` starts with 0.32 s of silence, which would make switching feel late. Silence at the start and end of every file is now trimmed when it loads (it plays 0.46 s instead of 1.1 s). The AWP shot starts right away and has a long echo (about 4 s), which is kept.
- If a file fails to load, the old built-in sound plays instead.
- Code: [client/src/game/Audio.ts](client/src/game/Audio.ts) (`FILE_SOUNDS`, `trimSilence`).

### B. Sniper scope (Sniper and Scout)
- The scope button (right mouse) is now a click, like Counter-Strike: **click once** to scope (it stays when you let go), **click again** to zoom in further, **a third time** to put it away. Switching weapons, reloading, getting in a car or dying puts it away too.
- Sniper: 4× then 8×. Scout: 3.2× then 6.5× (the Scout's second zoom is new). The scroll wheel switches weapons again.
- The hint line shows the zoom and what the next click does.
- You said "left click"; left click fires, so the scope is on the scope button (right click), as in CS. If you really want it on another button, it is one line to change.
- Checked in the browser: both guns cycle scope → zoom → off, the zoom sound plays twice, switching puts the scope away and plays the equip sound, and a sniper shot plays the AWP file.

### C. A kill icon for every gun
- Every gun's kill-feed icon is now drawn from the gun's own 3D model: side on, muzzle to the right, as a white silhouette (like Counter-Strike). So all 29 weapons have their own exact shape: each pistol, rifle, sniper, shotgun, knife, the katana and the pan look different. When a gun model changes, its icon changes with it.
- The icons are drawn once, a few per frame, shortly after your first match starts (so nothing stutters). Until a gun's icon is ready, the hand-drawn one from before is used; eggs, cars, the bomb and falls keep their drawn icons.
- Checked in the browser: a feed with one kill for each of the 29 weapons, every one showing its own picture.
- Code: [client/src/ui/GunIcons.ts](client/src/ui/GunIcons.ts), used in [client/src/ui/Hud.ts](client/src/ui/Hud.ts).

### D. Better inspect (F)
- Every kind of weapon now has its own inspect, with its own length:
  - **Pistols (2.6 s):** left side, a quick spin round the trigger finger, right side.
  - **Rifles, SMGs, shotguns (3.2 s):** left side, then turned over to check the magazine: it slides out a little and is slapped back in, with a click each way, then the right side.
  - **Snipers (3.4 s):** a heavy lift to show the side, then nose up to look along the scope.
  - **Heavy weapons (3.6 s, LMG, minigun, launchers, crossbow):** slow, with a little bounce from the weight; the minigun's barrels spin up while you look.
  - **Knives without a trick (2.8 s):** show the flat, toss it up spinning, catch it, show the other side.
  - **Butterfly, karambit, M9 and the other trick knives** keep their trick; **dual pistols and daggers** rock side to side.
- A small slow wobble is added on top, so the hand doesn't look like a machine.
- Shooting, aiming or reloading still stops it.
- Checked in the browser: screenshots partway through the rifle and pistol inspects, and the magazine clicks played once each per inspect.
- Code: [client/src/game/ViewModel.ts](client/src/game/ViewModel.ts) (`INSPECTS`, `inspectKind`); test: [client/test/inspect.test.ts](client/test/inspect.test.ts).

### E. More detailed gun shapes
- Guns were built only from rounded boxes. A new helper cuts a part from a drawn side outline (the way game guns are modelled), and the parts you see most now use it:
  - **Grips (every gun):** raked, with finger grooves on the front and a curved back strap.
  - **Pistol and Deagle:** slides sloped at the front and back, a shaped frame.
  - **Rifle:** one receiver with a magazine well, a tapered handguard, a stock with a sloped comb, and the curved magazine from before.
  - **Sniper:** a thumbhole stock and a fluted barrel.
  - **Shotgun:** a wooden stock with a pistol-grip wrist and a proper butt.
  - **SMG:** a receiver with an angled front and a magazine well.
  - **Knife:** a contoured handle with finger grooves.
- The kill-feed icons (step C) are drawn from the models, so they picked up the new shapes by themselves.
- Speed is unchanged: the parts are still merged per material (about 7 draw calls per gun).
- Checked with close-up renders of the rifle, sniper, pistol, Deagle, shotgun, SMG, knife and M9.
- Code: [client/src/game/models/Guns.ts](client/src/game/models/Guns.ts) (`profile`, `metresToUv`).

### F. Main menu: a game lobby, not an app
- The title screen is laid out like a game lobby (CS2 / Standoff style) instead of a page of cards:
  - **Left:** a big yellow **PLAY** cut at an angle, with your mode, map and bots choice under it; then **Change mode** and a column of slanted menu bars: Shop, Friends, Daily challenges, Leaderboard, Settings. They slide in one after another and slide out on hover.
  - **Right:** your chicken running its lap, now in the clear (the menu side of the screen is darker, the chicken side is not).
  - **Top:** the logo, and your level, XP bar, coins and account.
- **New features on the menu:**
  - **PLAY remembers your mode:** one click starts the mode you played last (with its map and bots choice). **Enter** does the same.
  - **Change mode** opens a full-screen mode picker: the mode cards by tab (your mode is highlighted), With bots / Without bots, Server browser, Create room and Join with code. Esc or ✕ closes it.
  - **Today's challenges** with progress bars, right on the title screen (Open shows the full list).
  - **What's new:** the latest changes. Edit `WHATS_NEW` in [client/src/ui/MainMenu.ts](client/src/ui/MainMenu.ts) to change it.
  - **Players in matches now:** a live count with a green dot, refreshed every 20 seconds.
  - **Menu sounds:** a soft tick on hover and a click on press.
  - **Controls** is a small button at the bottom instead of a long line of text.
- Everything that was on the old menu is still there (party strip, friends badge, leaderboard per mode, map picker, 🎬 to hide the menu, privacy link, the 5-tap logo shortcut).
- Checked in the browser at 1280×720, 1920×1080 and a 390×844 phone: PLAY starts your mode, Change mode → Team Fight played it and PLAY then showed Team Fight, Enter played it, Esc closed the picker, the challenges and player count loaded, no sideways scrolling on the phone, no errors.
- Code: [client/src/ui/MainMenu.ts](client/src/ui/MainMenu.ts), styles at the end of [client/src/style.css](client/src/style.css), `online()` in [client/src/net/Api.ts](client/src/net/Api.ts).

## Mistakes log

- **A test that depended on the date (from yesterday).** When daily challenges were added, I adjusted a ranks test to leave out daily-challenge coins, but only from the second match it records. Today one of the daily goals is "win a match", which the test's first match completes, so the test failed. It would have passed or failed depending on the day. Fix: the test now leaves out the daily coins of both matches. Checked by running it as if it were each of the next 20 days: it passes on all of them.
- **A wrong path in my own check.** The first 20-day check failed on every day, because the helper file's path lost its backslashes and never loaded, not because of the game. Fixed by putting the helper next to the tests. The real result is the second run (0 failing days).
- **DOCS.md text eaten by the shell.** I wrote the DOCS entry through a shell command, and the shell treated the backtick-quoted file names as commands to run, so they vanished from three lines (it only printed harmless "not found" errors; nothing was changed). Fixed by hand, and from now on DOCS.md is only edited with the file editor, never through the shell.
- **Magazine click repeating.** In the first version of the new inspect, the "magazine in" click played on every frame after the magazine check finished, instead of once. Caught by recording the clicks; fixed so each click plays exactly once per inspect (checked over two full inspects: out, in, out, in).
- **Magazine check pointed the wrong way.** My first magazine-check pose tipped the rifle so it pointed at the sky, with the magazine off screen; my second showed the top rail instead. I then rendered three candidate poses side by side and picked the one where the magazine faces you.
- **Two new gun parts placed wrong (caught before rendering).** Checking each new outline against the old part's position showed the Deagle slide would have left a 3 cm gap before the muzzle and the knife handle would have poked out behind its pommel. Both fixed before the first render.
- **Knife handle drawn inside out.** I listed the knife handle's outline points in the wrong order, so the shape crossed itself and rendered as a zigzag. Fixed the order.
- **Texture grain too big on the new parts.** The outline-cut parts measure texture coordinates in metres, the box parts stretch a texture over each face, so the grain on the new parts came out several times too big (blotchy wood and plastic). Fixed by scaling their texture coordinates to match.
- **Menu styles rejected by the shell.** I tried to add the menu styles through a shell command; the shell refused the long block (it tripped over a quote), so nothing was written. Checked that nothing had been added, then wrote the styles with the file editor. Same lesson as the DOCS.md mistake: long text goes through the editor.
- **"0 players online" looked wrong.** The first version said "0 players online" while you were on the menu, because the server only counts people in matches. It now says "No one in a match yet: start one!" or "N players in matches now".
- **Cards over the chicken.** At 1280×720 the "What's new" card ran into the chicken. The two cards are now stacked in a narrow column next to the menu, which stays clear of it at every size checked.
- **A phone screenshot that looked broken but wasn't.** A full-page screenshot at phone size showed the menu missing; measuring the page showed every button in place. The capture had caught the menu mid-animation while the page scrolled. A normal screenshot showed it correctly.
- **A slow test, not a bug.** "Knife Fight bots charge in to stab" failed once in a full run and passed three times on its own and in the next full run. It waits 4 real seconds for a bot to walk over, so a busy machine can make it miss. Nothing in this change touches bots or the server.
