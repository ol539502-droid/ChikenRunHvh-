/*
 * Gate (R39): client tickbase prediction holds up on bad networks. The seeded 5v5 match runs with
 * the real NetworkSimulator between each client's emit path and the room, under every latency /
 * jitter / loss configuration the codebase defines, and reconciles on hvhState. Per player:
 * no uncaught errors and PredictedTickbase.mismatches / ticks < 0.01.
 *
 * GameSession (three.js, DOM, sockets) is too heavy to run headless, so its HvH build, emit and
 * reconcile path (GameSession.ts tick loop, enemyInSight and markShot / fire, LocalPlayer.predict /
 * command / emitted / reconcile / onHvhState) is replayed with the same exported pieces, unmodified:
 *   shared  fakeLagTicks, CommandChoker (wouldHold / push), NetworkSimulator (send / receive), LATE_CSGO.maxChoke,
 *           enemyVisible, movementSteps, holdForCharge, stepPlayer, unpackPlayer
 *   client  commandIntent, shotReference, TickClock, PredictedTickbase (peek and apply when a command
 *           is built, reconcile on hvhState)
 * The only glue written here is the wiring between them, in GameSession's order. As on the real
 * client, sight comes from the latest 20 Hz snapshot (room.snapshotFor, delivered after the
 * tick's hvhState): the enemies it shows (snapshotSightTargets) from our own predicted eye, and
 * the command names that snapshot (sightT) so the server traces the same list (R56).
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  CommandChoker, INTERP_DELAY_MS, NetworkSimulator, SIM_DT, SNAPSHOT_RATE, copyMoveState, createMoveState, defaultHvhCore,
  exploitMode, eyeHeightOf, fakeLagTicks, hopMaxFor, moveSpeedFor, stepPlayer, unpackPlayer, WEAPONS,
  type HvhStateEvent, type InputCommand, type InputFrame, type MoveState, type NetworkConfig, type WorldSnapshot,
} from '@game/shared';
import { LATE_CSGO, enemyVisible, holdForCharge, movementSteps, snapshotSightTargets, type SightTarget } from '@game/shared/hvh/v2';
import { NO_SIGHT, PredictedTickbase, TickClock, commandIntent, shotReference } from '../../../client/src/hvh/PredictedTickbase';
import type { HvhRoom } from '../../src/rooms/HvhRoom';
import type { ServerPlayer } from '../../src/rooms/ServerPlayer';
import { stepRoom } from '../helpers';
import { CLOCK_BASE, Script, TICK_MS, makeMatch, prng, type ScriptOptions } from './hvhMatch';

const TICKS = 2_000;
const SEED = 0x5eed13;

/**
 * Every latency / jitter / loss configuration defined in the codebase (there is no named profile
 * table): the default practice connection (defaultHvhCore), the HvH benchmark's link
 * (server/src/tools/hvhBenchmark.ts), the NetworkSimulator unit test's link (shared/test/hvh-core.test.ts),
 * and the panel maxima sanitizeHvhLoadout allows (latency 150, jitter 50, loss 0.1).
 */
const core = defaultHvhCore();
const PROFILES: Record<string, NetworkConfig> = {
  'default (off)': { latencyMs: core.latencyMs, jitterMs: core.jitterMs, loss: core.packetLoss },
  'benchmark 35/12/2%': { latencyMs: 35, jitterMs: 12, loss: 0.02 },
  'unit test 50/0/0%': { latencyMs: 50, jitterMs: 0, loss: 0 },
  'panel max 150/50/10%': { latencyMs: 150, jitterMs: 50, loss: 0.1 },
};

