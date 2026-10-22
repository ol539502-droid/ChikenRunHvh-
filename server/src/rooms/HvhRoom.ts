import {
  MAX_PENDING_FIRES,
  MAX_REWIND_MS,
  SNAPSHOT_RATE,
  PLAYER,
  PLAYER_HULL_WIDTH,
  SIM_DT,
  WEAPONS,
  clamp,
  defaultHvhCore,
  fakeLagTicks,
  hopMaxFor,
  hvhPitch,
  hvhSpread,
  hvhWeapon,
  hvhStateEvent,
  isWeaponId,
  makeRay,
  moveSpeedFor,
  noBomb,
  packPlayer,
  rayHvhMatrix,
  shotSeed,
  shotUsesAmmo,
  stanceAntiAimFrom,
  stepPlayer,
  teamName,
  type BuyResult,
  type FireRequest,
  type HvhStanceAntiAim,
  type InputFrame,
  type PlayerState,
  type RoundState,
  type Team,
  type Vec3,
  type WeaponDef,
  type WeaponId,
  type WorldSnapshot,
} from '@game/shared';
import {
  EMPTY_TICKBASE,
  HVH_MAINS,
  HVH_PISTOLS,
  INITIAL_POSE,
  LATE_CSGO,
  PEEK_TICKS,
  V2_STANCES,
  RecordHistory,
  collisionWorldTracer,
  createResolverMemory,
  SightMemo,
  hammerTicks,
  stepHammerHold,
  snapshotSightTargets,
  guessedPose,
  holdForCharge,
  hvhWarmup,
  isHvhArsenal,
  learnFromVerdict,
  peekResolve,
  poseMatrix,
  processShot,
  publicObservation,
  stepHvhRound,
  stepPose,
  stepTickbase,
  tickbaseVerdictReason,
  type AntiAimConfig,
  type CommandIntent,
  type EraTable,
  type HvhRoundState,
  type LagRecord,
  type Motion,
  type Observation,
  type PoseState,
  type ResolverMemory,
  type ShotTarget,
  type ShotVerdict,
  type SightTarget,
  type TickbaseState,
  type WorldTracer,
} from '@game/shared/hvh/v2';
import type { GameServer } from '../types';
import { TokenBucket, isFiniteNumber, isRecord as isPlainRecord } from '../util';
import { GameRoom, parseFire, parseInput, type RoomHooks, type RoomOptions } from './GameRoom';
import type { ServerPlayer } from './ServerPlayer';

/*
 * HvH room. With hvhEngine 'legacy' (the default) every override defers to GameRoom, so the room
 * behaves exactly as a plain GameRoom in HvH mode. With 'v2' the per-player tick runs the v2
 * pipeline (shared/src/hvh/v2) instead of GameRoom.simulatePlayer:
 *
 *   per server tick, per player: refill the command budget by 1 (cap maxProcessTicks), then for
 *   each dequeued command (at most maxProcessTicks): enemy sight -> stepTickbase -> movement ->
 *   stepPose -> shots through processShot -> learnFromVerdict -> emit verdicts -> the burst's
 *   extra movement steps. At the end of the player's tick one LagRecord is pushed for the server
 *   tick (unless every command was choked or a hidden shot). DT bullet 2 is held until every player
 *   has been simulated, then fired in the same server tick. A tick with no command coasts, and once
 *   a player has been silent for more than maxChoke ticks every silent tick pushes a record of the
 *   coasted state (last pose), so withholding commands never makes a player unhittable.
 *
 * Decisions:
 * - Input passes the legacy per-player token limiter first (R25; rejected input is dropped
 *   silently, as in legacy). Queue cap 2 x maxProcessTicks; overflow drops the oldest with a
 *   'rejected / command flood' verdict sent to the sender only. A per-tick budget (refills 1 per
 *   tick, cap maxProcessTicks) bounds execution: a batch of up to 16 runs at once.
 * - Records are keyed by server tick (RecordHistory needs strictly increasing ticks), so several
 *   commands in one tick produce one record: the state after the last recordable command.
 *   Choke commands are not recordable. A command that fires a hide-shots burst is
 *   not recordable either (its on-shot pose is skipped, not pushed invalid); a plain shot records
 *   the on-shot pose (eyes and body on the aim, side 'center').
 * - Charge and burst (v2 tickbase, tickbase.ts): with DT or hide shots on and no enemy in actual
 *   line of sight (enemyVisible from room.eyeOf, the living enemies' positions and body yaw at the
 *   start of the tick), a command charges. A charge command is acknowledged like any other
 *   (lastSeq, so the client's CommandClock backlog keeps draining) and steps the pose (aim works),
 *   but runs no movement step: every velocity is zeroed and position and gravity hold, even
 *   mid-air; a tick with no command does not coast during a partial charge either (R55), for up to
 *   chargeTicks silent ticks (then it coasts, so withholding commands cannot hang a player). A burst
 *   (a DT / HS shot with a full charge, or DT / HS turned off while full: 'release') runs the
 *   command's own movement step, fires (bullets leave from that pre-burst eye), then runs `ticks`
 *   more normal steps of the same frame (R47: 1 + chargeTicks in all), so it slides along walls
 *   and a player standing still does not move. The teleport usually exceeds lagCompBreakHulls, so
 *   RecordHistory turns the pre-burst records 'lagcompBreak' by itself. Sight is traced only when
 *   it can change the action (stepTickbase rules 4 and 5) or for an on-peek pattern (below), once
 *   per command either way. R62: in freeze the tickbase is stepped with no enemy visible (nobody
 *   can move or shoot, so sight earns nothing), so the charge always completes before the round.
 *   No other path runs more than one movement step per command. Death and every spawn reset the
 *   tickbase (charge 0), and a dead player's commands never reach stepTickbase, so a dead player
 *   never bursts.
 * - Anti-aim (round redesign Part B): stepPose with the stance's StanceAA and DefensiveAA from
 *   loadout.v2AntiAim (absent: antiAim's single base, jitter and desync on every stance). A
 *   defensive pattern only changes the pose: no charge, no tickbase shift, records stay valid.
 *   The on-peek window opens for PEEK_TICKS commands when the same lag-compensated sight turns
 *   false -> true; it is only watched (and sight traced every command) while some stance has an
 *   on-peek pattern. An on-peek flick fires on window commands 0-3, its side alternating per
 *   window (HvhPlayerV2.peekSide). The random patterns are seeded from the room seed (or a random
 *   one when the room has none) and the pid (HvhPlayerV2.aaSeed).
 * - Targets (R24): the first enemy body the un-deviated aim ray intersects, traced against each
 *   enemy's lag record at the view tick (real pose, crouch scale; poseMatrix, as processShot).
 *   A client-named target (legacy fire intent.target) is only a hint: used when it is that body,
 *   or when no body is intersected. Nothing intersected and no hint: no target ('spread').
 * - R26: an accepted fire request is never dropped silently. A pending fire consumed while the
 *   player is dead / preparing / removed, or fired while dead, is 'rejected / actions blocked';
 *   one whose weapon became projectile or melee, and a command-level intent.fire stripped for a
 *   projectile or melee weapon (R30), is 'rejected / wrong weapon'; pending fires
 *   cleared by death are 'actions blocked'; overflow beyond MAX_PENDING_FIRES is 'fire flood'.
 *   Silent drops are only malformed packets and stale or duplicate seq. (Projectile and melee
 *   weapons fire through the legacy `fire` message.)
 * - Snapshots (R28): other viewers get v2 public state: yaw from the last publicObservation (eye
 *   yaw, never bodyYaw), and while choking, the state frozen at the last pushed record. The
 *   legacy fakeLag cache does not apply in v2 rooms.
 * - A hit on a spawn-protected target is 'rejected / spawn protection' and deals no damage, but
 *   the shot was fired: ammo, fire interval and the shooter's own spawn shield are spent.
 * - Projectile and melee weapons are excluded from v2: their `fire` messages take the legacy
 *   GameRoom path (fire queue, executeFire), and intent fire / DT / HS are ignored for them.
 *   Hitscan `fire` messages (bots, older clients) are attached as intent.fire to the command
 *   they followed, aimed with the message's direction.
 * - Exploit intents (choke, DT, HS) need the HvH tools on (hvhEnabled); Manual play
 *   keeps plain fire only.
 * - Ack: hvhState.lastAckSeq is ServerPlayer.lastSeq, the same value as the snapshot's `ack`.
 * - R41: bullet 1's weapon fire interval is measured in server ticks since the shooter's last
 *   shot, not in tickbase, so charge ticks (which do not advance tickbase) never block firing. DT
 *   bullet 2 keeps ticksSinceLastShot = the burst's ticks (slow weapons still cannot double tap).
 *   Within one server tick, the first shot is accepted once the interval has passed in server
 *   ticks, however many queued commands (a choke batch, a backlog) ran before it in that tick; a
 *   second bullet-1 shot in the same tick sees 0 ticks since the last shot and is rejected
 *   'fire interval' (DT bullet 2 is the only accepted same-tick second bullet).
 * - The R8 hammer: bullet 1 of a gun with csgo.hammerMs is 'rejected / hammer' unless hammerTicks
 *   commands ran with the trigger (intent.trigger, or the fire itself) held, on that gun, before the
 *   shot's command (R69: counted per command run, not by seq, so skipping seqs fakes nothing; a
 *   choke batch counts as it runs; rounded up like the fire interval). A hammer back for more than
 *   HAMMER_GRACE commands with no shot drops and the hold pulls it again, so it cannot stay cocked.
 *   Every bullet-1 attempt (fired or rejected) drops the hammer. Bots and the client step the same
 *   count (stepHammerHold).
 * - Rounds (v2 only; rounds.ts decides, the room applies): a warmup with free respawns, then
 *   rounds of freeze (everyone respawned at their team spawn and frozen, no shooting) -> live (no
 *   respawns) -> over, first to 13. The round is stepped once per tick after every player (and
 *   DT bullet 2) has run, so the last two players killing each other in one tick draw the round.
 *   Team scores are rounds won (kills do not score; no kill or time limit). Halftime swaps every
 *   player's team and the team scores. Every v2 spawn wears armor and helmet (armor 100); the
 *   shot applies it (shot.ts armorPen), so GameRoom.damage does not soak damage with it again.
 *   A team left with no players loses the round in play; then (or at once in freeze) the match
 *   pauses in warmup, keeping the score, half, kills and deaths, and resumes at the next round once
 *   both teams have players again (R70), rather than awarding a round every ~10 s. The match stays
 *   on while one player is left (a 1v1 refresh); a warmup's frags do not stick (the stats go back
 *   to where they were as the warmup began when the round starts).
 *   `hvhRounds: false` (test harnesses only) keeps the room in warmup with the old kill scoring.
 * - Loadout (v2 only): every spawn carries exactly [main, pistol] (HVH_MAINS, HVH_PISTOLS), no
 *   knife and no grenades. The pick lives in p.info.loadout (default SSG 08 + Desert Eagle), so
 *   every round start's respawn re-applies it. `buy` takes an arsenal id, free, in warmup and
 *   freeze only; the gun in hand stays out if it is still carried (as the client's setLoadout).
 *   A change is rate limited per player (2 at once, then one per 250 ms; the same pick is free).
 *   Public rooms fill to 10 with bots (5v5); each bot picks a random main and pistol at every
 *   round start from the room's seeded RNG.
 */

