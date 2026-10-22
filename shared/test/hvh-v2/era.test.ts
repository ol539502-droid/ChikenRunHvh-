import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  type EraTable,
  LATE_CSGO,
  validateEra,
  lagCompWindowTicks,
} from '../../src/hvh/v2/era';

describe('Era table and validation (v2)', () => {
  it('defines LATE_CSGO with verbatim era values from global constraints', () => {
    assert.equal(LATE_CSGO.id, 'late-csgo');
    assert.equal(LATE_CSGO.tickRate, 64);
    assert.equal(LATE_CSGO.maxProcessTicks, 16);
    assert.equal(LATE_CSGO.chargeTicks, 32);
    assert.equal(LATE_CSGO.maxChoke, 14);
    assert.equal(LATE_CSGO.lagCompWindowMs, 200);
    assert.equal(LATE_CSGO.maxDesyncDeg, 58);
    assert.equal(LATE_CSGO.desyncRunFalloff, 0.5);
    assert.equal(LATE_CSGO.lagCompBreakHulls, 2);
    assert.ok(Math.abs(LATE_CSGO.maxPitchDeg - (1.2 * 180) / Math.PI) < 1e-12, 'the hitbox pitch limit (1.2 rad)');
    for (const gone of ['doubleTapShift', 'doubleTapShiftOptions', 'hideShotsShift', 'defensiveShift', 'rechargeDelayTicks']) {
      assert.ok(!(gone in LATE_CSGO), `${gone} is no longer an era field`);
    }
  });

  it('validates LATE_CSGO cleanly with no errors', () => {
    const errors = validateEra(LATE_CSGO);
    assert.deepEqual(errors, []);
  });

  it('computes lag compensation window ticks correctly', () => {
    assert.equal(lagCompWindowTicks(LATE_CSGO), 12);
    const custom: EraTable = {
      ...LATE_CSGO,
      lagCompWindowMs: 250,
    };
    assert.equal(lagCompWindowTicks(custom), 16);
  });

  it('reports error when maxChoke exceeds maxProcessTicks', () => {
    const table: EraTable = {
      ...LATE_CSGO,
      maxChoke: 17,
    };
    const errors = validateEra(table);
    assert.ok(errors.includes('maxChoke exceeds maxProcessTicks'));
  });

  it('reports error when desyncRunFalloff is out of range [0,1]', () => {
    const tableHigh: EraTable = {
      ...LATE_CSGO,
      desyncRunFalloff: 1.2,
    };
    const errorsHigh = validateEra(tableHigh);
    assert.ok(errorsHigh.includes('desyncRunFalloff out of range [0,1]'));

    const tableLow: EraTable = {
      ...LATE_CSGO,
      desyncRunFalloff: -0.1,
    };
    const errorsLow = validateEra(tableLow);
    assert.ok(errorsLow.includes('desyncRunFalloff out of range [0,1]'));
  });

  it('reports error when chargeTicks is not an integer from 1 to 64', () => {
    for (const chargeTicks of [0, -1, 65, 12.5, Number.POSITIVE_INFINITY]) {
      const errors = validateEra({ ...LATE_CSGO, chargeTicks });
      assert.ok(errors.includes('chargeTicks not an integer in [1,64]'), String(chargeTicks));
    }
    for (const chargeTicks of [1, 32, 64]) {
      assert.deepEqual(validateEra({ ...LATE_CSGO, chargeTicks }), [], String(chargeTicks));
    }
  });
});

describe('validateEra NaN hardening', () => {
  for (const field of ['maxProcessTicks', 'maxChoke', 'desyncRunFalloff', 'chargeTicks'] as const) {
    it(`reports an error when ${field} is NaN`, () => {
      const table = { ...LATE_CSGO, [field]: Number.NaN } as EraTable;
      assert.ok(validateEra(table).length > 0, `${field}: NaN must not validate`);
    });
  }
});
