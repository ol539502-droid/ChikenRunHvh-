# HvH Mechanics Recode (Late CS:GO Era) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Each task names an **agent role**; put that role and its focus at the top of the implementer brief.

**Goal:** Replace ChikenRunHvh's abstract HvH charge system with a real per-player tickbase model that plays like late CS:GO HvH (2021–23), where every shot outcome is deterministic and explained.

**Architecture:** All HvH rules live in pure, deterministic modules under `shared/src/hvh/` (era table, tickbase, pose, lag records, resolver, shot pipeline, hit-log text), used by both server and client. `server/src/rooms/HvhRoom.ts` only orchestrates; the client mirrors the tickbase for prediction and renders server verdicts. The new engine runs behind a per-room flag until it passes every gate, then the legacy code is deleted.

**Tech Stack:** TypeScript, Node.js 22.13+, Socket.IO, Three.js, the repo's existing test runner (identified in Task 0).

**Spec:** No separate spec file (partner chose to go straight to the plan). The agreed design is the "Design" section below and is binding.

## Agent Roles

| Role | Owns | Tasks |
|---|---|---|
| Researcher | Era facts with sources and confidence | 1 |
| Game Designer | Values, counter-relationships, balance tuning | 2, 14 |
| Backend | `shared/src/hvh/`, `server/`, protocol | 3–8, 15 |
| Frontend | `client/` prediction, HUD, panel, overlay | 9–12 |
| QA / Simulation | Inventory, determinism, sweep harness, gates | 0, 13, 14 |

Task 0 runs first. Tasks 1–2 can run in parallel with Tasks 3–7 (modules read values only through `EraTable`). Tasks 9–12 start after Task 8.

## Design (agreed in chat)

- **Tickbase is real, not a resource bar.** Each player has a tick counter and a bank of unused ticks. Choking (fake lag), double tap (DT), hide shots (HS) and defensive all come from that one model.
- **Choke and shift share one budget:** `shiftBudget = min(bank, maxProcessTicks − choked)`. Heavy fake lag means no DT. This is the core tension of the era.
- **DT** spends `doubleTapShift` ticks inside one server tick, so the second shot happens at real tick timing. **HS** spends `hideShotsShift` so the on-shot pose is never recorded. **Defensive** spends `defensiveShift` and invalidates the shooter's recent lag records.
- **Every shot yields a `ShotVerdict`** with exactly one cause: `hit | resolver | spread | invalidRecord | obstruction | tickbase | rejected`. Outside seeded spread there is no hidden randomness.
- **Server is authoritative.** It processes at most `maxProcessTicks` commands per player per tick. Rejections produce verdicts, never silent drops or kicks.
- **One era table.** Late CS:GO is the default. The four existing era profiles become alternative tables.
- **Balance rule:** no config wins more than 55% against the field, and every config has a counter that beats it by at least 55%.
- **Out of scope here** (separate look & feel plan): the look-alike menu redesign, the IMGUI renderer audit, killcam, and sounds.

## Global Constraints

- Everything in `shared/src/hvh/` is deterministic: no `Math.random()`, no wall-clock time; randomness only via the existing seeded spread.
- Tick rate 64 Hz; all HvH timing is expressed in ticks, not milliseconds.
- Late CS:GO era values (initial; Task 1 verifies, Task 14 may tune the ones marked *tunable*): `maxProcessTicks 16`, `doubleTapShift 14`, `doubleTapShiftOptions [12, 14, 16]`, `maxChoke 14`, `lagCompWindowMs 200`, `maxDesyncDeg 58`, `desyncRunFalloff 0.5`, `lagCompBreakHulls 2`, `hideShotsShift 8` (*tunable*), `defensiveShift 12` (*tunable*), `rechargeDelayTicks 16` (*tunable*).
- No HvH rule may run in any non-HvH mode.
- All HvH work happens on branch `hvh-v2` in a worktree (superpowers:using-git-worktrees). Never commit to `main`.
- Room engine flag: `hvhEngine: 'legacy' | 'v2'`, set from env `HVH_ENGINE`, default `legacy` until Task 15.
- Test syntax below uses `describe/it/expect`; implementers translate to the runner recorded in `docs/hvh/parity-checklist.md` (Task 0) without changing assertions.

