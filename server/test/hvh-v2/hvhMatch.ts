/*
 * Headless, seeded 5v5 HvH v2 match for the Task 13 gates (replay and network).
 *
 * HvH rooms have no bots, so ten scripted players (two teams of five) drive the room through its
 * real command path (handleInput -> queue -> processPlayerTick). Every script decision comes from
 * a seeded PRNG and the authoritative state the script can see, so the same seed always produces
 * the same commands as long as the room itself is deterministic.
 *
 * The driver owns the clock: every tick is stepped with an explicit `now` (base + tick * TICK_MS),
 * and every message that takes a time (reload) is given that same clock.
 */
import { DEFAULT_APPEARANCE, DEFAULT_LOADOUT, SIM_DT, type HvhStanceAntiAim, type InputFrame, type MapId, type MoveState } from '@game/shared';
import { V2_STANCES, type CommandIntent, type PoseState, type TickbaseState } from '@game/shared/hvh/v2';
import { HvhRoom, type HvhPlayerV2 } from '../../src/rooms/HvhRoom';
import type { ServerPlayer } from '../../src/rooms/ServerPlayer';
import { fakeIo, type RecordedEvent } from '../helpers';

export const TICK_MS = SIM_DT * 1000;
export const CLOCK_BASE = 1_000_000;

/** mulberry32: small, fast, and identical on every platform. */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Match {
  room: HvhRoom;
  players: ServerPlayer[];
  /** Per-player socket sinks (only when `sockets` was requested). */
  sent: Map<number, { event: string; data: unknown }[]>;
  /** Room broadcasts (fakeIo). */
  events: RecordedEvent[];
}

/**
 * Socket-less players (by default ten, five per team; `teams` lists each player's team instead),
 * spawned, AA tools on, input limiter stubbed (R25). The balance sweep (tools/hvh-sweep.ts) builds
 * its 1v1 duels with `teams: [1, 2]`.
 *
 * The round flow is off unless `rounds` is set: the room stays in warmup (free respawns, no
 * freeze), so the replay and network gates and the sweep measure the per-tick pipeline as before.
 */
export function makeMatch(seed: number, opts: { map?: MapId; sockets?: boolean; teams?: readonly (1 | 2)[]; rounds?: boolean } = {}): Match {
  const { io, events } = fakeIo();
  const room = new HvhRoom(io, {
    id: `hvh-gate-${seed}`, code: 'GATE1', name: 'HvH gate', mode: 'hvh', map: opts.map ?? 'farm', private: true, hvhEngine: 'v2', seed,
    hvhRounds: opts.rounds === true,
  }, {});
  const players: ServerPlayer[] = [];
  const sent = new Map<number, { event: string; data: unknown }[]>();
  const teams = opts.teams ?? [1, 1, 1, 1, 1, 2, 2, 2, 2, 2];
  for (let i = 0; i < teams.length; i++) {
    const res = room.join(null, { userId: null, name: `P${i}`, appearance: { ...DEFAULT_APPEARANCE }, loadout: [...DEFAULT_LOADOUT], team: teams[i]! });
    if (!res.ok) throw new Error(res.error);
    const p = room.players.get(res.selfPid)!;
    p.takeInputToken = () => true;
    p.hvhEnabled = true;
    p.hvh.antiAim = { ...p.hvh.antiAim, enabled: true };
    if (opts.sockets) {
      const sink: { event: string; data: unknown }[] = [];
      sent.set(p.pid, sink);
      const socket = { emit(event: string, data: unknown) { sink.push({ event, data }); }, to() { return { emit() {} }; }, leave() {}, volatile: { emit() {} } };
      Object.defineProperty(p, 'socket', { value: socket });
    }
    players.push(p);
  }
  room.startNow(CLOCK_BASE);
  return { room, players, sent, events };
}

/** What a script wants for one command. */
export interface ScriptStep {
  frame: InputFrame;
  /** This command carries a hitscan shot. */
  fire: boolean;
  exploit: 'off' | 'doubleTap' | 'hideShots';
  /** Replay gate: this command is a choke command. */
  choke: boolean;
  /** Network gate: the fake-lag setting (choke ticks) the client's CommandChoker uses. */
  fakeLag: number;
}

/** Deathier matches: walk at the target (frames carry the aim yaw), aim tighter, fire more. */
export interface ScriptOptions { charge?: boolean; aimNoise?: number; fireChance?: number }

