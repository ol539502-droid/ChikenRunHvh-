/*
 * HvH v2 balance sweep (round redesign Task 10: charge and burst, defensive AA, the CS:GO arsenal).
 *
 *   npm run sweep          full grid: AA preset {static, jitter, stance} x exploit {none, dt, hs,
 *                          fakelag14} x defensive {off, inAir, onPeek} = 36 configs, 630 pairs, per
 *                          weapon pairing {ssg08, scar20, mixed}
 *   npm run sweep:quick    the 12-config QUICK_GRID with --check (CI: exit code 1 unless ok)
 *
 *   flags: --quick  --rounds N  --seed N  --charge N  --pairing ssg08|scar20|mixed  --json PATH
 *          --model charged|spawn  --oracle  --check  --workers N
 *   (--charge overrides LATE_CSGO.chargeTicks for this run only, so tuning can be explored without
 *   editing era.ts. --pairing runs one pairing instead of all three. --oracle is a control: the
 *   aimbot knows the real desync side. --check sets exit code 1 unless every pairing is ok.
 *   --workers runs the rooms on N threads, half the machine by default; the results are the same
 *   for any N.)
 *
 * Balance rule (plan, binding): no config wins more than 55% against the field, and every config
 * has a counter that beats it by at least 55%. R40: a config's field win rate is its mean win
 * rate over every other config (mirror matches excluded); dominant if that is > 0.55; it has a
 * counter if some other config beats it head-to-head with a rate >= 0.55. The rule is checked per
 * weapon pairing, and the sweep is ok only when all of them are.
 *
 * One round (the match design):
 * - A 1v1 in a real HvhRoom (hvhEngine 'v2', map 'mirage', `hvhRounds: false`, so the harness drives
 *   the rounds) built with the Task 13 harness (server/test/hvh-v2/hvhMatch.ts makeMatch, prng,
 *   clock), driven through the room's real command path (handleInput -> queue -> processPlayerTick).
 * - The spawn pair: Mirage B site, nav areas 13 (BombsiteB, x -58.44 z -9.06) and 747 (x -50.31
 *   z -11.56), 8.5 m apart with the sandstone pillar (map box 6603) between them. Both players move
 *   on parallel lines along PEEK_DIR (perpendicular to the line between the two areas): at offset
 *   HIDE_AT (-0.6 m) neither can see the other whatever the other does (up to PEEK_TO, 4.5 m), and
 *   they see each other once their offsets add up to about 4.5 m, so both have to peek to fight and
 *   cover always blocks the hider. Sides swap every round. Spawn protection is removed.
 * - Loadout: the pairing's main (ssg08 vs ssg08, scar20 vs scar20, or mixed: one of each, the
 *   assignment alternating every two rounds), scoped, armor and helmet (every v2 spawn). Pistols
 *   are not played: they only matter after a main is empty, and no round gets there.
 * - AA from the config (antiAimFor): the preset's StanceAA on each stance with desync 58 (the era
 *   maximum), plus the config's DefensiveAA on every stance. The inverter is a seeded coin per round.
 * - Exploits (the config's `exploit`): none = plain fire; dt / hs = double tap / hide shots on every
 *   command, so the server charges (the stop) whenever no enemy is in real line of sight, and a
 *   shot with a full charge bursts; fakelag14 = every non-firing command is choked (held and sent in
 *   one batch, the client's CommandChoker) up to 14, a shot sends at once.
 * - Freeze ('charged' model, R42's primary): each round starts with era.chargeTicks ticks behind
 *   cover, sending ordinary commands through the real command path (no movement, no fire; DT / HS
 *   on, fakelag choking), so every DT / HS player goes live with a full charge, as after a real
 *   freeze time. 'spawn' (secondary) goes live at once, uncharged.
 * - The same script for both, with seeded timings (rand per bot):
 *   hide   at HIDE_AT for a seeded wait (DT / HS also until the charge is full, which the server
 *          fills there: no enemy in sight), then peek; a quarter of the peeks start with a jump.
 *   peek   move out along PEEK_DIR up to PEEK_TO; hold there for a seeded time, then retreat.
 *   fight  as soon as the enemy is in line of sight (from any state but a committed retreat):
 *          counter-strafe to a stop and fire whenever the weapon is ready (R41: server ticks since the
 *          own last shot) and the shot's speed after its movement step is at most ACCURATE_SPEED on
 *          the ground. A DT / HS shot with a full charge is a burst: its command moves back toward
 *          cover (the teleport goes there), and the bot commits to a retreat. So does a plain shot
 *          whose weapon cannot fire again within FOLLOW_UP_TICKS (the SSG 08). Otherwise it keeps
 *          fighting for a seeded time, or until the enemy has been out of sight for LOST_TICKS.
 *   retreat move back to HIDE_AT, then hide again (where DT / HS recharge mid-round).
 * - Aimbot: it sees only what a client sees: the opponent's newest lag record position, duck, eye
 *   yaw and pitch (the snapshot), the observation feed (speed), whether that record is an on-shot
 *   record (shots are public), and its own resolver (peekResolve on the shooter's server-side
 *   memory, which learns from its own verdicts). It aims at the head of the pose that resolver
 *   guesses, with max desync for the observed speed (0 on an on-shot record), plus seeded aim noise,
 *   and tags the command with clientTick = that record's tick. It never reads bodyYaw or realSide.
 *   Its line of sight is the same enemyVisible test, on that record. Headless, no snapshot is sent,
 *   so the server's charge sight takes its start-of-tick fallback (R56).
 * - A round ends when a player dies (the survivor wins) or after ROUND_TICKS live (a draw, 0.5
 *   each). A cell (config pair) plays roundsPerCell rounds in two rooms: half with config A joined
 *   first, half with B first (the room simulates players in join order). Lives within a room keep
 *   the resolver memory (the room keeps it across respawns), as in a real match.
 *
 * Determinism: every random choice comes from mulberry32 seeded from (seed, pairing, pair, order);
 * the room is seeded and driven on the harness clock. Same seed -> same WinMatrix.
 */