## Review Focus

1. Weapon switch or slow weapon during DT: the second bullet must still respect that weapon's fire interval in ticks (Task 7 test `dt respects slow weapon interval`).
2. Turning on DT while choking at 14: the player gets a `tickbase` verdict, "choke too high", not a silent no-shot (Task 3 test `dt rejected when choke eats budget`).
3. Packet-loss burst: the server receives more than 16 commands for one player in one tick and must not run them all at once (Task 8 test `burst is capped at maxProcessTicks`).
4. Death or respawn mid-shift: bank cleared, pending second DT bullet cancelled (Task 8 test `death cancels pending dt bullet`).
5. First DT bullet kills: the second bullet must not double-count a kill or crash on a dead target (Task 7 test `second dt bullet on dead target`).

---

### Task 0: Pre-flight inventory and parity checklist — *QA / Simulation*

**Files:**
- Create: `docs/hvh/parity-checklist.md`

**Interfaces:**
- Produces: the test runner name and invocation, the hull-width constant name in shared physics, the current HvH entry points, and one checklist row per current HvH feature.

- [ ] **Step 1:** Create worktree and branch `hvh-v2`; run `npm install && npm test && npm run typecheck`. Expected: all green on the untouched baseline (record any pre-existing failures in the checklist).
- [ ] **Step 2:** Record in the checklist: the test runner and single-file command; the exported player hull width constant in `shared/src/physics.ts` (or wherever it lives); the file:line of every current HvH entry point (`shared/src/hvh.ts`, `server/src/rooms/GameRoom.ts` HvH branches, `client/src/dev/*` Skeet panel, DevRuntime, charge/exploit code).
- [ ] **Step 3:** List every current HvH feature from the README "HvH setup", "Skeet" and bullet sections (aim, autowall, anti-aim, simulation, exploits, movement, telemetry). Give each row a status: `rebuild (Task N)`, `replace with <x> (Task N)`, or `drop: <reason>`. No row may be left without a status.
- [ ] **Step 4: Commit** `git add docs/hvh/parity-checklist.md && git commit -m "docs(hvh): v2 parity checklist and pre-flight"`

### Task 1: Era reference — *Researcher*

**Files:**
- Create: `docs/hvh/era-reference.md`
- Test: `shared/src/hvh/__tests__/eraReference.test.ts`

**Interfaces:**
- Produces: a markdown table with columns `field | value | meaning (plain English) | source | confidence (high/medium/low)`, one row per `EraTable` field (Task 2).

- [ ] **Step 1: Write the failing test** `every EraTable field has a reference row`: read `docs/hvh/era-reference.md`, parse the first column, and expect it to contain every key of `LATE_CSGO` (Task 2) except `id`.
- [ ] **Step 2:** Run it. Expected: FAIL (file missing).
- [ ] **Step 3:** Write the reference. Verify each Global Constraints value against public sources (engine cvars such as `sv_maxusrcmdprocessticks`, the lag-compensation teleport distance, the max desync delta and how it scales with speed). Explain each in one plain-English sentence for a developer new to HvH. Where a value can't be sourced, keep the initial value, mark it `low`, and flag it for Task 14.
- [ ] **Step 4:** Run the test. Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "docs(hvh): late CS:GO era reference"`

### Task 2: Era table and validation — *Game Designer*

**Files:**
- Create: `shared/src/hvh/era.ts`
- Test: `shared/src/hvh/__tests__/era.test.ts`

**Interfaces:**
- Produces:
  - `interface EraTable { id: string; tickRate: 64; maxProcessTicks: number; doubleTapShift: number; doubleTapShiftOptions: readonly number[]; maxChoke: number; lagCompWindowMs: number; maxDesyncDeg: number; desyncRunFalloff: number; lagCompBreakHulls: number; hideShotsShift: number; defensiveShift: number; rechargeDelayTicks: number }`
  - `const LATE_CSGO: EraTable` (Global Constraints values)
  - `function validateEra(t: EraTable): string[]` (empty array = valid)
  - `function lagCompWindowTicks(t: EraTable): number` = `Math.floor(t.lagCompWindowMs * t.tickRate / 1000)`

- [ ] **Step 1: Write the failing tests:**
  - `validateEra(LATE_CSGO)` → `[]`; `lagCompWindowTicks(LATE_CSGO)` → `12`.
  - `{...LATE_CSGO, maxChoke: 17}` → errors include `"maxChoke exceeds maxProcessTicks"`.
  - `{...LATE_CSGO, doubleTapShift: 17}` → errors include `"doubleTapShift exceeds maxProcessTicks"`.
  - `{...LATE_CSGO, desyncRunFalloff: 1.2}` → errors include `"desyncRunFalloff out of range [0,1]"`.
- [ ] **Step 2:** Run. Expected: FAIL (module missing).
- [ ] **Step 3:** Implement. Also check that `hideShotsShift` and `defensiveShift` don't exceed `doubleTapShift`, and that `doubleTapShift` is in `doubleTapShiftOptions`.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "feat(hvh): era table with validation"`

