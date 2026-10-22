import assert from 'node:assert/strict';
import { describe, it, type TestContext } from 'node:test';
import { DEFAULT_APPEARANCE, DEFAULT_LOADOUT } from '@game/shared';
import type { ServerPlayer } from '../../src/rooms/ServerPlayer';
import { stepRoom, type RecordedEvent } from '../helpers';
import { CLOCK_BASE, TICK_MS, makeMatch } from './hvhMatch';

/*
 * R70 through a real leave and rejoin: a private 1v1 v2 room keeps its match while one player is
 * left (paused in warmup, score, half, kills and deaths kept) and resumes when someone joins
 * again. Kills and deaths made during a warmup do not stick to the match (M3).
 */

function teamScores(events: RecordedEvent[]): [number, number] {
  return (events.filter((e) => e.event === 'scores').at(-1)?.args[0] as { teamScores: [number, number] }).teamScores;
}

function duel(t: TestContext) {
  const m = makeMatch(7, { rounds: true, teams: [1, 2] });
  t.after(() => m.room.close());
  let now = CLOCK_BASE;
  const step = (ms = TICK_MS) => { now += ms; stepRoom(m.room, now); };
  const until = (phase: string) => {
    for (let i = 0; i < 10 && m.room.hvhRound.phase !== phase; i++) step(Math.max(TICK_MS, (m.room.hvhRound.endsAt ?? now) - now));
    assert.equal(m.room.hvhRound.phase, phase);
  };
  const kill = (victim: ServerPlayer, by: ServerPlayer | null) => {
    victim.shieldUntil = 0;
    m.room.damage(victim, by, 1000, false, 'world', { x: 0, y: 0, z: 0 }, now);
  };
  const join = (name: string, team: 1 | 2) => {
    const res = m.room.join(null, { userId: null, name, appearance: { ...DEFAULT_APPEARANCE }, loadout: [...DEFAULT_LOADOUT], team });
    assert.ok(res.ok, 'joined');
    const p = m.room.players.get(res.selfPid)!;
    p.takeInputToken = () => true;
    p.hvhEnabled = true;
    return p;
  };
  const [a, b] = m.players as [ServerPlayer, ServerPlayer];
  return { ...m, a, b, step, until, kill, join, scores: () => teamScores(m.events), get now() { return now; } };
}

describe('R70 with a real leave (1v1)', () => {
  it('the last player of a team leaving pauses the match in warmup and keeps the score, kills and deaths', (t) => {
    const m = duel(t);
    m.until('live');
    m.kill(m.b, m.a);
    m.step();
    assert.equal(m.room.hvhRound.phase, 'over');
    assert.deepEqual(m.scores(), [1, 0]);
    assert.equal(m.a.info.kills, 1);
    m.until('freeze');
    m.room.removePlayer(m.b);
    for (let i = 0; i < 40; i++) m.step(1000);
    assert.equal(m.room.phase, 'playing', 'the match stays on with one player left');
    assert.equal(m.room.hvhRound.phase, 'warmup');
    assert.deepEqual(m.room.hvhRound.score, { 1: 1, 2: 0 });
    assert.deepEqual(m.scores(), [1, 0]);
    assert.equal(m.a.info.kills, 1, 'kills kept');
    const back = m.join('B2', 2);
    m.until('freeze');
    assert.equal(m.room.hvhRound.round, 2, 'the unplayed round 2 is replayed');
    assert.deepEqual(m.room.hvhRound.score, { 1: 1, 2: 0 });
    assert.deepEqual(m.scores(), [1, 0]);
    assert.equal(m.a.info.kills, 1);
    assert.ok(back.alive && back.info.team === 2);
  });

  it('kills and deaths made during the paused warmup do not stick to the match (M3)', (t) => {
    const m = duel(t);
    m.until('live');
    m.kill(m.b, m.a);
    m.step();
    m.until('freeze');
    m.room.removePlayer(m.b);
    m.step();
    assert.equal(m.room.hvhRound.phase, 'warmup');
    const stats = [m.a.info.kills, m.a.info.deaths, m.a.info.score];
    assert.deepEqual(stats.slice(0, 2), [1, 0]);
    // Back to 1v1: the warmup counts down to round 2, with free respawns, so frags pile up.
    const back = m.join('B2', 2);
    m.step();
    assert.notEqual(m.room.hvhRound.endsAt, null, 'precondition: the warmup clock runs');
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 100 && !back.alive; j++) m.step(100);
      assert.ok(back.alive, 'respawned in warmup');
      m.kill(back, m.a);
      m.step();
    }
    assert.equal(m.room.hvhRound.phase, 'warmup');
    assert.equal(m.a.info.kills, 4, 'precondition: warmup kills show on the scoreboard meanwhile');
    m.until('freeze');
    assert.deepEqual([m.a.info.kills, m.a.info.deaths, m.a.info.score], stats, 'back to the stats at the pause');
    assert.deepEqual([back.info.kills, back.info.deaths, back.info.score], [0, 0, 0]);
    const row = (m.events.filter((e) => e.event === 'scores').at(-1)?.args[0] as { rows: number[][] }).rows.find((r) => r[0] === m.a.pid);
    assert.deepEqual(row, [m.a.pid, ...stats], 'the scoreboard is told');
  });

  it('everyone leaving ends the match as before: the room waits in a fresh warmup', (t) => {
    const m = duel(t);
    m.until('live');
    m.kill(m.b, m.a);
    m.step();
    m.until('freeze');
    m.room.removePlayer(m.b);
    m.room.removePlayer(m.a);
    m.step();
    assert.equal(m.room.phase, 'waiting');
    assert.equal(m.room.hvhRound.phase, 'warmup');
    assert.deepEqual(m.room.hvhRound.score, { 1: 0, 2: 0 });
  });

  it('the first warmup does not carry its kills into round 1 either', (t) => {
    const m = duel(t);
    m.step();
    assert.equal(m.room.hvhRound.phase, 'warmup');
    m.kill(m.b, m.a);
    assert.equal(m.a.info.kills, 1);
    m.until('freeze');
    assert.deepEqual([m.a.info.kills, m.b.info.deaths], [0, 0]);
  });
});