import { pathToFileURL } from 'node:url';
import { writeFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import {
  SIM_DT, WEAPONS, buildHvhMatrix, eyeHeightOf, hopMaxFor, moveSpeedFor, stepPlayer,
  type HvhStanceAntiAim, type InputFrame, type MoveState, type Vec3, type WeaponId,
} from '@game/shared';
import {
  LATE_CSGO, V2_STANCES, enemyVisible, fireIntervalTicks, lagCompWindowTicks, maxDesync, peekResolve, validateEra,
  type CommandIntent, type DefensiveAA, type EraTable, type LagRecord, type ShotVerdict, type StanceAA, type V2Stance, type VerdictCause,
} from '@game/shared/hvh/v2';
import type { HvhRoom } from '../server/src/rooms/HvhRoom';
import type { ServerPlayer } from '../server/src/rooms/ServerPlayer';
import { stepRoom } from '../server/test/helpers';
import { CLOCK_BASE, TICK_MS, makeMatch, prng } from '../server/test/hvh-v2/hvhMatch';

export type AAPreset = 'static' | 'jitter' | 'stance';
export type Exploit = 'none' | 'dt' | 'hs' | 'fakelag14';
export type Defensive = 'off' | 'inAir' | 'onPeek';
export interface SweepConfig { aa: AAPreset; exploit: Exploit; defensive: Defensive }
/** The list of configs to sweep (every unordered pair of distinct configs is a cell). */
export type SweepGrid = readonly SweepConfig[];
export type Pairing = 'ssg08' | 'scar20' | 'mixed';

/**
 * rate[i][j]: config i's win rate against config j (draws count half); rate[j][i] = 1 - rate[i][j].
 * The diagonal (mirror matches) is not played and holds NaN. rounds[i][j]: rounds played.
 */
export interface WinMatrix { configs: string[]; rate: number[][]; rounds: number[][] }

export const PRESETS: readonly AAPreset[] = ['static', 'jitter', 'stance'];
export const EXPLOITS: readonly Exploit[] = ['none', 'dt', 'hs', 'fakelag14'];
export const DEFENSIVES: readonly Defensive[] = ['off', 'inAir', 'onPeek'];
export const PAIRINGS: readonly Pairing[] = ['ssg08', 'scar20', 'mixed'];

export const FULL_GRID: SweepGrid = PRESETS.flatMap((aa) => EXPLOITS.flatMap((exploit) => DEFENSIVES.map((defensive) => ({ aa, exploit, defensive }))));

/** The 12-config CI subset: every exploit with every defensive mode, the preset rotating (every preset occurs). */
export const QUICK_GRID: SweepGrid = EXPLOITS.flatMap((exploit, e) => DEFENSIVES.map((defensive, d) => ({ aa: PRESETS[(e + d) % PRESETS.length]!, exploit, defensive })));

export const configName = (c: SweepConfig): string => `${c.aa}/${c.exploit}/${c.defensive}`;

const DESYNC_DEG = 58;
/** Each preset per stance (desync 58 everywhere). 'stance': jitter standing, static moving, spin in the air. */
const PRESET_STANCES: Record<AAPreset, Partial<Record<V2Stance, Omit<StanceAA, 'desyncDeg'>>> & { all: Omit<StanceAA, 'desyncDeg'> }> = {
  static: { all: { base: 'backward', yawOffsetDeg: 0, jitterDeg: 0 } },
  jitter: { all: { base: 'backward', yawOffsetDeg: 0, jitterDeg: 45 } },
  stance: {
    all: { base: 'backward', yawOffsetDeg: 0, jitterDeg: 0 },
    standing: { base: 'backward', yawOffsetDeg: 0, jitterDeg: 30 },
    airborne: { base: 'spin', yawOffsetDeg: 0, jitterDeg: 0 },
  },
};
const DEFENSIVE_MODES: Record<Defensive, DefensiveAA> = {
  off: { enabled: false, inAir: false, onPeek: false, always: false, pitch: 'down', yaw: 'off' },
  inAir: { enabled: true, inAir: true, onPeek: false, always: false, pitch: 'random', yaw: 'off' },
  onPeek: { enabled: true, inAir: false, onPeek: true, always: false, pitch: 'down', yaw: 'flick' },
};

/** The config's per-stance AA (loadout.v2AntiAim): the preset's stances, its defensive mode on every stance. */
export function antiAimFor(c: SweepConfig): HvhStanceAntiAim {
  const preset = PRESET_STANCES[c.aa];
  const out = { stances: {}, defensive: {} } as HvhStanceAntiAim;
  for (const s of V2_STANCES) {
    out.stances[s] = { ...(preset[s] ?? preset.all), desyncDeg: DESYNC_DEG };
    out.defensive[s] = { ...DEFENSIVE_MODES[c.defensive] };
  }
  return out;
}

/** Thresholds of the balance rule. EPS absorbs float noise in rates such as (0.45 + 0.65) / 2. */
export const DOMINANT_ABOVE = 0.55;
export const COUNTER_AT_LEAST = 0.55;
const EPS = 1e-9;

export function fieldRate(m: WinMatrix, i: number): number {
  let sum = 0;
  let n = 0;
  for (let j = 0; j < m.configs.length; j++) {
    if (j === i) continue;
    sum += m.rate[i]![j]!;
    n++;
  }
  return n === 0 ? 0.5 : sum / n;
}

/** The best head-to-head rate any other config gets against config i. */
export function bestCounter(m: WinMatrix, i: number): { j: number; rate: number } {
  let best = { j: -1, rate: -Infinity };
  for (let j = 0; j < m.configs.length; j++) {
    if (j !== i && m.rate[j]![i]! > best.rate) best = { j, rate: m.rate[j]![i]! };
  }
  return best;
}

export function checkBalance(m: WinMatrix): { ok: boolean; dominant: string[]; uncountered: string[] } {
  const dominant: string[] = [];
  const uncountered: string[] = [];
  m.configs.forEach((name, i) => {
    if (fieldRate(m, i) > DOMINANT_ABOVE + EPS) dominant.push(name);
    if (!(bestCounter(m, i).rate >= COUNTER_AT_LEAST - EPS)) uncountered.push(name);
  });
  return { ok: dominant.length === 0 && uncountered.length === 0, dominant, uncountered };
}

/** Standard error of rate[i][j] (binomial, draws counted as half a win). */
export function cellSE(m: WinMatrix, i: number, j: number): number {
  const r = m.rate[i]![j]!;
  const n = m.rounds[i]![j]!;
  return n > 0 ? Math.sqrt((r * (1 - r)) / n) : Number.NaN;
}

/** Standard error of config i's field rate (independent cells). */
export function fieldSE(m: WinMatrix, i: number): number {
  let sq = 0;
  let n = 0;
  for (let j = 0; j < m.configs.length; j++) {
    if (j === i) continue;
    sq += cellSE(m, i, j) ** 2;
    n++;
  }
  return n === 0 ? 0 : Math.sqrt(sq) / n;
}

/**
 * For the report (checkBalance keeps the strict rule): a config is countered when its best
 * counter is >= 0.55 + 1 SE, uncountered when it is < 0.55 - 1 SE, otherwise inconclusive.
 */
export function classifyCounters(m: WinMatrix): { countered: string[]; uncountered: string[]; inconclusive: string[] } {
  const out = { countered: [] as string[], uncountered: [] as string[], inconclusive: [] as string[] };
  m.configs.forEach((name, i) => {
    const best = bestCounter(m, i);
    const se = cellSE(m, best.j, i);
    if (best.rate >= COUNTER_AT_LEAST + se) out.countered.push(name);
    else if (best.rate < COUNTER_AT_LEAST - se) out.uncountered.push(name);
    else out.inconclusive.push(name);
  });
  return out;
}

/** Triples of configs that form a cycle of head-to-head wins, each >= `at` (a rock-paper-scissors). */
export function threeCycles(m: WinMatrix, at = COUNTER_AT_LEAST): number {
  const n = m.configs.length;
  const beats = (a: number, b: number): boolean => m.rate[a]![b]! >= at - EPS;
  let k = 0;
  for (let a = 0; a < n; a++) {
    for (let b = a + 1; b < n; b++) {
      for (let c = b + 1; c < n; c++) {
        if ((beats(a, b) && beats(b, c) && beats(c, a)) || (beats(b, a) && beats(c, b) && beats(a, c))) k++;
      }
    }
  }
  return k;
}

// ---------------------------------------------------------------------------
// Duels
// ---------------------------------------------------------------------------

/** Live ticks before a round is a draw (15 s). */
export const ROUND_TICKS = 960;
/** The spawn pair (nav areas 13 and 747, see the header) and the line both players peek along. */
const SPAWNS = [{ x: -58.4375, y: 6, z: -9.0625 }, { x: -50.3125, y: 6, z: -11.5625 }] as const;
const PEEK_DIR = (() => {
  const dx = SPAWNS[1].x - SPAWNS[0].x;
  const dz = SPAWNS[1].z - SPAWNS[0].z;
  const d = Math.hypot(dx, dz);
  return { x: -dz / d, z: dx / d };
})();
/** Offsets along PEEK_DIR, metres: fully behind the pillar, and the widest peek. */
const HIDE_AT = -0.6;
const PEEK_TO = 4.5;
/** A shot fires only at or below this speed after its movement step (counter-strafe, then shoot). */
const ACCURATE_SPEED = 0.5;
/** Aim noise, radians (uniform, per axis): the same aim skill for everyone. */
const AIM_NOISE = 0.01;
/** Fighting ends (retreat) once the enemy has been out of sight this long. */
const LOST_TICKS = 16;
/** A weapon that fires again within this many ticks keeps fighting after a plain shot (scar20); a slower one retreats (ssg08). */
const FOLLOW_UP_TICKS = 32;
const IDLE: CommandIntent = Object.freeze({ fire: false, choke: false, doubleTap: false, hideShots: false });

/** Per-shooter-config verdict counts, round outcomes and charge events (for the report). */
export interface SweepStats {
  /** By shooter config, and by target config under '>' + its name. */
  causes: Map<string, Map<VerdictCause | string, number>>;
  rounds: number;
  draws: number;
  roundTicks: number;
  /** DT / HS lives, and how many of them went live with a full charge. */
  exploitLives: number;
  chargedAtLive: number;
  /** Charges spent by a burst, and charges completed mid-round (live). */
  bursts: number;
  recharges: number;
}

export function createStats(): SweepStats {
  return { causes: new Map(), rounds: 0, draws: 0, roundTicks: 0, exploitLives: 0, chargedAtLive: 0, bursts: 0, recharges: 0 };
}

export type SweepModel = 'charged' | 'spawn';

export interface SweepOptions {
  /** Overrides the room's era (tunable exploration). Defaults to LATE_CSGO. */
  era?: EraTable;
  /** The weapon pairing (default ssg08). */
  pairing?: Pairing;
  stats?: SweepStats;
  /** 'charged' (default, R42 primary model: a freeze charge) or 'spawn' (live at once, uncharged). */
  model?: SweepModel;
  /** Control only: the aimbot knows the target's real pose (never used for balance results). */
  oracle?: boolean;
  onCell?: (done: number, total: number) => void;
}

function mix(...xs: number[]): number {
  let h = 0x811c9dc5;
  for (const x of xs) {
    h = Math.imul(h ^ (x >>> 0), 0x01000193) >>> 0;
    h = Math.imul(h ^ (h >>> 15), 0x85ebca6b) >>> 0;
  }
  return h >>> 0;
}

type BotState = 'hide' | 'peek' | 'fight' | 'retreat';

interface Bot {
  config: SweepConfig;
  p: ServerPlayer;
  rand: () => number;
  seq: number;
  held: object[];
  /** The predicted state after the held commands (null when nothing is held). */
  heldState: MoveState | null;
  /** The AA inverter, a seeded coin per round. */
  invert: boolean;
  /** This round's spawn (SPAWNS index). */
  side: 0 | 1;
  state: BotState;
  /** Ticks left of the current hide wait, peek hold or fight. */
  timer: number;
  /** Ticks since the enemy was last in sight. */
  unseen: number;
  /** This peek starts with a jump (pressed on its first command). */
  jump: boolean;
  /** Charge after the last tick, for the stats. */
  charge: number;
}

/** Ticks at which each player's newest record is an on-shot record (a shot was fired that tick). */
type ShotTicks = Map<number, Set<number>>;

const exploitOf = (c: SweepConfig): boolean => c.exploit === 'dt' || c.exploit === 'hs';

/** The offset along PEEK_DIR from the bot's spawn. */
function offsetOf(bot: Bot, s: MoveState): number {
  const o = SPAWNS[bot.side];
  return (s.x - o.x) * PEEK_DIR.x + (s.z - o.z) * PEEK_DIR.z;
}

/** forward / right that move along `dir` (a PEEK_DIR multiple) with the view at `yaw` (stepPlayer's wish vectors). */
function moveAlong(dir: number, yaw: number): { forward: number; right: number } {
  const sin = Math.sin(yaw);
  const cos = Math.cos(yaw);
  const x = PEEK_DIR.x * dir;
  const z = PEEK_DIR.z * dir;
  return { forward: -sin * x - cos * z, right: cos * x - sin * z };
}

/** One movement step of `frame` on `state` (in place), as the room runs it. */
function stepAs(room: HvhRoom, p: ServerPlayer, state: MoveState, frame: InputFrame): MoveState {
  stepPlayer(state, frame, SIM_DT, room.world, p.moveMods(), hopMaxFor(p.weapon), moveSpeedFor(p.weapon), true);
  return state;
}

/** The bot's own state before its next command runs: the room's, or its prediction through the commands it still holds (choke). */
const currentOf = (bot: Bot): MoveState => bot.heldState ?? bot.p.state;

const eyeOf = (s: MoveState): Vec3 => ({ x: s.x, y: s.y + eyeHeightOf(s), z: s.z });

/** The enemy's newest record (the snapshot), if it is inside the unlag window. */
function snapshotOf(room: HvhRoom, enemy: ServerPlayer, era: EraTable, tick: number): LagRecord | null {
  const record = room.v2State(enemy.pid)!.history.records().at(-1);
  // A client knows how old its newest snapshot of the enemy is; it holds fire past the unlag window.
  return record && enemy.alive && tick - record.tick <= lagCompWindowTicks(era) ? record : null;
}

function aimAt(room: HvhRoom, bot: Bot, eye: Vec3, enemy: ServerPlayer, record: LagRecord, shotTicks: ShotTicks, era: EraTable, oracle: boolean):
  { yaw: number; pitch: number; clientTick: number } {
  const t = room.v2State(enemy.pid)!;
  const obs = t.observations.find((o) => o.tick === record.tick);
  const onShot = shotTicks.get(enemy.pid)?.has(record.tick) ?? false;
  const side = peekResolve(room.v2State(bot.p.pid)!.resolver, String(enemy.pid), t.observations, record.tick).side;
  const magnitude = onShot ? 0 : Math.min(DESYNC_DEG, maxDesync(obs?.speedFraction ?? 0, era));
  const sign = side === 'left' ? 1 : side === 'right' ? -1 : 0;
  // The oracle control reads the real body (a cheat that always resolves correctly).
  const bodyYaw = oracle ? record.pose.bodyYaw : record.pose.eyeYaw + (magnitude * sign * Math.PI) / 180;
  const duck = record.duck ?? 0;
  const head: Vec3 = buildHvhMatrix(record.position, bodyYaw, 1 - duck * 0.3, record.pose.pitch).boxes[0]!.center;
  const dx = head.x - eye.x;
  const dy = head.y - eye.y;
  const dz = head.z - eye.z;
  const yaw = Math.atan2(-dx, -dz) + (bot.rand() * 2 - 1) * AIM_NOISE;
  const pitch = Math.asin(dy / Math.hypot(dx, dy, dz)) + (bot.rand() * 2 - 1) * AIM_NOISE;
  return { yaw, pitch, clientTick: record.tick };
}

/** One command. `live` false: the freeze (no movement, no fire; the exploits stay on, so DT / HS charge and fakelag chokes). */
function botCommand(room: HvhRoom, bot: Bot, enemy: ServerPlayer, shotTicks: ShotTicks, era: EraTable, tick: number, now: number,
  live: boolean, oracle: boolean): void {
  const { p, config, rand } = bot;
  const s = room.v2State(p.pid)!;
  const exploit = exploitOf(config);
  const full = s.tickbase.charge >= era.chargeTicks;
  const towards = Math.atan2(-(enemy.state.x - p.state.x), -(enemy.state.z - p.state.z));
  const record = live ? snapshotOf(room, enemy, era, tick) : null;
  const cur = currentOf(bot);
  // Line of sight as the client predicts it: the same test, from the own eye to the snapshot.
  const seen = record !== null && enemyVisible(eyeOf(cur),
    [{ x: record.position.x, y: record.position.y, z: record.position.z, crouch: record.duck ?? 0, yaw: record.pose.eyeYaw }], room.world);
  bot.unseen = seen ? 0 : bot.unseen + 1;

  const offset = offsetOf(bot, cur);
  const along = (cur.walkVx ?? 0) * PEEK_DIR.x + (cur.walkVz ?? 0) * PEEK_DIR.z;
  let dir = 0;
  let jump = false;
  if (live) {
    if (seen && bot.state !== 'retreat' && bot.state !== 'fight') {
      bot.state = 'fight';
      bot.timer = 48 + Math.floor(rand() * 96);
    }
    switch (bot.state) {
      case 'hide':
        if (offset > HIDE_AT + 0.05) dir = -1;
        if (--bot.timer <= 0 && (!exploit || full)) {
          bot.state = 'peek';
          bot.timer = 32 + Math.floor(rand() * 64);
          bot.jump = rand() < 0.25;
        }
        break;
      case 'peek':
        if (offset < PEEK_TO) {
          dir = 1;
          jump = bot.jump;
          bot.jump = false;
        } else if (--bot.timer <= 0) {
          bot.state = 'retreat';
        }
        break;
      case 'fight':
        // Counter-strafe to a stop.
        if (Math.abs(along) > 0.3) dir = along > 0 ? -1 : 1;
        if (--bot.timer <= 0 || bot.unseen > LOST_TICKS) bot.state = 'retreat';
        break;
      case 'retreat':
        dir = -1;
        if (offset <= HIDE_AT + 0.05) {
          bot.state = 'hide';
          bot.timer = 8 + Math.floor(rand() * 40);
          dir = 0;
        }
        break;
    }
  }

  if (p.mag <= 0) room.handleReload(p, now);
  // Readiness (R41): server ticks since the bot's own last shot, at the tick this command runs.
  const ready = p.reloadUntil === 0 && p.mag > 0 && tick - s.lastShotTick >= fireIntervalTicks(WEAPONS[p.weapon]);
  // A burst carries the command's movement: it goes back toward cover.
  const burst = exploit && full;
  let aim: { yaw: number; pitch: number; clientTick: number } | null = null;
  let fire = false;
  if (live && seen && bot.state === 'fight' && ready && !(exploit && s.tickbase.charge > 0 && !full)) {
    const shotDir = burst ? -1 : dir;
    const look = moveAlong(shotDir, towards);
    const after = stepAs(room, p, structuredClone(cur), { seq: 0, ...look, jump: false, yaw: towards, pitch: 0 });
    if (after.onGround && after.horizontalSpeed <= ACCURATE_SPEED) {
      aim = aimAt(room, bot, eyeOf(after), enemy, record!, shotTicks, era, oracle);
      fire = true;
      dir = shotDir;
      // Back to cover after a burst, or when the next shot is too far off to wait for in the open.
      if (burst || fireIntervalTicks(WEAPONS[p.weapon]) > FOLLOW_UP_TICKS) bot.state = 'retreat';
    }
  }
  const intent: CommandIntent = { ...IDLE, fire };
  if (config.exploit === 'dt') intent.doubleTap = true;
  if (config.exploit === 'hs') intent.hideShots = true;
  if (config.exploit === 'fakelag14' && !fire && bot.held.length < era.maxChoke) intent.choke = true;
  const yaw = aim?.yaw ?? towards;
  const frame: InputFrame & { intent: CommandIntent; clientTick?: number } = {
    seq: ++bot.seq, ...moveAlong(dir, yaw), jump, crouch: false, yaw, pitch: aim?.pitch ?? 0, invert: bot.invert, intent,
  };
  if (aim) frame.clientTick = aim.clientTick;
  bot.held.push(frame);
  if (intent.choke) {
    bot.heldState = stepAs(room, p, bot.heldState ?? structuredClone(p.state), frame);
    return;
  }
  bot.heldState = null;
  for (const command of bot.held.splice(0)) room.handleInput(p, command);
}

function count(stats: SweepStats | undefined, config: string, cause: string, k = 1): void {
  if (!stats) return;
  let m = stats.causes.get(config);
  if (!m) stats.causes.set(config, (m = new Map()));
  m.set(cause, (m.get(cause) ?? 0) + k);
}

/** The main gun of bot i (0 = joined first) in round r. Mixed: one of each, swapped every two rounds. */
function mainFor(pairing: Pairing, i: number, r: number): WeaponId {
  if (pairing !== 'mixed') return pairing;
  return (i + Math.floor(r / 2)) % 2 === 0 ? 'ssg08' : 'scar20';
}

/** Plays `rounds` duels between configs a (joined first) and b; returns a's score (wins + draws / 2). */
function playRoom(a: SweepConfig, b: SweepConfig, rounds: number, seed: number, era: EraTable, opts: SweepOptions): number {
  const stats = opts.stats;
  const oracle = opts.oracle === true;
  const pairing = opts.pairing ?? 'ssg08';
  const { room, players } = makeMatch(seed, { map: 'mirage', teams: [1, 2] });
  try {
    if (era !== room.era) Object.defineProperty(room, 'era', { value: era });
    const rand = prng(seed);
    const bots: Bot[] = [a, b].map((config, i) => ({
      config, p: players[i]!, rand: prng(mix(seed, i + 1)), seq: 0, held: [], heldState: null, invert: false, side: 0, state: 'hide', timer: 0, unseen: 0, jump: false, charge: 0,
    }));
    const names = [configName(a), configName(b)];
    const shotTicks: ShotTicks = new Map(players.map((p) => [p.pid, new Set<number>()]));
    room.addVerdictListener((v: ShotVerdict) => {
      const i = bots.findIndex((x) => String(x.p.pid) === v.shooterId);
      if (i < 0) return;
      count(stats, names[i]!, v.cause === 'rejected' || v.cause === 'tickbase' ? `${v.cause}:${v.reason}` : v.cause);
      if (v.cause !== 'rejected') shotTicks.get(bots[i]!.p.pid)!.add(v.tick);
      // The same verdict seen from its target ('>' + the target's config), for the defensive table.
      if (v.cause !== 'rejected' && v.cause !== 'tickbase' && v.targetId !== undefined) count(stats, `>${names[1 - i]!}`, v.cause === 'hit' ? `hit:${v.hitgroup}` : v.cause);
    });
    const match = (room as unknown as { match: { teamScores: number[]; endsAt: number | null } }).match;
    let tick = 0;
    let score = 0;
    /** One server tick: both commands, then the room; `live` counts charge events. */
    const step = (live: boolean): void => {
      tick++;
      const now = CLOCK_BASE + tick * TICK_MS;
      bots.forEach((bot, i) => {
        if (bot.p.alive) botCommand(room, bot, bots[1 - i]!.p, shotTicks, era, room.hvhTick + 1, now, live, oracle);
      });
      stepRoom(room, now);
      for (const bot of bots) {
        const charge = room.tickbaseOf(bot.p.pid)!.charge;
        if (stats && live && bot.p.alive) {
          if (bot.charge >= era.chargeTicks && charge === 0) stats.bursts++;
          if (bot.charge < era.chargeTicks && charge >= era.chargeTicks) stats.recharges++;
        }
        bot.charge = charge;
      }
    };
    for (let r = 0; r < rounds; r++) {
      const now0 = CLOCK_BASE + tick * TICK_MS;
      match.teamScores = [0, 0];
      match.endsAt = null;
      bots.forEach((bot, i) => {
        const p = bot.p;
        p.info.loadout = [mainFor(pairing, i, r), 'deserteagle'];
        p.hvh.antiAim = { ...p.hvh.antiAim, enabled: true, mode: 'backward', jitter: 0, desync: DESYNC_DEG };
        p.hvh.v2AntiAim = antiAimFor(bot.config);
        bot.invert = rand() < 0.5;
        room.respawnPlayer(p, now0);
        p.weaponSlot = 0;
        bot.side = ((i + r) % 2) as 0 | 1;
        const spawn = SPAWNS[bot.side];
        p.state.x = spawn.x + PEEK_DIR.x * HIDE_AT;
        p.state.z = spawn.z + PEEK_DIR.z * HIDE_AT;
        p.state.y = spawn.y;
        p.state.vx = p.state.vy = p.state.vz = 0;
        p.state.walkVx = p.state.walkVz = 0;
        p.state.onGround = true;
        p.shieldUntil = 0;
        room.handleAim(p, true);
        bot.held.length = 0;
        bot.heldState = null;
        bot.state = 'hide';
        bot.timer = Math.floor(bot.rand() * 32);
        bot.unseen = 0;
        bot.jump = false;
        bot.charge = 0;
      });
      // R42 'charged': the freeze, behind cover, through ordinary commands (no state writes).
      const freeze = (opts.model ?? 'charged') === 'charged' ? era.chargeTicks : 0;
      for (let h = 0; h < freeze; h++) step(false);
      if (stats) {
        for (const bot of bots) {
          if (!exploitOf(bot.config)) continue;
          stats.exploitLives++;
          if (bot.charge >= era.chargeTicks) stats.chargedAtLive++;
        }
      }
      let t = 0;
      for (; t < ROUND_TICKS; t++) {
        step(true);
        if (!bots[0]!.p.alive || !bots[1]!.p.alive) break;
      }
      const aAlive = bots[0]!.p.alive;
      const bAlive = bots[1]!.p.alive;
      const result = aAlive && !bAlive ? 1 : bAlive && !aAlive ? 0 : 0.5;
      score += result;
      if (stats) {
        stats.rounds++;
        stats.roundTicks += Math.min(t + 1, ROUND_TICKS);
        if (result === 0.5) stats.draws++;
      }
    }
    return score;
  } finally {
    room.close();
  }
}

/** One room of a cell: configs i and j, `order` 0 with i joined first (ceil(rounds / 2) rounds), 1 with j first (the rest). */
interface RoomJob { i: number; j: number; order: 0 | 1; rounds: number; seed: number }

function roomJobs(n: number, roundsPerCell: number, seed: number, pairing: Pairing): RoomJob[] {
  const p = PAIRINGS.indexOf(pairing);
  const jobs: RoomJob[] = [];
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const first = Math.ceil(roundsPerCell / 2);
      jobs.push({ i, j, order: 0, rounds: first, seed: mix(seed, p, i, j, 0) });
      if (roundsPerCell > first) jobs.push({ i, j, order: 1, rounds: roundsPerCell - first, seed: mix(seed, p, i, j, 1) });
    }
  }
  return jobs;
}