interface Client {
  choker: CommandChoker;
  network: NetworkSimulator<readonly InputCommand[]>;
  tickbase: PredictedTickbase;
  clock: TickClock;
  hvhV2: boolean;
  nextSeq: number;
  shotSeq: number;
  shotCommand: number | null;
  /** Server ack from the last hvhState (the snapshot ack in GameSession). */
  ack: number;
  read: number;
  reconciles: number;
  /** LocalPlayer's predicted movement and its unacknowledged inputs (with their movement steps). */
  move: MoveState;
  pending: { frame: InputFrame; steps: number }[];
  /** The latest snapshot's `t` and living enemies (GameSession.sightView), and the own frozen flag. */
  sightT: number | undefined;
  view: SightTarget[];
  frozen: boolean;
  /** A snapshot sent after the last tick, read with that tick's other events. */
  snapshot: WorldSnapshot | null;
}

const SNAPSHOT_MS = 1000 / SNAPSHOT_RATE;

/**
 * A deathier match: about one death per player every 300 ticks. The scripts charge and fire more,
 * but at high latency most shots fall outside the unlag window, so the harness also adds a seeded
 * world hazard (lethal 'world' damage through GameRoom.damage, like a fall), so every profile
 * crosses the same number of life boundaries (death -> dead commands -> respawn).
 */
const DEATHY: ScriptOptions = { charge: true, aimNoise: 0, fireChance: 0.6 };
const HAZARD_PER_ALIVE_TICK = 1 / 110;

/** LocalPlayer.step: `steps` normal movement steps; 0 is the charging stop; frozen moves nothing. */
function predictStep(room: HvhRoom, p: ServerPlayer, c: Client, frame: InputFrame, steps: number): void {
  if (c.frozen) { c.move.horizontalSpeed = 0; return; }
  if (steps === 0) return holdForCharge(c.move);
  for (let i = 0; i < steps; i++) stepPlayer(c.move, frame, SIM_DT, room.world, p.moveMods(), hopMaxFor(p.weapon), moveSpeedFor(p.weapon), true);
}

/** GameSession.onSnapshot: the remotes' latest states, and LocalPlayer.reconcile (rewind and replay). */
function readSnapshot(room: HvhRoom, p: ServerPlayer, c: Client, snap: WorldSnapshot): void {
  c.sightT = snap.t;
  c.view = snapshotSightTargets(snap.p, (pid) => pid !== p.pid && room.players.get(pid)?.info.team !== p.info.team);
  for (const packed of snap.p) {
    const s = unpackPlayer(packed);
    if (s.pid === p.pid) {
      c.frozen = s.frozen === true;
      copyMoveState(s, c.move);
      c.pending = s.alive ? c.pending.filter((e) => e.frame.seq > s.ack) : [];
      for (const e of c.pending) predictStep(room, p, c, e.frame, (c.hvhV2 ? c.tickbase.stepsFor(e.frame.seq) : undefined) ?? e.steps);
    }
  }
}

