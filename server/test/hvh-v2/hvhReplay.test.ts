/*
 * Gate (R39): a seeded 5v5 match of 2,000 ticks is bit-identical when replayed through the server
 * (a fresh room, the same seed, the same scripts) and through client prediction (each player's
 * executed command intents through PredictedTickbase, and through the shared stepPose with each
 * stance's AA and defensive pattern and the on-peek window the server stepped it with).
 */
import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { SIM_DT, createCollisionWorld, defaultHvhLoadout, hopMaxFor, hvhPitch, moveSpeedFor, MAPS, PLAYER, clamp, stanceAntiAimFrom, stepPlayer, type MoveState } from '@game/shared';
import {
  INITIAL_POSE, LATE_CSGO, PEEK_TICKS, defensiveActive, holdForCharge, stanceOf, movementSteps, stepPose, stepTickbase, type PoseState, type ShotVerdict, type TickbaseState,
} from '@game/shared/hvh/v2';
import { PredictedTickbase } from '../../../client/src/hvh/PredictedTickbase';
import { stepRoom } from '../helpers';
import { CLOCK_BASE, Script, TICK_MS, intentOf, makeMatch, recordTicks, type PlayerTickRecord } from './hvhMatch';

const TICKS = 2_000;
const SEED = 0x5eed13;
const MAP = 'farm' as const;

interface Run {
  /** Per tick, per player (pid order): the state at the end of the server tick. */
  ticks: { tickbase: TickbaseState; pose: PoseState; x: number; y: number; z: number; hp: number; alive: boolean }[][];
  /** Per player: every processPlayerTick call, in order. */
  records: Map<number, PlayerTickRecord[]>;
  verdicts: ShotVerdict[];
  kills: number[];
  /** Per player: the ticks in which the server spawned them (a 'spawn' broadcast); a new life starts next tick. */
  spawns: Map<number, Set<number>>;
}

function runMatch(seed: number): Run {
  const { room, players, events } = makeMatch(seed, { map: MAP });
  try {
    const records = new Map<number, PlayerTickRecord[]>(players.map((p) => [p.pid, []]));
    recordTicks(room, (pid, r) => records.get(pid)!.push(r));
    const verdicts: ShotVerdict[] = [];
    room.addVerdictListener((v) => verdicts.push(structuredClone(v)));
    const scripts = players.map((_, i) => new Script(seed * 31 + i));
    const seqs = players.map(() => 0);
    // Choke commands are held back and leave in one batch with the next sent command (the client's CommandChoker).
    const held: object[][] = players.map(() => []);
    const ticks: Run['ticks'] = [];
    const spawns = new Map<number, Set<number>>(players.map((p) => [p.pid, new Set()]));
    let seen = events.length;
    for (let tick = 1; tick <= TICKS; tick++) {
      const now = CLOCK_BASE + tick * TICK_MS;
      players.forEach((p, i) => {
        if (!p.alive) { held[i]!.length = 0; return; } // the client only sends commands while alive (GameSession)
        const step = scripts[i]!.step(room, p, ++seqs[i]!, now);
        held[i]!.push({ ...step.frame, intent: intentOf(step) });
        if (step.choke) return;
        for (const command of held[i]!.splice(0)) room.handleInput(p, command);
      });
      stepRoom(room, now);
      for (; seen < events.length; seen++) {
        const e = events[seen]!;
        if (e.event === 'spawn') spawns.get((e.args[0] as { pid: number }).pid)!.add(tick);
      }
      ticks.push(players.map((p) => {
        const s = room.v2State(p.pid)!;
        return { tickbase: { ...s.tickbase }, pose: { ...s.pose }, x: p.state.x, y: p.state.y, z: p.state.z, hp: p.hp, alive: p.alive };
      }));
    }
    return { ticks, records, verdicts, kills: players.map((p) => p.info.kills), spawns };
  } finally {
    room.close();
  }
}

