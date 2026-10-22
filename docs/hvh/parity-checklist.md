# HvH v2 parity checklist and pre-flight

Branch `hvh-v2` (worktree `ChikenRunHvh-hvh-v2`). Baseline taken from the untouched branch before any HvH v2 code.

## 1. Environment and baseline

- Windows: Nodist shadows Node. PowerShell: `$env:Path = 'C:\Program Files\nodejs;' + $env:Path;`. Git Bash: `export PATH="/c/Program Files/nodejs:$PATH"`. Verified `node v24.20.0`, `npm 11.19.0`.
- `npm install`: ok (esbuild postinstall warning only).
- `npm test`: 528 pass, **1 fail**, 0 skipped. The failure is `server/test/botchoice.test.ts:10` ("keeps the two kinds of players in separate rooms; without bots has no bots and waits for people") with a socket.io-client `operation has timed out` after ~14 s. It passed 2/2 when run alone (`npx tsx --test server/test/botchoice.test.ts`), so it is a load-related flake in the full parallel run, not an HvH issue. Not fixed.
- `npm run typecheck`: clean in all three workspaces (shared, server, client; shared and client also check `tsconfig.test.json`).

## 2. Test runner

- Runner: Node built-in test runner (`node:test`) executed through `tsx`.
- Root script: `tsx --test "shared/test/**/*.test.ts" "server/test/**/*.test.ts" "client/test/**/*.test.ts"`.
- Single file: `npx tsx --test shared/test/hvh-core.test.ts` (from repo root, Node on PATH).
- Name filter: `npx tsx --test --test-name-pattern "<regex>" <file>`.
- Existing HvH tests: `shared/test/{hvh,hvh-core,hvh-mechanics,auto-stop,skeet,shot-timing,chicken-pose}.test.ts`, `server/test/{hvh,hvh-core,hvh-mechanics,hvh-benchmark,hvh-bot-movement,skeet}.test.ts`, `client/test/{hvh-config,hvh-runtime,hvh-tactics,hvh-weapons,skeet,fake-lag,classic-antiaim,auto-stop-config,dev-combine}.test.ts`.
- **Plan-path mismatch:** the plan's test paths `shared/src/hvh/__tests__/*.test.ts` are NOT matched by the glob (only `*/test/**`). Recommendation: put new tests in `shared/test/hvh-v2-<area>.test.ts`, `server/test/hvh-v2-<area>.test.ts`, `client/test/hvh-v2-<area>.test.ts` (flat names; subfolders such as `shared/test/hvh/` are also matched by `**`). Alternative: widen the glob to add `shared/src/**/__tests__/**/*.test.ts`. `package.json` was not changed; the controller rules on it. `shared/tsconfig.test.json` and `client/tsconfig.test.json` typecheck tests, so new test locations must be included there.
- Server test helper `server/test/helpers.ts:30` advances one authoritative tick without wall-clock sleeps (use it for deterministic server tests).

## 3. Constants for later tasks

- **Player hull width:** there is no exported "hull width" constant. The horizontal collision half-extent is `PLAYER.radius = 0.45` (`shared/src/constants.ts:19`; doc comment: AABB of 2r x height x 2r, so full width 0.9). `PLAYER.height = 1.5` (`:20`), `PLAYER.eyeHeight = 1.3` (`:22`), `PLAYER.slowWalkSpeed = 0.45` (`:26`). `shared/src/physics.ts:101` has an unexported alias `const R = PLAYER.radius;`. Crouch scale `CROUCH.scale = 0.7` (`constants.ts:52`). Hitbox shapes: `CHICKEN_POSE` (`shared/src/chickenPose.ts:4`), `HVH_HEAD` (`shared/src/hvh/geometry.ts:8`).
- Tick: `SIM_RATE = 64`, `SIM_DT = 1/64` (`constants.ts:2-3`), `SNAPSHOT_RATE = 20` (`:6`), `MAX_REWIND_MS = 300` (`:15`).
- Existing HvH tunables: `HVH = { maxDesync: 58, maxJitter: 45, revealMs: 300, hideMs: 300 }` (`shared/src/hvh.ts:86`). Choke limit 0..12 (`commands.ts:9`, `CommandChoker` clamp `:57`). Resource capacity 32 (`commands.ts:69`).

