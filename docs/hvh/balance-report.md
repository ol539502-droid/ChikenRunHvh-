# HvH v2 balance report (round redesign, Task 10)

**Result: the balance rule is not met. The stop condition applies.**

**Owner decision R65 (ledger):** keep `chargeTicks` 32 and ship with the balance failure documented. There is no further tuning.

At the shipped values (chargeTicks 32, peek window 4), the full sweep has a max field rate of
59.5%, with 29 dominant and 12 uncountered configs over the three weapon pairings. One tunable
changed: the on-peek window went from 8 to 4 commands (`PEEK_TICKS`, `shared/src/hvh/v2/pose.ts`).
That removed a dominant defensive pattern. `chargeTicks` is unchanged. No charge size meets the
rule, and the best candidates are listed below for a ruling.

This report replaces the old Task 14 report. That sweep's model (a rifle duel on `flat`, the
tickbase bank, defensive as a shift) no longer exists.

**Balance rule** (binding, unchanged). No config wins more than 55% against the field, and every
config has a counter at 55% or more. The R40 definitions apply:
- A config's field rate is its mean win rate over all other configs, mirror matches excluded.
- A config is dominant if its field rate is above 0.55.
- A config has a counter if some other config beats it head-to-head at 0.55 or more.

The rule is checked per weapon pairing, and `--check` passes only when all three pairings are ok.
Per R42, the verdict comes from the primary model ('charged': each round starts charged).

## How to run

| Command | Grid | Rounds per cell | Runtime (measured wall time, this machine) |
| --- | --- | --- | --- |
| `npm run sweep` | 36 configs, 630 pairs, × 3 pairings | 200 | about 47 min (8 workers) |
| `npm run sweep -- --rounds 100` | same | 100 | about 18 min (8 workers) |
| `npm run sweep:quick` | 12-config `QUICK_GRID` × 3 pairings | 60 | about 2.5-3.5 min (153 s with 8 workers, 196 s with the default 6) |

The optional flags are:
- `--rounds N`, `--seed N` and `--json PATH`.
- `--charge N`: overrides `chargeTicks` for one run.
- `--pairing ssg08|scar20|mixed`: runs one pairing only.
- `--model charged|spawn`.
- `--oracle`: a control in which the aimbot knows the real side.
- `--workers N`: the number of threads, half the machine by default.

`--def`, `--recharge` and `--hs` were removed, because the charge model has no such tunables.
Rooms are independent seeded jobs, so the results are identical for any worker count. A unit test
(`hvhSweep.test.ts`) checks that `runSweepParallel` gives the same matrix and stats as the
serial `runSweep`. The first failing job fails the whole run. The tool header in `tools/hvh-sweep.ts` documents the
model in full.

## The model

- **Map and spawn pair.** Mirage B site, nav areas 13 (BombsiteB, x -58.44 z -9.06) and 747
  (x -50.31 z -11.56). They are 8.5 m apart with a sandstone pillar (map box 6603) between them.
  - Both players move along parallel peek lines. At the hide offset (-0.6 m), neither can see the
    other, wherever the other stands on its line, up to the widest peek (4.5 m).
  - They see each other once their offsets add up to about 4.5 m. Line of sight is symmetric, so
    both must peek to fight, and cover always protects the hider.
  - This was measured with the real `enemyVisible` test over the whole offset grid.
- **Rounds.** The room is a real `HvhRoom` (v2, `hvhRounds: false`), and the harness drives the
  rounds.
  - The freeze runs `chargeTicks` ordinary commands behind cover, with DT and HS on, so every DT or
    HS life goes live fully charged. That held for 126,000 of 126,000 lives in the final run.
  - A round ends at the first death, or is a draw after 960 live ticks. About 0.1% of rounds
    were draws (0.1-0.2% per pairing).
  - Sides swap every round, and the inverter is a seeded coin.
- **Weapons.**
  - Pairings: ssg08 vs ssg08, scar20 vs scar20, and mixed. In the mixed pairing each cell plays
    both assignments of the two guns, swapped every two rounds, so the cell measures the configs
    and not the guns.
  - Every spawn has armor and a helmet. Players are scoped.
  - Pistols are not played: no round empties a main.
