# HvH Round Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn v2 HvH into round-based 5v5 with a four-weapon CS:GO arsenal and a stop-to-charge / burst-to-teleport DT and hide shots. Defensive becomes a situational anti-aim pattern, and the Skeet panel becomes compact.

**Architecture:** All rules stay pure in `shared/` (`shared/src/hvh/v2/*`): the arsenal, the round state machine, tickbase charge and burst, visibility, and defensive pose. `server/src/rooms/HvhRoom.ts` runs them authoritatively on the v2 path only. The client predicts with the same shared functions (`PredictedTickbase`, `LocalPlayer`) and renders the buy menu and the compact panel. Legacy HvH rooms stay unchanged until the old plan's Task 15 cutover.

**Tech Stack:** TypeScript monorepo (`shared`, `server`, `client`), Node 24, socket.io, Three.js, node:test via tsx.

**Spec:** `docs/superpowers/specs/2026-10-18-hvh-round-redesign-design.md` (approved 2026-10-18). Read it before any task.

## Global Constraints

- Branch `hvh-v2`, worktree `C:\Users\ojatw\ChikenRunHvh-hvh-v2`. Never commit to `main`, never push.
- Every new behaviour is v2-only (`hvhEngine === 'v2'`). Legacy HvH rooms and every non-HvH mode behave exactly as before.
- PATH prefix before node/npm/npx. Git Bash: `export PATH="/c/Program Files/nodejs:$PATH";`. PowerShell: `$env:Path='C:\Program Files\nodejs;'+$env:Path;`
- Tests use node:test via tsx and live in `{shared,server,client}/test/**` (new v2 tests go in `*/test/hvh-v2/`). Run one file with `npx tsx --test <file>`. The full gate is `npm run typecheck` (must exit 0) plus `npm test`. Known flaky tests: botchoice, report, phase5, zombie Exploder, and socket tests under CPU load (re-run them alone).
- Commit messages end with a blank line, then `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **No speed-up, ever.** No path may run more than one movement step per command, except the burst teleport (Task 7). A command backlog must keep draining (CommandClock, commit 7f9a43f).
- Do not undo the performance and clock fixes in commits 870024b, 1eb8bea, 8743179, 0aae3af and 7f9a43f.
- Determinism: same seed, same results. The Task 13 replay and network gates (`server/test/hvh-v2/hvhReplay.test.ts`, `hvhNetwork.test.ts`) keep passing. Update their scripts where intents change, and state why in the commit.
- Units: 40 Source units = 1 m. CS:GO run speed 250 u/s matches `PLAYER.speed` 6 m/s (≈ 6.25). A weapon's `moveSpeed` is its CS speed ÷ 250.
- Tunables (exact starting values):
  - `chargeTicks` 32 (0.5 s at 64 Hz).
  - Freeze time 5000 ms, round 115000 ms, round-end banner 5000 ms.
  - First to 13 rounds, at most 24, sides swap after 12 rounds played, warmup 15000 ms.
  - Peek window 8 ticks. (Task 10 tuned it to 4: `PEEK_TICKS` in `shared/src/hvh/v2/pose.ts`; take the value from there.)
  - Random-pitch interval 4 ticks, flick length 4 ticks, flick angle 120°.

## Review Focus

1. **The burst near walls, ledges and map edges, and while airborne.** Expected: the burst is the normal movement step run `chargeTicks` times, so it slides along walls and never enters one, and a player standing still doesn't move. Pinned in Task 7.
2. **Visibility flicker at a corner** (an enemy visible on alternate ticks). Expected: a charge can only complete after `chargeTicks` consecutive ticks with no visible enemy. Pinned in Task 5.
3. **Death, round end, or disconnect mid-charge or mid-burst.** Expected: charge resets to 0 at spawn, and a dead player never bursts. Pinned in Task 7.
4. **Buying out of window, unknown items, or buying in legacy rooms.** Expected: rejected with an error; the loadout is unchanged. Pinned in Task 4.
5. **The round's last two players killing each other on the same tick, or a team emptying by disconnect.** Expected: both teams at 0 alive is a drawn round; an empty team loses the round. Pinned in Task 3.

---

## Part C: Rounds, 5v5, arsenal

### Task 1: CS:GO arsenal weapon definitions

**Files:**
- Modify: `shared/src/weapons.ts` (the `WeaponId` list ~line 9, `DEFS`, `ARSENAL` ~272, `damageAt` ~432)
- Modify: `shared/src/hvh/weapons.ts` (`hvhWeapon`)
- Modify: `shared/src/hvh/ballistics.ts` (`hvhHitDamage`, the stomach multiplier)
- Create: `shared/src/hvh/v2/arsenal.ts`, exported from `shared/src/hvh/v2/index.ts`
- Modify: `client/src/game/WeaponController.ts` (R8 hammer: with `csgo.hammerMs`, the shot goes out `hammerMs` after the trigger press while it is held; releasing early cancels it)
- Test: `shared/test/hvh-v2/arsenal.test.ts`, `client/test/hvh-v2/r8Hammer.test.ts`

**Interfaces:**
- Produces:
  - New `WeaponId`s `'ssg08' | 'scar20' | 'deserteagle' | 'r8'`.
  - `WeaponDef.csgo?: { armorPen: number; rangeModifier: number; hammerMs?: number }`.
  - `HVH_MAINS = ['ssg08', 'scar20'] as const` and `HVH_PISTOLS = ['deserteagle', 'r8'] as const` (in `arsenal.ts`).
  - `isHvhArsenal(id: WeaponId): boolean`.
  - `CSGO_HITGROUP = { head: 4, stomach: 1.25, leg: 0.75, other: 1 }`.

Values (verbatim from the spec). **Verify each against a CS:GO weapon-data reference (`items_game` values) and note the source in a code comment.** Spread and inaccuracy come from the same reference: the value ÷ 1000 gives radians for `spread`, `moveSpread` and `airSpread`. Scoped values go in the existing `zoom` fields.

| id | name | damage | armorPen | fireInterval ms | magazine | moveSpeed | rangeModifier | scope | other |
|---|---|---|---|---|---|---|---|---|---|
| ssg08 | SSG 08 | 88 | 0.85 | 1250 | 10 | 0.92 | 0.98 | yes | |
| scar20 | SCAR-20 | 80 | 0.825 | 250 | 20 | 0.86 | 0.98 | yes | automatic |
| deserteagle | Desert Eagle | 63 | 0.932 | 225 | 7 | 0.92 | 0.81 | no | |
| r8 | R8 Revolver | 86 | 0.932 | 500 | 8 | 0.88 | 0.94 | no | `hammerMs: 400` |

- All four have `headshotMultiplier: 4`.
- Range falloff: `damage × rangeModifier ^ (distance_m / 12.5)`.
- Models and sounds reuse the closest existing ones (scout, sniper, deagle, revolver).
- These ids are HvH-only. Every place that lists weapons for shops, buy menus, loadouts, arms race or the inventory must skip `isHvhArsenal` ids. Find them with `grep -rn "WEAPONS\b\|DEFS\b" shared/src client/src server/src`.

- [ ] **Step 1: Write the failing tests** in `shared/test/hvh-v2/arsenal.test.ts`:
  - `damageAt(WEAPONS.ssg08, 12.5)` ≈ 88 × 0.98 (within 1e-9). `damageAt(WEAPONS.deserteagle, 25)` ≈ 63 × 0.81².
  - `hvhWeapon(WEAPONS.ssg08) === WEAPONS.ssg08` (no HvH tuning on csgo weapons). `hvhWeapon(WEAPONS.scout)` is unchanged from today.
  - `hvhHitDamage(WEAPONS.scar20, {t: 5, group: 'stomach', headshot: false}, {wallDistance: 100, passages: []})` = `damageAt(WEAPONS.scar20, 5) × 1.25`. A head hit is ×4.
  - `fireIntervalTicks` gives ssg08 80, scar20 16, deserteagle 15, r8 32.
  - No shop or arms-race list contains an arsenal id. Use whichever lists exist; name them in the test.
  - Client (`r8Hammer.test.ts`): with the trigger held from t=0, the R8's first shot is at t=400 ms. Releasing at 300 ms gives no shot. With the Deagle, the shot is at t=0.
- [ ] **Step 2: Run** `npx tsx --test shared/test/hvh-v2/arsenal.test.ts`. Expected: FAIL (unknown ids).
- [ ] **Step 3: Implement** the defs, the `csgo` field, the falloff branch in `damageAt`, the `hvhWeapon` passthrough (return `w` when `w.csgo`), and the stomach multiplier of 1.25 when `w.csgo` in `hvhHitDamage`.
- [ ] **Step 4: Run** the test, then `npm run typecheck`. Expected: PASS, exit 0.
- [ ] **Step 5: Commit** with the message `feat(hvh): CS:GO arsenal (SSG 08, SCAR-20, Desert Eagle, R8) for v2 HvH`.

### Task 2: Armor and helmet in v2 shots

**Files:**
- Modify: `shared/src/hvh/v2/shot.ts` (`ShotTarget`, `processShot`, the header comment line 39)
- Modify: `server/src/rooms/HvhRoom.ts` (where `ShotTarget`s are built for `processShot`)
- Test: `shared/test/hvh-v2/shot.test.ts` (add cases)

**Interfaces:**
- Produces: `ShotTarget.armored?: boolean` (armor and helmet).
- Damage to an armored target = the raw hit damage × `w.csgo.armorPen`, for every group except `leg`. Weapons without `csgo` ignore armor (today's behaviour). Armor never wears down (my call in the spec).

- [ ] **Step 1: Write the failing tests:**
  - An armored target, ssg08 head hit at 5 m: damage = 88 × 0.98^(5/12.5) × 4 × 0.85.
  - The same hit unarmored: no 0.85 factor.
  - A leg hit armored: no 0.85 factor.
  - A rifle (no `csgo`) hit on an armored target: the same as today.
- [ ] **Step 2: Run** `npx tsx --test shared/test/hvh-v2/shot.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** The HvhRoom v2 path sets `armored: true` for every living target while v2 rounds run (Task 3 spawns everyone armored).
- [ ] **Step 4: Run** the shot tests and `server/test/hvh-v2/HvhRoom.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** with the message `feat(hvh): armor and helmet with per-weapon armor penetration in v2 shots`.

### Task 3: Round state machine and v2 round flow

**Files:**
- Create: `shared/src/hvh/v2/rounds.ts` (pure)
- Modify: `server/src/rooms/HvhRoom.ts` (v2 path: round flow, freeze, no respawn while live, halftime swap, match end, `round` event)
- Modify: `server/src/rooms/GameRoom.ts` (only to expose the protected seams HvhRoom needs: a respawn gate, `spawn` already exists)
- Modify: `client/src/game/GameSession.ts` (`onRound`: show the round timer and score for a v2 HvH round state, not only `mode.bomb`)
- Test: `shared/test/hvh-v2/rounds.test.ts`, `server/test/hvh-v2/hvhRounds.test.ts`

**Interfaces:**
- Produces, in `rounds.ts`:
  - `HVH_ROUNDS = { warmupMs: 15000, freezeMs: 5000, roundMs: 115000, roundEndMs: 5000, roundsToWin: 13, maxRounds: 24, halfAfter: 12 }`.
  - `type HvhRoundPhase = 'warmup' | 'freeze' | 'live' | 'over' | 'ended'`.
  - `interface HvhRoundState { phase: HvhRoundPhase; round: number; endsAt: number | null; score: { 1: number; 2: number }; winner: 0 | 1 | 2; reason: 'eliminated' | 'time' | 'draw' | null }`.
  - `stepHvhRound(s: HvhRoundState, alive: { 1: number; 2: number }, players: { 1: number; 2: number }, now: number): { state: HvhRoundState; events: ('roundStart' | 'goLive' | 'roundEnd' | 'halftime' | 'matchEnd')[] }`.
  - Round-end rules:
    - A team with 0 alive (or 0 players) loses the round.
    - Both teams at 0 alive is a drawn round, `winner` 0.
    - On time-out, more alive wins; equal alive is a draw.
  - Match end: a team reaches 13, or 24 rounds have been played; 24 without a winner is a draw. Drawn rounds count toward `halfAfter`.
- Produces on the server: the existing `round` socket event carries a `RoundState`-compatible object built from `HvhRoundState`, with `bomb: noBomb()`. Map phase `freeze` to `'buy'` and `over` to `'over'`. The builder may add an `hvh` flag if the client needs one. During freeze, `p.frozen = true`. Living players never respawn during `live`. `spawn` gives full HP and `armor = 100`. Halftime swaps `info.team` (as `BombRoom.startRound` does).

- [ ] **Step 1: Write failing pure tests** (`rounds.test.ts`):
  - warmup → freeze at `warmupMs` once both teams have players.
  - freeze → live at `freezeMs`.
  - live → over when team 2 has 0 alive (winner 1, reason `'eliminated'`).
  - Both at 0 alive gives a draw.
  - Time-out with alive {1: 2, 2: 1} gives winner 1; {1: 1, 2: 1} gives a draw.
  - over → freeze of the next round after `roundEndMs`.
  - `halftime` is emitted when starting round 13.
  - `matchEnd` at score 13, and at round 24 played with a 12-12 draw.
- [ ] **Step 2: Run** the test. Expected: FAIL (module missing).
- [ ] **Step 3: Implement** `rounds.ts`.
- [ ] **Step 4: Write failing room tests** (`hvhRounds.test.ts`, using the `makeMatch` harness from `server/test/hvh-v2/hvhMatch.ts` with v2):
  - Players are frozen during freeze.
  - Killing all of team 2 ends the round, and the dead do not respawn before the next freeze.
  - Every spawn has armor 100.
  - Teams swap at halftime.
  - A legacy-engine HvhRoom still respawns after `respawnMs` and has no rounds.
- [ ] **Step 5: Implement** the HvhRoom wiring and the GameSession `onRound` display. Dead players spectate a living teammate until the next freeze: reuse the client's existing dead/spectate camera used by ChikenBomb (`GameSession`, search `respawnAt` / spectate). If none exists, keep the death camera on the killer, and note it in the report.
- [ ] **Step 6: Run** both tests plus `server/test/hvh-v2/*.test.ts`. Expected: PASS. Update the replay and network gate scripts if a frozen phase changes their assumptions, and note why.
- [ ] **Step 7: Commit** with the message `feat(hvh): round-based v2 HvH (first to 13, freeze time, halftime)`.

### Task 4: HvH buy menu, loadout, 5v5 fill, bot buys

**Files:**
- Modify: `server/src/rooms/HvhRoom.ts` (override `handleBuy` for v2; apply the loadout at each round start; bot fill target; bot buys)
- Modify: `server/src/rooms/GameRoom.ts` (make the fill target overridable: `protected botFillTarget(): number`, used at line ~1461)
- Create: `client/src/ui/hvh/HvhBuyMenu.ts` (a pure model plus a thin DOM view, in the style of `HitLog.ts`)
- Modify: `client/src/game/GameSession.ts` (open the menu at freeze in v2 HvH, close it at live, send `buy`)
- Test: `server/test/hvh-v2/hvhBuy.test.ts`, `client/test/hvh-v2/HvhBuyMenu.test.ts`

**Interfaces:**
- Consumes: `HVH_MAINS`, `HVH_PISTOLS` (Task 1); `HvhRoundState` (Task 3).
- Produces:
  - Server: `handleBuy(p, itemId)` accepts only arsenal ids, only while the v2 round phase is `warmup` or `freeze`, at no cost. It returns `{ ok: true, money: 0 }` and sets that slot.
  - The loadout is `[main, pistol]`, defaulting to `['ssg08', 'deserteagle']`. It is remembered in `p.info.loadout` and re-applied at every round start.
  - Errors: `'Buying is closed.'` outside the window; `'Not in the HvH arsenal.'` for other ids. Legacy rooms keep `GameRoom.handleBuy`.
  - The v2 `botFillTarget()` returns 10 (5v5). Each bot picks a random main and pistol at round start from the room's seeded RNG. Bots keep `exploit: 'off'`.
  - Client: `HvhBuyModel` with `pick(id)`, `selected: { main, pistol }`, and `categories: [{ id: 'main', items: HVH_MAINS }, { id: 'pistol', items: HVH_PISTOLS }]`. It remembers the last pick (localStorage in try/catch).

- [ ] **Step 1: Write failing server tests:**
  - Buy `scar20` during freeze → ok, and the loadout main is `scar20`.
  - Buy during live → `'Buying is closed.'`.
  - Buy `'ak47'` → `'Not in the HvH arsenal.'`.
  - Buying in a legacy room gives the legacy behaviour.
  - With one human, the room fills to 10 players.
  - Each bot's loadout is one main plus one pistol.
  - Every v2 spawn's loadout is exactly `[main, pistol]`: no knife, no grenades (`eggs`, `smokes` and `flashes` all 0).
- [ ] **Step 2: Write failing client model tests:** two categories with the exact ids; `pick('r8')` replaces the pistol; the default pick is `ssg08` + `deserteagle`.
- [ ] **Step 3: Run** both. Expected: FAIL.
- [ ] **Step 4: Implement** the server, the model and the view (follow `client/src/ui/BuyMenu.ts` styling; no money line).
- [ ] **Step 5: Run** the tests and typecheck. Expected: PASS.
- [ ] **Step 6: Commit** with the message `feat(hvh): round-start buy menu (main and pistol), 5v5 bot fill`.

## Part A: Charge and burst

### Task 5: Tickbase charge-and-burst model

**Files:**
- Modify: `shared/src/hvh/v2/era.ts`, `shared/src/hvh/v2/eras.ts`, `shared/src/hvh/v2/tickbase.ts`, `shared/src/hvh/v2/hitlog.ts` (reasons)
- Test: `shared/test/hvh-v2/tickbase.test.ts` (rewrite the bank/shift cases), `era.test.ts`, `eras.test.ts`

**Interfaces:**
- `EraTable` gains `chargeTicks: number` (late-csgo 32). It drops `doubleTapShift`, `doubleTapShiftOptions`, `hideShotsShift`, `defensiveShift` and `rechargeDelayTicks`. `validateEra` checks that `chargeTicks` is an integer from 1 to 64 (and NaN fails).
- `TickbaseState = { tickbase: number; charge: number; choked: number; armed: boolean }`. Here `charge` is 0..`chargeTicks`, and `armed` means DT or hide shots was on last tick.
- `CommandIntent = { fire: boolean; choke: boolean; doubleTap: boolean; hideShots: boolean }` (no `defensive`).
- `stepTickbase(s, intent, era, ctx: { enemyVisible: boolean })` returns `{ next, action }` with:

  `TickAction = { kind: 'run' } | { kind: 'choke' } | { kind: 'charge' } | { kind: 'cancel' } | { kind: 'burst'; ticks: number; reason: 'doubleTap' | 'hideShots' | 'release' } | { kind: 'reject'; reason: 'dtNotCharged' | 'hsNotCharged' }`

- Rules, in priority order:
  1. Exploit on and fire with `charge === chargeTicks` → `burst` (reason doubleTap or hideShots), `charge = 0`, `tickbase += 1 + ticks`.
  2. Exploit on and fire with partial charge → `reject` (the command still runs as a plain shot), `charge = 0`.
  3. `armed` and the exploit now off with full charge → `burst` with reason `'release'`.
  4. Exploit on, charge below full, no enemy visible, not firing → `charge`: `charge += 1`, tickbase does not advance, `choked = 0`.
  5. Exploit on, charge partial (between 0 and full, exclusive) and an enemy visible → `cancel`: `charge = 0`, runs normally.
  6. `intent.choke` and `choked < era.maxChoke` → `choke`.
  7. Otherwise `run`.
- `next.armed` is `doubleTap || hideShots`.
- Choke is ignored on a `charge` tick (the stop sends ordinary commands).

- [ ] **Step 1: Write failing tests**, one per rule, plus:
  - 32 consecutive invisible ticks reach full charge.
  - Alternating visible and invisible never reaches full charge (Review Focus 2).
  - A full charge with an enemy visible stays full (no cancel once full).
  - The tickbase counter matches the rules above.
  - `validateEra({ ...LATE_CSGO, chargeTicks: NaN })` has an error.
- [ ] **Step 2: Run** `npx tsx --test shared/test/hvh-v2/tickbase.test.ts shared/test/hvh-v2/era.test.ts shared/test/hvh-v2/eras.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Map the legacy era profiles in `eras.ts` with `chargeTicks: 32` (with a one-line comment). Update `tickbaseVerdictReason` copy: `'dtNotCharged' → 'double tap not charged'`, `'hsNotCharged' → 'hide shots not charged'`.
- [ ] **Step 4: Run** the tests. Expected: PASS. Then run `npm run typecheck` and list every compile error in server and client. Tasks 7 and 8 fix them; this task may stub call sites only with the new signature and `{ enemyVisible: false }`, each marked `// Task 7` or `// Task 8`.
- [ ] **Step 5: Commit** with the message `feat(hvh): tickbase charge-and-burst model (32-tick charge, burst on shot or release)`.

### Task 6: Visible-enemy test

**Files:**
- Create: `shared/src/hvh/v2/visibility.ts`, exported from the index
- Test: `shared/test/hvh-v2/visibility.test.ts`

**Interfaces:**
- Produces: `enemyVisible(eye: Vec3, enemies: readonly { x: number; y: number; z: number; crouch: number }[], world: CollisionWorld): boolean`.
- It is true when any enemy's head point or chest point (from `buildHvhMatrix` centres with yaw 0) is reachable by `raycastWorld(makeRay(eye, dir), world, dist, world.seeThrough)` returning null (no hit before the point). It ignores the wallhack by design.

- [ ] **Step 1: Write failing tests:**
  - An open field gives true.
  - A box fully between eye and enemy gives false.
  - A box covering only the head point still leaves the chest visible, so true.
  - A see-through box (`world.seeThrough`) does not block.
  - No enemies gives false.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** with the message `feat(hvh): line-of-sight enemy visibility for charging`.

### Task 7: Server charge, stop and burst

**Files:**
- Modify: `server/src/rooms/HvhRoom.ts` (`runCommand`, `move`, `prepareBullet`/`fireBullet` for DT bullet 2, `spawn`, the `hvhState` payload)
- Modify: `shared/src/protocol.ts` (the `HvhStateEvent` tickbase now has `charge`/`armed`)
- Modify: the Task 13 gates' scripts (`server/test/hvh-v2/hvhMatch.ts` Script: no `defensive`)
- Test: `server/test/hvh-v2/HvhRoom.test.ts` (add a `describe('charge and burst')`)

**Interfaces:**
- Consumes: `stepTickbase` and `TickAction` (Task 5); `enemyVisible` (Task 6), with the eye from `room.eyeOf(p)` and the living enemies' current positions.
- Produces:
  - `charge`: the command is acknowledged, but movement does not step. Set horizontal and vertical velocity to 0, and keep position and gravity frozen (the player stops dead, even mid-air). The pose still steps (aim works).
  - `burst`: fire the shot first, from the pre-burst eye (DT bullet 2 as today, with `ticksSinceLastShot = action.ticks`). Then step movement `action.ticks` times with this command's frame. Hide shots skips the on-shot record as today.
  - `release` bursts the same way with no shot.
  - The `lagcompBreak` record invalidation happens naturally through `RecordHistory`. Assert it, don't code it.
  - `spawn` resets to `EMPTY_TICKBASE` (`charge` 0).

- [ ] **Step 1: Write failing room tests:**
  - With DT on and no enemy visible, 32 commands leave the position unchanged (also mid-air: y unchanged) and the charge full.
  - Then a DT shot, moving forward, gives two bullet verdicts and moves the position by about 32 ticks of walking (compare with 32 plain `stepPlayer` calls on a copy).
  - Bursting into a wall stops at the wall (Review Focus 1).
  - A burst standing still gives no displacement.
  - Toggling DT off while charged moves the player without a shot.
  - An enemy appearing mid-charge resets the charge, and the player moves on the next command.
  - Death mid-charge followed by a respawn gives charge 0. A dead player's queued fire never bursts (Review Focus 3).
  - The shooter's records before the burst are invalid (`'lagcompBreak'`) for enemy shots after it.
  - Hide shots: the burst skips the on-shot record.
- [ ] **Step 2: Run** `npx tsx --test server/test/hvh-v2/HvhRoom.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Remove the old bank, shift and defensive paths (`markDefensive`, `defensiveUntilTick`). Remove the defensive branch of the debug feed if present.
- [ ] **Step 4: Run** `server/test/hvh-v2/*.test.ts`. Expected: PASS. Update the replay and network gates' scripts and expected intents, with the reason in the commit body.
- [ ] **Step 5: Commit** with the message `feat(hvh): stop-to-charge and burst teleport on the server`.

### Task 8: Client prediction of charge and burst

**Files:**
- Modify: `client/src/hvh/PredictedTickbase.ts` (`commandIntent`: no `defensive`; prediction with `enemyVisible`)
- Modify: `client/src/game/LocalPlayer.ts` (`predict`: no movement on `charge`; `ticks` steps on `burst`)
- Modify: `client/src/game/GameSession.ts` (compute `enemyVisible` from the local eye and the remotes' latest positions; drop the defensive bind wiring)
- Modify: `client/src/ui/hvh/Indicators.ts` (adapt or delete; Task 12 removes the status UI)
- Test: `client/test/hvh-v2/PredictedTickbase.test.ts`, `client/test/hvh-v2/LocalPlayerCharge.test.ts`

**Interfaces:**
- Consumes: Tasks 5 and 6 (the same shared functions as the server).
- Produces: client prediction equals server results for the same inputs and visibility. Mismatches are reconciled from `hvhState` as today.

- [ ] **Step 1: Write failing tests:**
  - Predicted tickbase for a scripted sequence (charge ×32, DT shot, release) equals `stepTickbase` run directly.
  - `LocalPlayer.predict` on a `charge` tick leaves the position unchanged.
  - On a burst, the position equals 33 movement steps (1 + 32) of the same frame.
  - `commandIntent` has no `defensive` key.
- [ ] **Step 2: Run** the tests. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the tests plus `npm run typecheck` (now exit 0 with no Task-5 stubs left) and `npm test`. Expected: PASS.
- [ ] **Step 5: Commit** with the message `feat(hvh): client predicts the charge stop and the burst`.

## Part B: Defensive anti-aim

### Task 9: Per-stance v2 anti-aim and defensive patterns

**Files:**
- Modify: `shared/src/hvh/v2/pose.ts` (`AntiAimConfig`, `stepPose`)
- Modify: `server/src/rooms/HvhRoom.ts` (`stepPoseFor`: select the stance, track the peek window, pass the defensive context)
- Modify: `client/src/dev/config.ts` and the place where the v2 `AntiAimConfig` is built from the dev config (search `hvh.antiAim` in `client/src`)
- Test: `shared/test/hvh-v2/pose.test.ts`, `server/test/hvh-v2/HvhRoom.test.ts`

**Interfaces:**
- Produces:
  - `type V2Stance = 'standing' | 'moving' | 'airborne' | 'crouching' | 'slowwalking'`.
  - `StanceAA = { base: 'backward' | 'left' | 'right' | 'spin'; yawOffsetDeg: number; jitterDeg: number; desyncDeg: number }`.
  - `DefensiveAA = { enabled: boolean; inAir: boolean; onPeek: boolean; always: boolean; pitch: 'down' | 'up' | 'zero' | 'random' | 'jitter'; yaw: 'off' | 'flick' | 'spin' | 'random' | 'sideways' }`.
  - `AntiAimConfig = { stances: Record<V2Stance, StanceAA>; inverted: boolean; defensive: Record<V2Stance, DefensiveAA> }`.
  - `stanceOf(motion: Motion & { slowWalk: boolean }): V2Stance`.
  - `stepPose(prev, aimYaw, aa, motion, tick, era, ctx: { seed: number; peekTicksLeft: number; slowWalk: boolean })`.
- Defensive rules:
  - A pattern is active when `enabled` and any of: (`inAir` and airborne), (`onPeek` and `peekTicksLeft > 0`), or `always`.
  - Pitch while active: down 89°, up −89°, zero 0, random (a new value in [−89, 89] every 4 ticks from `mulberry32(seed ^ floor(tick/4))`), jitter (±89 alternating each tick).
  - Yaw while active: flick (+120° × side for 4 ticks, then 4 ticks off, alternating side each flick), spin (the existing spin), random (a seeded random offset in [−180, 180) every 4 ticks), sideways (±90 alternating each tick).
  - Desync limits stay `maxDesync`.
  - Server: when `enemyVisible` turns false→true, set `peekTicksLeft = 8`, counting down by 1 per command.

- [ ] **Step 1: Write failing pose tests:**
  - `stanceOf` covers each stance.
  - The stance config selects the yaw base.
  - Random pitch is deterministic for the same seed and tick, and changes every 4 ticks.
  - A flick cycle is 4 on and 4 off.
  - `peekTicksLeft > 0` activates `onPeek`.
  - Inactive defensive leaves the pose identical to the plain stance.
  - Pitch stays within ±89.
- [ ] **Step 2: Write failing room tests:** an enemy appearing gives 8 ticks of defensive yaw (flick config), then none.
- [ ] **Step 3: Run** both. Expected: FAIL.
- [ ] **Step 4: Implement.** Migrate the dev config: the old single base, jitter and desync become all five stances. Use the `migrateConfig` pattern from Task 11 of the old plan; dropped fields go in the reset list.
- [ ] **Step 5: Run** the tests, typecheck and `npm test`. Expected: PASS.
- [ ] **Step 6: Commit** with the message `feat(hvh): per-stance v2 anti-aim and defensive patterns (in air, on peek)`.

## Part E: Balance

### Task 10: Sweep on the new rules, tune, report

**Files:**
- Modify: `tools/hvh-sweep.ts`, `server/test/hvh-v2/hvhSweep.test.ts`, `docs/hvh/balance-report.md`

**Interfaces:**
- Consumes: Tasks 1, 2, 5, 7 and 9.
- Sweep model:
  - 1v1 on **Mirage** between two spawn points with cover (pick a pair; name them in the tool's header comment).
  - Each round starts charged.
  - Configs: AA stance presets × exploit {none, dt, hs, fakelag14} × defensive {off, inAir+random pitch, onPeek+flick}, for main pairings ssg08 vs ssg08, scar20 vs scar20, and ssg08 vs scar20.
  - Remove the `--def` and `--recharge` flags; add `--charge N`.
- The balance rule is unchanged: field rate ≤ 0.55, and every config has a counter at ≥ 0.55. `--check` exits 1 otherwise.

- [ ] **Step 1: Update** the sweep's unit test to the new model (it should fail first on the removed flags and intents).
- [ ] **Step 2: Implement** the model and run `npm run sweep:quick`. Record the output.
- [ ] **Step 3: Tune** `chargeTicks` and the defensive timings, or remove a dominant defensive mode (the spec's rule), until `--check` passes on the full run (`npm run sweep`, background it; about 15 minutes).
- [ ] **Step 4: Rewrite** `docs/hvh/balance-report.md` with the tables, the tuning steps and the final values.
- [ ] **Step 5: Commit** with the message `feat(hvh): balance sweep on rounds, arsenal, charge/burst and defensive AA`.

## Part D: Compact Skeet panel

### Task 11: Remove status panels and anti-bruteforce

**Files:**
- Modify: `client/src/dev/DevRuntime.ts` (~399: the target/charge info overlay), `client/src/ui/hvh/Indicators.ts` and its wiring in `GameSession.ts`, `client/src/dev/skeet/tabs.ts` and `client/src/dev/config.ts` (anti-bruteforce)
- Test: `client/test/skeet.test.ts`, `client/test/hvh-v2/Indicators.test.ts` (delete or adapt)

**Interfaces:**
- Keep: the keybind list (`skeet.indicators.binds`), the top-right watermark (`skeet.indicators.watermark`), and the hit log (`HitLog`).
- Remove: the target/charge status box, the v2 DT/HS/DEF indicators, and every anti-bruteforce control and config field. The legacy server code keeps reading `core.antiBruteforce` as `false` until cutover.

- [ ] **Step 1: Write failing tests:**
  - No Skeet tab control has a label matching `/brute/i`.
  - With an active v2 session, the HUD root has no `.hvh-indicators` element (or whatever class Indicators uses).
  - The watermark and keybind list still render.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement**, migrating the config (the dropped fields go in the reset notice).
- [ ] **Step 4: Run** the client tests and typecheck. Expected: PASS.
- [ ] **Step 5: Commit** with the message `feat(skeet): remove status panels and anti-bruteforce`.

### Task 12: Icon pickers for weapons and anti-aim stances

**Files:**
- Modify: `client/src/dev/controls.ts` (a new `Control` variant `picker`)
- Modify: `client/src/dev/skeet/tabs.ts` (Rage: a weapon picker over the four arsenal ids; Anti-aim: a stance picker over `V2Stance` with that stance's `StanceAA` + `DefensiveAA`)
- Modify: `client/src/dev/config.ts` (profiles keyed by arsenal id; migration from the old weapon groups)
- Modify: `client/src/dev/skeet/NativeMenu.ts` only if the native renderer needs the new control type
- Test: `client/test/skeet.test.ts`, `client/test/hvh-v2/configMigration.test.ts`

**Interfaces:**
- Produces: `Control` variant `{ type: 'picker'; label: string; options: { value: string; label: string; icon: string }[]; bind: Binding<string>; sections: (value: string) => Control[] }`. It renders an icon row; clicking an icon shows that value's controls beneath it. One open at a time; the selection is remembered per tab.
- Weapon profiles: `skeet.profiles.{ssg08, scar20, deserteagle, r8}`, each with hit chance, min damage, hitboxes, multipoint, safe points, auto-stop and auto-scope (scoped weapons only). Old group profiles migrate: snipers → ssg08 and scar20, pistols/heavy pistols → deserteagle and r8.
- Anti-aim tab, top to bottom: enable, at targets, freestanding, invert key; then the stance picker (yaw base, yaw offset, jitter, desync, and the defensive block); then DT and hide shots as they are today. The old "Base stance (v2)", the "Use state builder" toggle and the six legacy stance sections are removed from the v2 panel.

- [ ] **Step 1: Write failing tests:**
  - The Rage tab has exactly one `picker` with the four arsenal ids.
  - The Anti-aim tab has one stance `picker` with five options.
  - `sections('r8')` contains hit chance and no auto-scope; `sections('ssg08')` has auto-scope.
  - Migrating an old config keeps the snipers' hit chance in ssg08 and scar20, and lists dropped fields.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the tests, typecheck and `npm test`. Expected: PASS.
- [ ] **Step 5: Manual check:** open the panel with the dev server and Playwright, screenshot the Rage and Anti-aim tabs, and attach the paths in the report.
- [ ] **Step 6: Commit** with the message `feat(skeet): weapon and stance icon pickers`.

### Task 13: Misc tab de-duplication

**Files:**
- Modify: `client/src/dev/skeet/tabs.ts` (Misc), plus `client/src/dev/tabs.ts` or `client/src/dev/panels.ts` where the shared sections come from
- Test: `client/test/skeet.test.ts`

- [ ] **Step 1: List the duplicates** before changing code: every config `path` (or bind) that appears in more than one control across all Skeet tabs. Write the list into the task report and keep the clearest control for each.
- [ ] **Step 2: Write the failing test:** across all Skeet tabs, every `path` appears in at most one control; Misc has at most 4 sections.
- [ ] **Step 3: Run.** Expected: FAIL.
- [ ] **Step 4: Implement:** remove the duplicates and group what's left into at most 4 short sections.
- [ ] **Step 5: Run** the tests and typecheck. Expected: PASS.
- [ ] **Step 6: Commit** with the message `feat(skeet): compact Misc tab, one control per setting`.

---

After Task 13: a final whole-branch review (most capable model) covering commits from `d4b7846..HEAD`. Then resume the old plan at its Task 15 (cutover). Its Task 14 is superseded by Task 10 here.