/** Config i's score (wins + draws / 2) in one room. */
function playJob(grid: SweepGrid, job: RoomJob, era: EraTable, opts: SweepOptions): number {
  const [a, b] = job.order === 0 ? [grid[job.i]!, grid[job.j]!] : [grid[job.j]!, grid[job.i]!];
  const score = playRoom(a, b, job.rounds, job.seed, era, opts);
  return job.order === 0 ? score : job.rounds - score;
}

function eraOf(opts: SweepOptions): EraTable {
  const era = opts.era ?? LATE_CSGO;
  const errors = validateEra(era);
  if (errors.length > 0) throw new Error(`invalid era: ${errors.join(', ')}`);
  return era;
}

/** The matrix from every room's score for config i (scores in roomJobs order). */
function matrixOf(grid: SweepGrid, roundsPerCell: number, jobs: readonly RoomJob[], scores: readonly number[]): WinMatrix {
  const configs = grid.map(configName);
  const rate = configs.map(() => configs.map(() => Number.NaN));
  const rounds = configs.map(() => configs.map(() => 0));
  const sum = configs.map(() => configs.map(() => 0));
  jobs.forEach((job, k) => { sum[job.i]![job.j]! += scores[k]!; });
  for (const { i, j } of jobs) {
    rate[i]![j] = sum[i]![j]! / roundsPerCell;
    rate[j]![i] = 1 - rate[i]![j]!;
    rounds[i]![j] = rounds[j]![i] = roundsPerCell;
  }
  return { configs, rate, rounds };
}