- **Configs.** AA preset × exploit × defensive mode, 3 × 4 × 3 = 36:
  - AA presets (desync 58 on every stance):
    - static: backward, jitter 0;
    - jitter: backward, jitter 45;
    - stance: jitter 30 standing, static backward while moving, spin in the air.
  - Exploits:
    - none;
    - dt and hs, toggled on for every command, so the server charges whenever no enemy is in real
      line of sight;
    - fakelag14: chokes every non-firing command, up to 14.
  - Defensive modes, set on every stance:
    - off;
    - inAir: random pitch, yaw off;
    - onPeek: flick, with pitch down, the panel's default pitch.
- **Script.** The same script runs for every config, with seeded timings:
  - hide behind cover; DT and HS also wait for a full charge, which recharges them mid-round;
  - peek out, a quarter of the peeks starting with a jump;
  - on sight, counter-strafe and fire once the weapon is ready (R41: server ticks) and the shot's
    post-step speed is at most 0.5 m/s on the ground.
  - A DT or HS shot with a full charge is a burst. Its command moves back toward cover, so the
    teleport goes there, and the bot retreats. A plain SSG 08 shot also retreats, because the
    next shot is 1.25 s away. A SCAR-20 keeps fighting for a seeded time.
- **Aimbot.** It sees only what a client sees:
  - the newest lag record (the snapshot), the observations, and whether that record is an
    on-shot record;
  - its own resolver, through `peekResolve`.

  It aims at the head of the guessed pose, its own line of sight is the same `enemyVisible` test
  on that record, and it sends `clientTick`. Headless, no snapshot is sent, so the server's charge
  sight takes its start-of-tick fallback (R56).
- **Statistics.** The sweep reports:
  - standard errors on the field and cell rates;
  - a ±1 SE counter classification (countered / uncountered / inconclusive) for the report, while
    `checkBalance` keeps the strict rule;
  - the 3-cycle count;
  - verdicts by shooter exploit and by target defensive mode (with the hitgroup);
  - charge events: lives that went live charged, bursts, and mid-round recharges.

## Final result (shipped values: chargeTicks 32, peek window 4)

Full grid, seed 20, 200 rounds per cell: 378,000 rounds in 47 min. **Verdict: not ok.**

| Pairing | Max / min field rate | Dominant | Uncountered (strict) | Uncountered (±1 SE) | 3-cycles |
| --- | --- | --- | --- | --- | --- |
| ssg08 vs ssg08 | 59.5% / 35.2% | 10 | 4 | 1 | 8 of 7,140 |
| scar20 vs scar20 | 58.0% / 35.0% | 9 | 5 | 0 | 9 |
| mixed | 59.1% / 34.9% | 10 | 3 | 0 | 29 |

Every dominant config is DT or HS on the static or stance preset. The highest field rates are:
- ssg08: `stance/dt/inAir` and `stance/dt/off` 59.5%, `static/dt/inAir` 59.0%;
- scar20: `static/dt/inAir` 58.0%;
- mixed: `static/dt/off` 59.1%.

Field SE is 0.6% and cell SE is about 3.5%.

Mean field rate by axis (ssg08; the other two pairings are within about 3 points):

| Exploit | none | dt | hs | fakelag14 |
| --- | --- | --- | --- | --- |
| static preset | 46.8 | **58.7** | **55.4** | 51.6 |
| jitter preset | 37.2 | 45.7 | 43.9 | 47.7 |
| stance preset | 47.3 | **59.3** | **55.2** | 51.1 |

| Defensive | off | inAir | onPeek |
| --- | --- | --- | --- |
| mean field rate | 49.6 | 49.7 | 50.7 |

Exploit against exploit, as the row's mean win rate (ssg08 / scar20):

|  | none | dt | hs | fakelag14 |
| --- | --- | --- | --- | --- |
| none | 50 | 36.3 / 39.2 | 40.3 / 42.3 | 49.1 / 48.0 |
| dt | 63.7 / 60.8 | 50 | 53.1 / 52.7 | 51.0 / 48.2 |
| hs | 59.7 / 57.7 | 46.9 / 47.3 | 50 | 49.3 / 48.0 |
| fakelag14 | 50.9 / 52.0 | 49.0 / 51.8 | 50.7 / 52.0 | 50 |