### Task 3: Tickbase — *Backend*

**Files:**
- Create: `shared/src/hvh/tickbase.ts`
- Test: `shared/src/hvh/__tests__/tickbase.test.ts`

**Interfaces:**
- Consumes: `EraTable`.
- Produces:
  - `interface TickbaseState { tickbase: number; bank: number; choked: number; ticksSinceShift: number }`
  - `const EMPTY_TICKBASE: (tick: number) => TickbaseState` (bank 0, choked 0, ticksSinceShift = rechargeDelayTicks)
  - `interface CommandIntent { fire: boolean; choke: boolean; doubleTap: boolean; hideShots: boolean; defensive: boolean }`
  - `type TickbaseReject = 'dtNotCharged' | 'hsNotCharged' | 'defensiveNotCharged' | 'chokeTooHigh'`
  - `type TickAction = { kind: 'run' } | { kind: 'bank' } | { kind: 'choke' } | { kind: 'shift'; ticks: number; reason: 'doubleTap' | 'hideShots' | 'defensive' } | { kind: 'reject'; reason: TickbaseReject }`
  - `function shiftBudget(s: TickbaseState, era: EraTable): number` = `max(0, min(bank, maxProcessTicks − choked))`
  - `function stepTickbase(s: TickbaseState, intent: CommandIntent, era: EraTable): { next: TickbaseState; action: TickAction }`

Rules: choke while `intent.choke && choked < maxChoke`, and a non-choked tick flushes `choked` to 0. Bank +1 per tick only when not firing, not choking, `ticksSinceShift ≥ rechargeDelayTicks` and `bank < doubleTapShift`. A shift needs `shiftBudget ≥` its shift size, otherwise reject: `chokeTooHigh` if `bank` alone would have covered it, else the matching `*NotCharged`. A shift subtracts its ticks from `bank`, resets `ticksSinceShift`, and advances `tickbase` by the shifted ticks for DT. Priority when several intents are set: defensive > doubleTap > hideShots.