export function runSweep(grid: SweepGrid, roundsPerCell: number, seed: number, opts: SweepOptions = {}): WinMatrix {
  const era = eraOf(opts);
  const jobs = roomJobs(grid.length, roundsPerCell, seed, opts.pairing ?? 'ssg08');
  const total = (grid.length * (grid.length - 1)) / 2;
  let cells = 0;
  const scores = jobs.map((job, k) => {
    const score = playJob(grid, job, era, opts);
    const last = jobs[k + 1];
    if (!last || last.i !== job.i || last.j !== job.j) opts.onCell?.(++cells, total);
    return score;
  });
  return matrixOf(grid, roundsPerCell, jobs, scores);
}

interface WorkerSetup { hvhSweepWorker: true; grid: SweepGrid; era: EraTable; pairing: Pairing; model: SweepModel; oracle: boolean }
type StatsWire = Omit<SweepStats, 'causes'> & { causes: [string, [string, number][]][] };

function mergeStats(into: SweepStats, from: StatsWire): void {
  for (const key of ['rounds', 'draws', 'roundTicks', 'exploitLives', 'chargedAtLive', 'bursts', 'recharges'] as const) into[key] += from[key];
  for (const [config, causes] of from.causes) for (const [cause, k] of causes) count(into, config, cause, k);
}