## 4. Current HvH entry points (file:line)

Shared
- `shared/src/hvh.ts` (151 lines): `HVH_PANEL_IDS :4`, `HVH_STANCES :7`, `SkeetAntiAim :15`, `hvhStance :33`, `defaultSkeetAntiAim :37`, `sanitizeSkeetAntiAim :48`, `HvhLoadout :69` (includes `exploit: off|doubleTap|hideShots`), `HvhCoreSettings :75` (`era: legacy|desync|tickbase|defensive`, fakeLag, fakeDuck, antiBruteforce, defensive, latency/jitter/loss), `defaultHvhCore :82`, `HVH :86`, `sanitizeHvhLoadout :91`, `hvhPitch :119`, `hvhPose :127`.
- `shared/src/hvh/commands.ts`: `fakeLagTicks :8`, `correctMovement :19`, `CommandBuffer :26` (one command per tick, queue 32), `NetworkConfig :37`, `NetworkSimulator :38`, `CommandChoker :53`, `exploitMode :62`, **`ExploitResource :66`** (the "charge": capacity 32, DT cost 32, HS cost 14, defensive cost 12; `step/fire/defend/reset`).
- `shared/src/hvh/animation.ts`: `AuthoritativeAnimation :5`, `createAnimation :10`, `maximumBodyDelta :15`, `movementLayerWeight :22`, `stepAnimation :29`, `ObservableRecord :57`, `observableRecord :74`.
- `shared/src/hvh/geometry.ts`: `buildHvhMatrix :10`, `rayHvhMatrix :20`, `rayHvhChicken :36`, `pointSafety :39`, `matrixPoints :45`.
- `shared/src/hvh/ballistics.ts`: `traceHvhCover :11` (autowall), `coverDamageScale :29`, `hvhHitDamage :32`, `afterArmor :36`, `hvhHitchance :39`.
- `shared/src/hvh/resolver.ts`: `HypothesisSource :4`, `ShotReason :6`, `ResolverPolicy :9`, `ResolverSystem :28` (`observe :31`, `records :42`, `feedback :45`, `resolve :63`), `recordValidity :103`.
- `shared/src/hvh/rage.ts`: `RageSettings :9`, `DEFAULT_RAGE :20`, `scanRage :40`, `ShotIntent :128`, `ShotAudit :129`, `auditShot :131`.
- `shared/src/hvh/autostop.ts`: `planAutoStop :22`, `autoStopInput :32`, `predictEnemyPeek :58`. `shared/src/hvh/weapons.ts`: `hvhWeapon :4`, `hvhSpread :15`. `shared/src/hvh/shotTiming.ts:4` `shotRecordUsable`. `shared/src/hvh/hooks.ts:18` `HvhExtensionHost` (Extensions tab recipes).
- Re-exports `shared/src/index.ts:9-18,37`. Wire: `shared/src/protocol.ts` fields `hvhDefensive :49`, `hvhCharge :54`, `hvhBurst :55`, `hvhConcealed :56`, `hvhRevealed :58`, `hvhPreparing :61`; pack `:138-149`, unpack `:189-200`; `FireRequest.intent :386`, shot event `charge :403`, `audit :405`; socket events `hvhReady :600`, `devHvh :601`. Mode def `shared/src/modes.ts:105`. Dev status `shared/src/dev.ts:165-173`.