const AA_MODES = ['backward', 'left', 'right', 'spin'] as const;
const JITTERS = [0, 20, 45];
const DESYNCS = [0, 30, 58];
const EXPLOITS = ['off', 'doubleTap', 'hideShots'] as const;
const FAKE_LAGS = [0, 0, 4, 14];
const YAW_OFFSETS = [-30, 0, 0, 45];
const DEFENSIVE_PITCHES = ['down', 'up', 'zero', 'random', 'jitter'] as const;
const DEFENSIVE_YAWS = ['off', 'flick', 'spin', 'random', 'sideways'] as const;

/**
 * A seeded script for one player: moves, aims at the nearest living enemy, fires, chokes, uses
 * DT / HS (charging, bursting and releasing), and toggles jitter / desync / inverted AA. Reads
 * only state a client sees.
 */
export class Script {
  private readonly rand: () => number;
  private forward = 0;
  private right = 0;
  private moveLeft = 0;
  private chokeLeft = 0;
  private exploit: ScriptStep['exploit'] = 'off';
  private fakeLag = 0;
  private invert = false;
  /** Per-stance AA, defensive patterns and slow walk: a stream of their own, so the other decisions keep their sequence. */
  private readonly aaRand: () => number;

  constructor(seed: number, private readonly opts: ScriptOptions = {}) {
    this.rand = prng(seed);
    this.aaRand = prng(seed ^ 0x5a5a5a5a);
  }

  private pick<T>(xs: readonly T[], r = this.rand): T {
    return xs[Math.floor(r() * xs.length)]!;
  }

  /** A per-stance config (loadout.v2AntiAim), each stance with its own defensive pattern, often off. */
  private stanceAntiAim(): HvhStanceAntiAim {
    const r = this.aaRand;
    const out = { stances: {}, defensive: {} } as HvhStanceAntiAim;
    for (const s of V2_STANCES) {
      out.stances[s] = { base: this.pick(AA_MODES, r), yawOffsetDeg: this.pick(YAW_OFFSETS, r), jitterDeg: this.pick(JITTERS, r), desyncDeg: this.pick(DESYNCS, r) };
      out.defensive[s] = {
        enabled: r() < 0.6, inAir: r() < 0.5, onPeek: r() < 0.6, always: r() < 0.15,
        pitch: this.pick(DEFENSIVE_PITCHES, r), yaw: this.pick(DEFENSIVE_YAWS, r),
      };
    }
    return out;
  }

  /** Called once per tick before the command; may change the AA config (the client's loadout message). */
  step(room: HvhRoom, p: ServerPlayer, seq: number, now: number): ScriptStep {
    const r = this.rand;
    // The own charge, as the client's hvhState shows it.
    const charge = room.tickbaseOf(p.pid)?.charge ?? 0;
    const full = charge >= room.era.chargeTicks;
    if (this.moveLeft-- <= 0) {
      this.moveLeft = 20 + Math.floor(r() * 40);
      this.forward = this.opts.charge ? 1 : this.pick([-1, 0, 1, 1]);
      this.right = this.pick([-1, 0, 1]);
    }
    if (r() < 0.006) this.exploit = this.pick(EXPLOITS);
    // Now and then turn the exploit off with a full charge: a release burst.
    if (this.exploit !== 'off' && full && r() < 0.02) this.exploit = 'off';
    if (r() < 0.006) this.fakeLag = this.pick(FAKE_LAGS);
    if (r() < 0.007) {
      p.hvh.antiAim = { ...p.hvh.antiAim, enabled: true, mode: this.pick(AA_MODES), jitter: this.pick(JITTERS), desync: this.pick(DESYNCS) };
      // Half the time per-stance AA with defensive patterns; otherwise the single legacy stance.
      p.hvh.v2AntiAim = this.aaRand() < 0.5 ? this.stanceAntiAim() : undefined;
    }
    if (r() < 0.03) this.invert = !this.invert;

    // Aim at the nearest living enemy (positions are what snapshots show), with a little noise.
    const eye = room.eyeOf(p);
    let best: ServerPlayer | undefined;
    let bestD = Infinity;
    for (const q of room.players.values()) {
      if (q === p || !q.alive || q.info.team === p.info.team) continue;
      const d = Math.hypot(q.state.x - eye.x, q.state.z - eye.z);
      if (d < bestD) { bestD = d; best = q; }
    }
    let yaw = (r() * 2 - 1) * Math.PI;
    let pitch = 0;
    if (best) {
      const dx = best.state.x - eye.x;
      const dy = best.state.y + 0.6 + r() * 0.5 - eye.y;
      const dz = best.state.z - eye.z;
      yaw = Math.atan2(-dx, -dz) + (r() - 0.5) * (this.opts.aimNoise ?? 0.06);
      pitch = Math.asin(dy / Math.hypot(dx, dy, dz));
    }

    // With DT / HS on, mostly hold fire while the charge fills: a shot then would only lose the
    // partial charge (a reject), so most charges reach a burst.
    const charging = this.exploit !== 'off' && charge > 0 && !full;
    let fire = false;
    if (p.mag <= 0) room.handleReload(p, now);
    else if (best && p.reloadUntil === 0 && r() < (this.opts.fireChance ?? 0.2)) fire = !charging || r() < 0.03;
    if (this.chokeLeft <= 0 && r() < 0.03) this.chokeLeft = 1 + Math.floor(r() * 14);
    const choke = this.chokeLeft-- > 0 && !fire;

    const frame: InputFrame = {
      seq, forward: this.forward, right: this.right, jump: r() < 0.02, crouch: r() < 0.1, yaw, pitch, invert: this.invert,
      slowWalk: this.aaRand() < 0.15,
    };
    return { frame, fire, exploit: this.exploit, choke, fakeLag: this.fakeLag };
  }
}