/**
 * runSweep on `workers` threads: each room is an independent seeded job, and the scores are put
 * back in roomJobs order, so the matrix is the same as runSweep's for any worker count.
 */
export async function runSweepParallel(grid: SweepGrid, roundsPerCell: number, seed: number, workers: number, opts: SweepOptions = {}): Promise<WinMatrix> {
  const era = eraOf(opts);
  const pairing = opts.pairing ?? 'ssg08';
  const jobs = roomJobs(grid.length, roundsPerCell, seed, pairing);
  const scores = new Array<number>(jobs.length);
  const total = (grid.length * (grid.length - 1)) / 2;
  const roomsPerCell = jobs.length / total;
  let next = 0;
  let finished = 0;
  const setup: WorkerSetup = { hvhSweepWorker: true, grid, era, pairing, model: opts.model ?? 'charged', oracle: opts.oracle === true };
  const pool: Worker[] = [];
  /** The first failure fails the run at once: no more jobs are handed out and every other worker stops. */
  const fail = (e: Error): Error => {
    next = jobs.length;
    for (const w of pool) void w.terminate();
    return e;
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(workers, jobs.length)) }, () => new Promise<void>((resolve, reject) => {
    const worker = new Worker(new URL(import.meta.url), { workerData: setup });
    pool.push(worker);
    const feed = (): void => {
      if (next < jobs.length) worker.postMessage({ k: next, job: jobs[next++] });
      else worker.postMessage({ done: true });
    };
    worker.on('message', (m: { k: number; score: number } | { stats: StatsWire }) => {
      if ('stats' in m) {
        if (opts.stats) mergeStats(opts.stats, m.stats);
        return;
      }
      scores[m.k] = m.score;
      if (++finished % roomsPerCell === 0) opts.onCell?.(finished / roomsPerCell, total);
      feed();
    });
    worker.on('error', (e: unknown) => reject(fail(e instanceof Error ? e : new Error(String(e)))));
    worker.on('exit', (code) => (code === 0 ? resolve() : reject(fail(new Error(`sweep worker exited ${code}`)))));
    feed();
  })));
  return matrixOf(grid, roundsPerCell, jobs, scores);
}