describe('HvH v2 determinism gate', () => {
  let first: Run;
  before(() => { first = runMatch(SEED); });

  it('the scripted match exercises every mechanic', () => {
    const intents = [...first.records.values()].flat().flatMap((r) => r.executed.map((c) => c.intent));
    for (const key of ['fire', 'choke', 'doubleTap', 'hideShots'] as const) {
      assert.ok(intents.some((i) => i[key]), `some executed command has intent.${key}`);
    }
    const causes = new Set(first.verdicts.map((v) => v.cause));
    assert.ok(causes.has('hit'), `some shot hit (causes: ${[...causes].join(', ')})`);
    assert.ok(first.verdicts.some((v) => v.bullet === 2), 'some DT bullet 2 fired');
    const recs = [...first.records.values()].flat();
    assert.ok(recs.some((r) => r.executed.length > 1), 'some tick ran a batch of commands (released choke)');
    for (const key of ['doubleTap', 'hideShots'] as const) {
      assert.ok(recs.some((r) => r.executed.at(-1)?.intent[key] && r.tickbaseBefore.charge === LATE_CSGO.chargeTicks && r.tickbaseAfter.charge === 0), `some ${key} burst was granted`);
    }
    // Every tickbase action, recomputed from each command and the sight the server stepped it with.
    const actions = new Set<string>();
    for (const r of recs) {
      if (!r.aliveBefore) continue;
      let tb = r.tickbaseBefore;
      r.executed.forEach((c, k) => {
        const { next, action } = stepTickbase(tb, c.intent, LATE_CSGO, { enemyVisible: r.sight[k]! });
        actions.add(action.kind === 'burst' ? `burst:${action.reason}` : action.kind);
        tb = next;
      });
    }
    for (const kind of ['run', 'choke', 'charge', 'cancel', 'reject', 'burst:doubleTap', 'burst:hideShots', 'burst:release']) {
      assert.ok(actions.has(kind), `some command was a ${kind} (actions: ${[...actions].join(', ')})`);
    }
    assert.ok(recs.some((r) => r.sight.includes(true)) && recs.some((r) => r.sight.includes(false)), 'enemies are seen and unseen');
    assert.ok(first.kills.some((k) => k > 0), 'someone scored a kill');
    const poses = [...first.records.values()].flat().map((r) => r.poseAfter.realSide);
    assert.ok(poses.includes('left') && poses.includes('right') && poses.includes('center'), 'desync sides and no desync all occur');
    // Per-stance AA with defensive patterns, and on-peek windows open (both flick sides).
    assert.ok(recs.some((r) => r.v2AntiAim) && recs.some((r) => !r.v2AntiAim), 'per-stance and single-stance AA both run');
    assert.ok(recs.some((r) => r.peek.includes(PEEK_TICKS)), 'some on-peek window opened');
    assert.ok(recs.some((r) => r.peekSides.includes(1)) && recs.some((r) => r.peekSides.includes(-1)), 'both flick sides occur');
  });

  it('replay through the server is bit-identical', () => {
    const second = runMatch(SEED);
    assert.equal(second.ticks.length, TICKS);
    for (let t = 0; t < TICKS; t++) assert.deepStrictEqual(second.ticks[t], first.ticks[t], `server tick ${t + 1}`);
    for (const [pid, recs] of first.records) assert.deepStrictEqual(second.records.get(pid), recs, `player ${pid} executed commands`);
    assert.deepStrictEqual(second.verdicts, first.verdicts, 'verdicts');
    assert.deepStrictEqual(second.kills, first.kills, 'kills');
  });

  it('replay through client prediction matches the server every tick', () => {
    const world = createCollisionWorld(MAPS[MAP]);
    let compared = 0;
    let defensive = 0;
    for (const [pid, recs] of first.records) {
      let predicted: PredictedTickbase | null = null;
      let pose: PoseState = INITIAL_POSE;
      let wasAlive = false;
      const spawned = first.spawns.get(pid)!;
      recs.forEach((r, i) => {
        const where = `player ${pid}, tick ${i + 1}`;
        if (!r.aliveBefore) { wasAlive = false; return; }
        // A spawn (respawn or a new match) starts a new life, dead or not before it.
        if (!wasAlive || spawned.has(i)) {
          // A new life: the client starts from the server's spawn tickbase (its first hvhState) and the initial pose.
          predicted = new PredictedTickbase(LATE_CSGO, r.tickbaseBefore);
          pose = INITIAL_POSE;
          assert.deepStrictEqual(r.poseBefore, pose, `${where}: a life starts at the initial pose`);
        }
        wasAlive = true;
        const tb = predicted!;
        // Movement is reconciled to the authoritative state (LocalPlayer); pose is predicted from it.
        // Each command is predicted with the enemy sight the server stepped it with, and moves as
        // its tickbase action says: no step while charging, the own step then the rest on a burst.
        const move: MoveState = structuredClone(r.stateBefore);
        r.executed.forEach((c, k) => {
          const ctx = { enemyVisible: r.sight[k]! };
          const steps = movementSteps(stepTickbase(tb.state, c.intent, LATE_CSGO, ctx).action);
          tb.apply(c.frame.seq, c.intent, ctx);
          const step = () => stepPlayer(move, c.frame, SIM_DT, world, null, hopMaxFor(r.weapon), moveSpeedFor(r.weapon), true);
          if (steps === 0) holdForCharge(move);
          else step();
          const motion = {
            speedFraction: clamp(move.horizontalSpeed / (PLAYER.speed * moveSpeedFor(r.weapon)), 0, 1),
            duck: move.crouchAmount ?? (move.crouching ? 1 : 0),
            onGround: move.onGround,
          };
          // The pose: the stance's AA and defensive pattern, with the peek window the server stepped it with.
          const aa = r.antiAim;
          const config = { ...(r.v2AntiAim ?? stanceAntiAimFrom(aa)), inverted: c.frame.invert === true };
          const pitch = hvhPitch(c.frame.pitch, { ...defaultHvhLoadout(), antiAim: aa });
          pose = stepPose({ ...pose, pitch }, c.frame.yaw, config, motion, tb.state.tickbase, LATE_CSGO,
            { seed: r.aaSeed, peekTicksLeft: r.peek[k]!, slowWalk: c.frame.slowWalk === true, peekSide: r.peekSides[k]! });
          const stance = stanceOf({ ...motion, slowWalk: c.frame.slowWalk === true });
          if (defensiveActive(config.defensive[stance], stance, r.peek[k]!)) defensive++;
          for (let i = 1; i < steps; i++) step();
        });
        assert.deepStrictEqual(tb.state, r.tickbaseAfter, `${where}: TickbaseState`);
        assert.deepStrictEqual(pose, r.poseAfter, `${where}: PoseState`);
        // A tick with no command coasts on the server (not predicted), so only command ticks compare.
        if (r.executed.length > 0) {
          assert.deepStrictEqual([move.x, move.y, move.z], [r.stateAfter.x, r.stateAfter.y, r.stateAfter.z], `${where}: position (charge stop and burst)`);
        }
        compared++;
      });
    }
    assert.ok(compared > TICKS * 5, `compared ${compared} player ticks`);
    assert.ok(defensive > 0, 'some command ran an active defensive pattern');
  });
});
