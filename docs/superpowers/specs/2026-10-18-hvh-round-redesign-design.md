# HvH redesign: charge-and-burst exploits, round-based 5v5, CS:GO arsenal, compact Skeet panel

Date: 2026-10-18 · Branch: `hvh-v2` (worktree `C:\Users\ojatw\ChikenRunHvh-hvh-v2`) · Engine: HvH v2 (`HVH_ENGINE=v2`)

## Why

The owner played the v2 engine and wants HvH to feel like a CS:GO HvH server: 5v5, rounds, a small
fixed arsenal, and exploits that are readable and fair. The current tickbase model already works
(Tasks 0–14 of `docs/superpowers/plans/2026-10-17-hvh-mechanics-recode.md`), but:

- **Double tap and hide shots feel wrong.** Charging is invisible, and the owner wants a clear
  physical rule instead: stop to charge, then burst.
- **Defensive is too strong as an exploit.** The balance sweep (708,000 simulated rounds, 60 configs) shows
  every defensive config winning about 70% against the field and 72–74% against every other
  exploit (see the sweep output in `docs/hvh/balance-report.md` and the latest run in this
  session).
- **The Skeet panel is overwhelming.** There are too many sections, duplicate toggles, a stance
  builder and weapon profiles that each take a whole screen, and status panels nobody reads.
- **HvH is a respawn deathmatch to 40 kills with an open arsenal.** The owner wants rounds and a
  1-to-1 arsenal.

Already fixed this session (do not redo): the Mirage server stall from bot CPU (870024b, 1eb8bea,
8743179) and the command-backlog clock correction (0aae3af, 7f9a43f). Do not reintroduce
anything those commits removed.

## Goals

1. DT and hide shots charge by **stopping the player for ~0.5 s** and **burst as a teleport**
   along the movement direction.
2. Defensive becomes a **situational anti-aim pattern** (random pitch in air, fake flick on
   peek, and so on), with no charge and no lag-compensation effect.
3. HvH is **round-based 5v5**, with bots filling empty seats.
4. A **buy menu** opens at each round start with two categories: Main (Scout, Auto sniper) and
   Pistol (Desert Eagle, R8 Revolver).
5. These four weapons are **balanced like CS:GO**, and the Auto sniper is new.
6. The Skeet panel is **compact**: weapon and anti-aim configuration are reached by clicking icons,
   Misc has no duplicates, and the status panels are gone.
7. The balance sweep is re-run on the new rules and the result is documented.

## Non-goals

- **No anti-bruteforce.** The owner rejected it because it breaks balance. Remove the legacy
  `antiBruteforce` option from the panel. The legacy engine may keep its code until the Task 15
  cutover.
- No bomb, no economy (picking is free), and no other weapons in HvH.
- No change to non-HvH modes. ChikenBomb's round flow may be **reused**, but its behaviour must not
  change.
- No visual redesign of the Skeet panel beyond what is described here (colours, fonts and theme stay).

## Anti-goals (a failure even if it technically works)

- **Any speed-up.** No speed-up of the game, the player or the tick rate while charging or while
  charged. The owner reported "the game speeds up" and "command flood" as the worst bugs; both
  must stay gone.
- A burst that teleports through walls or out of the map.
- An exploit that wins about 70% against the field again. The plan's balance rule stays: no config
  above 55% against the field, and every config has a counter at 55% or more.
- A panel that still needs scrolling through every weapon group or stance to find a setting.

## Part A: DT and hide-shots charge and burst (decided by the owner)

**Charging**
- When DT or hide shots is enabled and the player has no stored charge, the player charges
  **automatically, but only while no enemy is visible to shoot**.
- Charging **stops the player dead for about 0.5 s, even mid-air**: no movement, no gravity during
  the stop. The charge stores **0.5 s worth of movement (32 ticks at 64 Hz)**.
- The player can still aim during the stop (my call; the owner did not object).
- If an enemy becomes visible mid-charge, the charge is cancelled, the player can move and shoot
  at once, and the partial charge is lost (my call).
- While charged, the game runs at normal speed. Nothing is faster for anyone.

**Burst**
- It triggers when the player **shoots an enemy** with DT or hide shots on, or **toggles the
  exploit off manually**.
- All stored ticks are spent at once. The player **teleports along their current movement
  direction**, to where 32 ticks of that movement would have taken them. The server computes this
  by simulating the movement (same physics, same input, the 32 ticks in a row).
- **Collision applies**, because the simulation is the normal movement step: no wall clipping,
  and the player stays inside the map. Standing still means no teleport (my call; it follows from
  the simulation).
- On a shot, the bullet or bullets leave from the pre-burst position, then the teleport happens
  (my call, CS:GO-like).