function workerMain(setup: WorkerSetup): void {
  const stats = createStats();
  const opts: SweepOptions = { era: setup.era, pairing: setup.pairing, model: setup.model, oracle: setup.oracle, stats };
  parentPort!.on('message', (m: { k: number; job: RoomJob } | { done: true }) => {
    if ('done' in m) {
      const wire: StatsWire = { ...stats, causes: [...stats.causes].map(([c, byCause]) => [c, [...byCause]]) };
      parentPort!.postMessage({ stats: wire });
      parentPort!.close();
      return;
    }
    parentPort!.postMessage({ k: m.k, score: playJob(setup.grid, m.job, setup.era, opts) });
  });
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const DEFAULT_ROUNDS = { full: 200, quick: 60 };
const DEFAULT_SEED = 0x14;
/** Half the machine: leaves room for whatever else runs. */
const DEFAULT_WORKERS = Math.max(1, Math.floor(availableParallelism() / 2));

export interface SweepArgs {
  quick: boolean;
  rounds: number;
  seed: number;
  /** Worker threads (rooms are independent; the results do not depend on the count). */
  workers: number;
  /** --charge: chargeTicks for this run (undefined: LATE_CSGO's). */
  charge?: number;
  pairings: Pairing[];
  model: SweepModel;
  oracle: boolean;
  check: boolean;
  json?: string;
}

const VALUE_FLAGS = new Set(['--rounds', '--seed', '--charge', '--pairing', '--model', '--json', '--workers']);
const BOOLEAN_FLAGS = new Set(['--quick', '--oracle', '--check']);
/** Flags of the old tickbase model, whose tunables the charge model removed. */
const REMOVED_FLAGS = new Set(['--hs', '--def', '--recharge']);

export function parseArgs(argv: readonly string[]): SweepArgs {
  const values = new Map<string, string>();
  const on = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (REMOVED_FLAGS.has(a)) throw new Error(`${a} was removed: the charge model's tunable is --charge N`);
    if (BOOLEAN_FLAGS.has(a)) on.add(a);
    else if (VALUE_FLAGS.has(a) && i + 1 < argv.length) values.set(a, argv[++i]!);
    else throw new Error(`unknown flag or missing value: ${a}`);
  }
  const num = (name: string): number | undefined => {
    const v = values.get(name);
    if (v === undefined) return undefined;
    const n = Number(v);
    if (!Number.isFinite(n)) throw new Error(`${name} needs a number`);
    return n;
  };
  const quick = on.has('--quick');
  const charge = num('--charge');
  if (charge !== undefined) {
    const errors = validateEra({ ...LATE_CSGO, chargeTicks: charge });
    if (errors.length > 0) throw new Error(`--charge ${charge}: ${errors.join(', ')}`);
  }
  const pairing = values.get('--pairing');
  if (pairing !== undefined && !(PAIRINGS as readonly string[]).includes(pairing)) throw new Error(`--pairing is one of ${PAIRINGS.join(', ')}`);
  const model = values.get('--model') ?? 'charged';
  if (model !== 'charged' && model !== 'spawn') throw new Error('--model is charged or spawn');
  const out: SweepArgs = {
    quick,
    rounds: num('--rounds') ?? (quick ? DEFAULT_ROUNDS.quick : DEFAULT_ROUNDS.full),
    seed: num('--seed') ?? DEFAULT_SEED,
    workers: Math.max(1, Math.floor(num('--workers') ?? DEFAULT_WORKERS)),
    pairings: pairing ? [pairing as Pairing] : [...PAIRINGS],
    model,
    oracle: on.has('--oracle'),
    check: on.has('--check'),
  };
  if (charge !== undefined) out.charge = charge;
  const json = values.get('--json');
  if (json !== undefined) out.json = json;
  return out;
}