The mechanics are exercised:
- ssg08: 108,943 bursts and 41,014 mid-round recharges in 126,000 rounds;
- mean live round 114-121 ticks;
- DT on the SSG 08 never gets a second bullet: its 80-tick interval exceeds the burst, so the
  bullet is 'fire interval' rejected.

The quick sweep at the shipped values (`npm run sweep:quick`, 60 rounds per cell, 153 s with 8 workers) is not ok:
max field rate 60.8%, 11 dominant, 5 uncountered.

## Tuning steps

### 1. Initial model, shipped values (chargeTicks 32, peek window 8)

Quick sweep: **not ok.** Max field rate 76.4-77.2% over three runs, as the model was finalised
(the last change added the SSG 08 retreat rule), with 10-11 dominant and 3-4 uncountered.
`static/dt/onPeek` reached 76%, and onPeek beat off 63-66%.

**The cause is the on-peek pitch.** While the defensive pattern is active, the pitch is forced
down (68.75°, the era limit). That hides the chicken head behind the chest from a level shooter.
Against on-peek targets, 50% of shots hit the chest and 27% the head. Against targets with
defensive off, 2% hit the chest and 60% the head.

The 8-command window covers the opponent's first aimed shot, which comes about 6 ticks after
sight, once the counter-strafe has stopped.

### 2. Which part of on-peek is dominant (quick grid, ssg08, 60 rounds per cell)

| On-peek pattern | onPeek vs off |
| --- | --- |
| pitch down + flick (shipped default) | 66.3% |
| pitch down, yaw off | 71.2% |
| pitch zero + flick | 49.0% |
| pitch random + flick | 50.4% |
| pitch jitter + flick | 53.3% |
| pitch up + flick | 40.6% |

The flick (120°, 4 ticks) is neutral. The pitch-down override is the dominant mode.

### 3. Peek window (pitch down + flick, ssg08)

| `PEEK_TICKS` | onPeek vs off | onPeek vs inAir |
| --- | --- | --- |
| 8 (shipped) | 66.3% | 65.9% |
| 4 | 51.0% | 53.6% |
| 2 | 50.7% | 51.8% |
| 1 | 51.2% | 50.9% |