Server
- `server/src/rooms/GameRoom.ts` (HvH branches): `enforceHvhRules :304`, `updateHvhPose :311`, input handling with CommandBuffer/assist `:541-576`, `executeFire :593` (exploit permission `:605-607`, reveal/conceal `:623-626`, spread `:656`, intent vs actual `:666-667`, autowall `:684`, hits/damage `:692-724`, audit `:738`, shot emit with charge `:762`, anti-bruteforce/defensive reaction `:767-778`), `rejectHvhShot :801`, lag-comp rewind `:823-835`, `hvhMode set :391`, `finishHvhSetup :1054`, other `enforceHvhRules` call sites `:860,:967-968,:1116`, `fixedUpdate :1383` (`hvhTick++ :1384`, `resource.step :1399-1402`, physics HvH flag `:1395`, pose `:1404`, animation step and fake pitch `:1405-1414`, `hvhPreparing` blocks respawn `:1419`), `snapshot :1469` (choke-cached public state `:1471-1479`), and `broadcastSnapshot :1484`, whose `this.mode.id !== 'hvh'` check at `:1486` forces per-viewer snapshots instead of the shared broadcast.
- `server/src/rooms/ServerPlayer.ts`: HvH fields `:48-60` (`hvh`, `hvhEnabled`, `hvhPanel`, `hvhPreparing`, `commands = CommandBuffer :55`, `resource = ExploitResource :56`, `resolver :58`), reset `:176-177`, history push `:200`, `toState` charge/defensive/conceal/reveal `:224-237`.
- `server/src/rooms/History.ts:20` lag-comp history (`push :28`, `atValid :39`, `at :47`). `server/src/rooms/BotSystem.ts`: HvH bot setup `:109-117`, `thinkHvh :332` (uses `p.resolver`, `p.resource`).
- `server/src/app.ts`: dev/HvH access `:263-281`, `hvhReady :325`, `devHvh :335`. `server/src/index.ts:44` `HVH_PUBLIC_PANEL`. `server/src/dev/devActions.ts:15` HvH admin blocking.
- `server/src/tools/hvhBenchmark.ts`, `runHvhBenchmark.ts` (`npm run benchmark:hvh`).

Client
- `client/src/dev/DevRuntime.ts` (413 lines; class `:22`, `active :94`, `beforeHvh :266`, target scan/aim `:143-190`, `modifyFrame :201`, auto-stop `:249`, HUD text incl. charge `:376-402`). `client/src/dev/Dev.ts:39` (`selectPanel :117`, `devHvh` emit `:191`).
- Skeet panel: `client/src/dev/skeet/{tabs.ts, model.ts, NativeMenu.ts, nativeFields.ts, points.ts, visualValues.ts}`; classic tab defs `client/src/dev/tabs.ts` (Aim `:17`, Anti-aim `:25`, Simulation `:29`, Exploits `:33`, Movement `:36`, Telemetry `:56`); `client/src/dev/panels.ts:14` (`HVH_PANELS`); `client/src/ui/HvhSetup.ts:7`; `client/src/app/App.ts:375` `openHvhSetup`.
- Config and migration: `client/src/dev/config.ts` (loadout `:81`, ranges `:128-151`, enums `:174-180`, fake-lag migration `:256`, presets `:298-318`, import `:368`).
- Prediction/choke: `client/src/game/GameSession.ts` `CommandChoker/NetworkSimulator :192-193`, tick loop with choke/network `:430-451`, shot request `:900-941`; `client/src/game/WeaponController.ts` `ExploitResource` use `:149`, `exploitReady :171`, `exploitState :172`, server charge reconcile `:190,205`.
- Debug: `client/src/dev/HvhDebug.ts:7`, `client/src/dev/DevDebug3D.ts:37-60` (hitbox matrices), `client/src/dev/DevOverlay.ts`.
- Docs to retire or update: `docs/hvh-simulation.md`, `docs/skeet-adaptation.md`, `docs/auto-stop.md`, `docs/hvh-movement-exploits.md`, README HvH sections (`README.md:217-295`).

## 5. Parity checklist

Status values: `rebuild (Task N)`, `replace with <x> (Task N)`, `drop: <reason>`, `keep: <reason>` (an existing feature that this plan must leave untouched; it counts as resolved for Task 15 Step 1). Tasks: 1 era docs; 2 era table; 3 tickbase; 4 pose and desync/anti-aim; 5 lag-comp records; 6 resolver; 7 shot pipeline/verdicts/hit-log text; 8 protocol and server HvhRoom; 9 client tickbase prediction; 10 hit log and tickbase HUD; 11 Skeet panel wiring, config migration, era profiles; 12 debug overlay; 13 determinism/network/isolation gates; 14 balance sweep; 15 cutover and legacy deletion.