/** `lifeResets` false skips the kill / spawn wiring (LocalPlayer.onOwnDeath / respawnAt), to measure what it fixes. */
function runProfile(config: NetworkConfig, script: ScriptOptions = {}, lifeResets = true, hazard = 0) {
  const { room, players, sent, events } = makeMatch(SEED, { sockets: true });
  try {
    const scripts = players.map((_, i) => new Script(SEED * 31 + i, script));
    let broadcastsRead = events.length;
    const hazards = players.map((p) => prng(SEED ^ (p.pid * 0x9e37)));
    const clients: Client[] = players.map((p) => ({
      choker: new CommandChoker(), network: new NetworkSimulator(config, p.pid), tickbase: new PredictedTickbase(), clock: new TickClock(),
      hvhV2: false, nextSeq: 1, shotSeq: 0, shotCommand: null, ack: 0, read: 0, reconciles: 0,
      move: copyMoveState(p.state, createMoveState(0, 0, 0)), pending: [], sightT: undefined, view: [], frozen: false, snapshot: null,
    }));
    let nextSnapshot = CLOCK_BASE + SNAPSHOT_MS;
    let sentCommands = 0;
    let executed = 0;
    for (let tick = 1; tick <= TICKS; tick++) {
      const now = CLOCK_BASE + tick * TICK_MS;
      // Room broadcasts of the last tick, which a socket delivers before that tick's hvhState:
      // our own kill -> LocalPlayer.onOwnDeath, our own spawn -> LocalPlayer.respawnAt (v2 only).
      for (; broadcastsRead < events.length; broadcastsRead++) {
        const e = events[broadcastsRead]!;
        const data = e.args[0] as { victim?: number; pid?: number; x?: number; y?: number; z?: number };
        const i = players.findIndex((p) => p.pid === (e.event === 'kill' ? data.victim : e.event === 'spawn' ? data.pid : -1));
        const c = clients[i];
        // LocalPlayer.respawnAt: a fresh movement state at the spawn point.
        if (c && e.event === 'spawn') { copyMoveState(createMoveState(data.x ?? 0, data.y ?? 0, data.z ?? 0), c.move); c.pending = []; }
        if (!c || !c.hvhV2 || !lifeResets) continue;
        if (e.event === 'kill') c.tickbase.reset(undefined, false);
        else c.tickbase.reset();
      }
      players.forEach((p, i) => {
        const c = clients[i]!;
        // Socket events since the last frame (GameSession.bindNetwork: hvhState -> TickClock, LocalPlayer.onHvhState).
        const sink = sent.get(p.pid)!;
        for (; c.read < sink.length; c.read++) {
          const e = sink[c.read]!;
          if (e.event !== 'hvhState') continue;
          const state = e.data as HvhStateEvent;
          c.clock.sample(state.tick, now);
          c.hvhV2 = true;
          c.ack = state.lastAckSeq;
          c.tickbase.reconcile(state.tickbase, state.lastAckSeq);
          c.reconciles++;
        }
        if (c.snapshot) { readSnapshot(room, p, c, c.snapshot); c.snapshot = null; }
        if (p.alive) {
          // One fixed step of GameSession's tick loop.
          const seq = c.nextSeq;
          const step = scripts[i]!.step(room, p, seq, now);
          const def = WEAPONS[p.weapon];
          if (step.fire) {
            // GameSession.fire / markShot: the fire message leaves at once (not through the simulated link).
            const ref = shotReference(c.hvhV2 && !def.melee && !def.projectile, c.nextSeq, c.ack);
            c.shotCommand = ref.shotSeq;
            if (ref.shotSeq !== null) c.tickbase.shot(ref.shotSeq);
            const dir = { x: -Math.sin(step.frame.yaw) * Math.cos(step.frame.pitch), y: Math.sin(step.frame.pitch), z: -Math.cos(step.frame.yaw) * Math.cos(step.frame.pitch) };
            room.handleFire(p, { shot: ++c.shotSeq, weapon: p.weapon, dx: dir.x, dy: dir.y, dz: dir.z, t: now - INTERP_DELAY_MS, command: ref.command, aiming: false });
          }
          const frame = { ...step.frame, seq: c.nextSeq++ };
          const hvh = { ...core, fakeLag: step.fakeLag };
          const maxChoke = c.hvhV2 ? LATE_CSGO.maxChoke : undefined;
          const choke = fakeLagTicks(hvh, frame.seq, p.state.horizontalSpeed, step.fire, maxChoke);
          const flush = hvh.fakeLagBreakOnShot && step.fire;
          const hitscan = !def.melee && !def.projectile;
          const exploit = exploitMode(step.exploit, def, p.mag);
          // LocalPlayer.predict: the movement of the tickbase action, with the sight from our predicted
          // eye and the snapshot's enemies (GameSession.enemyInSight).
          let ctx = NO_SIGHT;
          const draft = commandIntent({ seq: frame.seq, shotSeq: c.shotCommand, hitscan, held: false, exploit });
          if (c.hvhV2 && c.tickbase.needsSight(frame.seq, draft)) {
            ctx = { enemyVisible: enemyVisible({ x: c.move.x, y: c.move.y + eyeHeightOf(c.move), z: c.move.z }, c.view, room.world) };
          }
          const steps = c.hvhV2 ? movementSteps(c.tickbase.peek(frame.seq, draft, ctx)) : 1;
          predictStep(room, p, c, frame, steps);
          c.pending.push({ frame, steps });
          const intent = commandIntent({
            seq: frame.seq, shotSeq: c.shotCommand, hitscan,
            held: c.choker.wouldHold(choke, flush, maxChoke), exploit,
          });
          // LocalPlayer.command: the tickbase is predicted when the command is built.
          if (c.hvhV2) c.tickbase.apply(frame.seq, intent, ctx);
          const command: InputCommand = { ...frame, intent, clientTick: c.clock.viewedTick(now - INTERP_DELAY_MS) };
          if (c.sightT !== undefined) command.sightT = c.sightT;
          const batch = c.choker.push(command, choke, flush, maxChoke);
          if (batch.length) c.network.send(batch, now);
        }
        // After the loop: whatever the simulated link delivers now goes out (LocalPlayer.emitted).
        for (const batch of c.network.receive(now)) {
          for (const cmd of batch) {
            const lost = c.hvhV2 && cmd.intent ? c.tickbase.sent(cmd.seq) : [];
            if (lost.length) c.pending = c.pending.filter((e) => !lost.includes(e.frame.seq));
            room.handleInput(p, cmd);
            sentCommands++;
          }
        }
      });
      players.forEach((p, i) => {
        if (p.alive && hazards[i]!() < hazard) room.damage(p, null, 1000, false, 'world', { x: p.state.x, y: p.state.y, z: p.state.z }, now);
      });
      stepRoom(room, now);
      for (const p of players) executed += room.v2State(p.pid)!.executed;
      // The snapshot timer runs between ticks, after the tick's hvhState (GameRoom.broadcastSnapshot).
      if (now >= nextSnapshot) {
        nextSnapshot += SNAPSHOT_MS;
        players.forEach((p, i) => { clients[i]!.snapshot = room.snapshotFor(p, now); });
      }
    }
    return { players, clients, sentCommands, executed, issued: clients.reduce((n, c) => n + c.nextSeq - 1, 0), deaths: players.map((p) => p.info.deaths) };
  } finally {
    room.close();
  }
}

