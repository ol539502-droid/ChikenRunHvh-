# Late CS:GO Era Reference (2021–2023)

This document provides historical and technical justification for the era constants defined in [`shared/src/hvh/v2/era.ts`](../../shared/src/hvh/v2/era.ts) (`LATE_CSGO`), supporting ChikenRunHvh's transition to a tickbase simulation model mirroring late Counter-Strike: Global Offensive HvH (Hacker vs. Hacker) mechanics.

---

## Era Constants (`LATE_CSGO`)

| field | value | meaning (plain English) | source | confidence (high/medium/low) |
|---|---|---|---|---|
| `tickRate` | `64` | The standard rate at which the server simulates physics and game state, running at 64 ticks per second (15.625 ms per tick). | CS:GO official matchmaking server tickrate (default 64 tick) | high |
| `maxProcessTicks` | `16` | The server-enforced cap on how many user commands (ticks) the engine will process from a single client in one frame before dropping the remainder. | CS:GO server cvar sv_maxusrcmdprocessticks (default 16) | high |
| `chargeTicks` | `32` | Ticks a double-tap or hide-shots charge stores. The player stops for this many ticks (0.5 s) with no enemy in sight, and one burst spends them all: the shot or the toggle-off teleports the player along their movement by that many movement steps. | none (owner decision, 2026-10-18 HvH redesign; replaces the bank and shift fields below) | high |
| `maxChoke` | `14` | The maximum consecutive user commands a client holds back and sends in a single packet batch to hide real-time movement and break enemy resolver tracking. | none (convention / observed Valve-server limit) | medium |
| `lagCompWindowMs` | `200` | The historical rewind buffer duration in milliseconds stored by the server for lag-compensated hit registration. | CS:GO server cvar sv_maxunlag (default 0.2, representing 200 ms) | high |
| `maxDesyncDeg` | `58` | The maximum angular difference in degrees (body_yaw pose range [-58, +58]) between the server-authoritative hitbox body yaw and the client-rendered visual direction while standing still. | Leaked CS:GO source csgo_playeranimstate.cpp (CCSGOPlayerAnimState body_yaw pose parameter range [-58, 58]) | high |
| `maxPitchDeg` | `68.75` (1.2 rad) | The largest pitch, in degrees up or down, a pose may take. Defensive anti-aim pitches (down, up, random, jitter) stay inside it (ruling R58); CS:GO itself allows 89. | The chicken hitbox head pose (`CHICKEN_POSE.pitchLimit`, 1.2 rad), which clamps there, so a larger pitch would not move the hitboxes | high |
| `desyncRunFalloff` | `0.5` | The multiplier (0.5) applied to maximum desync when running at full speed, reducing the 58-degree standing pose limit down to 29 degrees (simplifying CS:GO's piecewise lerp). | Leaked CS:GO source csgo_playeranimstate.cpp (CSGO_ANIM_AIM_NARROW_RUN 0.5 aim-matrix width multiplier at maximum running speed) | high |
| `lagCompBreakHulls` | `2` | The horizontal distance threshold in player hull widths (2 hulls × (2 × 0.45) = 1.8 units) beyond which server lag compensation detects a teleport and stops backtracking at that record. | CS:GO source game/server/player_lagcompensation.cpp (CLagCompensationManager::BacktrackPlayer, m_flTeleportDistanceSqr = 64²); 2 hulls × (2 × 0.45) = 1.8 proportional translation (CS:GO fact: high, game mapping: medium) | medium |

---

## Detailed Technical Context

### 1. Command Budget & Tickbase Exploitation (`maxProcessTicks`, `doubleTapShift`, `maxChoke`)
In the Source engine, `sv_maxusrcmdprocessticks` (default 16 in CS:GO) limits the maximum number of user commands a client can transmit in a single packet or process in a single server tick. 
- **Double Tap (DT)**: Works by artificially advancing the client's `tickbase` ahead of server time before firing. Because the server evaluates weapon attack delays (`m_flNextPrimaryAttack`) against the advanced `tickbase`, the second shot is permitted immediately without waiting for normal cooldown. A 14-tick advance leaves a 2-tick safety margin within `sv_maxusrcmdprocessticks 16` so user commands are not dropped by the server.
- **Packet Choking**: The engine limits `clc_Move` new commands (`MAX_NEW_COMMANDS 15`, plus up to 7 backup commands). On official Valve matchmaking servers, a client can hold back packet transmission (`bSendPacket = false`) for up to 14 consecutive ticks (community-observed limit). When released, all choked commands arrive at once. The engine processes them in a single frame, resulting in rapid movement on other clients' screens and masking real yaw updates.

### 2. Lag Compensation & Teleport Threshold (`lagCompWindowMs`, `lagCompBreakHulls`)
- **Rewind Window**: In CS:GO, `sv_maxunlag` defaults to 0.2 seconds (200 ms). At 64 ticks per second, this corresponds to $\lfloor (200 \times 64) / 1000 \rfloor = \lfloor 12.8 \rfloor = 12$ ticks.
- **Teleport Breaking Rule**: In CS:GO server code (`game/server/player_lagcompensation.cpp`, `CLagCompensationManager::BacktrackPlayer`), lag compensation loops backwards over historical tick records. If horizontal (2D) distance squared between consecutive records exceeds the teleport threshold `m_flTeleportDistanceSqr` (`LAG_COMPENSATION_TELEPORTED_DISTANCE_SQR = 64.0f * 64.0f`), backtracking stops at that record:
  ```cpp
  // Paraphrase of CLagCompensationManager::BacktrackPlayer:
  if ( delta.Length2DSqr() > m_flTeleportDistanceSqr ) {
      // Teleport detected: stop backtracking at this record
      break;
  }
  ```
- **Hull Mapping**: In CS:GO, the standard player bounding hull width is 32 units ($x, y \in [-16, +16]$). Therefore, the 64-unit teleport distance represents $64 / 32 = 2.0$ player hull widths. In ChikenRun, the player horizontal radius is `PLAYER.radius = 0.45` ([`shared/src/constants.ts`](../../shared/src/constants.ts)), giving a hull width of $2 \times 0.45 = 0.9$ world units. Setting `lagCompBreakHulls = 2` yields $2 \text{ hulls} \times (2 \times 0.45) = 1.8$ world units. This is a proportional translation of CS:GO's 2-hull rule rather than an exact engine value (CS:GO 64-unit fact: high confidence; ChikenRun 1.8 unit hull mapping: medium confidence).

### 3. Anti-Aim Desync (`maxDesyncDeg`, `desyncRunFalloff`)
- In leaked CS:GO animstate source (`csgo_playeranimstate.cpp`), `CCSGOPlayerAnimState` manages body and feet alignment. The player's `body_yaw` pose parameter range is clamped between -58.0° and +58.0°, establishing the maximum standing desync angle of 58° (`maxDesyncDeg: 58`).
- When the player moves, `CCSGOPlayerAnimState` scales the allowable desync delta by multiplying the pose range by the aim-matrix width. This width lerps from 1.0 (stationary) toward `CSGO_ANIM_AIM_NARROW_WALK` (0.8) and `CSGO_ANIM_AIM_NARROW_RUN` (0.5) based on normalized running speed, and toward `CSGO_ANIM_AIM_NARROW_CROUCHMOVING` (0.5) while crouch-moving. At maximum running speed, the aim-matrix multiplier is 0.5, halving the 58° standing delta to 29° (`desyncRunFalloff: 0.5`). Note that `desyncRunFalloff: 0.5` in `EraTable` is a linear simplification of CS:GO's piecewise lerp.

### 4. Cheat Conventions (`hideShotsShift`, `defensiveShift`, `rechargeDelayTicks`)
_The charge-and-burst redesign (2026-10-18) removed `doubleTapShift`, `doubleTapShiftOptions`, `hideShotsShift`, `defensiveShift` and `rechargeDelayTicks` in favour of `chargeTicks`. This section and the related flags below are kept as history._

Unlike engine cvars, these values were established purely by late CS:GO cheat providers (e.g. Gamesense/Skeet, Neverlose, Onetap):
- **Hide Shots (8 ticks)**: Manipulates tickbase when discharging a weapon so that the user command containing the on-shot view angles is excluded from the server's lag-compensation record. This conceals on-shot angle updates from enemy resolvers.
- **Defensive Shift (12 ticks)**: Triggered when peeking corners or anticipating an enemy shot. By shifting tickbase backwards so simulation time does not advance normally, the client invalidates the server's lag-compensation backtrack records for that tick, causing incoming enemy fire to miss.
- **Recharge Delay (16 ticks)**: A client-side cooldown period (16 server ticks, or 250 ms at 64 tick) required after a tickbase shift before the shift buffer can begin replenishing, preventing continuous back-to-back double taps.

---

## Flags for Task 14

1. **Composite Budget Constraint (Double Tap Shift + Packet Choke)**: `validateEra` already validates `doubleTapShift <= maxProcessTicks` and `maxChoke <= maxProcessTicks` independently. However, if a client chokes commands (e.g. 14 ticks) and executes a double-tap shift (e.g. 14 ticks), the combined total of 28 commands would exceed `maxProcessTicks: 16`. Task 14 should implement and verify a composite budgeting rule ensuring `chokedTicks + shiftedTicks <= maxProcessTicks` (or managing how shifted commands are batched across packet transmissions).
2. **Double Tap Shift Options Tuning**: `doubleTapShiftOptions: [12, 14, 16]` contains 16, which consumes the entire `maxProcessTicks` budget and allows zero packet choke headroom. Task 14 should verify whether 16 should be clamped or disallowed when choking is active.
3. **Max Choke Limit Enforcement**: `maxChoke: 14` is a community-observed convention for Valve matchmaking servers rather than a documented cvar. Task 14 should test whether clients holding 14 commands experience packet drops under network jitter.
4. **Hull Mapping for Lag Comp Break**: `lagCompBreakHulls: 2` translates CS:GO's 64-unit threshold proportionally to $2 \times (2 \times 0.45) = 1.8$ units. Task 14 should verify whether 1.8 units behaves properly in ChikenRun's collision geometry and whether high-speed dashes trigger false-positive teleports.
5. **Desync Piecewise vs Linear Falloff**: `desyncRunFalloff: 0.5` simplifies CS:GO's piecewise lerp (`CSGO_ANIM_AIM_NARROW_WALK 0.8`, `CSGO_ANIM_AIM_NARROW_RUN 0.5`, `CSGO_ANIM_AIM_NARROW_CROUCHMOVING 0.5`). Task 14 should assess whether a single linear falloff factor is sufficient or whether distinct walk and crouch multipliers are needed.
6. **Hide Shots Shift Tuning**: `hideShotsShift: 8` is an unsourced cheat tunable (varied from 6 to 9 ticks across cheats). Task 14 should verify whether 8 ticks reliably shields on-shot angles under 14-tick choke and whether it interacts cleanly with double-tap recharge.
7. **Defensive Shift Mechanics**: `defensiveShift: 12` is an unsourced cheat tunable (varied from 11 to 14 ticks). Task 14 should verify that 12 ticks reliably invalidates lag-compensation records without causing client prediction stutter.
8. **Recharge Granularity**: `rechargeDelayTicks: 16` sets a 16-tick cooldown. Task 14 should confirm whether recharge is step-instant after 16 ticks or recharges linearly (e.g. 1 tick per server frame after delay).
