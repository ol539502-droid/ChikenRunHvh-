import assert from 'node:assert/strict';
import { describe, it, type TestContext } from 'node:test';
import { PLAYER, type MatchState, type RoundState } from '@game/shared';
import { HVH_ROUNDS } from '@game/shared/hvh/v2';
import type { ServerPlayer } from '../../src/rooms/ServerPlayer';
import { HvhRoom } from '../../src/rooms/HvhRoom';
import { addPlayer, fakeIo, stepRoom, type RecordedEvent } from '../helpers';
import { CLOCK_BASE, TICK_MS, makeMatch } from './hvhMatch';

/** The team scores of the newest 'scores' broadcast. */
function teamScores(events: RecordedEvent[]): [number, number] {
  return (events.filter((e) => e.event === 'scores').at(-1)?.args[0] as { teamScores: [number, number] }).teamScores;
}

/** A seeded 5v5 v2 match with the real round flow, and a clock the test moves. */
function roundMatch(t: TestContext) {
  const m = makeMatch(7, { rounds: true });
  t.after(() => m.room.close());
  let now = CLOCK_BASE;
  const step = (ms = TICK_MS) => { now += ms; stepRoom(m.room, now); };
  const kill = (p: ServerPlayer) => { p.shieldUntil = 0; m.room.damage(p, null, 1000, false, 'world', { x: 0, y: 0, z: 0 }, now); };
  const team = (n: 1 | 2) => m.players.filter((p) => p.info.team === n);
  /** Steps until the round reaches `phase` (the clock jumps to each phase's end). */
  const until = (phase: string) => {
    for (let i = 0; i < 10 && m.room.hvhRound.phase !== phase; i++) step(Math.max(TICK_MS, (m.room.hvhRound.endsAt ?? now) - now));
    assert.equal(m.room.hvhRound.phase, phase);
  };
  const rounds = () => m.events.filter((e) => e.event === 'round').map((e) => e.args[0] as RoundState);
  return { ...m, step, kill, team, until, rounds, scores: () => teamScores(m.events), get now() { return now; } };
}

