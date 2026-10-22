import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { LATE_CSGO, validateEra } from '../../src/hvh/v2/era';
import { DEFAULT_ERA_ID, ERAS } from '../../src/hvh/v2/eras';

describe('Era profiles (v2)', () => {
  it('every ERAS entry passes validateEra', () => {
    for (const [id, era] of Object.entries(ERAS)) assert.deepEqual(validateEra(era), [], id);
  });

  it('ERAS default is LATE_CSGO', () => {
    assert.equal(DEFAULT_ERA_ID, 'late-csgo');
    assert.equal(ERAS[DEFAULT_ERA_ID], LATE_CSGO);
  });

  it('holds the four legacy era profiles, each keyed by its own id', () => {
    for (const id of ['legacy', 'desync', 'tickbase', 'defensive']) assert.ok(ERAS[id], id);
    for (const [id, era] of Object.entries(ERAS)) {
      assert.equal(era.id, id);
      assert.equal(era.tickRate, 64);
      assert.ok(Object.isFrozen(era), `${id} is frozen`);
    }
    assert.deepEqual(Object.keys(ERAS).sort(), ['defensive', 'desync', 'late-csgo', 'legacy', 'tickbase']);
  });

  it('legacy profiles carry the legacy limits: 12 choked commands, 300 ms rewind', () => {
    for (const id of ['legacy', 'desync', 'tickbase', 'defensive']) {
      assert.equal(ERAS[id]!.maxChoke, 12, id);
      assert.equal(ERAS[id]!.lagCompWindowMs, 300, id);
      assert.equal(ERAS[id]!.maxDesyncDeg, 58, id);
    }
  });

  it('every profile charges 32 ticks', () => {
    for (const [id, era] of Object.entries(ERAS)) assert.equal(era.chargeTicks, 32, id);
  });
});