export type HvhEngine = 'legacy' | 'v2';

interface WarmupStats { kills: number; deaths: number; score: number; headshotKills: number }

export interface HvhRoomOptions extends RoomOptions {
  /**
   * v2 only, default on. false is for test harnesses (the replay and network gates, the balance
   * sweep): no rounds, the room stays in warmup and scores kills as before.
   */
  hvhRounds?: boolean;
}

/** HVH_ENGINE=v2 selects the v2 engine; anything else (or nothing) is legacy. */
export function hvhEngineFrom(env: Readonly<Record<string, string | undefined>>): HvhEngine {
  return env.HVH_ENGINE === 'v2' ? 'v2' : 'legacy';
}

const IDLE: CommandIntent = Object.freeze({ fire: false, choke: false, doubleTap: false, hideShots: false });
const TICK_MS = SIM_DT * 1000;
const OBSERVATIONS_KEPT = 32;
const MAINS: readonly WeaponId[] = HVH_MAINS;
const PISTOLS: readonly WeaponId[] = HVH_PISTOLS;

/** The v2 loadout from the player's last picks: [main, pistol], SSG 08 and Desert Eagle by default. */
function hvhLoadout(loadout: readonly WeaponId[]): [WeaponId, WeaponId] {
  return [loadout.find((w) => MAINS.includes(w)) ?? 'ssg08', loadout.find((w) => PISTOLS.includes(w)) ?? 'deserteagle'];
}

interface QueuedCommand {
  frame: Readonly<InputFrame>;
  intent: CommandIntent;
  clientTick?: number;
  /** The snapshot `t` the client predicted the sight from (R56). */
  sightT?: number;
}

/** Sent snapshots kept per viewer for sight (R56): enough to cover the unlag window. */
const SIGHT_SNAPSHOTS = Math.ceil((MAX_REWIND_MS * SNAPSHOT_RATE) / 1000) + 1;

interface PendingBullet {
  seq: number;
  weaponId: string;
  aim: { origin: Vec3; dir: Vec3 };
  viewTick: number;
  ticksSinceLastShot: number;
  /** Commands run with the trigger held before bullet 1's (the R8 hammer). */
  hammered: number;
  spread: number;
  targetPid?: number;
}

interface RecordCapture {
  position: Vec3;
  pose: PoseState;
  duck: number;
  motion: Motion;
}

/** Everything v2 tracks about one player, in one object (debug feeds and headless matches read it). */
export interface HvhPlayerV2 {
  queue: QueuedCommand[];
  /** Highest seq accepted into the queue. */
  lastQueuedSeq: number;
  /** Commands that may still run this tick (refills 1 per tick, cap maxProcessTicks). */
  budget: number;
  tickbase: TickbaseState;
  pose: PoseState;
  history: RecordHistory;
  observations: Observation[];
  /** This player's resolver, as a shooter. Only the sim drives it. */
  resolver: ResolverMemory;
  /**
   * Server tick of the last shot fired (R41): bullet 1's fire interval counts server ticks since
   * it, not tickbase, so charge ticks (which freeze tickbase) never block firing.
   */
  lastShotTick: number;
  /** Legacy `fire` messages for a hitscan weapon, waiting for their command, oldest first. */
  pendingFires: FireRequest[];
  /** DT bullet 2, fired after every player has been simulated this tick. */
  pendingBullet: PendingBullet | null;
  /** Commands executed this tick. */
  executed: number;
  /** Server ticks in a row with no command executed (a silent player). */
  silentTicks: number;
  /** The enemyVisible each of this tick's commands was stepped with, in order (headless matches replay prediction from it). */
  sight: boolean[];
  /** Seeds the defensive random pitch and yaw (stepPose ctx.seed): from the room seed and the pid, so opponents cannot derive it. */
  aaSeed: number;
  /** Commands left in the on-peek window: PEEK_TICKS when an enemy becomes visible, then -1 per command. */
  peekTicksLeft: number;
  /** An enemy was in sight at the last command that watched for a peek. */
  enemySeen: boolean;
  /** The flick side of the current on-peek window: +1, -1, +1, ... per window opened. */
  peekSide: 1 | -1;
  /** The peekSide each of this tick's commands stepped its pose with, in order. */
  peekSides: (1 | -1)[];
  /** The peekTicksLeft each of this tick's commands stepped its pose with, in order (headless matches replay prediction from it). */
  peek: number[];
  /** Commands run in the current trigger hold (intent.trigger or fire), this tick's included (stepHammerHold). */
  hammerHold: number;
  /** The gun the hold started on (a switch restarts the pull). */
  hammerWeapon: WeaponId | null;
  /** This player's last sight trace (enemyInSight), reused while nothing it reads has changed. */
  sightMemo: SightMemo;
  /** Loadout changes (buy): 2 at once (a main and a pistol), then 4 per second. */
  buyLimiter: TokenBucket;
  /** Server tick of the newest pushed record. */
  lastRecordTick: number;
  /** What other viewers saw at the newest pushed record (frozen while choking). */
  publicState: PlayerState | null;
  /** The enemies the last SIGHT_SNAPSHOTS snapshots sent to this player showed, oldest first. */
  sentSight: { t: number; targets: SightTarget[] }[];
}

