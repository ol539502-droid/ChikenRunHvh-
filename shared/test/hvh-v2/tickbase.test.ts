import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { LATE_CSGO } from '../../src/hvh/v2/era';
import {
  type CommandIntent,
  type TickbaseState,
  EMPTY_TICKBASE,
  holdForCharge,
  movementSteps,
  stepTickbase,
} from '../../src/hvh/v2/tickbase';
import { createMoveState } from '../../src/physics';

const IDLE: CommandIntent = { fire: false, choke: false, doubleTap: false, hideShots: false };
const DT: CommandIntent = { ...IDLE, doubleTap: true };
const HS: CommandIntent = { ...IDLE, hideShots: true };
const HIDDEN = { enemyVisible: false };
const SEEN = { enemyVisible: true };
const FULL = LATE_CSGO.chargeTicks;

function state(partial: Partial<TickbaseState>): TickbaseState {
  return { ...EMPTY_TICKBASE(100), ...partial };
}

describe('Tickbase charge and burst (v2)', () => {
  it('EMPTY_TICKBASE starts uncharged, unchoked and unarmed', () => {
    assert.deepEqual(EMPTY_TICKBASE(7), { tickbase: 7, charge: 0, choked: 0, armed: false });
  });

  it('rule 1: DT shot with full charge bursts every stored tick', () => {
    const s = state({ charge: FULL, armed: true });
    const r = stepTickbase(s, { ...DT, fire: true }, LATE_CSGO, SEEN);
    assert.deepEqual(r.action, { kind: 'burst', ticks: 32, reason: 'doubleTap' });
    assert.deepEqual(r.next, { tickbase: s.tickbase + 1 + 32, charge: 0, choked: 0, armed: true });
  });

  it('rule 1: hide-shots shot with full charge bursts with reason hideShots', () => {
    const s = state({ charge: FULL, armed: true });
    const r = stepTickbase(s, { ...HS, fire: true }, LATE_CSGO, HIDDEN);
    assert.deepEqual(r.action, { kind: 'burst', ticks: 32, reason: 'hideShots' });
    assert.equal(r.next.charge, 0);
    assert.equal(r.next.tickbase, s.tickbase + 33);
  });

  it('rule 1: DT takes the reason when both exploits are on', () => {
    const r = stepTickbase(state({ charge: FULL }), { ...DT, hideShots: true, fire: true }, LATE_CSGO, SEEN);
    assert.deepEqual(r.action, { kind: 'burst', ticks: 32, reason: 'doubleTap' });
  });

  it('rule 2: shot with a partial charge is rejected, runs, and loses the charge', () => {
    const s = state({ charge: 10, armed: true, choked: 3 });
    const dt = stepTickbase(s, { ...DT, fire: true }, LATE_CSGO, HIDDEN);
    assert.deepEqual(dt.action, { kind: 'reject', reason: 'dtNotCharged' });
    assert.deepEqual(dt.next, { tickbase: s.tickbase + 1, charge: 0, choked: 0, armed: true });
    const hs = stepTickbase(s, { ...HS, fire: true }, LATE_CSGO, SEEN);
    assert.deepEqual(hs.action, { kind: 'reject', reason: 'hsNotCharged' });
    assert.equal(hs.next.charge, 0);
  });

  it('a shot at charge 0 runs as a plain shot, no reject, and does not charge', () => {
    for (const ctx of [SEEN, HIDDEN]) {
      const s = state({ charge: 0 });
      const r = stepTickbase(s, { ...DT, fire: true }, LATE_CSGO, ctx);
      assert.deepEqual(r.action, { kind: 'run' });
      assert.deepEqual(r.next, { tickbase: s.tickbase + 1, charge: 0, choked: 0, armed: true });
      const c = stepTickbase(s, { ...HS, fire: true, choke: true }, LATE_CSGO, ctx);
      assert.deepEqual(c.action, { kind: 'choke' });
      assert.equal(c.next.charge, 0);
    }
  });

  it('rule 3: turning the exploit off with full charge releases a burst', () => {
    const s = state({ charge: FULL, armed: true });
    const r = stepTickbase(s, IDLE, LATE_CSGO, SEEN);
    assert.deepEqual(r.action, { kind: 'burst', ticks: 32, reason: 'release' });
    assert.deepEqual(r.next, { tickbase: s.tickbase + 33, charge: 0, choked: 0, armed: false });
  });

  it('rule 3: release also wins over a choke and over a plain shot', () => {
    const s = state({ charge: FULL, armed: true });
    assert.equal(stepTickbase(s, { ...IDLE, choke: true }, LATE_CSGO, HIDDEN).action.kind, 'burst');
    assert.deepEqual(stepTickbase(s, { ...IDLE, fire: true }, LATE_CSGO, HIDDEN).action, {
      kind: 'burst', ticks: 32, reason: 'release',
    });
  });

  it('rule 3: exploit off without full charge does not burst and drops the partial charge', () => {
    const r = stepTickbase(state({ charge: 20, armed: true }), IDLE, LATE_CSGO, HIDDEN);
    assert.deepEqual(r.action, { kind: 'run' });
    assert.equal(r.next.charge, 0);
  });

  it('rule 4: exploit on, no enemy visible, not firing charges without advancing tickbase', () => {
    const s = state({ charge: 5, choked: 4 });
    const r = stepTickbase(s, DT, LATE_CSGO, HIDDEN);
    assert.deepEqual(r.action, { kind: 'charge' });
    assert.deepEqual(r.next, { tickbase: s.tickbase, charge: 6, choked: 0, armed: true });
    assert.deepEqual(stepTickbase(state({ charge: 0 }), HS, LATE_CSGO, HIDDEN).action, { kind: 'charge' });
  });

  it('rule 4: choke is ignored on a charge tick', () => {
    const r = stepTickbase(state({ charge: 3, choked: 2 }), { ...DT, choke: true }, LATE_CSGO, HIDDEN);
    assert.deepEqual(r.action, { kind: 'charge' });
    assert.equal(r.next.choked, 0);
  });

  it('rule 5: an enemy seen mid-charge cancels it and the tick runs', () => {
    const s = state({ charge: 12, armed: true });
    const r = stepTickbase(s, DT, LATE_CSGO, SEEN);
    assert.deepEqual(r.action, { kind: 'cancel' });
    assert.deepEqual(r.next, { tickbase: s.tickbase + 1, charge: 0, choked: 0, armed: true });
  });

  it('rule 5 is exclusive: no charge and an enemy visible is a plain run', () => {
    const r = stepTickbase(state({ charge: 0 }), DT, LATE_CSGO, SEEN);
    assert.deepEqual(r.action, { kind: 'run' });
    assert.equal(r.next.charge, 0);
  });

  it('rule 6: choke up to maxChoke, then the tick runs', () => {
    let s = EMPTY_TICKBASE(0);
    for (let i = 1; i <= 20; i++) {
      const r = stepTickbase(s, { ...IDLE, choke: true }, LATE_CSGO, SEEN);
      if (i <= 14) assert.deepEqual(r.action, { kind: 'choke' }, `tick ${i}`);
      if (i === 15) assert.deepEqual(r.action, { kind: 'run' });
      s = r.next;
      assert.ok(s.choked <= 14, `choked ${s.choked} at tick ${i}`);
    }
  });

  it('rule 6: a fully charged player can still choke', () => {
    const s = state({ charge: FULL, armed: true });
    const r = stepTickbase(s, { ...DT, choke: true }, LATE_CSGO, HIDDEN);
    assert.deepEqual(r.action, { kind: 'choke' });
    assert.deepEqual(r.next, { tickbase: s.tickbase + 1, charge: FULL, choked: 1, armed: true });
  });

  it('rule 7: exploits off is a plain run', () => {
    const s = state({ choked: 5 });
    const r = stepTickbase(s, { ...IDLE, fire: true }, LATE_CSGO, HIDDEN);
    assert.deepEqual(r.action, { kind: 'run' });
    assert.deepEqual(r.next, { tickbase: s.tickbase + 1, charge: 0, choked: 0, armed: false });
  });

  it('32 consecutive invisible ticks reach full charge; tickbase holds still meanwhile', () => {
    let s = EMPTY_TICKBASE(50);
    for (let i = 0; i < 32; i++) {
      const r = stepTickbase(s, DT, LATE_CSGO, HIDDEN);
      assert.deepEqual(r.action, { kind: 'charge' }, `tick ${i}`);
      s = r.next;
    }
    assert.equal(s.charge, 32);
    assert.equal(s.tickbase, 50);
    // Full: no more charging; the next tick runs.
    const r = stepTickbase(s, DT, LATE_CSGO, HIDDEN);
    assert.deepEqual(r.action, { kind: 'run' });
    assert.equal(r.next.charge, 32);
    assert.equal(r.next.tickbase, 51);
  });

  it('alternating visible and invisible ticks never reach full charge', () => {
    let s = EMPTY_TICKBASE(0);
    for (let i = 0; i < 500; i++) {
      s = stepTickbase(s, DT, LATE_CSGO, { enemyVisible: i % 2 === 1 }).next;
      assert.ok(s.charge <= 1, `charge ${s.charge} at tick ${i}`);
    }
    // The loop ends on a visible tick, so the charge is 0 and a shot is a plain run.
    assert.equal(s.charge, 0);
    assert.equal(stepTickbase(s, { ...DT, fire: true }, LATE_CSGO, HIDDEN).action.kind, 'run');
  });

  it('a full charge stays full while an enemy is visible', () => {
    let s = state({ charge: FULL, armed: true });
    for (let i = 0; i < 10; i++) {
      const r = stepTickbase(s, DT, LATE_CSGO, SEEN);
      assert.deepEqual(r.action, { kind: 'run' });
      s = r.next;
    }
    assert.equal(s.charge, FULL);
  });

  it('tickbase counter over a charge, wait, DT shot and recharge cycle', () => {
    let s = EMPTY_TICKBASE(0);
    for (let i = 0; i < 32; i++) s = stepTickbase(s, DT, LATE_CSGO, HIDDEN).next; // +0 each
    for (let i = 0; i < 5; i++) s = stepTickbase(s, DT, LATE_CSGO, SEEN).next; // +1 each
    assert.equal(s.tickbase, 5);
    s = stepTickbase(s, { ...DT, fire: true }, LATE_CSGO, SEEN).next; // +33
    assert.equal(s.tickbase, 38);
    s = stepTickbase(s, { ...DT, choke: true }, LATE_CSGO, SEEN).next; // choke +1
    s = stepTickbase(s, DT, LATE_CSGO, HIDDEN).next; // charge +0
    s = stepTickbase(s, DT, LATE_CSGO, SEEN).next; // cancel +1
    s = stepTickbase(s, { ...DT, fire: true }, LATE_CSGO, SEEN).next; // charge 0 after the cancel: plain shot +1
    assert.equal(s.tickbase, 41);
    assert.equal(s.charge, 0);
  });

  it('next.armed is doubleTap || hideShots on every kind of tick', () => {
    assert.equal(stepTickbase(state({}), HS, LATE_CSGO, SEEN).next.armed, true);
    assert.equal(stepTickbase(state({ armed: true }), IDLE, LATE_CSGO, SEEN).next.armed, false);
    assert.equal(stepTickbase(state({}), { ...IDLE, choke: true }, LATE_CSGO, SEEN).next.armed, false);
  });

  it('is pure: does not mutate input state', () => {
    const s = Object.freeze(state({ charge: FULL, choked: 3, armed: true }));
    stepTickbase(s, { ...DT, fire: true }, LATE_CSGO, SEEN);
    stepTickbase(s, IDLE, LATE_CSGO, SEEN);
    assert.deepEqual(s, { tickbase: 100, charge: FULL, choked: 3, armed: true });
  });
});

describe('charge movement', () => {
  it('movementSteps: none on a charge tick, 1 + ticks on a burst, one otherwise', () => {
    assert.equal(movementSteps({ kind: 'charge' }), 0);
    assert.equal(movementSteps({ kind: 'burst', ticks: FULL, reason: 'release' }), 1 + FULL);
    for (const action of [{ kind: 'run' }, { kind: 'choke' }, { kind: 'cancel' }, { kind: 'reject', reason: 'dtNotCharged' }] as const) {
      assert.equal(movementSteps(action), 1, action.kind);
    }
  });

  it('holdForCharge zeroes every velocity and keeps the position', () => {
    const s = { ...createMoveState(1, 2, 3), vx: 1, vy: -4, vz: 2, walkVx: 3, walkVz: -3, horizontalSpeed: 5, onGround: false };
    holdForCharge(s);
    assert.deepEqual([s.x, s.y, s.z, s.vx, s.vy, s.vz, s.walkVx, s.walkVz, s.horizontalSpeed], [1, 2, 3, 0, 0, 0, 0, 0, 0]);
  });
});