- [ ] **Step 1: Write the failing tests:**
  - `shiftBudget`: `{bank:14, choked:0}` → 14; `{bank:14, choked:4}` → 12; `{bank:14, choked:14}` → 2; `{bank:5, choked:0}` → 5.
  - `banks to full`: from empty, idle intents for `16 + 14` ticks → `bank === 14`; the 31st idle tick keeps 14.
  - `dt shifts 14`: full bank, `{fire:true, doubleTap:true}` → `action {kind:'shift', ticks:14, reason:'doubleTap'}`, `next.bank === 0`.
  - `dt rejected when choke eats budget`: bank 14, choked 14 → `{kind:'reject', reason:'chokeTooHigh'}`.
  - `dt not charged`: bank 6 → `{kind:'reject', reason:'dtNotCharged'}`.
  - `choke caps at 14`: 20 choke intents → `choked` never exceeds 14, and the 15th tick action is `run`.
  - `no recharge while firing`: firing every tick for 40 ticks → bank stays 0.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement `stepTickbase` per the rules above.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "feat(hvh): real tickbase with shared choke/shift budget"`

### Task 4: Pose and desync — *Backend*

**Files:**
- Create: `shared/src/hvh/pose.ts`
- Test: `shared/src/hvh/__tests__/pose.test.ts`

**Interfaces:**
- Consumes: `EraTable`.
- Produces:
  - `type Side = 'left' | 'right' | 'center'`
  - `interface AntiAimConfig { base: 'backward' | 'left' | 'right' | 'spin'; jitterDeg: number; desyncDeg: number; inverted: boolean }` (jitter clamp 0–45 as today)
  - `interface Motion { speedFraction: number; duck: number; onGround: boolean }`
  - `interface PoseState { eyeYaw: number; bodyYaw: number; pitch: number; jitterPhase: 0 | 1; realSide: Side }`
  - `function maxDesync(speedFraction: number, era: EraTable): number` = `maxDesyncDeg × (1 − desyncRunFalloff × clamp01(speedFraction))`
  - `function stepPose(prev: PoseState, aimYaw: number, aa: AntiAimConfig, motion: Motion, tick: number, era: EraTable): PoseState`
  - `function publicObservation(p: PoseState, motion: Motion, tick: number): Observation` (eye yaw, jitter-visible eye offset, speed, duck; never `bodyYaw` or `realSide`) — `Observation` is defined here and consumed by Task 6.

- [ ] **Step 1: Write the failing tests:**
  - `maxDesync(0, LATE_CSGO)` → 58; `maxDesync(1, …)` → 29; `maxDesync(0.5, …)` → 43.5.
  - `desync clamps by speed`: `desyncDeg 58` at speed 1 → `|bodyYaw − eyeYaw| ≤ 29` (wrapped angle).
  - `jitter alternates`: `jitterDeg 30` → `jitterPhase` flips every tick, eye offset ±30.
  - `inverted flips side`: same inputs with `inverted` true and false → opposite `realSide`.
  - `observation hides body`: `publicObservation` has no `bodyYaw` or `realSide` keys.
  - `deterministic`: same inputs twice → deep-equal outputs.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "feat(hvh): pose and velocity-limited desync"`

### Task 5: Lag records — *Backend*

**Files:**
- Create: `shared/src/hvh/records.ts`
- Test: `shared/src/hvh/__tests__/records.test.ts`

**Interfaces:**
- Consumes: `EraTable`, `lagCompWindowTicks`, `PoseState`, the hull-width constant from Task 0.
- Produces:
  - `type InvalidCause = 'expired' | 'defensive' | 'lagcompBreak' | 'choked'`
  - `interface LagRecord { tick: number; position: Vec3; pose: PoseState; valid: boolean; invalidCause?: InvalidCause }`
  - `class RecordHistory { constructor(era: EraTable, hullWidth: number); push(r: LagRecord): void; markDefensive(fromTick: number): void; select(viewTick: number, nowTick: number): { record: LagRecord } | { invalid: InvalidCause } }`

Rules: records older than `lagCompWindowTicks` are `expired`. If a new record is more than `lagCompBreakHulls × hullWidth` from the previous one, every older record becomes `lagcompBreak`. `markDefensive` invalidates records at or after `fromTick`. A view tick that falls inside a choke gap selects the last record before it.

