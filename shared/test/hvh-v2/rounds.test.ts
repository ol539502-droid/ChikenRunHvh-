import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { HVH_ROUNDS, hvhWarmup, stepHvhRound, type HvhRoundState } from '../../src/hvh/v2/rounds';

const FULL = { 1: 5, 2: 5 } as const;

function state(over: Partial<HvhRoundState>): HvhRoundState {
  return { ...hvhWarmup(), ...over };
}

describe('HvH v2 rounds', () => {
  it('uses the round tunables', () => {
    assert.deepEqual(HVH_ROUNDS, { warmupMs: 15000, freezeMs: 5000, roundMs: 115000, roundEndMs: 5000, roundsToWin: 13, maxRounds: 24, halfAfter: 12 });
  });

  it('warmup -> freeze at warmupMs once both teams have players', () => {
    const empty = stepHvhRound(hvhWarmup(), { 1: 1, 2: 0 }, { 1: 1, 2: 0 }, 0);
    assert.equal(empty.state.endsAt, null, 'no clock while a team is empty');
    assert.deepEqual(empty.events, []);
    const clock = stepHvhRound(empty.state, FULL, FULL, 1000).state;
    assert.equal(clock.phase, 'warmup');
    assert.equal(clock.endsAt, 1000 + HVH_ROUNDS.warmupMs);
    assert.equal(stepHvhRound(clock, FULL, FULL, 1000 + HVH_ROUNDS.warmupMs - 1).state.phase, 'warmup');
    const start = stepHvhRound(clock, FULL, FULL, 1000 + HVH_ROUNDS.warmupMs);
    assert.deepEqual(start.events, ['roundStart']);
    assert.equal(start.state.phase, 'freeze');
    assert.equal(start.state.round, 1);
    assert.equal(start.state.endsAt, 1000 + HVH_ROUNDS.warmupMs + HVH_ROUNDS.freezeMs);
  });

  it('a team emptying during warmup stops the clock', () => {
    const clock = state({ endsAt: 5000 });
    assert.equal(stepHvhRound(clock, { 1: 1, 2: 0 }, { 1: 1, 2: 0 }, 6000).state.endsAt, null);
  });

  it('freeze -> live at freezeMs', () => {
    const freeze = state({ phase: 'freeze', round: 1, endsAt: 5000 });
    assert.equal(stepHvhRound(freeze, FULL, FULL, 4999).state, freeze, 'unchanged state is the same object');
    const live = stepHvhRound(freeze, FULL, FULL, 5000);
    assert.deepEqual(live.events, ['goLive']);
    assert.equal(live.state.phase, 'live');
    assert.equal(live.state.endsAt, 5000 + HVH_ROUNDS.roundMs);
  });

  it('live -> over when team 2 has 0 alive', () => {
    const live = state({ phase: 'live', round: 1, endsAt: 100_000 });
    const r = stepHvhRound(live, { 1: 3, 2: 0 }, FULL, 50_000);
    assert.deepEqual(r.events, ['roundEnd']);
    assert.equal(r.state.phase, 'over');
    assert.equal(r.state.winner, 1);
    assert.equal(r.state.reason, 'eliminated');
    assert.deepEqual(r.state.score, { 1: 1, 2: 0 });
    assert.equal(r.state.endsAt, 50_000 + HVH_ROUNDS.roundEndMs);
  });

  it('an empty team loses the round', () => {
    const live = state({ phase: 'live', round: 1, endsAt: 100_000 });
    const r = stepHvhRound(live, { 1: 0, 2: 2 }, { 1: 0, 2: 2 }, 50_000);
    assert.equal(r.state.winner, 2);
    assert.equal(r.state.reason, 'eliminated');
  });

  it('a team with no players: the round in play is lost, then a warmup that keeps the score (R70)', () => {
    const over = state({ phase: 'over', round: 3, endsAt: 60_000, score: { 1: 1, 2: 2 }, winner: 2, reason: 'eliminated' });
    assert.equal(stepHvhRound(over, { 1: 0, 2: 2 }, { 1: 0, 2: 2 }, 59_999).state, over, 'the banner runs out first');
    const paused = stepHvhRound(over, { 1: 0, 2: 2 }, { 1: 0, 2: 2 }, 60_000);
    assert.deepEqual(paused.state, { ...hvhWarmup(), round: 3, score: { 1: 1, 2: 2 } });
    assert.deepEqual(paused.events, ['pause']);
    // With both teams staffed the next round starts as before.
    assert.deepEqual(stepHvhRound(over, FULL, FULL, 60_000).events, ['roundStart']);
  });

  it('once both teams have a player again the match resumes from the kept score at the next round', () => {
    const paused = state({ round: 3, score: { 1: 1, 2: 2 } });
    assert.equal(stepHvhRound(paused, { 1: 0, 2: 2 }, { 1: 0, 2: 2 }, 0).state, paused, 'waits for both teams');
    const clock = stepHvhRound(paused, FULL, FULL, 1000).state;
    assert.equal(clock.endsAt, 1000 + HVH_ROUNDS.warmupMs);
    const next = stepHvhRound(clock, FULL, FULL, 1000 + HVH_ROUNDS.warmupMs);
    assert.deepEqual(next.events, ['roundStart']);
    assert.equal(next.state.phase, 'freeze');
    assert.equal(next.state.round, 4);
    assert.deepEqual(next.state.score, { 1: 1, 2: 2 });
  });

  it('a team emptying during freeze pauses before the round is played; it is replayed on resume', () => {
    const freeze = state({ phase: 'freeze', round: 2, endsAt: 10_000, score: { 1: 1, 2: 0 } });
    const paused = stepHvhRound(freeze, { 1: 2, 2: 0 }, { 1: 2, 2: 0 }, 6_000);
    assert.deepEqual(paused.state, { ...hvhWarmup(), round: 1, score: { 1: 1, 2: 0 } });
    assert.deepEqual(paused.events, ['pause']);
    const clock = stepHvhRound(paused.state, FULL, FULL, 7_000).state;
    assert.equal(stepHvhRound(clock, FULL, FULL, 7_000 + HVH_ROUNDS.warmupMs).state.round, 2);
  });

  it('the half is kept: a pause in the first freeze of the second half does not swap the sides again', () => {
    const over = state({ phase: 'over', round: HVH_ROUNDS.halfAfter, endsAt: 1000, score: { 1: 7, 2: 5 } });
    const half = stepHvhRound(over, FULL, FULL, 1000);
    assert.deepEqual(half.events, ['halftime', 'roundStart']);
    assert.deepEqual(half.state.score, { 1: 5, 2: 7 });
    const paused = stepHvhRound(half.state, { 1: 5, 2: 0 }, { 1: 5, 2: 0 }, 2000).state;
    const clock = stepHvhRound(paused, FULL, FULL, 3000).state;
    const resumed = stepHvhRound(clock, FULL, FULL, 3000 + HVH_ROUNDS.warmupMs);
    assert.deepEqual(resumed.events, ['roundStart'], 'no second halftime');
    assert.equal(resumed.state.round, HVH_ROUNDS.halfAfter + 1);
    assert.deepEqual(resumed.state.score, { 1: 5, 2: 7 });
  });

  it('both teams at 0 alive is a draw', () => {
    const live = state({ phase: 'live', round: 1, endsAt: 100_000 });
    const r = stepHvhRound(live, { 1: 0, 2: 0 }, FULL, 50_000);
    assert.deepEqual(r.events, ['roundEnd']);
    assert.equal(r.state.winner, 0);
    assert.equal(r.state.reason, 'draw');
    assert.deepEqual(r.state.score, { 1: 0, 2: 0 });
  });

  it('on time-out more alive wins, equal alive is a draw', () => {
    const live = state({ phase: 'live', round: 1, endsAt: 100_000 });
    assert.equal(stepHvhRound(live, { 1: 2, 2: 1 }, FULL, 99_999).state.phase, 'live');
    const more = stepHvhRound(live, { 1: 2, 2: 1 }, FULL, 100_000).state;
    assert.equal(more.winner, 1);
    assert.equal(more.reason, 'time');
    const even = stepHvhRound(live, { 1: 1, 2: 1 }, FULL, 100_000).state;
    assert.equal(even.winner, 0);
    assert.equal(even.reason, 'draw');
  });

  it('over -> freeze of the next round after roundEndMs', () => {
    const over = state({ phase: 'over', round: 3, endsAt: 10_000, winner: 1, reason: 'eliminated', score: { 1: 2, 2: 1 } });
    assert.equal(stepHvhRound(over, FULL, FULL, 9_999).state.phase, 'over');
    const next = stepHvhRound(over, FULL, FULL, 10_000);
    assert.deepEqual(next.events, ['roundStart']);
    assert.equal(next.state.phase, 'freeze');
    assert.equal(next.state.round, 4);
    assert.equal(next.state.winner, 0);
    assert.equal(next.state.reason, null);
    assert.deepEqual(next.state.score, { 1: 2, 2: 1 });
  });

  it('halftime is emitted when starting round 13, and the score follows the swapped sides', () => {
    const over = state({ phase: 'over', round: 12, endsAt: 10_000, winner: 0, reason: 'draw', score: { 1: 7, 2: 4 } });
    const next = stepHvhRound(over, FULL, FULL, 10_000);
    assert.deepEqual(next.events, ['halftime', 'roundStart']);
    assert.equal(next.state.round, 13);
    assert.deepEqual(next.state.score, { 1: 4, 2: 7 });
    const later = stepHvhRound(state({ phase: 'over', round: 13, endsAt: 0 }), FULL, FULL, 0);
    assert.deepEqual(later.events, ['roundStart']);
  });

  it('matchEnd when a team reaches 13', () => {
    const live = state({ phase: 'live', round: 20, endsAt: 100_000, score: { 1: 12, 2: 7 } });
    const r = stepHvhRound(live, { 1: 1, 2: 0 }, FULL, 50_000);
    assert.deepEqual(r.events, ['roundEnd', 'matchEnd']);
    assert.equal(r.state.phase, 'ended');
    assert.equal(r.state.winner, 1);
    assert.deepEqual(r.state.score, { 1: 13, 2: 7 });
    assert.equal(stepHvhRound(r.state, FULL, FULL, 1e9).state, r.state, 'ended is final');
  });

  it('matchEnd after 24 rounds played: 12-12 (with the last round drawn) is a draw', () => {
    const live = state({ phase: 'live', round: 24, endsAt: 100_000, score: { 1: 12, 2: 12 } });
    const r = stepHvhRound(live, { 1: 0, 2: 0 }, FULL, 50_000);
    assert.deepEqual(r.events, ['roundEnd', 'matchEnd']);
    assert.equal(r.state.phase, 'ended');
    assert.equal(r.state.winner, 0);
    assert.deepEqual(r.state.score, { 1: 12, 2: 12 });
  });

  it('no team at 13 after 24 rounds is a draw too', () => {
    const live = state({ phase: 'live', round: 24, endsAt: 100_000, score: { 1: 11, 2: 10 } });
    const r = stepHvhRound(live, { 1: 1, 2: 0 }, FULL, 50_000);
    assert.equal(r.state.phase, 'ended');
    assert.deepEqual(r.state.score, { 1: 12, 2: 10 });
    assert.equal(r.state.winner, 0);
  });
});