describe('HvH v2 round flow', () => {
  it('players are frozen during freeze, and move once live', (t) => {
    const m = roundMatch(t);
    m.step();
    assert.equal(m.room.hvhRound.phase, 'warmup');
    assert.ok(m.players.every((p) => !p.frozen), 'nobody is frozen in warmup');
    m.until('freeze');
    assert.equal(m.room.hvhRound.round, 1);
    const p = m.players[0]!;
    const x = p.state.x;
    const z = p.state.z;
    for (let seq = 1; seq <= 20; seq++) {
      m.room.handleInput(p, { seq, forward: 1, right: 1, jump: false, yaw: 0, pitch: 0 });
      m.step();
      assert.ok(p.frozen, 'frozen during freeze');
    }
    assert.ok(m.players.every((q) => q.frozen));
    assert.deepEqual([p.state.x, p.state.z], [x, z], 'a frozen player does not move');
    const round = m.rounds().at(-1)!;
    assert.equal(round.phase, 'buy', 'freeze is sent as the buy phase');
    assert.equal(round.round, 1);
    assert.equal(round.bomb.carrier, 0);
    m.until('live');
    m.room.handleInput(p, { seq: 21, forward: 1, right: 0, jump: false, yaw: 0, pitch: 0 });
    m.step();
    assert.ok(m.players.every((q) => !q.frozen));
    assert.notDeepEqual([p.state.x, p.state.z], [x, z], 'moves once live');
    assert.equal(m.rounds().at(-1)!.phase, 'live');
  });

  it('killing all of team 2 ends the round; the dead stay dead until the next freeze', (t) => {
    const m = roundMatch(t);
    m.until('live');
    for (const p of m.team(2)) m.kill(p);
    m.step();
    assert.equal(m.room.hvhRound.phase, 'over');
    assert.equal(m.room.hvhRound.winner, 1);
    assert.equal(m.room.hvhRound.reason, 'eliminated');
    assert.deepEqual(m.scores(), [1, 0], 'the scoreboard counts rounds, not kills');
    // Well past respawnMs, still in the round-end banner: nobody comes back.
    for (let i = 0; i < 4; i++) {
      m.step((HVH_ROUNDS.roundEndMs - 2 * TICK_MS) / 4);
      assert.equal(m.room.hvhRound.phase, 'over');
      assert.ok(m.team(2).every((p) => !p.alive), 'the dead wait for the next round');
    }
    m.until('freeze');
    assert.equal(m.room.hvhRound.round, 2);
    assert.ok(m.players.every((p) => p.alive && p.hp === PLAYER.maxHealth), 'everyone is back for the next round');
  });

  it('the dead do not respawn during a live round', (t) => {
    const m = roundMatch(t);
    m.until('live');
    const victim = m.team(2)[0]!;
    m.kill(victim);
    m.step(PLAYER.spawnProtectionMs + 10_000);
    assert.equal(m.room.hvhRound.phase, 'live');
    assert.equal(victim.alive, false);
  });

  it('every spawn has armor 100, and v2 shots are not cut again by legacy armor', (t) => {
    const m = roundMatch(t);
    m.step();
    const p = m.players[0]!;
    m.kill(p);
    m.step(10_000);
    assert.ok(p.alive, 'warmup respawns');
    assert.equal(p.armor, 100);
    m.until('freeze');
    assert.ok(m.players.every((q) => q.armor === 100));
    const q = m.players[1]!;
    q.shieldUntil = 0;
    m.room.damage(q, null, 30, false, 'world', { x: 0, y: 0, z: 0 }, m.now);
    assert.equal(q.hp, PLAYER.maxHealth - 30, 'armor is applied by the shot (armorPen), not by GameRoom.damage');
    assert.equal(q.armor, 100, 'armor never wears down');
  });

  it('a drawn round scores nobody', (t) => {
    const m = roundMatch(t);
    m.until('live');
    for (const p of m.players) m.kill(p);
    m.step();
    assert.equal(m.room.hvhRound.phase, 'over');
    assert.equal(m.room.hvhRound.winner, 0);
    assert.deepEqual(m.scores(), [0, 0]);
  });

  it('teams swap at halftime, and the match ends at 13', (t) => {
    const m = roundMatch(t);
    const first = m.team(1).map((p) => p.pid);
    for (let round = 1; round <= HVH_ROUNDS.halfAfter; round++) {
      m.until('live');
      for (const p of m.team(2)) m.kill(p);
      m.step();
      assert.equal(m.room.hvhRound.phase, 'over');
    }
    assert.deepEqual(m.scores(), [12, 0]);
    m.until('freeze');
    assert.equal(m.room.hvhRound.round, 13);
    assert.deepEqual(m.team(2).map((p) => p.pid), first, 'team 1 now plays as team 2');
    assert.deepEqual(m.room.hvhRound.score, { 1: 0, 2: 12 });
    assert.deepEqual(m.scores(), [0, 12], 'the scores follow the sides');
    assert.ok(m.players.every((p) => p.alive && p.frozen));
    m.until('live');
    for (const p of m.team(1)) m.kill(p);
    m.step();
    assert.equal(m.room.hvhRound.phase, 'ended');
    assert.equal(m.room.phase, 'ended');
    assert.equal((m.events.filter((e) => e.event === 'match').at(-1)!.args[0] as MatchState).winnerTeam, 2);
  });

  it('a team left with no players: warmup keeps the score, half, kills and deaths, and the match resumes (R70)', (t) => {
    const m = roundMatch(t);
    m.until('live');
    const killer = m.team(1)[0]!;
    m.room.damage(m.team(2)[0]!, killer, 1000, false, 'world', { x: 0, y: 0, z: 0 }, m.now);
    const kills = m.players.map((p) => [p.info.kills, p.info.deaths]);
    assert.equal(killer.info.kills, 1);
    // Everyone on team 2 leaves the team (as if they had all left the room).
    const leavers = m.team(2);
    for (const p of leavers) p.info.team = 1;
    m.step();
    assert.equal(m.room.hvhRound.phase, 'over');
    assert.deepEqual(m.scores(), [1, 0]);
    m.step(HVH_ROUNDS.roundEndMs);
    assert.equal(m.room.hvhRound.phase, 'warmup', 'no more rounds against an empty team');
    assert.equal(m.room.hvhRound.endsAt, null, 'the warmup clock waits for both teams');
    assert.deepEqual(m.scores(), [1, 0], 'the score is kept');
    assert.deepEqual(m.room.hvhRound.score, { 1: 1, 2: 0 });
    assert.deepEqual(m.players.map((p) => [p.info.kills, p.info.deaths]), kills, 'kills and deaths are kept');
    for (let i = 0; i < 40; i++) m.step(1000);
    assert.equal(m.room.hvhRound.phase, 'warmup');
    assert.deepEqual(m.scores(), [1, 0], 'no rounds are awarded meanwhile');
    assert.ok(m.players.every((p) => p.alive && !p.frozen), 'warmup: everyone plays freely');
    // Team 2 has players again: after the warmup the match goes on with round 2.
    for (const p of leavers) p.info.team = 2;
    m.until('freeze');
    assert.equal(m.room.hvhRound.round, 2);
    assert.deepEqual(m.scores(), [1, 0]);
    assert.deepEqual(m.room.hvhRound.score, { 1: 1, 2: 0 });
  });

  it('the harness option keeps a v2 room in warmup', (t) => {
    const m = makeMatch(7);
    t.after(() => m.room.close());
    stepRoom(m.room, CLOCK_BASE + TICK_MS);
    stepRoom(m.room, CLOCK_BASE + HVH_ROUNDS.warmupMs * 10);
    assert.equal(m.room.hvhRound.phase, 'warmup');
    assert.ok(m.players.every((p) => !p.frozen));
  });

  it('a legacy-engine HvhRoom still respawns after respawnMs and has no rounds', (t) => {
    const { io, events } = fakeIo();
    const room = new HvhRoom(io, { id: 'legacy', code: 'LEG01', name: 'legacy', mode: 'hvh', map: 'flat', private: true, hvhEngine: 'legacy' }, {});
    t.after(() => room.close());
    const a = addPlayer(room, 'A');
    const b = addPlayer(room, 'B');
    a.info.team = 1;
    b.info.team = 2;
    room.startNow(CLOCK_BASE);
    assert.equal(a.armor, 0, 'no armor on the legacy engine');
    b.shieldUntil = 0;
    room.damage(b, a, 1000, false, 'pistol', { x: 0, y: 0, z: 0 }, CLOCK_BASE);
    assert.equal(b.alive, false);
    stepRoom(room, CLOCK_BASE + room.mode.respawnMs - 1);
    assert.equal(b.alive, false);
    stepRoom(room, CLOCK_BASE + room.mode.respawnMs);
    assert.equal(b.alive, true);
    for (let i = 1; i <= 4; i++) stepRoom(room, CLOCK_BASE + room.mode.respawnMs + HVH_ROUNDS.warmupMs * i);
    assert.ok(!events.some((e) => e.event === 'round'), 'no round events');
    assert.ok(!a.frozen && !b.frozen);
    assert.deepEqual(teamScores(events), [1, 0], 'legacy HvH still scores team kills');
  });
});