const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;
const pm = (x: number, se: number): string => `${pct(x)} +-${(se * 100).toFixed(1)}`;

/** Mean field rate of the configs grouped by `key` (one row per value), per exploit. */
function axisByExploit(m: WinMatrix, grid: SweepGrid, title: string, values: readonly string[], key: (c: SweepConfig) => string): string[] {
  const exploits = EXPLOITS.filter((x) => grid.some((c) => c.exploit === x));
  const lines = [`${title} x exploit (mean field rate)`, `${''.padEnd(10)}${exploits.map((x) => x.padStart(11)).join('')}${'all'.padStart(11)}`];
  for (const v of values) {
    const cell = (x?: Exploit): string => {
      const idx = grid.map((c, i) => [c, i] as const).filter(([c]) => key(c) === v && (x === undefined || c.exploit === x)).map(([, i]) => fieldRate(m, i));
      return (idx.length ? pct(idx.reduce((a, r) => a + r, 0) / idx.length) : '-').padStart(11);
    };
    if (grid.some((c) => key(c) === v)) lines.push(`${v.padEnd(10)}${exploits.map((x) => cell(x)).join('')}${cell()}`);
  }
  return lines;
}

/** Mean rate of configs whose `key` is x over configs whose `key` is y (pairs of distinct configs). */
function versus(m: WinMatrix, grid: SweepGrid, title: string, values: readonly string[], key: (c: SweepConfig) => string): string[] {
  const present = values.filter((x) => grid.some((c) => key(c) === x));
  const lines = [`${title} vs ${title} (row's mean win rate)`, `${''.padEnd(10)}${present.map((y) => y.padStart(10)).join('')}`];
  for (const x of present) {
    const row = present.map((y) => {
      let sum = 0;
      let k = 0;
      grid.forEach((ci, i) => grid.forEach((cj, j) => {
        if (i !== j && key(ci) === x && key(cj) === y) { sum += m.rate[i]![j]!; k++; }
      }));
      return (k > 0 ? pct(sum / k) : '-').padStart(10);
    });
    lines.push(`${x.padEnd(10)}${row.join('')}`);
  }
  return lines;
}