function parseIntent(raw: unknown): CommandIntent {
  if (!isPlainRecord(raw)) return IDLE;
  return {
    fire: raw.fire === true,
    choke: raw.choke === true,
    doubleTap: raw.doubleTap === true,
    hideShots: raw.hideShots === true,
    ...(raw.trigger === true ? { trigger: true } : {}),
  };
}

/** Some stance has an on-peek defensive pattern, so the peek window needs sight every command. */
function watchesPeek(aa: HvhStanceAntiAim): boolean {
  for (const stance of V2_STANCES) if (aa.defensive[stance].enabled && aa.defensive[stance].onPeek) return true;
  return false;
}

function hitscan(w: WeaponDef): boolean {
  return !w.projectile && !w.melee;
}

function aimFromAngles(yaw: number, pitch: number): Vec3 {
  // Inverse of the legacy reveal: yaw = atan2(-dx, -dz), pitch = asin(dy).
  const c = Math.cos(pitch);
  return { x: -Math.sin(yaw) * c, y: Math.sin(pitch), z: -Math.cos(yaw) * c };
}

/** The `round` event for a v2 HvH round: freeze is the buy phase, and there is no bomb. */
function roundEvent(s: HvhRoundState): RoundState {
  return {
    phase: s.phase === 'freeze' ? 'buy' : s.phase === 'ended' ? 'over' : s.phase,
    round: s.round,
    endsAt: s.endsAt,
    buyEndsAt: s.phase === 'freeze' ? s.endsAt : null,
    bomb: noBomb(),
    winner: s.winner,
    reason: s.reason === 'draw' ? null : s.reason,
  };
}

/** Newest lag records sent per target in the dev overlay feed. */
export const DEBUG_MAX_RECORDS = 24;

export class HvhRoom extends GameRoom {
  readonly hvhEngine: HvhEngine;
  readonly era: EraTable = LATE_CSGO;
  private readonly v2Players = new Map<number, HvhPlayerV2>();
  private readonly verdictListeners = new Set<(v: ShotVerdict) => void>();
  private tracer: WorldTracer | null = null;
  /** Dev overlay viewers (pid -> still-authorized check, re-evaluated every tick). */
  private readonly debugViewers = new Map<number, () => boolean>();
  /** v2 round flow on (every v2 room but test harnesses). */
  private readonly rounds: boolean;
  private round: HvhRoundState = hvhWarmup();
  /** Kills, deaths and score as the warmup began (pid -> stats; missing = 0), put back when the round starts. */
  private warmupStats = new Map<number, WarmupStats>();
  /** Every player as they stood at the start of this tick (the end of the last), for enemy sight. */
  private readonly sightTargets = new Map<number, SightTarget>();
  /** Mixed with each pid into HvhPlayerV2.aaSeed: the room seed, or a random one. */
  private readonly aaSeedBase: number;

  constructor(io: GameServer, options: HvhRoomOptions, hooks: RoomHooks = {}) {
    super(io, options, hooks);
    this.hvhEngine = options.hvhEngine === 'v2' ? 'v2' : 'legacy';
    this.rounds = this.hvhEngine === 'v2' && options.hvhRounds !== false;
    this.aaSeedBase = options.seed !== undefined ? options.seed >>> 0 : (Math.random() * 2 ** 32) >>> 0;
  }

  private get v2(): boolean {
    return this.hvhEngine === 'v2';
  }

  /** The v2 round (a warmup that never ends on the legacy engine or with `hvhRounds: false`). */
  get hvhRound(): Readonly<HvhRoundState> {
    return this.round;
  }

  /** Every verdict the room emits (dev-only debug feeds, headless matches, tests). */
  addVerdictListener(fn: (v: ShotVerdict) => void): () => void {
    this.verdictListeners.add(fn);
    return () => this.verdictListeners.delete(fn);
  }

  /** The v2 state of a player (undefined on the legacy engine or for unknown players). */
  v2State(pid: number): Readonly<HvhPlayerV2> | undefined {
    const p = this.players.get(pid);
    return this.v2 && p ? this.stateOf(p) : undefined;
  }

  /**
   * Turns the authoritative debug feed (hvhDebug) on or off for a developer. `authorized` is the
   * caller's live DevAccess check; it is re-run every tick, and the feed only ever flows in
   * private v2 rooms. Pass null to stop.
   */
  setDebugViewer(p: ServerPlayer, authorized: (() => boolean) | null): void {
    if (authorized) this.debugViewers.set(p.pid, authorized);
    else this.debugViewers.delete(p.pid);
  }

  /** One hvhDebug message per other player per tick, to each authorized viewer. Pure reads: peekResolve, never resolve. */
  private sendDebugFeed(): void {
    if (this.debugViewers.size === 0 || !this.info.private) return;
    for (const [pid, authorized] of this.debugViewers) {
      const viewer = this.players.get(pid);
      if (!viewer?.socket) continue;
      if (!authorized()) { this.debugViewers.delete(pid); continue; }
      const memory = this.stateOf(viewer).resolver;
      for (const target of this.players.values()) {
        if (target === viewer || !target.alive) continue;
        const t = this.stateOf(target);
        // Volatile (like snapshots): a slow dev socket drops frames instead of buffering without bound.
        viewer.socket.volatile.emit('hvhDebug', {
          playerId: target.pid,
          realPose: { ...t.pose },
          records: t.history.records().slice(-DEBUG_MAX_RECORDS).map((r) => ({ ...r })),
          resolver: peekResolve(memory, String(target.pid), t.observations, this.hvhTick),
        });
      }
    }
  }

  queuedCommands(pid: number): number {
    return this.v2State(pid)?.queue.length ?? 0;
  }

  tickbaseOf(pid: number): Readonly<TickbaseState> | undefined {
    return this.v2State(pid)?.tickbase;
  }

  private stateOf(p: ServerPlayer): HvhPlayerV2 {
    let s = this.v2Players.get(p.pid);
    if (!s) {
      s = {
        queue: [],
        lastQueuedSeq: 0,
        budget: this.era.maxProcessTicks,
        tickbase: EMPTY_TICKBASE(this.hvhTick),
        pose: INITIAL_POSE,
        history: new RecordHistory(this.era, PLAYER_HULL_WIDTH),
        observations: [],
        resolver: createResolverMemory(),
        lastShotTick: -Infinity,
        pendingFires: [],
        pendingBullet: null,
        executed: 0,
        silentTicks: 0,
        sight: [],
        aaSeed: Math.imul((this.aaSeedBase ^ p.pid) >>> 0, 0x9e3779b1) >>> 0,
        peekTicksLeft: 0,
        enemySeen: false,
        peekSide: -1,
        peekSides: [],
        peek: [],
        hammerHold: 0,
        hammerWeapon: null,
        buyLimiter: new TokenBucket(2, 4),
        sightMemo: new SightMemo(),
        lastRecordTick: -Infinity,
        publicState: null,
        sentSight: [],
      };
      this.v2Players.set(p.pid, s);
    }
    return s;
  }

  private world2(): WorldTracer {
    return (this.tracer ??= collisionWorldTracer(this.world, this.isSoft,
      (id) => (id < 0 ? 'ground' : this.map.boxes[id]?.kind ?? 'world')));
  }

  // ---------------------------------------------------------------------------
  // Messages
  // ---------------------------------------------------------------------------

