import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as THREE from 'three';
import {
  DEFAULT_APPEARANCE, MAPS, SIM_DT, copyMoveState, createCollisionWorld, createMoveState, stepPlayer,
  type InputFrame, type MoveState, type PlayerInfo, type PlayerState,
} from '@game/shared';
import { EMPTY_TICKBASE, LATE_CSGO, holdForCharge, type CommandIntent } from '@game/shared/hvh/v2';
import { LocalPlayer } from '../../src/game/LocalPlayer';

const N = LATE_CSGO.chargeTicks;
const world = createCollisionWorld(MAPS.flat);
const NONE: CommandIntent = { fire: false, choke: false, doubleTap: false, hideShots: false };
const DT: CommandIntent = { ...NONE, doubleTap: true };
const HIDDEN = { enemyVisible: false };
const HOP = 1;

function player(y = 0, v2 = true): LocalPlayer {
  const info = { pid: 1, name: 'me', team: 1, appearance: DEFAULT_APPEARANCE, loadout: [], bot: false, kills: 0, deaths: 0, score: 0 } as unknown as PlayerInfo;
  const spawn = { ...createMoveState(20, y, 20), pid: 1, yaw: 0, pitch: 0, alive: true, weapon: 'deserteagle', ack: 0 } as unknown as PlayerState;
  const oldDocument = globalThis.document;
  // A stand-in 2D canvas (0 x 0) for the chicken and gun textures: every drawing call is a no-op.
  const pixels = () => ({ data: new Uint8ClampedArray(0), addColorStop() {} });
  const ctx: object = new Proxy({}, { get: () => pixels, set: () => true });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement() { return { width: 0, height: 0, getContext() { return ctx; } }; } } });
  try {
    const p = new LocalPlayer(new THREE.Scene(), info, spawn);
    p.hvhV2 = v2;
    return p;
  } finally {
    Object.defineProperty(globalThis, 'document', { configurable: true, value: oldDocument });
  }
}

function frame(seq: number, over: Partial<InputFrame> = {}): InputFrame {
  return { seq, forward: 1, right: 0, jump: false, yaw: 0, pitch: 0, ...over };
}

/** One predicted command as GameSession builds it: movement with the tickbase's action, then the tickbase step. */
function run(p: LocalPlayer, f: InputFrame, intent: CommandIntent, ctx = HIDDEN): void {
  p.predict(f, world, HOP, 1, { intent, ctx });
  p.command(f, intent, 0, ctx);
}

function walked(from: MoveState, f: InputFrame, steps: number): MoveState {
  const s = structuredClone(from);
  for (let i = 0; i < steps; i++) stepPlayer(s, f, SIM_DT, world, null, HOP, 1, false);
  return s;
}

const at = (s: MoveState) => [s.x, s.y, s.z];