export function summarize(m: WinMatrix, grid: SweepGrid): string {
  const lines: string[] = [];
  const cls = classifyCounters(m);
  const classOf = (name: string): string => (cls.countered.includes(name) ? 'countered' : cls.uncountered.includes(name) ? 'UNCOUNTERED' : 'inconclusive');
  const rows = m.configs.map((name, i) => {
    const counter = bestCounter(m, i);
    return { name, field: fieldRate(m, i), fieldSE: fieldSE(m, i), counter, counterSE: cellSE(m, counter.j, i) };
  });
  rows.sort((x, y) => y.field - x.field);
  lines.push('config                     field +-SE     best counter (rate +-SE, class)');
  for (const r of rows) {
    lines.push(`${r.name.padEnd(26)} ${pm(r.field, r.fieldSE).padStart(12)}   ${m.configs[r.counter.j] ?? '-'} ${pm(r.counter.rate, r.counterSE)} ${classOf(r.name)}`);
  }
  lines.push('', ...axisByExploit(m, grid, 'preset', PRESETS, (c) => c.aa));
  lines.push('', ...axisByExploit(m, grid, 'defensive', DEFENSIVES, (c) => c.defensive));
  lines.push('', ...versus(m, grid, 'exploit', EXPLOITS, (c) => c.exploit));
  lines.push('', ...versus(m, grid, 'defensive', DEFENSIVES, (c) => c.defensive));
  const fields = rows.map((r) => r.field);
  lines.push('', `field rate: max ${pct(Math.max(...fields))}, min ${pct(Math.min(...fields))}`);
  const n = m.configs.length;
  let edges = 0;
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) if (i !== j && m.rate[i]![j]! >= COUNTER_AT_LEAST - EPS) edges++;
  lines.push(`head-to-head wins >= 55%: ${edges} of ${(n * (n - 1)) / 2} pairs; 3-cycles at >= 55%: ${threeCycles(m)} of ${(n * (n - 1) * (n - 2)) / 6} triples`);
  lines.push(`counters (+-1 SE): countered ${cls.countered.length}, uncountered ${cls.uncountered.length}, inconclusive ${cls.inconclusive.length}`);
  lines.push(`  uncountered: ${cls.uncountered.join(', ') || '-'}`, `  inconclusive: ${cls.inconclusive.join(', ') || '-'}`);
  return lines.join('\n');
}

async function main(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const grid = args.quick ? QUICK_GRID : FULL_GRID;
  const era: EraTable = args.charge === undefined ? LATE_CSGO : { ...LATE_CSGO, chargeTicks: args.charge };
  console.log(`HvH v2 balance sweep: ${args.quick ? 'quick' : 'full'} grid, ${grid.length} configs, ${args.rounds} rounds per cell, seed ${args.seed}, model ${args.model}${args.oracle ? ' (ORACLE resolver control)' : ''}, ${args.workers} workers`);
  console.log(`map mirage (B site, nav areas 13 / 747); era tunables: chargeTicks ${era.chargeTicks}`);
  const results: { pairing: Pairing; seconds: number; matrix: WinMatrix; balance: ReturnType<typeof checkBalance> }[] = [];
  for (const pairing of args.pairings) {
    const stats = createStats();
    const started = performance.now();
    let lastPrint = 0;
    const m = await runSweepParallel(grid, args.rounds, args.seed, args.workers, {
      era, pairing, stats, model: args.model, oracle: args.oracle,
      onCell(done, total) {
        const t = performance.now();
        if (t - lastPrint > 10000) { lastPrint = t; process.stderr.write(`  ${pairing} ${done}/${total} cells, ${((t - started) / 1000).toFixed(0)} s\n`); }
      },
    });
    const seconds = (performance.now() - started) / 1000;
    const balance = checkBalance(m);
    results.push({ pairing, seconds, matrix: m, balance });
    console.log('', `=== pairing ${pairing === 'mixed' ? 'ssg08 vs scar20 (mixed)' : `${pairing} vs ${pairing}`} ===`);
    console.log(`rounds ${stats.rounds}, draws ${pct(stats.draws / stats.rounds)}, mean live round ${(stats.roundTicks / stats.rounds).toFixed(1)} ticks, runtime ${seconds.toFixed(1)} s`);
    console.log(`charge: ${stats.chargedAtLive} of ${stats.exploitLives} DT / HS lives live charged; ${stats.bursts} bursts, ${stats.recharges} mid-round recharges`);
    console.log('');
    console.log(summarize(m, grid));
    const table = (title: string, pick: (name: string) => string | null): void => {
      const causes = new Map<string, Map<string, number>>();
      for (const [name, byCause] of stats.causes) {
        const x = pick(name);
        if (x === null) continue;
        let agg = causes.get(x);
        if (!agg) causes.set(x, (agg = new Map()));
        for (const [c, k] of byCause) agg.set(c, (agg.get(c) ?? 0) + k);
      }
      console.log('', title);
      for (const [x, agg] of causes) {
        const total = [...agg.values()].reduce((s, k) => s + k, 0);
        console.log(`  ${x.padEnd(10)} ${[...agg].sort((p, q) => q[1] - p[1]).map(([c, k]) => `${c} ${pct(k / total)}`).join(', ')}`);
      }
    };
    table('verdicts by shooter exploit:', (name) => (name.startsWith('>') ? null : name.split('/')[1]!));
    table('verdicts by target defensive (shots that reached a target):', (name) => (name.startsWith('>') ? name.split('/')[2]! : null));
    console.log('', `checkBalance ${pairing}: ${JSON.stringify(balance)}`);
  }
  const ok = results.every((r) => r.balance.ok);
  const maxField = Math.max(...results.map((r) => Math.max(...r.matrix.configs.map((_, i) => fieldRate(r.matrix, i)))));
  const uncountered = results.reduce((k, r) => k + r.balance.uncountered.length, 0);
  const dominant = results.reduce((k, r) => k + r.balance.dominant.length, 0);
  console.log('', `verdict: ${ok ? 'ok' : 'NOT ok'} (max field rate ${pct(maxField)}, ${dominant} dominant, ${uncountered} uncountered over ${results.length} pairing(s))`);
  if (args.json) writeFileSync(args.json, JSON.stringify({ era, args, results }, null, 1));
  if (args.check && !ok) {
    console.log('--check: checkBalance is not ok (exit code 1)');
    process.exitCode = 1;
  }
}

if (!isMainThread && (workerData as WorkerSetup | undefined)?.hvhSweepWorker) workerMain(workerData as WorkerSetup);
else if (isMainThread && process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((e: unknown) => { console.error(e); process.exitCode = 1; });
}