- DT's burst also fires the second bullet (same fire-interval rules as today). Hide shots' burst
  hides the on-shot pose (today's hide-shots semantics).

**Lag compensation (owner decision):** a moving burst **breaks lag compensation**, as in CS:GO.
The teleport (about 3 m at `PLAYER.speed` 6 m/s) exceeds the `lagCompBreakHulls` distance, so the
shooter's pre-teleport records become invalid (`'lagcompBreak'`). This is intended, and the sweep
tunes around it.

**What the enemy sees:** a brief stop while charging, then a snap forward when the burst happens.

**"Visible enemy"**: an enemy in actual line of sight, ignoring the HvH wallhack (everyone sees
everyone through walls, so the wallhack cannot be the test) (my call). The server decides, and
the client predicts.

Notes for the builder:
- 32 ticks is more than `maxProcessTicks` (16) and `doubleTapShift` (14). The era table and
  `validateEra` must be changed to express the new charge size. The shift and budget rules in
  `shared/src/hvh/v2/tickbase.ts` change accordingly.
- `PredictedTickbase` (client) must predict the stop and the burst so that the owner sees no
  rubber-banding.
- The recharge rules change. Today, firing and fake lag block banking and recharge has a 16-tick
  delay. New rule: charge only with no visible enemy, via the stop.

## Part B: Defensive anti-aim (decided by the owner)

**Defensive is an anti-aim pattern, not an exploit.** It **spends no charge**, has **no tickbase
shift**, and **does not break lag compensation**. All it does is change the anti-aim pattern in
specific situations, as community "defensive AA" scripts present it (in-air, on-peek, and
per-state overrides with random pitch, flick, spin and the like).

- **Remove today's defensive exploit:** `intent.defensive` as a tickbase shift,
  `era.defensiveShift`, `markDefensive`, and records pushed `valid:false / 'defensive'`.
  `CommandIntent.defensive` either goes away or carries the pattern trigger. The builder decides,
  but no LC effect remains.
- **Where:** the Anti-aim tab, per stance icon (Part D), with one shared on/off.
- **Triggers** (multi-select, my proposal): **In air** (jumping), **On peek** (the moment an enemy
  becomes visible, same line-of-sight test as Part A), and **Always**.
- **Overrides while a trigger is active** (my proposal):
  - **Pitch:** Down, Up, Zero, Random (a new random pitch every few ticks), or Jitter (alternates
    up and down).
  - **Yaw:** Off, Flick (a snap of ±90–180° for a few ticks, then back), Spin, Random, or Sideways
    jitter.
  - **"Fake flick before peeking"** is On peek + Flick: a short yaw flick fires as the enemy
    becomes visible.
- Overrides change the **real pose** (eye and body yaw, pitch, so the hitboxes move) through the
  shared pose model (`shared/src/hvh/v2/pose.ts`). They stay inside the era's limits (desync max,
  pitch range) and are deterministic from the seed and tick, so prediction and replay hold.
- Timing values (flick length, random-pitch interval) are left to the builder; the sweep checks
  them.
- **Balance:** defensive configs join the sweep like any other anti-aim, under the same 55% rule.
  The owner rejected anti-bruteforce for breaking balance, so if a defensive pattern turns out
  dominant, nerf or remove that mode rather than keep it.

## Part C: Round-based 5v5 HvH with a CS:GO arsenal (decided by the owner)

**Match**
- 5v5. Bots fill empty seats up to 10 players (today HvH fills only to 4). Bot cost on Mirage is
  now about 3–4% of the tick budget with 9 bots (measured after 870024b).
- **First to 13 rounds, at most 24 rounds. Sides swap at halftime after 12 rounds played (drawn
  rounds count as played). 12-12, or no team at 13 after 24 rounds, ends the match as a draw**
  (CS:GO short-match format, my call).
- No bomb. A round ends when one team is eliminated. After **1:55** the team with more players
  alive wins, and a tie is a draw.
- No respawns. The dead spectate living teammates until the round ends.
- The scoreboard shows rounds won.

**Round start**
- Everyone spawns at their team spawn with full HP, **armor and helmet**.
- **Freeze time of about 5 s.** No movement, but the buy menu is open. The DT and hide-shots charge
  completes during freeze time (nobody can shoot).
- **Bots buy only (owner decision).** Bots pick one main and one pistol each round and fight
  with their existing rage logic. They do not use DT, hide shots or defensive
  (`p.hvh.exploit = 'off'` stays).
- The buy menu has two categories:
  - **Main:** Scout (SSG 08) or **Auto sniper (new; SCAR-20 / G3SG1 style)**
  - **Pistol:** Desert Eagle or R8 Revolver
- Picks are free. The menu remembers the last pick, so closing it keeps that pick (my call).
- No knife, no grenades and no other weapons in HvH (my call).

**Weapons: balanced like CS:GO.** These are the published CS:GO values. **Verify them against a
CS:GO weapon-data reference before using them.**

| Weapon | Damage | Armor pen | Cycle | Magazine | Move speed (u/s) | Range modifier |
|---|---|---|---|---|---|---|
| SSG 08 | 88 | 85% | 1.25 s | 10 | 230 | 0.98 |
| SCAR-20 / G3SG1 | 80 | 82.5% | 0.25 s | 20 | 215 (120 scoped) | 0.98 |
| Desert Eagle | 63 | 93.2% | 0.225 s | 7 | 230 | 0.81 |
| R8 Revolver | 86 | 93.2% | 0.4 s hammer pull, ~0.5 s cycle | 8 | 220 | 0.94 |