**Applied: `PEEK_TICKS` 8 → 4.** This nerfs the mode with a timing (the spec: "nerf or remove that
mode") and keeps every pitch mode available. With a 4-command window, the 4-tick flick fills the
whole window.

On the full grid, the defensive axis is now flat: 49.5-50.8% in every pairing at every charge
size tried. The random-pitch interval (4) and the flick length (4) and angle (120°) were left
alone, because neither in-air nor the flick moves results.

### 4. Charge size (quick grid, peek window 4, 60 rounds per cell)

| `--charge` | ssg08 max field | scar20 max field | dt vs none (ssg / scar) | hs vs none (ssg / scar) |
| --- | --- | --- | --- | --- |
| 8 | 55.2% | 55.5% | 48.7 / 48.3 | 56.9 / 50.0 |
| 12 | 55.8% | 56.1% | 52.8 / 51.3 | 54.3 / 49.3 |
| 16 | 58.6% | 57.7% | 56.5 / 56.3 | 57.6 / 55.6 |
| 24 | 57.4% | 57.9% | 58.9 / 59.3 | 62.8 / 58.7 |
| 32 (shipped) | 57.4% | 59.5% | 61.1 / 63.8 | 64.3 / 63.0 |
| 48 | 60.0% | 59.9% | 60.6 / 66.7 | 60.6 / 60.9 |
| 64 | 57.4% | 60.3% | 58.5 / 58.5 | 59.0 / 59.1 |

The burst's edge comes from the teleport carrying the shooter back to cover. A smaller charge
shrinks that edge. **Below 16, double tap disappears.** DT bullet 2's fire interval is the burst's
tick count. The SCAR-20 needs 16 ticks, the Desert Eagle 15, the R8 32 and the SSG 08 80, so a
charge under 15 gives no arsenal weapon a second bullet.

### 5. Full-grid runs of the candidates (peek window 4, 100 rounds per cell, about 18 min each)

| chargeTicks | Max field rate | Dominant (3 pairings) | Uncountered | Note |
| --- | --- | --- | --- | --- |
| 32 (shipped, 200 rounds) | 59.5% | 29 | 12 | |
| 16 | 57.8% | 25 | 2 | the smallest charge that keeps the SCAR-20's double tap |
| 12 | 56.5% | 8 | 0 | no arsenal weapon double taps |

At 12 the exploit axis is nearly flat: dt and hs within about 5 points of none on the ssg08, and
within 1 point on the scar20. The rule still fails, on 8 configs at 55.1-56.5%. What remains is
the AA preset axis.

`chargeTicks` was **not changed**, for three reasons:
1. No value meets the rule.
2. 32 ticks (a 0.5 s stop) is the owner's Part A decision.
3. The only values that come close remove DT's second bullet altogether.

16 is recorded as the best candidate that keeps DT intact.

## Why the rule cannot be met with the allowed knobs

1. **The AA preset axis is about 10 points wide, and no allowed knob reaches it.**
   - The jitter preset (backward, jitter 45) has a field rate of 43-44% in every run. The static
     and stance presets are at 53%.
   - The weak jitter configs raise every other config's field rate. So even a flat exploit axis
     (charge 12) leaves static and stance configs near 55%, and noise pushes some over.
   - **This is not the resolver.** In the oracle control (`--oracle`: the aimbot knows the real
     side), the jitter preset is still at 44%. It is the pose geometry: a ±45° eye swing with
     desync 58 exposes the head more.
   - Neither `chargeTicks` nor the defensive timings touch jitter or desync.
2. **The burst is worth 7-14 points over plain fire at every charge that keeps double tap**
   (16 or more). Shrinking the charge to cut that edge removes double tap altogether.
3. **The counter half is mostly noise-satisfied.** At 200 rounds per cell (SE about 3.5%), 11-17
   configs per pairing are 'inconclusive'. The matrix is close to transitive, with 8-29 3-cycles
   out of 7,140 triples. The strongest DT configs have no real counter: their best opponents win
   51-56%.

## Controls and the secondary model (quick grid, 60 rounds per cell)

- **Oracle resolver** (`--oracle`): not ok, max 76.4%.
  - fakelag14 becomes dominant, beating the other exploits 72-82%. With resolver misses gone, the
    choked, stale records are what decides the duel, so the resolver is what holds fakelag in check.
  - The jitter preset stays at 44% (see above).
- **Spawn model** (R42 secondary: no freeze charge): not ok, max 62.1%. The burst exploits are
  stronger here (dt vs none 67-71%). DT and HS still charge behind cover before their first peek,
  and plain fire gains nothing from the earlier start.

## Possible rulings (for the controller, not applied)

- **Charge size.** Take `chargeTicks` 16 as a partial improvement: max field rate 57.8%, DT keeps
  its second bullet on the SCAR-20. Or take 12, which comes closest but removes double tap.
- **R8 double tap (proposed ruling, to apply together with any charge change).** The R8 can double
  tap today only because `fireIntervalTicks(r8)` (32) equals `chargeTicks` (32). DT bullet 2 gets
  `ticksSinceLastShot` equal to the burst's 32 ticks, which just passes the fire-interval check.
  Both candidates above (16 and 12) would silently remove the R8's double tap, and 12 would also
  remove the SCAR-20's. A charge change should therefore rule on R8 double tap explicitly, and add
  a test that pins the intended rule. The proposal: accept that the R8 does not double tap (it is a
  hammer revolver), and pin "DT bullet 2 needs `fireIntervalTicks(weapon) <= chargeTicks`" per
  arsenal weapon. Not needed at the shipped 32, where nothing changes.
- **The jitter-preset weakness.** Exclude that preset from the grid as a dominated config, or
  change the jitter and desync pose geometry.
- **The counter half.** Accept it as unattainable for a near-transitive design, and keep only the
  dominance half.
- **The base AA pitch.** Look at the legacy `antiAim.pitch: 'down'` (hvhPitch, -1.15 rad). It
  applies on every tick, not only in a defensive window, and probably hides the head the same way.
  It was outside this grid (every config uses 'look'), and it was not measured.