export function intentOf(s: ScriptStep): CommandIntent {
  return { fire: s.fire, choke: s.choke, doubleTap: s.exploit === 'doubleTap', hideShots: s.exploit === 'hideShots' };
}

/** What the room did for one player in one processPlayerTick call. */
export interface PlayerTickRecord {
  aliveBefore: boolean;
  tickbaseBefore: TickbaseState;
  poseBefore: PoseState;
  /** Movement state before the tick (the client's reconciled movement). */
  stateBefore: MoveState;
  executed: { frame: InputFrame; intent: CommandIntent }[];
  /** The enemyVisible the server stepped each executed command with (HvhPlayerV2.sight). */
  sight: boolean[];
  stateAfter: MoveState;
  tickbaseAfter: TickbaseState;
  poseAfter: PoseState;
  antiAim: ServerPlayer['hvh']['antiAim'];
  /** The per-stance AA the pose was stepped with (absent: antiAim on every stance). */
  v2AntiAim?: HvhStanceAntiAim;
  /** HvhPlayerV2.aaSeed. */
  aaSeed: number;
  /** The peekTicksLeft the server stepped each executed command's pose with (HvhPlayerV2.peek). */
  peek: number[];
  /** The on-peek flick side of each executed command (HvhPlayerV2.peekSides). */
  peekSides: (1 | -1)[];
  weapon: ServerPlayer['weapon'];
}

/**
 * Wraps the processPlayerTick seam: records the commands each call executed (the head of the
 * queue, in order) and the tickbase / pose around it. Pure observation; the room is unchanged.
 */
export function recordTicks(room: HvhRoom, sink: (pid: number, r: PlayerTickRecord) => void): void {
  const original = room.processPlayerTick.bind(room);
  room.processPlayerTick = (playerId: string, now?: number) => {
    const p = room.players.get(Number(playerId))!;
    const s = room.v2State(p.pid) as HvhPlayerV2;
    const queued = s.queue.map((c) => ({ frame: { ...c.frame }, intent: { ...c.intent } }));
    const before = {
      aliveBefore: p.alive, tickbaseBefore: { ...s.tickbase }, poseBefore: { ...s.pose }, stateBefore: structuredClone(p.state),
      antiAim: { ...p.hvh.antiAim }, v2AntiAim: p.hvh.v2AntiAim && structuredClone(p.hvh.v2AntiAim), aaSeed: s.aaSeed, weapon: p.weapon,
    };
    original(playerId, now);
    sink(p.pid, { ...before, executed: queued.slice(0, s.executed), sight: [...s.sight], peek: [...s.peek], peekSides: [...s.peekSides], stateAfter: structuredClone(p.state), tickbaseAfter: { ...s.tickbase }, poseAfter: { ...s.pose } });
  };
}
