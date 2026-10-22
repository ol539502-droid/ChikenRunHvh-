import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Vec3 } from '../../src/math';
import { PLAYER_HULL_WIDTH } from '../../src/constants';
import { LATE_CSGO, lagCompWindowTicks } from '../../src/hvh/v2/era';
import { INITIAL_POSE } from '../../src/hvh/v2/pose';
import { type LagRecord, RecordHistory } from '../../src/hvh/v2/records';

const HULL = PLAYER_HULL_WIDTH;

function rec(tick: number, position: Vec3 = { x: 0, y: 0, z: 0 }): LagRecord {
  return { tick, position, pose: INITIAL_POSE, valid: true };
}

function fill(h: RecordHistory, from: number, to: number): void {
  for (let t = from; t <= to; t++) h.push(rec(t));
}

function selectedTick(r: ReturnType<RecordHistory['select']>): number {
  assert.ok('record' in r, `expected a record, got ${JSON.stringify(r)}`);
  return r.record.tick;
}

describe('Lag records (v2)', () => {
  it('hull width is twice the player radius and the window is 12 ticks', () => {
    assert.equal(HULL, 0.9);
    assert.equal(lagCompWindowTicks(LATE_CSGO), 12);
  });

  it('expired after 12 ticks', () => {
    const h = new RecordHistory(LATE_CSGO, HULL);
    const now = 100;
    fill(h, 80, now);
    assert.equal(selectedTick(h.select(now - 12, now)), now - 12, 'now-12 still inside the window');
    assert.deepEqual(h.select(now - 13, now), { invalid: 'expired' });
  });

  it('break on teleport-sized move', () => {
    const now = 100;
    const broken = new RecordHistory(LATE_CSGO, HULL);
    fill(broken, 90, now - 1);
    broken.push(rec(now, { x: 2.01 * HULL, y: 0, z: 0 }));
    assert.deepEqual(broken.select(now - 1, now), { invalid: 'lagcompBreak' });
    assert.deepEqual(broken.select(now - 5, now), { invalid: 'lagcompBreak' });
    assert.equal(selectedTick(broken.select(now, now)), now, 'the new record itself stays valid');

    const ok = new RecordHistory(LATE_CSGO, HULL);
    fill(ok, 90, now - 1);
    ok.push(rec(now, { x: 0, y: 0, z: 1.99 * HULL }));
    assert.equal(selectedTick(ok.select(now - 1, now)), now - 1);
    assert.equal(selectedTick(ok.select(now - 5, now)), now - 5);
  });

  it('break distance is horizontal: a large vertical move does not break', () => {
    const now = 100;
    const h = new RecordHistory(LATE_CSGO, HULL);
    fill(h, 90, now - 1);
    h.push(rec(now, { x: 0, y: 10 * HULL, z: 0 }));
    assert.equal(selectedTick(h.select(now - 1, now)), now - 1);
  });

  it('break measures the diagonal horizontal distance', () => {
    const now = 100;
    const h = new RecordHistory(LATE_CSGO, HULL);
    fill(h, 90, now - 1);
    const d = (2.01 * HULL) / Math.SQRT2;
    h.push(rec(now, { x: d, y: 0, z: d }));
    assert.deepEqual(h.select(now - 1, now), { invalid: 'lagcompBreak' });
  });

  it('records older than a break stay invalid after later pushes', () => {
    const h = new RecordHistory(LATE_CSGO, HULL);
    fill(h, 90, 94);
    h.push(rec(95, { x: 5, y: 0, z: 0 }));
    h.push(rec(96, { x: 5, y: 0, z: 0 }));
    h.push(rec(97, { x: 5, y: 0, z: 0 }));
    assert.deepEqual(h.select(94, 97), { invalid: 'lagcompBreak' });
    assert.equal(selectedTick(h.select(95, 97)), 95);
  });

  it('choke gap uses last record', () => {
    const h = new RecordHistory(LATE_CSGO, HULL);
    h.push(rec(90));
    h.push(rec(92));
    // ticks 93..97 choked
    h.push(rec(98));
    const now = 100;
    assert.equal(selectedTick(h.select(95, now)), 92);
    assert.equal(selectedTick(h.select(91, now)), 90);
    assert.equal(selectedTick(h.select(99, now)), 98, 'still choking after the last record');
  });

  it('choke gap with no earlier record inside the window is choked', () => {
    const h = new RecordHistory(LATE_CSGO, HULL);
    h.push(rec(80));
    h.push(rec(99));
    const now = 100;
    // view 92 is inside the window, but the last record before it (80) is expired.
    assert.deepEqual(h.select(92, now), { invalid: 'choked' });

    const empty = new RecordHistory(LATE_CSGO, HULL);
    assert.deepEqual(empty.select(95, now), { invalid: 'choked' });
  });

  it('choke gap after an invalid record inherits its cause', () => {
    const h = new RecordHistory(LATE_CSGO, HULL);
    h.push(rec(93));
    h.push(rec(94));
    // ticks 95..97 choked, then a teleport
    h.push(rec(98, { x: 5, y: 0, z: 0 }));
    const now = 100;
    assert.deepEqual(h.select(96, now), { invalid: 'lagcompBreak' });
  });

  it('records are immutable to callers', () => {
    const h = new RecordHistory(LATE_CSGO, HULL);
    const input = rec(10);
    h.push(input);
    input.valid = false;
    input.position.x = 99;
    const r = h.select(10, 10);
    assert.ok('record' in r);
    assert.equal(r.record.position.x, 0, 'push copies its input');
    assert.throws(() => {
      (r.record as LagRecord).valid = false;
    }, TypeError);
    assert.throws(() => {
      (r.record.position as Vec3).x = 1;
    }, TypeError);
    const all = h.records();
    assert.throws(() => {
      (all[0] as LagRecord).valid = false;
    }, TypeError);
    assert.equal(selectedTick(h.select(10, 10)), 10);
  });

  it('records() exposes valid and invalid records for the overlay', () => {
    const h = new RecordHistory(LATE_CSGO, HULL);
    fill(h, 1, 3);
    h.push(rec(4, { x: 5, y: 0, z: 0 }));
    h.push(rec(5, { x: 5, y: 0, z: 0 }));
    const all = h.records();
    assert.deepEqual(
      all.map((r) => [r.tick, r.valid, r.invalidCause]),
      [
        [1, false, 'lagcompBreak'],
        [2, false, 'lagcompBreak'],
        [3, false, 'lagcompBreak'],
        [4, true, undefined],
        [5, true, undefined],
      ],
    );
  });

  it('prunes records far outside the window', () => {
    const h = new RecordHistory(LATE_CSGO, HULL);
    fill(h, 0, 10_000);
    const all = h.records();
    assert.ok(all.length <= 2 * lagCompWindowTicks(LATE_CSGO) + 1, `kept ${all.length}`);
    assert.equal(all[all.length - 1]!.tick, 10_000);
    assert.equal(selectedTick(h.select(10_000 - 12, 10_000)), 10_000 - 12);
  });

  it('rejects non-increasing ticks', () => {
    const h = new RecordHistory(LATE_CSGO, HULL);
    h.push(rec(5));
    assert.throws(() => h.push(rec(5)), RangeError);
    assert.throws(() => h.push(rec(4)), RangeError);
    assert.throws(() => h.push({ ...rec(6), valid: false }), RangeError, 'invalid without a cause');
  });

  it('duck round-trips through push/select, and stays absent when not given', () => {
    const h = new RecordHistory(LATE_CSGO, HULL);
    h.push(rec(10));
    h.push({ ...rec(11), duck: 0.6 });
    const ducked = h.select(11, 11);
    assert.ok('record' in ducked);
    assert.equal(ducked.record.duck, 0.6);
    assert.ok(Object.isFrozen(ducked.record));
    const standing = h.select(10, 11);
    assert.ok('record' in standing);
    assert.equal('duck' in standing.record, false);
    // Survives an invalidating re-freeze too (a break).
    h.push(rec(12, { x: 5, y: 0, z: 0 }));
    assert.deepEqual([h.records()[1]!.valid, h.records()[1]!.duck], [false, 0.6]);
  });
});