describe('HvH v2 network gate', () => {
  for (const [label, script] of [['', {}], [' (deathy match)', DEATHY]] as const)
  for (const [profile, config] of Object.entries(PROFILES)) {
    const name = profile + label;
    it(`prediction holds under ${name}`, () => {
      const run = runProfile(config, script, true, script === DEATHY ? HAZARD_PER_ALIVE_TICK : 0);
      if (script === DEATHY) {
        const mean = run.deaths.reduce((a, b) => a + b, 0) / run.deaths.length;
        assert.ok(mean >= TICKS / 300 * 0.8, `${name}: about one death per player every 300 ticks (mean ${mean} deaths in ${TICKS} ticks)`);
      }
      if (config.loss > 0) assert.ok(run.sentCommands < run.issued, `${name}: some commands were lost (${run.sentCommands} of ${run.issued} arrived)`);
      // Dead players send nothing: the deathy match runs fewer commands (players are alive about a third of the time).
      assert.ok(run.executed > TICKS * (script === DEATHY ? 2 : 5), `${name}: the room executed ${run.executed} commands`);
      const ratios = run.players.map((p, i) => {
        const c = run.clients[i]!;
        assert.ok(c.reconciles > TICKS / 10, `${name}: player ${p.pid} reconciled ${c.reconciles} times`);
        return c.tickbase.mismatches / TICKS;
      });
      console.log(`[hvhNetwork] ${name}: deaths ${run.deaths.join(' ')}; mismatches/ticks per player ${ratios.map((r) => r.toFixed(4)).join(' ')}`);
      ratios.forEach((r, i) => assert.ok(r < 0.01, `${name}: player ${run.players[i]!.pid} mismatches / ticks = ${r}`));
    });
  }
});