### 5.1 HvH setup flow

| Feature | Current location | Status |
|---|---|---|
| Per-player setup pause, no combat until Begin match (`hvhPreparing`) | GameRoom `:397,1054`; ServerPlayer `:54` | rebuild (Task 8) |
| Skeet vs Manual panel choice, `hvhReady` ack | app.ts `:325`; HvhSetup.ts; App.ts `:375` | done (Task 11): unchanged choice; Manual sends no exploit/choke/defensive intents (default loadout, Defensive bind needs the assisted panel, DevRuntime `takeDefensive`); protocol (Task 8) |
| Manual play = default loadout, no tools | GameRoom `:1057` | rebuild (Task 8) |
| First-person default, `V` view toggle preserved | Game/CameraRig | drop: unrelated to mechanics, untouched |
| Panel switch never restores health/ammo/charge | GameRoom `:1054-1062` | replace with tickbase not refilled by panel change (Task 3, Task 8) |
| Public panel access (`HVH_PUBLIC_PANEL`), passkey fallback | app.ts `:263-281`, index.ts `:44` | rebuild (Task 8) |
| Equal stats, no multipliers/ammo/fly/noclip, admin actions blocked in HvH | devActions.ts `:15`, app.ts `:316` | rebuild (Task 13 isolation gates) |
| Everyone sees enemies through walls (`wallhack: true`; also `wallbang: true`, `teamKills: true`) | shared/src/modes.ts `:107`; README `:118`; GameSession `:383,:602` | rebuild (Task 8): HvhRoom must keep the mode flags |
| HvH has no vehicles; friendly fire blocked; kills score for team | GameRoom, modes.ts `:105` | rebuild (Task 8) |
| Mode isolation (legacy modifiers cleared on every HvH path) | `enforceHvhRules :304` | rebuild (Task 13) |

### 5.2 Skeet panel (nine tabs)