  override handleInput(p: ServerPlayer, raw: unknown): void {
    if (!this.v2) return super.handleInput(p, raw);
    this.enforceHvhRules(p);
    const parsed = parseInput(raw);
    const s = this.stateOf(p);
    if (!parsed || p.removedForCheating || parsed.seq <= Math.max(p.lastSeq, s.lastQueuedSeq)) return;
    if (!p.takeInputToken(performance.now())) return; // R25: the legacy limiter, silent as in legacy
    const assisted = p.hvhEnabled && !p.hvhPreparing;
    const frame: InputFrame = { ...parsed, autoHop: assisted && parsed.autoHop === true, subtickStrafe: assisted && parsed.subtickStrafe === true };
    const r = raw as Record<string, unknown>;
    const command: QueuedCommand = { frame: Object.freeze(frame), intent: parseIntent(r.intent) };
    if (isFiniteNumber(r.clientTick)) command.clientTick = Math.floor(r.clientTick);
    if (isFiniteNumber(r.sightT)) command.sightT = r.sightT;
    s.lastQueuedSeq = frame.seq;
    s.queue.push(command);
    while (s.queue.length > 2 * this.era.maxProcessTicks) {
      s.queue.shift();
      this.emitVerdict(p, this.rejected(p, 'command flood'), { senderOnly: true });
    }
  }

  override handleFire(p: ServerPlayer, raw: unknown): void {
    if (!this.v2) return super.handleFire(p, raw);
    // Projectile and melee weapons keep the legacy path.
    if (!hitscan(WEAPONS[p.weapon])) return super.handleFire(p, raw);
    this.enforceHvhRules(p);
    const req = parseFire(raw);
    if (!req) return;
    const s = this.stateOf(p);
    if (req.shot <= p.lastShotSeq || s.pendingFires.some((f) => f.shot >= req.shot)) return;
    if (!p.alive || p.removedForCheating || p.hvhPreparing) {
      p.lastShotSeq = req.shot;
      this.emitVerdict(p, this.rejected(p, 'actions blocked'));
      return;
    }
    s.pendingFires.push(req);
    while (s.pendingFires.length > MAX_PENDING_FIRES) {
      p.lastShotSeq = Math.max(p.lastShotSeq, s.pendingFires.shift()!.shot);
      this.emitVerdict(p, this.rejected(p, 'fire flood'), { senderOnly: true });
    }
  }

  private rejected(p: ServerPlayer, reason: string, bullet: 1 | 2 = 1): ShotVerdict {
    return { shooterId: String(p.pid), tick: this.hvhTick, bullet, cause: 'rejected', reason };
  }

  // ---------------------------------------------------------------------------
  // Tick
  // ---------------------------------------------------------------------------

  protected override fixedUpdate(now: number): void {
    if (this.v2) this.captureSightTargets();
    super.fixedUpdate(now);
    if (!this.v2) return;
    this.flushPendingBullets(now);
    if (this.rounds) this.updateRound(now);
    for (const p of this.players.values()) {
      const s = this.stateOf(p);
      if (s.executed > 0) p.socket?.emit('hvhState', hvhStateEvent(s.tickbase, this.era, p.lastSeq, this.hvhTick, s.queue.length));
    }
    this.sendDebugFeed();
  }

  protected override simulatePlayer(p: ServerPlayer, now: number): void {
    if (!this.v2) return super.simulatePlayer(p, now);
    this.processPlayerTick(String(p.pid), now);
  }

  /** One player's v2 tick: up to maxProcessTicks queued commands, then one lag record. */
  processPlayerTick(playerId: string, now = performance.now()): void {
    const p = this.players.get(Number(playerId));
    if (!p) return;
    const s = this.stateOf(p);
    s.budget = Math.min(this.era.maxProcessTicks, s.budget + 1);
    s.executed = 0;
    s.sight = [];
    s.peek = [];
    s.peekSides = [];
    let capture: RecordCapture | null = null;
    while (s.executed < this.era.maxProcessTicks && s.budget >= 1 && s.queue.length > 0) {
      const command = s.queue.shift()!;
      s.budget--;
      s.executed++;
      capture = this.runCommand(p, s, command, now) ?? capture;
    }
    s.silentTicks = s.executed === 0 ? s.silentTicks + 1 : 0;
    // R55: a lost command never applies gravity during the charging stop, but only for chargeTicks
    // silent ticks: withholding commands cannot hang the player in the air.
    const charging = s.tickbase.armed && s.tickbase.charge > 0 && s.tickbase.charge < this.era.chargeTicks;
    if (s.executed === 0 && !(charging && s.silentTicks <= this.era.chargeTicks)) this.coast(p);
    p.simulationTime = now;
    p.weaponHeat = Math.max(0, p.weaponHeat - SIM_DT * 1.5);
    // The legacy resource still times projectile and melee weapons (legacy executeFire).
    p.resource.step(this.hvhTick, p.fireQueue.length > 0 || now - p.lastFireAt < 250,
      p.hvhEnabled && fakeLagTicks(p.hvh.core ?? defaultHvhCore(), p.lastSeq, p.state.horizontalSpeed) > 0);
    // Snapshots: everyone sees the eyes; only the owner's snapshot carries the body (p.yaw).
    p.animation.eyeYaw = p.animation.lowerBodyYaw = p.fakeYaw = s.pose.eyeYaw;
    p.animation.bodyYaw = p.yaw = s.pose.bodyYaw;
    p.fakePitch = s.pose.pitch;
    // A player silent for longer than maxChoke is recorded where the server has them every tick, so
    // withholding commands never makes them unhittable (a choke only lasts maxChoke commands).
    if (!capture && s.silentTicks > this.era.maxChoke) {
      capture = { position: { x: p.state.x, y: p.state.y, z: p.state.z }, pose: s.pose, duck: p.state.crouchAmount ?? (p.state.crouching ? 1 : 0), motion: this.motionOf(p) };
    }
    if (capture && p.alive) this.pushRecord(p, s, capture);
  }

  /** DT bullet 2 for everyone still alive; a shooter killed since bullet 1 fires nothing. */
  flushPendingBullets(now = performance.now()): void {
    for (const p of this.players.values()) {
      const s = this.stateOf(p);
      const bullet = s.pendingBullet;
      s.pendingBullet = null;
      if (!bullet || !p.alive) continue;
      this.fireBullet(p, s, bullet, 2, now);
    }
  }