- [ ] **Step 1: Write the failing tests:** `expired after 12 ticks` (view now−13 → `expired`); `break on teleport-sized move` (move 2.01 hulls → older `lagcompBreak`; 1.99 hulls → still valid); `defensive invalidates recent` (`markDefensive(now−3)` → view now−2 gives `defensive`, now−5 valid); `choke gap uses last record`.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "feat(hvh): lag-compensation records with break and defensive rules"`

### Task 6: Resolver — *Backend*

**Files:**
- Create: `shared/src/hvh/resolver.ts`
- Test: `shared/src/hvh/__tests__/resolver.test.ts`

**Interfaces:**
- Consumes: `Observation`, `Side`.
- Produces:
  - `type VerdictCause = 'hit' | 'resolver' | 'spread' | 'invalidRecord' | 'obstruction' | 'tickbase' | 'rejected'` (defined here; Task 7 imports it)
  - `interface ResolverMemory { byTarget: Map<string, TargetMemory> }` (internal `TargetMemory` shape is the implementer's choice)
  - `function createResolverMemory(): ResolverMemory`
  - `function resolve(mem: ResolverMemory, targetId: string, obs: readonly Observation[], atTick: number): { side: Side; confidence: number }` (uses only `obs` with `tick ≤ atTick`)
  - `function learnFromVerdict(mem: ResolverMemory, targetId: string, guessed: Side, cause: VerdictCause): void`

Behaviour: start from the side the eye offset suggests, at low confidence. After a `resolver` miss, flip the guess for that target. Detect period-2 jitter from three or more consecutive observations and predict by phase. A pattern break drops confidence below 0.4. Fully deterministic.

- [ ] **Step 1: Write the failing tests:**
  - `flips after resolver miss`: guess `left`, `learnFromVerdict(...,'left','resolver')` → next `side === 'right'`.
  - `learns jitter`: 4 alternating observations → side matches the next phase, `confidence ≥ 0.6`.
  - `pattern break lowers confidence`: then 2 non-alternating → `confidence < 0.4`.
  - `no future peeking`: observations with `tick > atTick` don't change the result.
  - `spread miss teaches nothing`: `cause 'spread'` leaves the next guess unchanged.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "feat(hvh): deterministic learning resolver"`

### Task 7: Shot pipeline, verdicts and hit-log text — *Backend*

**Files:**
- Create: `shared/src/hvh/shot.ts`, `shared/src/hvh/hitlog.ts`
- Test: `shared/src/hvh/__tests__/shot.test.ts`, `shared/src/hvh/__tests__/hitlog.test.ts`

**Interfaces:**
- Consumes: Tasks 2–6, existing `raycast.ts` hitbox tracing, `weapons.ts` fire interval and seeded spread, the autowall material rules.
- Produces:
  - `interface ShotVerdict { shooterId: string; targetId?: string; tick: number; bullet: 1 | 2; cause: VerdictCause; damage?: number; hitgroup?: string; remainingHp?: number; guessed?: Side; real?: Side; invalidCause?: InvalidCause; material?: string; reason?: string }`
  - `interface ShotContext { shooterId: string; tick: number; bullet: 1 | 2; aim: { origin: Vec3; dir: Vec3 }; weaponId: string; ticksSinceLastShot: number; target?: { id: string; history: RecordHistory; alive: boolean; hp: number }; viewTick: number; resolver: ResolverMemory; observations: readonly Observation[]; world: WorldTracer; spreadSeed: number }`
  - `function processShot(ctx: ShotContext): ShotVerdict`
  - `function formatVerdict(v: ShotVerdict, nameOf: (id: string) => string): string`

Cause order (first match wins): `rejected` (weapon, ammo, interval in ticks, angle check) → `invalidRecord` → `obstruction` (non-penetrable or damage fully absorbed) → trace the spread-deviated ray against the **real** pose: hit → `hit`; else if the un-deviated aim hits the **guessed** pose but not the real one → `resolver`; else → `spread`.

Exact hit-log copy:
- hit: `Hit {target} in the {hitgroup} for {damage} ({remaining} remaining)`
- resolver: `Missed shot due to resolver (guessed {guessed}, real {real})`
- spread: `Missed shot due to spread`
- invalidRecord: `Missed shot: target record invalid ({invalidCause})`
- obstruction: `Missed shot: blocked by {material}`
- tickbase: `Shot not fired: {reason}` with reasons `double tap not charged`, `hide shots not charged`, `defensive not charged`, `choke too high`
- rejected: `Shot rejected: {reason}`

