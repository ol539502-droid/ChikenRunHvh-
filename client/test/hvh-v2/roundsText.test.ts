import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MODES } from '@game/shared';
import { HVH_ROUNDS } from '@game/shared/hvh/v2';
import { roundsObjective, scoreTarget, warmupBanner } from '../../src/ui/hvh/roundsText';

describe('rounds HUD text (M7, paused banner)', () => {
  it('a v2 rounds match is first to 13 rounds, not 40 kills', () => {
    assert.equal(roundsObjective(HVH_ROUNDS), 'First to 13 rounds · sides switch after 12');
    assert.equal(scoreTarget(MODES.hvh, HVH_ROUNDS), 13);
  });

  it('without rounds (legacy HvH, other modes) the mode limit stays', () => {
    assert.equal(scoreTarget(MODES.hvh, null), MODES.hvh.scoreLimit);
    assert.equal(scoreTarget(MODES.bomb, null), MODES.bomb.scoreLimit);
  });

  it('the warmup banner names the next round: 1 first, the one after the score after a pause', () => {
    assert.equal(warmupBanner(0, 4200), 'Round 1 in 5');
    assert.equal(warmupBanner(7, 900), 'Round 8 in 1');
    assert.equal(warmupBanner(7, 0), 'Round 8 in 1');
    assert.equal(warmupBanner(7, 5000), '', 'not before the last 5 seconds');
    assert.equal(warmupBanner(7, null), '', 'not while the warmup waits for players');
  });
});
