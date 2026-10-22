import assert from 'node:assert/strict';
import { describe, it, type TestContext } from 'node:test';
import type { InputFrame } from '@game/shared';
import { LATE_CSGO, enemyVisible, type CommandIntent } from '@game/shared/hvh/v2';
import type { ServerPlayer } from '../../src/rooms/ServerPlayer';
import { stepRoom } from '../helpers';
import { CLOCK_BASE, TICK_MS, makeMatch } from './hvhMatch';

/*
 * R62: during freeze nobody can move or shoot, so seeing the enemy earns nothing and the tickbase
 * charge proceeds regardless of sight. In a 5v5 on farm every player at the team spawns sees an
 * enemy, and a player charging through freeze still starts the round fully charged.
 */

const DT: CommandIntent = { fire: false, choke: false, doubleTap: true, hideShots: false };

function freezeMatch(t: TestContext, seed: number) {
  const m = makeMatch(seed, { map: 'farm', rounds: true });
  t.after(() => m.room.close());
  let now = CLOCK_BASE;
  const seqs = new Map<number, number>();
  const step = (ms = TICK_MS) => { now += ms; stepRoom(m.room, now); };
  const send = (p: ServerPlayer, intent: CommandIntent, over: Partial<InputFrame> = {}) => {
    const seq = (seqs.get(p.pid) ?? 0) + 1;
    seqs.set(p.pid, seq);
    m.room.handleInput(p, { seq, forward: 0, right: 0, jump: false, yaw: 0, pitch: 0, intent, ...over });
  };
  const until = (phase: string) => {
    for (let i = 0; i < 10 && m.room.hvhRound.phase !== phase; i++) step(Math.max(TICK_MS, (m.room.hvhRound.endsAt ?? now) - now));
    assert.equal(m.room.hvhRound.phase, phase);
  };
  /** `p` sees a living enemy (actual line of sight, the tickbase's enemyVisible). */
  const sees = (p: ServerPlayer) => enemyVisible(m.room.eyeOf(p), m.players
    .filter((q) => q.alive && q.info.team !== p.info.team)
    .map((q) => ({ x: q.state.x, y: q.state.y, z: q.state.z, crouch: q.state.crouchAmount ?? 0, yaw: 0 })), m.room.world);
  const a = m.players[0]!;
  return { ...m, a, step, send, until, sees };
}

describe('freeze-time charge (R62)', () => {
  it('on farm, a player charging through freeze in sight of the enemy starts the round fully charged', (t) => {
    const m = freezeMatch(t, 7);
    m.until('freeze');
    assert.ok(m.players.every((p) => m.sees(p)), 'every farm spawn sees an enemy (the case under test)');
    for (let i = 0; i < LATE_CSGO.chargeTicks + 4; i++) {
      for (const p of m.players) m.send(p, DT);
      m.step();
      assert.equal(m.room.hvhRound.phase, 'freeze');
    }
    for (const p of m.players) {
      assert.equal(m.room.tickbaseOf(p.pid)?.charge, LATE_CSGO.chargeTicks, `${p.info.name} is fully charged in freeze`);
      assert.equal(m.room.tickbaseOf(p.pid)?.armed, true);
    }
    m.until('live');
    // Live and still in sight: the full charge is kept (only a burst spends it).
    m.send(m.a, DT);
    m.step();
    assert.ok(m.sees(m.a));
    assert.equal(m.room.tickbaseOf(m.a.pid)?.charge, LATE_CSGO.chargeTicks, 'the round starts charged');
  });

  it('once live, sight blocks a new charge again', (t) => {
    const m = freezeMatch(t, 7);
    m.until('live');
    for (let i = 0; i < LATE_CSGO.chargeTicks + 4; i++) {
      m.send(m.a, DT);
      m.step();
    }
    assert.ok(m.sees(m.a));
    assert.equal(m.room.tickbaseOf(m.a.pid)?.charge, 0, 'no charge in sight of the enemy once live');
  });

  it('a burst in freeze (a modified client firing with a full charge) does not move the player and the shot is blocked', (t) => {
    const m = freezeMatch(t, 7);
    const verdicts: { shooterId: string; cause: string; reason?: string }[] = [];
    m.room.addVerdictListener((v) => verdicts.push(v));
    m.until('freeze');
    for (let i = 0; i < LATE_CSGO.chargeTicks; i++) {
      m.send(m.a, DT);
      m.step();
    }
    assert.equal(m.room.tickbaseOf(m.a.pid)?.charge, LATE_CSGO.chargeTicks);
    const before = { x: m.a.state.x, y: m.a.state.y, z: m.a.state.z };
    m.send(m.a, { ...DT, fire: true }, { forward: 1, right: 1 });
    m.step();
    assert.equal(m.room.hvhRound.phase, 'freeze');
    assert.equal(m.room.tickbaseOf(m.a.pid)?.charge, 0, 'the burst spent the charge');
    assert.deepEqual({ x: m.a.state.x, y: m.a.state.y, z: m.a.state.z }, before, 'a frozen burst has no displacement');
    const shots = verdicts.filter((v) => v.shooterId === String(m.a.pid));
    assert.ok(shots.length > 0 && shots.every((v) => v.cause === 'rejected' && v.reason === 'actions blocked'),
      shots.map((v) => `${v.cause}:${v.reason}`).join(', '));
  });
});