  private runCommand(p: ServerPlayer, s: HvhPlayerV2, command: QueuedCommand, now: number): RecordCapture | null {
    const frame = command.frame;
    let intent = command.intent;
    let fireReq: FireRequest | null = null;
    const queued = s.pendingFires[0];
    if (queued && (queued.command === undefined || queued.command <= frame.seq)) {
      fireReq = s.pendingFires.shift()!;
      p.lastShotSeq = fireReq.shot;
      intent = { ...intent, fire: true };
    }
    this.stepHammer(p, s, p.alive && (intent.fire || intent.trigger === true));
    if (!p.alive || p.hvhPreparing || p.removedForCheating) {
      if (fireReq) this.emitVerdict(p, this.rejected(p, 'actions blocked'));
      s.sight.push(false);
      this.stepPeek(s, false, false);
      this.move(p, frame);
      return null;
    }
    if (!hitscan(WEAPONS[p.weapon])) {
      // R26 / R30: a fire message or a command-level intent.fire stripped here is answered.
      if (fireReq || intent.fire) this.emitVerdict(p, this.rejected(p, 'wrong weapon'));
      fireReq = null;
      intent = { ...intent, fire: false, doubleTap: false, hideShots: false };
    }
    if (!p.hvhEnabled) intent = { ...IDLE, fire: intent.fire };

    const before = s.tickbase;
    const aa = this.antiAimOf(p);
    // R62: in freeze nobody can move or shoot, so sight earns nothing and the charge ignores it.
    const forTickbase = this.sightChangesAction(before, intent) && !this.freezing();
    const forPeek = aa !== null && watchesPeek(aa);
    // One trace serves both (at most two raycasts per enemy per command).
    const seen = (forTickbase || forPeek) && this.enemyInSight(p, s, command.sightT, now);
    const visible = forTickbase && seen;
    s.sight.push(visible);
    this.stepPeek(s, forPeek, seen);
    const { next, action } = stepTickbase(before, intent, this.era, { enemyVisible: visible });
    s.tickbase = next;
    if (action.kind === 'reject') {
      this.emitVerdict(p, { shooterId: String(p.pid), tick: this.hvhTick, bullet: 1, cause: 'tickbase', reason: tickbaseVerdictReason(action.reason) });
    }
    // The charging stop runs no movement step; a burst runs its own step here, the rest after the shot.
    const moved = this.move(p, frame, action.kind === 'charge' ? 0 : 1);
    const motion = this.motionOf(p);
    s.pose = this.stepPoseFor(p, s, frame, motion, aa);
    const burst = action.kind === 'burst' ? action : null;

    let recordPose = s.pose;
    let hidden = false;
    if (intent.fire) {
      const bullet = this.prepareBullet(p, s, frame, command, fireReq, now);
      this.fireBullet(p, s, bullet, 1, now);
      // DT bullet 2: its interval is the burst's ticks (slow weapons cannot double tap).
      if (burst?.reason === 'doubleTap') s.pendingBullet = { ...bullet, ticksSinceLastShot: burst.ticks };
      // Hide shots: the on-shot pose is skipped, not recorded.
      hidden = burst?.reason === 'hideShots';
      // On-shot pose: eyes and body on the aim.
      const aimYaw = Math.atan2(-bullet.aim.dir.x, -bullet.aim.dir.z);
      recordPose = { ...s.pose, eyeYaw: aimYaw, bodyYaw: aimYaw, realSide: 'center', eyeOffsetDeg: 0 };
    }
    // The teleport: the burst's other steps, after the bullets left from the pre-burst eye.
    if (burst) this.stepMovement(p, moved, burst.ticks);
    if (hidden || action.kind === 'choke') return null;
    return {
      position: { x: p.state.x, y: p.state.y, z: p.state.z },
      pose: recordPose,
      duck: p.state.crouchAmount ?? (p.state.crouching ? 1 : 0),
      motion,
    };
  }

  /**
   * The R8 hammer, counted in commands the server runs (R69: a seq jump cannot fake the time); a
   * release or a gun switch ends the hold, and a hammer kept back too long drops (stepHammerHold).
   */
  private stepHammer(p: ServerPlayer, s: HvhPlayerV2, held: boolean): void {
    if (s.hammerWeapon !== p.weapon) s.hammerHold = 0;
    s.hammerWeapon = p.weapon;
    s.hammerHold = stepHammerHold(s.hammerHold, held, WEAPONS[p.weapon]);
  }

  private acknowledge(p: ServerPlayer, frame: Readonly<InputFrame>): void {
    p.lastSeq = frame.seq;
    p.useHeld = frame.use === true;
    p.yaw = p.lookYaw = frame.yaw;
    p.pitch = frame.pitch;
    p.lastInput = frame;
  }

  /**
   * GameRoom.applyInput without the legacy pose step: acknowledges the command, then runs `steps`
   * (0 or 1) movement steps of it. 0 is the charging stop. Returns the frame movement ran with.
   */
  private move(p: ServerPlayer, input: Readonly<InputFrame>, steps: 0 | 1 = 1): Readonly<InputFrame> {
    let frame = input;
    if ((frame.autoHop || frame.subtickStrafe) && (!p.hvhEnabled || p.hvhPreparing)) frame = { ...frame, autoHop: false, subtickStrafe: false };
    if (this.movementLocked(p)) frame = { ...frame, forward: 0, right: 0, jump: false, crouch: true };
    this.acknowledge(p, frame);
    if (steps === 0 && p.alive && !p.immobile) holdForCharge(p.state);
    else this.stepMovement(p, frame, 1);
    return frame;
  }

  /** `n` normal movement steps of `frame` (collision as always); none for the dead and the immobile. */
  private stepMovement(p: ServerPlayer, frame: Readonly<InputFrame>, n: number): void {
    if (!p.alive || p.immobile) {
      p.state.horizontalSpeed = 0;
      return;
    }
    for (let i = 0; i < n; i++) {
      stepPlayer(p.state, frame, SIM_DT, this.world, p.moveMods(), hopMaxFor(p.weapon), moveSpeedFor(p.weapon), true);
    }
  }

  /**
   * The tickbase's enemyVisible: a living enemy in actual line of sight (enemyVisible, not the
   * wallhack) from the command's eye. Lag-compensated (R56): the enemies are those of the snapshot
   * the command names (`sightT`), as this player was sent them (public positions, so a choking
   * enemy is seen as the viewer saw it), which the client predicts exactly. A claim newer than the
   * last sent snapshot is clamped to it; one older than every kept snapshot or than the unlag
   * window (MAX_REWIND_MS), or a missing one, falls back to R54: where enemies stood at the start
   * of the tick (sightTargets, with their body yaw). Either way the answer does not depend on the
   * order players are simulated in. Traced only when it can change the action (sightChangesAction)
   * or the player watches for a peek (an on-peek defensive pattern); the tickbase is stepped with
   * false otherwise, which it then ignores.
   */
  private enemyInSight(p: ServerPlayer, s: HvhPlayerV2, sightT: number | undefined, now: number): boolean {
    const sent = sightT === undefined ? null : this.sentSightAt(s, sightT, now);
    if (sent) return s.sightMemo.visible(this.eyeOf(p), sent, this.world);
    const enemies: SightTarget[] = [];
    for (const q of this.players.values()) {
      if (q === p || !q.alive || this.areTeammates(p, q)) continue;
      const target = this.sightTargets.get(q.pid);
      if (target) enemies.push(target);
    }
    return s.sightMemo.visible(this.eyeOf(p), enemies, this.world);
  }

  /** Sight can change the tickbase action: an exploit on, not firing, below a full charge (stepTickbase rules 4 and 5). */
  private sightChangesAction(tickbase: TickbaseState, intent: CommandIntent): boolean {
    return (intent.doubleTap || intent.hideShots) && !intent.fire && tickbase.charge < this.era.chargeTicks;
  }

  /**
   * The on-peek window: when the enemy sight turns false -> true it opens for PEEK_TICKS commands
   * (this one included), counting down by 1 per command, and each new window flips the flick side.
   * Closed and reset while not watching.
   */
  private stepPeek(s: HvhPlayerV2, watching: boolean, seen: boolean): void {
    if (!watching) {
      s.peekTicksLeft = 0;
    } else if (seen && !s.enemySeen) {
      s.peekTicksLeft = PEEK_TICKS;
      s.peekSide = s.peekSide === 1 ? -1 : 1;
    } else {
      s.peekTicksLeft = Math.max(0, s.peekTicksLeft - 1);
    }
    s.enemySeen = watching && seen;
    s.peek.push(s.peekTicksLeft);
    s.peekSides.push(s.peekSide);
  }

  /** The newest snapshot sent to the player at or before `t`, if it is inside the unlag window. */
  private sentSightAt(s: HvhPlayerV2, t: number, now: number): SightTarget[] | null {
    let found: { t: number; targets: SightTarget[] } | null = null;
    for (const e of s.sentSight) if (e.t <= t) found = e;
    return found && now - found.t <= MAX_REWIND_MS ? found.targets : null;
  }

  /** v2: also keeps the enemies each sent snapshot shows the viewer, for lag-compensated sight. */
  override snapshotFor(viewer: ServerPlayer, now = performance.now()): WorldSnapshot {
    const snapshot = super.snapshotFor(viewer, now);
    if (!this.v2) return snapshot;
    const sent = this.stateOf(viewer).sentSight;
    // Snapshots go out in time order; one with an older `t` (a test driving its own clock) restarts the ring.
    if (sent.length && sent[sent.length - 1]!.t > now) sent.length = 0;
    sent.push({ t: now, targets: snapshotSightTargets(snapshot.p, (pid) => {
      const q = this.players.get(pid);
      return q !== undefined && q !== viewer && !this.areTeammates(viewer, q);
    }) });
    if (sent.length > SIGHT_SNAPSHOTS) sent.shift();
    return snapshot;
  }