| Feature | Current location | Status |
|---|---|---|
| Tabs: Rage, Anti-aim, Fake lag, Trigger, Visuals, Misc, Skins, Configs, Extensions | skeet/tabs.ts `:32-90`, NativeMenu.ts | done (Task 11): tabs write config only; v2 values reach CommandIntent / AntiAimConfig via GameSession `:461-475` and HvhRoom |
| Fake lag tab: enable, limit, mode, break on shot | skeet/model.ts `:23,61`; skeet/tabs.ts `:62` | done (Task 11): limit 1-14 (LATE_CSGO.maxChoke) feeds CommandChoker, held frames become intent.choke; legacy rooms cap at 12 |
| Seven weapon profiles, geometric safe points | skeet/model.ts, skeet/points.ts | rebuild (Task 15): profiles and safe points drive the legacy client rage scan (rage.ts), which v2 replaces; kept working unchanged in both rooms |
| Visuals tab / native values (glow, tracers, fog, FOV, hitmarker) | skeet/nativeFields.ts, visualValues.ts, GameSession `:582-603` | keep: not mechanics; preserve unchanged through Task 11 and Task 15 (not in the out-of-scope list) |
| Skins tab (tint first-person weapon) | skeet tabs | keep: not mechanics; preserve unchanged through Task 11 and Task 15 (not in the out-of-scope list) |
| Configs tab (browser-saved configs, import/export) | dev/config.ts `:398-445`, panels/configs.ts | done (Task 11): saved, loaded and imported configs go through migrateConfig; import shows reset fields |
| Extensions tab (native recipes, no CSGO Lua) | hvh/hooks.ts `:18`, skeet/tabs.ts `:81-91` | done (Task 11): recipes only edit config (added Defensive peek); controller hooks unchanged |
| Config migration, fake-lag key move | config.ts `:313` (migrateConfig), `:385` (load), Dev.ts `:257` (one-time notice) | done (Task 11) |
| Four era profiles (legacy, desync, tickbase, defensive) | shared/src/hvh/v2/eras.ts; dev/tabs.ts `:33` | done (Task 11): ERAS holds the four profiles plus late-csgo (default); selection stored as skeet.era, not sent (server stays LATE_CSGO); legacy era select kept for legacy rooms |
| Presets (balanced, precision, aggressive, scout) | config.ts `:349-378` | done (Task 11): presets are v2-schema (migrate with no reset); Skeet Aggressive enables Defensive |
| Menu redesign / IMGUI renderer audit | n/a | drop: out of scope (look & feel plan) |
| Classic mega-dev (L) excluded from HvH | Dev.ts, classic/* | drop: not HvH; keep untouched |
| Watermark / info text | DevRuntime `:378-402` | rebuild (Task 10) |

### 5.3 Aim

| Feature | Current location | Status |
|---|---|---|
| Target priority and persistence | rage.ts `scanRage :40` | rebuild (Task 7) |
| Historical records, multi-record shot selection (`maxRecords`) | rage.ts, resolver `records :42` | rebuild (Task 5) |
| Multipoint, geometric safe points, body-aim fallback | rage.ts, geometry.ts `matrixPoints :45` | rebuild (Task 7) |
| Flat / HP-relative minimum damage, damage override key `H`, body-aim key `J` | DevRuntime `:162-164`, config `:129-133` | rebuild (Task 7) |
| Separate ground/air hitchance, spread trials after cheap gates | ballistics `hvhHitchance :39` | rebuild (Task 7) |
| Decision weights (damage/safety/accuracy/confidence) | config `:135-138` | rebuild (Task 7) |
| Reload/switch/pause/stale-target checks | DevRuntime, WeaponController `:142` | rebuild (Task 9) |
| Silent aim: camera and movement independent; smooth targeting; trigger | DevRuntime `:178`, GameSession `:902` | rebuild (Task 9) |
| Shot intent (record time, hypothesis source, yaw) sent with fire | protocol `:386`, GameSession `:900-941` | rebuild (Task 8) |
| Auto-scope | skeet profiles | rebuild (Task 15): part of the legacy weapon profiles / client rage scan; kept working unchanged |
| Players tab per-match target overrides | dev/tabs.ts; NativeMenu.ts `:107` | rebuild (Task 15): per-match overrides are runtime state feeding the legacy client rage scan, not config; kept working unchanged in both rooms |

### 5.4 Autowall and ballistics

| Feature | Current location | Status |
|---|---|---|
| Up to two soft boxes, thickness-based retained damage | ballistics `traceHvhCover :11`, `coverDamageScale :29` | rebuild (Task 7) |
| Stone/brick/concrete/metal stop bullets; prediction = server model | wallbang.ts, `isSoft` | rebuild (Task 7) |
| Hit damage, armor, headshot multiplier | ballistics `hvhHitDamage :32`, `afterArmor :36` | rebuild (Task 7) |
| HvH weapon table and spread model (heat, move, air, ADS) | hvh/weapons.ts `:4,15` | rebuild (Task 7) |
| Raycast against hitbox matrices | geometry.ts `:20,36` | rebuild (Task 7) |
| Burst/projectile/melee excluded from exploits | commands.ts `exploitMode :62` | rebuild (Task 3) |

### 5.5 Anti-aim

| Feature | Current location | Status |
|---|---|---|
| Bases: backward, left, right, spin; jitter to 45 deg; desync to 58 deg; invert key `K` | hvh.ts `hvhPose :127`, `HVH :86` | rebuild (Task 4) |
| Six stance states (standing, moving, slowwalking, crouching, airborne, aircrouch) | hvh.ts `:7,33` | rebuild (Task 4) |
| Server-authoritative body yaw; body matrices constrained by velocity/crouch/ground/turn rate | animation.ts `:15-56` | rebuild (Task 4) |
| Lower-body-yaw updates, turn weight, movement layer weight | animation.ts `:22,29`; ServerPlayer `:229-237` | rebuild (Task 4) |
| At-targets and freestanding cover (hit-damage probe) | GameRoom `:319-348` | rebuild (Task 4) |
| Pitch modes (look/down/up/zero), head moves with pose | hvh.ts `hvhPitch :119` | rebuild (Task 4) |
| On-shot reveal 300 ms | GameRoom `:623-626`, `HVH.revealMs` | rebuild (Task 4) |
| Anti-bruteforce side flip on threat | GameRoom `:775-777` | rebuild (Task 4); resolver counterplay (Task 6) |
| Defensive anti-aim after transitions (remain hittable) | GameRoom `:778`, resource.defend | rebuild (Task 3) |
| Slow walk (Shift 45% input) | physics, `PLAYER.slowWalkSpeed` | rebuild (Task 4) |
| Fake duck (gradual real crouch) | core.fakeDuck, DevRuntime `:205` | rebuild (Task 4) |

### 5.6 Resolver

| Feature | Current location | Status |
|---|---|---|
| Hypotheses CENTER/LEFT/RIGHT/LEFT_LOW/RIGHT_LOW/LAST_MOVING/BODY_UPDATE with probabilities | resolver.ts `:4-9,63` | rebuild (Task 6) |
| Policies adaptive / animation / cycle | resolver.ts `:9`, config `:175` | rebuild (Task 6) |
| Per-target observation history (32 samples, 1500 ms memory) | resolver `observe :31` | rebuild (Task 6) |
| Feedback from classified outcomes; uses only earlier observations | resolver `feedback :45` | rebuild (Task 6) |
| Record validity (too old, future, died) | resolver `recordValidity :103` | rebuild (Task 5) |
| Bots see the same public observations | BotSystem `:343-357` | rebuild (Task 8) |
| Confidence / state / pattern display | Resolution type | rebuild (Task 10) |

### 5.7 Simulation

| Feature | Current location | Status |
|---|---|---|
| 64 Hz, one queued command per tick in every mode | CommandBuffer `:26`, GameRoom `:1384` | rebuild (Task 8) |
| 0-12 choked commands; modes static/velocity/random/adaptive/peek; break on shot | commands.ts `fakeLagTicks :8`, `CommandChoker :53` | replace with tickbase choke (Task 3, Task 9) |
| Simulated input latency/jitter/loss, seeded | commands.ts `NetworkSimulator :38`, GameSession `:440-451` | rebuild (Task 9); gates (Task 13) |
| Owner receives fresh state; accepted shots refresh remote poses; choked public state cache | GameRoom `:1469-1479` | rebuild (Task 8) |
| Lag-compensated rewind of targets with validity window | History.ts `:20-47`; GameRoom `:823-835` | rebuild (Task 5) |
| Shot waits for the movement command it followed | GameRoom `:581-588` | rebuild (Task 8) |
| Four era profiles legacy/desync/tickbase/defensive | HvhCoreSettings | replace with era table (Task 2) |
| Era reference documentation | docs/hvh-simulation.md | replace with era reference docs (Task 1) |
| Prediction reconcile with server | WeaponController `:190-206` | replace with tickbase prediction (Task 9) |
| Determinism / benchmark | server/src/tools/hvhBenchmark.ts | rebuild (Task 13); tuning (Task 14) |

### 5.8 Exploits (the "charge")

| Feature | Current location | Status |
|---|---|---|
| Single 32-unit shared resource, regen 0.25/tick (0.125 choked), recovery lock | commands.ts `ExploitResource :66` | replace with per-player tickbase (Task 3) |
| Double Tap: full charge, two immediate bullets, cooldown >= 312.5 ms | `fire` | replace with tickbase shift (Task 3) |
| Hide Shots: 14 units, anti-aim kept through 300 ms exposure | `fire`, `HVH.hideMs` | replace with tickbase hide shots (Task 3) |
| Defensive transition: 12 units, 8-tick window | `defend` | replace with defensive tickbase window (Task 3) |
| Respawn empties charge; panel/mode/weapon change cannot refill | ServerPlayer `:177` | rebuild (Task 3, Task 8) |
| Exploit readiness/state text (Burst ready, Charging, Needs two rounds) | WeaponController `:172-177` | replace with tickbase indicators (Task 10) |
| Charge in snapshot, shot events, HUD | protocol `:54,138,189,403` | replace with tickbase fields (Task 8) |
| Exploits tab UI | dev/tabs.ts `:36-40` | done (Task 11): DT/HS select plus Defensive toggle and bind (intent.defensive, v2 rooms only); v2 status points to the tickbase HUD |
| Era availability: all exploits work in every era | exploitMode | replace with era table gating (Task 2) |

### 5.9 Movement

| Feature | Current location | Status |
|---|---|---|
| Inertial acceleration, counter-strafing | physics.ts `stepPlayer :128` | rebuild (Task 4) for HvH hull and movement; core physics otherwise untouched |
| Slow walk (Shift 45%) | physics, constants | rebuild (Task 4) |
| Auto-stop: native slow walk, between-shots, predicted cover-edge peeks | autostop.ts `:22-96`, DevRuntime `:249` | rebuild (Task 9) |
| Auto strafe (assisted), subtick strafe (8 sub-steps per tick) | GameRoom `:545-554`, input frame flags | rebuild (Task 9); blocked outside assisted HvH (Task 13) |
| Peek assist: hold `Z` anchor and return, cancel rules | DevRuntime `:218`, BotSystem `:366` | rebuild (Task 9) |
| Bunny hop / hop cap `HOP.max` | constants `:46` | drop: non-HvH movement setting, untouched |
| Bot HvH movement | BotSystem `thinkHvh :332`, server/test/hvh-bot-movement.test.ts | rebuild (Task 8) |

### 5.10 Telemetry and visuals

| Feature | Current location | Status |
|---|---|---|
| Target info: hypothesis, confidence, predicted damage/hitchance | DevRuntime `:378-402` | rebuild (Task 10) |
| Shot log: hit/spread/resolver/obstruction/invalid record/weapon rejection | resolver `ShotReason :6`, rage `auditShot :131` | rebuild (Task 7); text (Task 10) |
| Shot audit (target, source, reason, damage, headshot) | rage `ShotAudit :129`; protocol `:405` | rebuild (Task 7) |
| Debug 3D hitbox matrices (hypothesis, actual, selected) | HvhDebug.ts, DevDebug3D.ts | done (Task 12) |
| Indicators (readiness, charging, cooldown) | WeaponController `:172` | replace with tickbase HUD indicators (Task 10) |
| Inaccuracy overlay, ESP, glow | DevOverlay.ts `:222`, DevDebug3D | keep: not mechanics; preserve unchanged through Task 11 and Task 15 (not in the out-of-scope list) |
| Killcam | n/a | drop: out of scope (look & feel plan) |
| Sounds / hitmarker sound | Audio.ts, GameSession `:1813` | drop: out of scope (look & feel plan) |
| Benchmark tooling `npm run benchmark:hvh` | server/src/tools | rebuild (Task 14) |
| Docs and README HvH sections | docs/*, README `:217-295` | rebuild (Task 15) |
| Legacy removal (`ExploitResource`, `fakeLagTicks`, charge protocol fields) | see section 4 | drop: legacy deleted at cutover (Task 15) |

## 6. Notes for later tasks

- `shared/src/hvh/` already exists as a folder with the legacy modules; new v2 modules must not collide with names exported from `shared/src/index.ts:9-18` until Task 15 deletes the legacy ones.
- Hull width is `PLAYER.radius * 2 = 0.9`; there is no named full-width export. A later task may add one (suggest `PLAYER_HULL_WIDTH`) in `shared/src/constants.ts`, derived from `PLAYER.radius`.
- Pre-existing flake: `server/test/botchoice.test.ts` under full-suite load (see section 1).