describe('LocalPlayer charge and burst prediction', () => {
  it('a charge tick leaves the position unchanged, even mid-air (no gravity), and zeroes every velocity', () => {
    const p = player(2);
    p.state.vy = -3;
    for (let seq = 1; seq <= N; seq++) {
      run(p, frame(seq, { right: 1 }), DT);
      assert.deepEqual(at(p.state), [20, 2, 20], `charge tick ${seq}`);
      assert.deepEqual([p.state.vx, p.state.vy, p.state.vz, p.state.horizontalSpeed], [0, 0, 0, 0]);
    }
    assert.equal(p.tickbase.state.charge, N);
    run(p, frame(N + 1), DT);
    assert.ok(p.state.y < 2, 'a charged player moves (and falls) again');
  });

  it('a burst is 1 + chargeTicks normal movement steps of the same frame', () => {
    const p = player();
    for (let seq = 1; seq <= N; seq++) run(p, frame(seq), DT);
    const f = frame(N + 1);
    const expected = walked(p.state, f, 1 + N);
    run(p, f, { ...DT, fire: true });
    assert.deepEqual(at(p.state), at(expected));
    assert.ok(20 - p.state.z > 1.5, `the burst moved (${20 - p.state.z} m)`);
    assert.equal(p.tickbase.state.charge, 0);
    // No speed-up after it: with DT on the next command charges again; with it off, one step.
    const burstAt = at(p.state);
    run(p, frame(N + 2), DT);
    assert.deepEqual(at(p.state), burstAt);
    const next = walked(p.state, frame(N + 3), 1);
    run(p, frame(N + 3), NONE);
    assert.deepEqual(at(p.state), at(next));
  });

  it('a release (DT turned off with a full charge) bursts too', () => {
    const p = player();
    for (let seq = 1; seq <= N; seq++) run(p, frame(seq), DT);
    const f = frame(N + 1);
    const expected = walked(p.state, f, 1 + N);
    run(p, f, NONE);
    assert.deepEqual(at(p.state), at(expected));
  });

  it('an enemy in sight cancels the charge and the command moves one step', () => {
    const p = player();
    for (let seq = 1; seq <= 5; seq++) run(p, frame(seq), DT);
    const f = frame(6);
    const expected = walked(p.state, f, 1);
    run(p, f, DT, { enemyVisible: true });
    assert.deepEqual(at(p.state), at(expected));
    assert.equal(p.tickbase.state.charge, 0);
  });

  it('a waiting fire message counts for the action (it attaches to the command, as on the server)', () => {
    const p = player();
    for (let seq = 1; seq <= N; seq++) run(p, frame(seq), DT);
    p.tickbase.shot(N + 1);
    const f = frame(N + 1);
    const expected = walked(p.state, f, 1 + N);
    run(p, f, DT);
    assert.deepEqual(at(p.state), at(expected), 'the shot bursts');
  });

  it('reconcile replays a charge as a stop and a burst as 1 + chargeTicks steps', () => {
    const p = player();
    const start = copyMoveState(p.state, createMoveState(0, 0, 0));
    for (let seq = 1; seq <= N; seq++) run(p, frame(seq), DT);
    run(p, frame(N + 1), { ...DT, fire: true });
    const predicted = at(p.state);
    // The server has run nothing yet: rewind to the start and replay every command.
    p.reconcile({ ...start, pid: 1, yaw: 0, pitch: 0, alive: true, weapon: 'deserteagle', ack: 0 } as unknown as PlayerState, world);
    assert.deepEqual(at(p.state), predicted);
    // The server ran the charge; hvhState and the snapshot agree with the prediction.
    p.onHvhState({ tickbase: { ...EMPTY_TICKBASE(0), charge: N, armed: true }, lastAckSeq: N } as never);
    p.reconcile({ ...start, pid: 1, yaw: 0, pitch: 0, alive: true, weapon: 'deserteagle', ack: N } as unknown as PlayerState, world);
    assert.deepEqual(at(p.state), predicted);
    assert.equal(p.tickbase.mismatches, 0);
  });

  /**
   * The client predicted 32 charges and a DT burst, but the server saw an enemy at command 1: it
   * moved one step, charged 31 (2..32), and command 33's shot was a partial-charge reject (one step).
   */
  function corrected() {
    const p = player();
    const start = structuredClone(p.state);
    const server = (s: MoveState, ack: number) => ({ ...structuredClone(s), pid: 1, yaw: 0, pitch: 0, alive: true, weapon: 'deserteagle', ack }) as unknown as PlayerState;
    p.reconcile(server(start, 0), world);
    p.onHvhState({ tickbase: EMPTY_TICKBASE(0), lastAckSeq: 0 } as never);
    for (let seq = 1; seq <= N; seq++) run(p, frame(seq), DT);
    run(p, frame(N + 1), { ...DT, fire: true });
    const afterOne = walked(start, frame(1), 1);
    const held = structuredClone(afterOne);
    holdForCharge(held);
    const expected = walked(held, frame(N + 1), 1);
    const hvhState = { tickbase: { tickbase: 1, charge: 0, choked: 0, armed: true }, lastAckSeq: 1 } as never;
    return { p, snapshot: server(afterOne, 1), hvhState, expected: at(expected) };
  }

  it('production order (hvhState, then the snapshot for the same commands) replays the corrected actions', () => {
    const { p, snapshot, hvhState, expected } = corrected();
    p.onHvhState(hvhState);
    assert.equal(p.tickbase.mismatches, 1);
    p.reconcile(snapshot, world);
    assert.deepEqual(at(p.state), expected);
  });

  it('a snapshot before the hvhState: the correction replays from that snapshot at once', () => {
    const { p, snapshot, hvhState, expected } = corrected();
    p.reconcile(snapshot, world);
    assert.notDeepEqual(at(p.state), expected, 'precondition: replayed with the uncorrected burst');
    p.onHvhState(hvhState);
    assert.equal(p.tickbase.mismatches, 1);
    assert.deepEqual(at(p.state), expected);
  });

  it('legacy rooms (no hvhState) always step once, whatever the intent', () => {
    const p = player(0, false);
    const f = frame(1);
    const expected = walked(p.state, f, 1);
    run(p, f, DT);
    assert.deepEqual(at(p.state), at(expected));
    assert.equal(p.tickbase.pendingCount, 0, 'no tickbase prediction outside v2');
  });
});