  private captureSightTargets(): void {
    this.sightTargets.clear();
    for (const q of this.players.values()) {
      const crouch = q.state.crouchAmount ?? (q.state.crouching ? 1 : 0);
      this.sightTargets.set(q.pid, { x: q.state.x, y: q.state.y, z: q.state.z, crouch, yaw: this.stateOf(q).pose.bodyYaw });
    }
  }

  /** GameRoom's missing-command step: no presses are invented. */
  private coast(p: ServerPlayer): void {
    if (!p.alive || p.immobile || p.vehicle || !p.lastInput) return;
    const held = p.state.jumpHeld;
    stepPlayer(p.state,
      { ...p.lastInput, forward: 0, right: 0, jump: held && !p.state.onGround, autoHop: false, subtickStrafe: false }, SIM_DT,
      this.world, p.moveMods(), hopMaxFor(p.weapon), moveSpeedFor(p.weapon), true);
    p.state.jumpHeld = held;
  }

  private motionOf(p: ServerPlayer): Motion {
    return {
      speedFraction: clamp(p.state.horizontalSpeed / (PLAYER.speed * moveSpeedFor(p.weapon)), 0, 1),
      duck: p.state.crouchAmount ?? (p.state.crouching ? 1 : 0),
      onGround: p.state.onGround,
    };
  }

  /** The player's v2 per-stance anti-aim, or null with AA off. A loadout without one uses antiAim's single stance. */
  private antiAimOf(p: ServerPlayer): HvhStanceAntiAim | null {
    if (!p.hvhEnabled || !p.hvh.antiAim.enabled) return null;
    return p.hvh.v2AntiAim ?? stanceAntiAimFrom(p.hvh.antiAim);
  }

  /** stepPose carries the incoming (visual) pitch unless a defensive pattern sets it. */
  private stepPoseFor(p: ServerPlayer, s: HvhPlayerV2, frame: Readonly<InputFrame>, motion: Motion, aa: HvhStanceAntiAim | null): PoseState {
    const pitch = hvhPitch(frame.pitch, p.hvh);
    if (!aa) return { ...s.pose, eyeYaw: frame.yaw, bodyYaw: frame.yaw, pitch, realSide: 'center', eyeOffsetDeg: 0 };
    const config: AntiAimConfig = { ...aa, inverted: frame.invert === true };
    return stepPose({ ...s.pose, pitch }, frame.yaw, config, motion, s.tickbase.tickbase, this.era,
      { seed: s.aaSeed, peekTicksLeft: s.peekTicksLeft, slowWalk: frame.slowWalk === true, peekSide: s.peekSide });
  }

  private pushRecord(p: ServerPlayer, s: HvhPlayerV2, c: RecordCapture): void {
    const tick = this.hvhTick;
    // One record per server tick, even if processPlayerTick runs twice in a tick (headless drivers).
    if (tick <= s.lastRecordTick) return;
    s.lastRecordTick = tick;
    s.history.push({ tick, position: c.position, pose: c.pose, duck: c.duck, valid: true });
    s.observations.push(publicObservation(c.pose, c.motion, tick));
    if (s.observations.length > OBSERVATIONS_KEPT) s.observations.splice(0, s.observations.length - OBSERVATIONS_KEPT);
    s.publicState = this.publicView(p.toState(), c.pose.eyeYaw);
  }

  private publicView(state: PlayerState, eyeYaw: number): PlayerState {
    return { ...state, yaw: eyeYaw, fakeYaw: eyeYaw, lowerBodyYaw: eyeYaw };
  }

  /**
   * R28: other viewers see v2 public state. While choking, the state frozen at the last pushed
   * record (as the server's records); otherwise the live state with the last observed eye yaw.
   */
  private publicStateOf(p: ServerPlayer): PlayerState {
    const s = this.stateOf(p);
    if (s.tickbase.choked > 0 && s.publicState && s.publicState.alive === p.alive) return s.publicState;
    const live = p.toState();
    return this.publicView(live, s.observations.at(-1)?.eyeYaw ?? live.yaw);
  }

  override snapshot(now = performance.now(), viewer = 0): WorldSnapshot {
    if (!this.v2) return super.snapshot(now, viewer);
    return {
      t: now,
      p: [...this.players.values()].map((p) => packPlayer(p.pid === viewer ? { ...p.toState(), fakeYaw: p.yaw } : this.publicStateOf(p))),
      v: this.vehicles?.packed() ?? [],
    };
  }

  // ---------------------------------------------------------------------------
  // Shots
  // ---------------------------------------------------------------------------

  private prepareBullet(p: ServerPlayer, s: HvhPlayerV2, frame: Readonly<InputFrame>, command: QueuedCommand,
    fireReq: FireRequest | null, now: number): PendingBullet {
    const origin = this.eyeOf(p);
    let dir = aimFromAngles(frame.yaw, frame.pitch);
    if (fireReq) {
      const len = Math.hypot(fireReq.dx, fireReq.dy, fireReq.dz);
      dir = { x: fireReq.dx / len, y: fireReq.dy / len, z: fireReq.dz / len };
    }
    const tick = this.hvhTick;
    let viewTick = tick;
    if (command.clientTick !== undefined) viewTick = command.clientTick;
    else if (fireReq) viewTick = tick - Math.round(clamp(now - fireReq.t, 0, MAX_REWIND_MS) / TICK_MS);
    viewTick = Math.min(viewTick, tick);
    const w = WEAPONS[p.weapon];
    const spread = hvhSpread(hvhWeapon(w), p.state.horizontalSpeed, !p.state.onGround, p.aiming, p.weaponHeat) * (p.mods?.spread ?? 1);
    const bullet: PendingBullet = {
      seq: frame.seq,
      weaponId: fireReq && fireReq.weapon !== p.weapon ? fireReq.weapon : p.weapon,
      aim: { origin, dir },
      viewTick,
      ticksSinceLastShot: tick - s.lastShotTick,
      hammered: Math.max(0, s.hammerHold - 1),
      spread,
    };
    const targetPid = this.pickTarget(p, origin, dir, viewTick, bullet.weaponId, fireReq?.intent?.target);
    if (targetPid !== undefined) bullet.targetPid = targetPid;
    return bullet;
  }

  private isEnemy(p: ServerPlayer, pid: number): boolean {
    const t = this.players.get(pid);
    return !!t && t !== p && !this.areTeammates(p, t);
  }

  /**
   * R24 / R29: the first enemy body the un-deviated aim ray intersects, nearest along the ray,
   * traced against each enemy's lag record at the view tick (crouch scale), in both the real pose
   * and the pose this shooter's resolver would guess (peekResolve, pure; guessedPose as in
   * shot.ts), so a shot through only the fake body still names its target (a resolver miss).
   * `hint` (a client-named target) counts only when it is that body or when nothing is hit.
   */
  private pickTarget(p: ServerPlayer, origin: Vec3, dir: Vec3, viewTick: number, weaponId: string, hint?: number): number | undefined {
    const def = isWeaponId(weaponId) ? WEAPONS[weaponId] : undefined;
    const range = def ? hvhWeapon(def).range : 0;
    const ray = makeRay(origin, dir);
    const resolver = this.stateOf(p).resolver;
    let best: { pid: number; t: number } | undefined;
    for (const t of this.players.values()) {
      if (t === p || !t.alive || this.areTeammates(p, t)) continue;
      const records = this.stateOf(t).history.records();
      let record: LagRecord | undefined;
      for (let i = records.length - 1; i >= 0; i--) {
        if (records[i]!.tick <= viewTick) { record = records[i]; break; }
      }
      if (!record) continue;
      const side = peekResolve(resolver, String(t.pid), this.stateOf(t).observations, viewTick).side;
      for (const pose of [record.pose, guessedPose(record.pose, side)]) {
        const hit = rayHvhMatrix(ray, poseMatrix(record, pose), range);
        if (hit && (!best || hit.t < best.t)) best = { pid: t.pid, t: hit.t };
      }
    }
    if (best) return best.pid;
    return hint !== undefined && this.isEnemy(p, hint) ? hint : undefined;
  }