- [ ] **Step 1: Write the failing tests:**
  - One test per cause, built from a fixture target with known records, pose and seed, asserting `cause` and the cause-specific fields.
  - `dt respects slow weapon interval`: a bullet 2 whose weapon interval (ticks) exceeds `ticksSinceLastShot` → `rejected` with reason `fire interval`.
  - `second dt bullet on dead target`: `alive: false` → `rejected`, reason `target already dead`, no damage.
  - `hitlog covers every cause`: for each `VerdictCause`, `formatVerdict` returns the exact copy above (string equality), and an exhaustiveness check fails compilation if a cause is added without copy.
  - `same seed same verdict`: identical contexts → deep-equal verdicts.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement `processShot` and `formatVerdict` (switch on `cause` with a `never` default).
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "feat(hvh): single shot pipeline with explained verdicts"`

### Task 8: Protocol and server integration behind the flag — *Backend*

**Files:**
- Create: `server/src/rooms/HvhRoom.ts`
- Modify: `shared/src/protocol.ts`, `server/src/rooms/RoomManager.ts`, HvH branches in `server/src/rooms/GameRoom.ts` (lines from the Task 0 checklist)
- Test: `server/src/rooms/__tests__/HvhRoom.test.ts`

**Interfaces:**
- Consumes: Tasks 2–7.
- Produces:
  - Protocol: the input command gains `intent: CommandIntent` and `clientTick: number`; new server→client `hvhState { tickbase: TickbaseState; era: string }` (own player only); new `shotVerdict: ShotVerdict` (to shooter, target and spectators).
  - `class HvhRoom extends GameRoom` with `processPlayerTick(playerId: string): void` and room option `hvhEngine: 'legacy' | 'v2'` (env `HVH_ENGINE`, default `legacy`).
  - Per player per server tick: dequeue at most `maxProcessTicks` commands; `stepTickbase` → movement step per executed command → `stepPose` → push record unless choked → shots through `processShot` → `learnFromVerdict` → emit verdicts. Queue cap `2 × maxProcessTicks`; overflow drops the oldest with a `rejected` verdict, reason `command flood`.

- [ ] **Step 1: Write the failing tests** (seeded room with two scripted players):
  - `burst is capped at maxProcessTicks`: enqueue 30 commands at once → exactly 16 executed this tick, 14 remain queued.
  - `flood drops oldest with verdict`: 40 enqueued → 8 dropped, 8 `rejected / command flood` verdicts.
  - `dt fires two bullets same tick`: full bank, DT intent → two verdicts with `bullet` 1 and 2 at the same server tick.
  - `death cancels pending dt bullet`: the shooter is killed in the same server tick before their bullet 2 is processed → no bullet-2 verdict is emitted; after respawn the shooter's `bank === 0`.
  - `legacy flag untouched`: `hvhEngine 'legacy'` → existing HvH tests still pass unchanged.
  - `no hvh outside hvh`: a non-HvH room ignores `intent` entirely.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement. Keep `GameRoom` free of v2 logic; the v2 path lives only in `HvhRoom`.
- [ ] **Step 4:** Run the whole suite: `npm test`. Expected: PASS, including all pre-existing tests.
- [ ] **Step 5: Commit** `git commit -m "feat(hvh): v2 server tick pipeline behind HVH_ENGINE flag"`

### Task 9: Client tickbase prediction and reconciliation — *Frontend*

**Files:**
- Create: `client/src/hvh/PredictedTickbase.ts`
- Modify: `client/src/game/LocalPlayer.ts` (attach intents to commands), `client/src/game/GameSession.ts` (route `hvhState`)
- Test: `client/src/hvh/__tests__/PredictedTickbase.test.ts`

**Interfaces:**
- Consumes: `stepTickbase`, `hvhState`.
- Produces: `class PredictedTickbase { apply(seq: number, intent: CommandIntent): void; reconcile(server: TickbaseState, lastAckSeq: number): void; get state(): TickbaseState; get mismatches(): number }`

- [ ] **Step 1: Write the failing tests:** `prediction matches server` (same intents through both → equal states, `mismatches 0`); `reconcile replays unacked` (server state at ack 10, local at 14 → after reconcile, state equals server + replay of 11–14); `mismatch counted` (an injected divergent server state → `mismatches === 1` and snap to server).
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement, mirroring how `LocalPlayer` already reconciles movement.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "feat(hvh): client tickbase prediction"`