- CS:GO hitgroup multipliers: head ×4, stomach ×1.25, legs ×0.75, chest and arms ×1.
- Spread and inaccuracy (standing, moving, airborne, scoped and unscoped) and damage falloff
  should also follow CS:GO, mapped into the game's units (40 Source units = 1 m, as in
  `shared/src/maps/mirage.ts`).
- The DT interplay matters: the Auto's 0.25 s cycle can double tap, the Scout's 1.25 s cannot
  (today's rule that bullet 2 is held to the weapon's fire interval).

**Reuse:** `BombRoom` (`server/src/rooms/BombRoom.ts`) already has warmup, freeze, buy window, live
phase and halftime, and the client `BuyMenu` exists (`GameSession.ts` ~353). How to share that
code (extract a round base, or compose) is left to the builder. The bomb mode's behaviour must not
change.

## Part D: Compact Skeet panel (decided by the owner, details are my calls)

**Remove**
- The Skeet status panels (the target and charge info box, and similar).
- Duplicate toggles.
- Anti-bruteforce.

**Keep**
- The keybind list.
- The top-right Skeet watermark ("skeet · chicken hvh · fps · ping").

**Weapon configuration**
- A row of **four weapon icons** (Scout, Auto, Deagle, R8). Clicking one opens that weapon's
  settings (hit chance, min damage, hitboxes, multipoint, safe points, auto-stop, auto-scope) in a
  compact sub-panel.
- This replaces today's per-group profile sections (`client/src/dev/skeet/tabs.ts` profiles).

**Anti-aim**
- A row of **stance icons** (standing, moving, air, crouching, slow-walk). Clicking one opens that
  stance's yaw base, yaw offset, desync and jitter.
- The tab also holds the anti-aim on/off, at-targets and freestanding, the invert key, and
  **Defensive**.
- Today's separate "Base stance (v2)" section and the legacy "Use state builder" toggle merge
  into this one model. v2 uses the stance icons.

**Misc**
- Remove the duplicate toggles and group the rest into a few short sections.
- The builder must **list the duplicates found before deleting them** and keep one control per
  setting.

**Exploits**
- DT and hide shots stay as toggles or binds, wherever they live today.
- Fake-lag controls stay in the Fake lag tab.

Saved configs must keep loading (the Task 11 `migrateConfig` pattern). Any setting dropped is
listed in the one-time reset notice.

## Part E: Balance verification

- **Setup (my call):** 1v1 on **Mirage** with cover between spawns, so mid-round re-charging (it
  needs no visible enemy) is actually exercised. Each round starts charged (freeze time).
- Weapon pairings: all main vs main pairs (Scout and Auto), with pistols as tie-breakers only if
  the runtime allows.

- Update `tools/hvh-sweep.ts` to the new rules: the charge and burst model, defensive as an anti-aim pattern, the
  four weapons, and the round-start charge.
- Run it per weapon pairing (at least Scout and Auto mains).
- The plan's balance rule must hold: no config above 55% against the field, and every config
  countered at 55% or more.
- Tune the tunables (charge size, defensive pattern timings) until it does.
- Update `docs/hvh/balance-report.md` with the results.

## Fake lag and the charge (my call)

Choking is allowed at any time **except during the 0.5 s charging stop** (the stop sends ordinary
commands). Choking does not block or slow charging. The sweep includes fake-lag configs, and the
balance rule applies to them too, so fake lag must not become dominant again (see R41 in the
balance report).

## Engine scope (my call)

Rounds, 5v5, the arsenal and the buy menu apply to **v2 HvH rooms only**. Legacy HvH rooms keep
the respawn-to-40 deathmatch until the Task 15 cutover removes the legacy engine. The builder
chooses how to gate this (a mode flag, or the room's engine), and the mode description text
updates at cutover.

## Constraints

- The work stays on branch `hvh-v2` behind `HVH_ENGINE=v2`. Legacy rooms keep working until the
  Task 15 cutover.
- Superpowers subagent-driven-development is the only orchestrator. Backend tasks and all reviews
  use the strongest model.
- Windows environment notes are in the existing plan (the Nodist PATH prefix, node:test via tsx,
  tests in `*/test/**`).
- Every rule lives in `shared/` and is pure and testable. The client predicts; the server decides.
- Determinism holds: replay and network gates from Task 13 must keep passing, or be updated with
  reasons.

## Left to the builder

- The tickbase, era and budget data model for a 32-tick charge, and how it is validated.
- How round flow is shared with `BombRoom`.
- The exact line-of-sight test for "visible enemy" (hitbox points, eye to head, and so on), as
  long as walls block it.
- The panel component structure and sub-panel interaction details, within the existing Skeet look.
- The order of work across parts.

## Suggested order (my call)

1. Part C: rounds, 5v5, buy menu and weapons. Self-contained, and it changes what the sweep measures.
2. Part A: charge and burst.
3. Part B: defensive anti-aim.
4. Part E: sweep and tuning.
5. Part D: the panel. It can run in parallel after Part A defines the settings.