  private rejectReason(p: ServerPlayer, bullet: PendingBullet, n: 1 | 2, now: number): string | null {
    if (this.phase === 'ended' || this.actionsBlocked()) return 'actions blocked';
    if (bullet.weaponId !== p.weapon) return 'wrong weapon';
    if (now < p.switchReadyAt) return 'weapon switch';
    if (p.reloadUntil > 0) return 'reloading';
    if (p.mag <= 0) return 'no ammo';
    // The R8 pulls the hammer for bullet 1 only (DT bullet 2 rides the same pull).
    if (n === 1 && hammerTicks(WEAPONS[p.weapon]) > bullet.hammered) return 'hammer';
    return null;
  }

  private fireBullet(p: ServerPlayer, s: HvhPlayerV2, bullet: PendingBullet, n: 1 | 2, now: number): void {
    const tick = this.hvhTick;
    const target = bullet.targetPid !== undefined ? this.players.get(bullet.targetPid) : undefined;
    const reason = this.rejectReason(p, bullet, n, now);
    let verdict: ShotVerdict;
    if (reason !== null) {
      verdict = { shooterId: String(p.pid), tick, bullet: n, cause: 'rejected', reason };
      if (target) verdict.targetId = String(target.pid);
    } else {
      // Every v2 player wears armor and helmet (R44; every v2 spawn sets armor 100).
      const shotTarget: ShotTarget | undefined = target
        ? { id: String(target.pid), history: this.stateOf(target).history, alive: target.alive, hp: target.hp, armored: true }
        : undefined;
      verdict = processShot({
        shooterId: String(p.pid),
        tick,
        bullet: n,
        aim: bullet.aim,
        weaponId: bullet.weaponId,
        ticksSinceLastShot: bullet.ticksSinceLastShot,
        viewTick: bullet.viewTick,
        resolver: s.resolver,
        observations: target ? this.stateOf(target).observations : [],
        world: this.world2(),
        spreadSeed: shotSeed(p.pid, bullet.seq * 2 + n),
        spread: bullet.spread,
        ...(shotTarget ? { target: shotTarget } : {}),
      });
      // Exactly once per resolve: resolve ran iff the verdict carries `guessed`.
      if (verdict.guessed !== undefined && verdict.targetId !== undefined) {
        learnFromVerdict(s.resolver, verdict.targetId, verdict.guessed, verdict.cause);
      }
    }
    // Pulling the trigger drops the hammer, fired or rejected: the next shot needs a new pull (the
    // bots, which cannot see a rejection, count the same).
    if (n === 1) s.hammerHold = 0;
    // Bookkeeping for every shot that was really fired and traced (spawn-protected hits included).
    if (verdict.cause !== 'rejected') {
      const w = WEAPONS[p.weapon];
      if (shotUsesAmmo(w, p.mods)) p.mags.set(p.weapon, p.mag - 1);
      s.lastShotTick = tick;
      p.lastFireAt = now;
      p.shieldUntil = 0;
      p.weaponHeat = Math.min(3, p.weaponHeat + 0.25);
    }
    if (verdict.cause === 'hit' && target && now < target.shieldUntil) {
      verdict = { shooterId: String(p.pid), targetId: String(target.pid), tick, bullet: n, cause: 'rejected', reason: 'spawn protection' };
    }
    // R27: the verdict keeps `real` for the shooter too. The plan's hit-log copy ("Missed shot due
    // to resolver (guessed X, real Y)") needs it; the trade-off is that a shooter learns the
    // target's real side after each resolved shot (an oracle the in-game resolver never reads).
    this.emitVerdict(p, verdict, { target });
    if (verdict.cause === 'hit' && target && verdict.damage !== undefined) {
      this.damage(target, p, verdict.damage, verdict.hitgroup === 'head', p.weapon, bullet.aim.origin, now);
    }
  }

  /**
   * To the shooter, the target and spectators (players not alive), plus verdict listeners.
   * `senderOnly` (flood verdicts, R25): to the sender and listeners only.
   */
  private emitVerdict(shooter: ServerPlayer, v: ShotVerdict, opts: { target?: ServerPlayer; senderOnly?: boolean } = {}): void {
    for (const fn of this.verdictListeners) fn(v);
    const to = new Set<ServerPlayer>([shooter]);
    if (!opts.senderOnly) {
      if (opts.target) to.add(opts.target);
      for (const q of this.players.values()) if (!q.alive) to.add(q);
    }
    for (const q of to) q.socket?.emit('shotVerdict', v);
  }

  // ---------------------------------------------------------------------------
  // Rounds (v2)
  // ---------------------------------------------------------------------------

  /** Steps the round once per tick (after every shot) and applies what happened. */
  private updateRound(now: number): void {
    if (this.phase !== 'playing') {
      // Waiting for players: back to a fresh warmup (an ended match keeps its last round).
      if (this.phase !== 'ended' && (this.round.phase !== 'warmup' || this.round.endsAt !== null)) {
        this.round = hvhWarmup();
        this.emitRound();
      }
      return;
    }
    const alive = { 1: 0, 2: 0 };
    const players = { 1: 0, 2: 0 };
    for (const p of this.players.values()) {
      const team = p.info.team;
      if ((team !== 1 && team !== 2) || p.hvhPreparing) continue;
      players[team]++;
      if (p.alive) alive[team]++;
    }
    const before = this.round;
    const { state, events } = stepHvhRound(before, alive, players, now);
    if (state === before) return;
    this.round = state;
    for (const event of events) {
      switch (event) {
        case 'halftime':
          for (const p of this.players.values()) {
            if (p.info.team === 0) continue;
            p.info.team = p.info.team === 1 ? 2 : 1;
            this.announcePlayer(p);
          }
          this.swapTeamScores();
          this.systemMessage('HALF-TIME: teams have switched sides.');
          break;
        case 'roundStart':
          if (before.phase === 'warmup') this.restoreWarmupStats();
          this.startRound(now);
          break;
        case 'goLive':
          for (const p of this.players.values()) p.frozen = false;
          break;
        case 'roundEnd': {
          // In 'ended' state.winner is the match winner; the round winner is whose score went up.
          const winner = state.score[1] > before.score[1] ? 1 : state.score[2] > before.score[2] ? 2 : 0;
          if (winner !== 0) this.addTeamScore(winner, 1);
          const why = state.reason === 'time' ? 'more of them are alive' : 'the other team was wiped out';
          this.systemMessage(winner === 0 ? 'Round drawn.' : `${teamName(this.mode, winner)} win the round: ${why}.`);
          break;
        }
        case 'matchEnd':
          this.endMatch(now);
          break;
        case 'pause':
          // R70: warmup (free respawns) until both teams have players; the score, half, kills and deaths stay.
          this.systemMessage('A team has no players: warmup until both teams do. The score is kept.');
          this.snapshotWarmupStats();
          break;
      }
    }
    this.emitRound();
  }

  /** A warmup's frags do not count: the match stats are kept as the warmup began (M3). */
  private snapshotWarmupStats(): void {
    this.warmupStats = new Map([...this.players.values()].map((p) => [p.pid, { kills: p.info.kills, deaths: p.info.deaths, score: p.info.score, headshotKills: p.headshotKills }]));
  }

  private restoreWarmupStats(): void {
    for (const p of this.players.values()) {
      const s = this.warmupStats.get(p.pid);
      p.info.kills = s?.kills ?? 0;
      p.info.deaths = s?.deaths ?? 0;
      p.info.score = s?.score ?? 0;
      p.headshotKills = s?.headshotKills ?? 0;
    }
    this.warmupStats.clear();
    this.emitScores();
  }

  /** v2 rounds: the match goes on (paused in warmup, R70) while anyone is left, so a 1v1 refresh keeps it. */
  protected override keepsPlayingWith(n: number): boolean {
    return this.rounds ? n >= 1 : super.keepsPlayingWith(n);
  }