### Task 10: Hit log and tickbase indicators — *Frontend*

**Files:**
- Create: `client/src/ui/hvh/HitLog.ts`, `client/src/ui/hvh/Indicators.ts`
- Test: `client/src/ui/hvh/__tests__/HitLog.test.ts`, `client/src/ui/hvh/__tests__/Indicators.test.ts`

**Interfaces:**
- Consumes: `formatVerdict`, `PredictedTickbase.state`, `EraTable`.
- Produces: `HitLog.push(v: ShotVerdict): void` (top-left, max 8 lines, 5 s fade); `function indicatorModel(s: TickbaseState, toggles: {dt: boolean; hs: boolean}, era: EraTable): { dt: 'ready' | 'charging' | 'cooldown' | 'off'; hs: 'on' | 'off'; choke: number; defensive: boolean }`

- [ ] **Step 1: Write the failing tests:** `hit log uses formatVerdict text` and `keeps 8 newest`; `indicatorModel`: bank 14 → `dt 'ready'`; bank 6 → `'charging'`; `ticksSinceShift < rechargeDelayTicks` → `'cooldown'`; choked 14 with bank 14 → `dt 'charging'` (budget 2) and `choke 14`.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement with the existing HUD component pattern. Use plain styling for now; visual polish is in the look & feel plan.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "feat(hvh): verdict hit log and tickbase indicators"`

### Task 11: Skeet panel wiring, config migration, era profiles — *Frontend*

**Files:**
- Modify: `client/src/dev/tabs.ts`, `client/src/dev/config.ts`, the config migration and presets files from Task 0
- Create: `shared/src/hvh/eras.ts` (the four existing profiles as `EraTable`s, `LATE_CSGO` the default)
- Test: `client/src/dev/__tests__/configMigration.test.ts`, `shared/src/hvh/__tests__/eras.test.ts`

**Interfaces:**
- Consumes: `CommandIntent`, `AntiAimConfig`, `EraTable`.
- Produces: `function migrateConfig(old: unknown): { config: DevConfig; reset: string[] }`; `const ERAS: Record<string, EraTable>`; panel controls write intents and AA config only (no rule logic in the client).

- [ ] **Step 1: Write the failing tests:** every `ERAS` entry passes `validateEra`; `ERAS` default is `LATE_CSGO`; `migrateConfig` keeps cleanly mappable fields (AA base, jitter, desync, fake-lag limit clamped to 14, DT/HS toggles) and lists unmappable ones in `reset`; a corrupt config → defaults with every field in `reset`.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement. Show a one-time notice listing `reset` fields after migration. Update each row of the parity checklist this task covers.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "feat(hvh): panel on v2 intents, config migration, era tables"`

### Task 12: Debug overlay — *Frontend*

**Files:**
- Modify: `client/src/dev/DevDebug3D.ts`, server debug feed in `server/src/rooms/HvhRoom.ts`
- Test: `server/src/rooms/__tests__/HvhDebugFeed.test.ts`

**Interfaces:**
- Produces: dev-only message `hvhDebug { playerId; realPose: PoseState; records: LagRecord[]; resolver: { side: Side; confidence: number } }`, sent only to developer-authorized sockets in private rooms (existing `DevAccess` rules).

- [ ] **Step 1: Write the failing tests:** an authorized dev socket receives `hvhDebug`; a normal player never does; the payload replaces the old estimate matrices (the old message is no longer sent in v2 rooms).
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement the server feed, then render the real hitbox, presented pose, valid/invalid records (two colors) and the resolver guess.
- [ ] **Step 4:** Run, then check by eye in a private room with bots. Expected: tests PASS; real and presented poses visibly separate under desync.
- [ ] **Step 5: Commit** `git commit -m "feat(hvh): authoritative debug overlay"`

### Task 13: Determinism, network and isolation gates — *QA / Simulation*

**Files:**
- Create: `server/src/rooms/__tests__/hvhReplay.test.ts`, `server/src/rooms/__tests__/hvhNetwork.test.ts`, `server/src/rooms/__tests__/hvhIsolation.test.ts`

- [ ] **Step 1: Write the failing tests:**
  - `replay is bit-identical`: record 2,000 ticks of a seeded 5v5 bot match, replay through server and through client prediction → identical `TickbaseState` and `PoseState` every tick.
  - `network profiles`: run under each existing seeded latency/jitter/loss profile → no uncaught errors, `PredictedTickbase.mismatches / ticks < 0.01`.
  - `isolation`: every non-HvH mode with HvH intents injected → identical outcomes to the same match without them.
- [ ] **Step 2:** Run. Expected: FAIL where gaps exist. Fix any root causes in the owning module (not in the tests).
- [ ] **Step 3:** Run `npm test`. Expected: PASS.
- [ ] **Step 4: Commit** `git commit -m "test(hvh): determinism, network and isolation gates"`

### Task 14: Balance sweep and tuning — *QA / Simulation + Game Designer*

**Files:**
- Create: `tools/hvh-sweep.ts`, `docs/hvh/balance-report.md`
- Modify: `package.json` (scripts `sweep` and `sweep:quick`), `shared/src/hvh/era.ts` (tunable values only)
- Test: `tools/__tests__/hvhSweep.test.ts`

**Interfaces:**
- Produces: `function runSweep(grid: SweepGrid, roundsPerCell: number, seed: number): WinMatrix`; `function checkBalance(m: WinMatrix): { ok: boolean; dominant: string[]; uncountered: string[] }`.
- Grid: AA base {backward, left, right, spin} × jitter {0, 30, 45} × exploit {none, dt, hs, fakelag14, defensive}. `sweep:quick` uses a 12-config subset in CI.

- [ ] **Step 1: Write the failing tests:** `checkBalance` on a synthetic matrix where one config wins 0.70 against the field → `dominant` contains it; one with no counter of at least 0.55 → `uncountered` contains it; a balanced synthetic matrix → `ok`.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement the harness (headless bot matches through `HvhRoom`, seeded).
- [ ] **Step 4:** Run `npm run sweep`. The Designer changes only *tunable* `era.ts` values until `checkBalance` is `ok`, recording each change and its reason in `docs/hvh/balance-report.md`. If balance needs a non-tunable value changed, stop and record a ruling with its evidence.
- [ ] **Step 5:** Run `npm test && npm run sweep:quick`. Expected: PASS, `ok: true`.
- [ ] **Step 6: Commit** `git commit -m "feat(hvh): balance sweep harness and tuned era values"`

### Task 15: Cutover and legacy removal — *Backend*

**Files:**
- Modify: `server/src/rooms/HvhRoom.ts` / env default, `README.md` HvH sections, `docs/hvh-simulation.md`
- Delete: legacy charge/exploit code and v1 HvH branches listed in the parity checklist

- [ ] **Step 1:** Confirm every parity-checklist row is `done` or `dropped` with a reason.
- [ ] **Step 2:** Flip the `HVH_ENGINE` default to `v2`; remove the `legacy` path and its now-dead tests; delete the legacy files.
- [ ] **Step 3:** Run `npm run typecheck && npm test && npm run sweep:quick && npm run build`. Expected: all PASS, no references to the removed modules (`grep` for their export names returns nothing).
- [ ] **Step 4:** Update the README HvH sections and `docs/hvh-simulation.md` to describe the tickbase model, era tables and verdicts in plain language.
- [ ] **Step 5: Commit** `git commit -m "feat(hvh): v2 engine default, legacy HvH removed"`