  /** A new round: everyone (but players still setting up) back at their team spawn, frozen. */
  private startRound(now: number): void {
    for (const p of this.players.values()) {
      if (p.hvhPreparing) continue;
      this.spawn(p, now, true);
      p.frozen = true;
    }
    this.projectiles.clear();
    this.onRoundStart(now);
  }

  /**
   * Every round start (freeze), after everyone has respawned (which re-applied their loadout).
   * Bots buy only: a random main and pistol each, from the room's seeded RNG.
   */
  protected onRoundStart(_now: number): void {
    for (const p of this.players.values()) {
      if (!p.info.bot || p.hvhPreparing) continue;
      this.setLoadout(p, [MAINS[Math.floor(this.random() * MAINS.length)]!, PISTOLS[Math.floor(this.random() * PISTOLS.length)]!]);
    }
  }

  // ---------------------------------------------------------------------------
  // Buy menu (v2)
  // ---------------------------------------------------------------------------

  /** v2: a free main or pistol from the HvH arsenal, in warmup and freeze only. */
  override handleBuy(p: ServerPlayer, itemId: unknown, now = performance.now()): BuyResult {
    if (!this.v2) return super.handleBuy(p, itemId, now);
    if (typeof itemId !== 'string' || !isWeaponId(itemId) || !isHvhArsenal(itemId)) return { ok: false, error: 'Not in the HvH arsenal.', money: 0 };
    if (this.round.phase !== 'warmup' && this.round.phase !== 'freeze') return { ok: false, error: 'Buying is closed.', money: 0 };
    const [main, pistol] = hvhLoadout(p.info.loadout);
    const next: [WeaponId, WeaponId] = MAINS.includes(itemId) ? [itemId, pistol] : [main, itemId];
    // A change refills magazines and is broadcast to the room, so it is rate limited; the same pick is free.
    const same = p.info.loadout.length === 2 && p.info.loadout[0] === next[0] && p.info.loadout[1] === next[1];
    if (!same && !this.stateOf(p).buyLimiter.take(1, now)) return { ok: false, error: 'Picking too fast.', money: 0 };
    this.setLoadout(p, next);
    return { ok: true, money: 0 };
  }

  /** New guns come loaded; the gun in hand stays out if it is still carried, else slot 0. */
  private setLoadout(p: ServerPlayer, next: [WeaponId, WeaponId]): void {
    const before = p.info.loadout;
    if (before.length === 2 && before[0] === next[0] && before[1] === next[1]) return;
    const slot = next.indexOf(p.weapon);
    p.info.loadout = next;
    for (const id of next) if (!before.includes(id)) p.mags.set(id, p.magazineSize(id));
    p.weaponSlot = Math.max(0, slot);
    if (slot < 0) p.reloadUntil = 0;
    // A player still joining is announced by join's playerJoined.
    if (this.players.has(p.pid)) this.announcePlayer(p);
  }

  /** A human joining a live round takes a dead bot's seat, so no living player leaves the round. */
  protected override removesDeadBotsFirst(): boolean {
    return this.rounds;
  }

  /** A team switch in freeze puts the player straight back into the round, on the new side. */
  protected override onTeamSwitched(p: ServerPlayer, now: number): void {
    if (!this.rounds || this.phase !== 'playing' || this.round.phase !== 'freeze' || p.hvhPreparing) return;
    this.spawn(p, now, true);
    p.frozen = true;
  }

  /** Public v2 rooms fill to a full 5v5. */
  protected override botFillTarget(): number {
    return this.v2 ? 10 : super.botFillTarget();
  }

  private emitRound(): void {
    this.io.to(this.channel).emit('round', roundEvent(this.round));
  }

  protected override onMatchStart(now: number): void {
    super.onMatchStart(now);
    if (!this.rounds) return;
    this.round = hvhWarmup();
    this.warmupStats.clear();
    this.emitRound();
  }

  /** Freeze keeps everyone frozen (the HvH rules clear `frozen` every tick otherwise). */
  override enforceHvhRules(p: ServerPlayer): void {
    super.enforceHvhRules(p);
    if (this.rounds && this.round.phase === 'freeze') p.frozen = true;
  }

  protected override actionsBlocked(): boolean {
    return this.freezing() || super.actionsBlocked();
  }

  /** The v2 round's freeze time (the buy phase): nobody moves or shoots. */
  private freezing(): boolean {
    return this.rounds && this.round.phase === 'freeze';
  }

  /** Respawns in warmup and freeze only (and while no match is on); the dead watch the round. */
  protected override mayRespawn(p: ServerPlayer): boolean {
    if (!this.rounds || this.phase !== 'playing') return super.mayRespawn(p);
    return this.round.phase === 'warmup' || this.round.phase === 'freeze';
  }

  protected override scoresTeamKills(): boolean {
    return !this.rounds && super.scoresTeamKills();
  }

  protected override matchTimeLimitMs(): number {
    return this.rounds ? 0 : super.matchTimeLimitMs();
  }

  /** The rounds end the match (rounds.ts); there is no kill limit. */
  protected override checkScoreLimit(now: number): void {
    if (!this.rounds) super.checkScoreLimit(now);
  }

  /** No team at 13 is a draw, even after 24 rounds with one team ahead. */
  protected override matchWinnerTeam(): Team {
    return this.rounds ? this.round.winner : super.matchWinnerTeam();
  }

  protected override armorAbsorbs(): boolean {
    return !this.v2 && super.armorAbsorbs();
  }

  protected override joinExtras(player: ServerPlayer) {
    return this.rounds ? { ...super.joinExtras(player), round: roundEvent(this.round) } : super.joinExtras(player);
  }

  /** Joining a live round (or its end banner): watch until the next round starts. */
  protected override onPlayerJoin(p: ServerPlayer, now: number): void {
    super.onPlayerJoin(p, now);
    if (this.rounds && this.phase === 'playing' && (this.round.phase === 'live' || this.round.phase === 'over')) p.alive = false;
  }

  // ---------------------------------------------------------------------------
  // Life cycle
  // ---------------------------------------------------------------------------

  protected override onPlayerDeath(victim: ServerPlayer, now: number): void {
    super.onPlayerDeath(victim, now);
    if (!this.v2) return;
    const s = this.stateOf(victim);
    s.pendingBullet = null;
    this.blockPendingFires(victim, s);
    s.tickbase = EMPTY_TICKBASE(this.hvhTick);
  }

  /** R26: fire requests still waiting when a life ends are answered, not dropped. */
  private blockPendingFires(p: ServerPlayer, s: HvhPlayerV2): void {
    for (const f of s.pendingFires.splice(0)) {
      p.lastShotSeq = Math.max(p.lastShotSeq, f.shot);
      this.emitVerdict(p, this.rejected(p, 'actions blocked'));
    }
  }

  protected override spawn(p: ServerPlayer, now: number, announce: boolean): void {
    if (!this.v2) return super.spawn(p, now, announce);
    // Before the respawn, so it fills these magazines.
    this.setLoadout(p, hvhLoadout(p.info.loadout));
    super.spawn(p, now, announce);
    p.eggs = p.smokes = p.flashes = 0;
    const s = this.stateOf(p);
    // A new life: no charge, a fresh pose and lag records (the resolver keeps what it learned).
    s.queue.length = 0;
    s.budget = this.era.maxProcessTicks;
    s.silentTicks = 0;
    s.hammerHold = 0;
    s.hammerWeapon = null;
    s.tickbase = EMPTY_TICKBASE(this.hvhTick);
    s.pose = INITIAL_POSE;
    s.history = new RecordHistory(this.era, PLAYER_HULL_WIDTH);
    s.observations = [];
    s.lastShotTick = -Infinity;
    this.blockPendingFires(p, s);
    s.pendingBullet = null;
    s.lastRecordTick = -Infinity;
    s.publicState = null;
    // Armor and helmet on every v2 life (R44).
    p.armor = PLAYER.maxArmor;
  }

  protected override onPlayerLeave(player: ServerPlayer): void {
    super.onPlayerLeave(player);
    this.debugViewers.delete(player.pid);
    this.v2Players.delete(player.pid);
  }
}
