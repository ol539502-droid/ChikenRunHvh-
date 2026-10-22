import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { wrapAngle } from '../../src/math';
import { LATE_CSGO } from '../../src/hvh/v2/era';
import { mulberry32 } from '../../src/rng';
import {
  type AntiAimConfig,
  type DefensiveAA,
  type PoseContext,
  type StanceAA,
  type V2Stance,
  FLICK_TICKS,
  NO_DEFENSIVE,
  PEEK_TICKS,
  V2_STANCES,
  stanceOf,
  uniformAntiAim,
  type Motion,
  type PoseState,
  INITIAL_POSE,
  maxDesync,
  publicObservation,
  stepPose,
} from '../../src/hvh/v2/pose';

const EPS = 1e-9;
const DEG = Math.PI / 180;

const STAND: Motion = { speedFraction: 0, duck: 0, onGround: true };
const RUN: Motion = { speedFraction: 1, duck: 0, onGround: true };
const CTX: PoseContext = { seed: 0, peekTicksLeft: 0, slowWalk: false };
/** One stance config for all five stances, defensive off. */
function plain(s: Partial<StanceAA> = {}, inverted = false): AntiAimConfig {
  return uniformAntiAim({ base: 'backward', yawOffsetDeg: 0, jitterDeg: 0, desyncDeg: 58, ...s }, inverted);
}
const AA = plain();

function desyncDeg(p: PoseState): number {
  return Math.abs(wrapAngle(p.bodyYaw - p.eyeYaw)) / DEG;
}

describe('Pose and desync (v2)', () => {
  it('maxDesync falls off linearly with speed', () => {
    assert.equal(maxDesync(0, LATE_CSGO), 58);
    assert.equal(maxDesync(1, LATE_CSGO), 29);
    assert.ok(Math.abs(maxDesync(0.5, LATE_CSGO) - 43.5) < EPS);
    assert.equal(maxDesync(2, LATE_CSGO), 29, 'speedFraction clamped to 1');
    assert.equal(maxDesync(-1, LATE_CSGO), 58, 'speedFraction clamped to 0');
  });

  it('desync clamps by speed', () => {
    const p = stepPose(INITIAL_POSE, 0, AA, RUN, 1, LATE_CSGO, CTX);
    assert.ok(desyncDeg(p) <= 29 + EPS, `desync ${desyncDeg(p)}`);
    assert.ok(Math.abs(desyncDeg(p) - 29) < EPS);
    const s = stepPose(INITIAL_POSE, 0, AA, STAND, 1, LATE_CSGO, CTX);
    assert.ok(Math.abs(desyncDeg(s) - 58) < EPS);
  });

  it('backward base faces away from aim', () => {
    const p = stepPose(INITIAL_POSE, 0.3, AA, STAND, 1, LATE_CSGO, CTX);
    assert.ok(Math.abs(wrapAngle(p.eyeYaw - (0.3 + Math.PI))) < EPS);
  });

  it('jitter alternates', () => {
    const aa = plain({ jitterDeg: 30 });
    let p = INITIAL_POSE;
    let lastPhase = p.jitterPhase;
    for (let tick = 1; tick <= 6; tick++) {
      p = stepPose(p, 0, aa, STAND, tick, LATE_CSGO, CTX);
      assert.notEqual(p.jitterPhase, lastPhase, `phase flips at tick ${tick}`);
      lastPhase = p.jitterPhase;
      const offset = wrapAngle(p.eyeYaw - Math.PI) / DEG;
      assert.ok(Math.abs(Math.abs(offset) - 30) < EPS, `offset ${offset}`);
      assert.equal(Math.sign(offset), p.jitterPhase === 1 ? 1 : -1);
      const obs = publicObservation(p, STAND, tick);
      assert.ok(Math.abs(obs.eyeOffsetDeg - offset) < EPS);
    }
  });

  it('jitter is clamped to 0..45', () => {
    const p = stepPose(INITIAL_POSE, 0, plain({ jitterDeg: 90 }), STAND, 1, LATE_CSGO, CTX);
    assert.ok(Math.abs(Math.abs(wrapAngle(p.eyeYaw - Math.PI)) / DEG - 45) < EPS);
  });

  it('inverted flips side', () => {
    const a = stepPose(INITIAL_POSE, 0, AA, STAND, 1, LATE_CSGO, CTX);
    const b = stepPose(INITIAL_POSE, 0, plain({}, true), STAND, 1, LATE_CSGO, CTX);
    assert.notEqual(a.realSide, 'center');
    assert.notEqual(b.realSide, 'center');
    assert.notEqual(a.realSide, b.realSide);
  });

  it('jitter desync alternates realSide in lockstep with jitterPhase', () => {
    const aa = plain({ jitterDeg: 30, desyncDeg: 58 });
    let p = INITIAL_POSE;
    let last: PoseState | undefined;
    for (let tick = 1; tick <= 8; tick++) {
      p = stepPose(p, 0, aa, STAND, tick, LATE_CSGO, CTX);
      assert.notEqual(p.realSide, 'center');
      assert.equal(p.realSide, p.jitterPhase === 0 ? 'left' : 'right', `tick ${tick}`);
      if (last) assert.notEqual(p.realSide, last.realSide, `realSide flips at tick ${tick}`);
      assert.ok(Math.abs(desyncDeg(p) - 58) < EPS);
      last = p;
    }
  });

  it('inverted gives the opposite realSide at every jitter tick', () => {
    const aa = plain({ jitterDeg: 30, desyncDeg: 58 });
    let a = INITIAL_POSE;
    let b = INITIAL_POSE;
    for (let tick = 1; tick <= 8; tick++) {
      a = stepPose(a, 0, aa, STAND, tick, LATE_CSGO, CTX);
      b = stepPose(b, 0, { ...aa, inverted: true }, STAND, tick, LATE_CSGO, CTX);
      assert.equal(a.jitterPhase, b.jitterPhase);
      assert.notEqual(a.realSide, 'center');
      assert.notEqual(a.realSide, b.realSide, `tick ${tick}`);
    }
  });

  it('no jitter keeps realSide constant', () => {
    for (const inverted of [false, true]) {
      let p = INITIAL_POSE;
      const sides = new Set<string>();
      for (let tick = 1; tick <= 8; tick++) {
        p = stepPose(p, 0, plain({ jitterDeg: 0 }, inverted), STAND, tick, LATE_CSGO, CTX);
        sides.add(p.realSide);
      }
      assert.deepEqual([...sides], [inverted ? 'right' : 'left']);
    }
  });

  it('eyeOffsetDeg is never -0', () => {
    let p = INITIAL_POSE;
    for (let tick = 1; tick <= 4; tick++) {
      p = stepPose(p, 0, plain({ jitterDeg: 0 }), STAND, tick, LATE_CSGO, CTX);
      assert.ok(!Object.is(p.eyeOffsetDeg, -0), `tick ${tick}`);
      assert.ok(!Object.is(publicObservation(p, STAND, tick).eyeOffsetDeg, -0));
    }
  });

  it('zero desync is center', () => {
    const p = stepPose(INITIAL_POSE, 0, plain({ desyncDeg: 0 }), STAND, 1, LATE_CSGO, CTX);
    assert.equal(p.realSide, 'center');
    assert.ok(desyncDeg(p) < EPS);
  });

  it('observation hides body', () => {
    const p = stepPose(INITIAL_POSE, 0, plain({ jitterDeg: 20 }), RUN, 5, LATE_CSGO, CTX);
    const obs = publicObservation(p, RUN, 5);
    assert.ok(!('bodyYaw' in obs));
    assert.ok(!('realSide' in obs));
    assert.equal(obs.tick, 5);
    assert.equal(obs.eyeYaw, p.eyeYaw);
    assert.equal(obs.speedFraction, 1);
    assert.equal(obs.duck, 0);
  });

  it('does not mutate prev', () => {
    const prev = Object.freeze({ ...INITIAL_POSE });
    stepPose(prev, 1, plain({ jitterDeg: 30 }), RUN, 3, LATE_CSGO, CTX);
    assert.deepEqual(prev, INITIAL_POSE);
  });

  it('deterministic', () => {
    const aa = plain({ base: 'spin', jitterDeg: 15, desyncDeg: 40 }, true);
    const run = () => {
      let p = INITIAL_POSE;
      const out = [];
      for (let tick = 1; tick <= 20; tick++) {
        p = stepPose(p, tick * 0.01, aa, { speedFraction: 0.4, duck: 0.5, onGround: true }, tick, LATE_CSGO, CTX);
        out.push({ p, obs: publicObservation(p, RUN, tick) });
      }
      return out;
    };
    assert.deepEqual(run(), run());
  });
});

describe('Per-stance anti-aim and defensive patterns (v2)', () => {
  const AIR: Motion = { speedFraction: 0.5, duck: 0, onGround: false };
  const CROUCH: Motion = { speedFraction: 0.5, duck: 1, onGround: true };
  const SLOW: Motion = { speedFraction: 0.3, duck: 0, onGround: true };
  const STANCE: StanceAA = { base: 'backward', yawOffsetDeg: 0, jitterDeg: 0, desyncDeg: 30 };
  const DEF: DefensiveAA = { enabled: true, inAir: false, onPeek: false, always: true, pitch: 'zero', yaw: 'off' };
  /** The defensive pitch magnitude: 89 within the era limit (R58), 1.2 rad in LATE_CSGO. */
  const P = Math.min(89, LATE_CSGO.maxPitchDeg);

  /** Every stance STANCE (with `stances` overrides), and `defensive` on all five. */
  function withDefensive(defensive: Partial<DefensiveAA>, stances: Partial<Record<V2Stance, Partial<StanceAA>>> = {}): AntiAimConfig {
    const aa = uniformAntiAim(STANCE);
    for (const s of V2_STANCES) {
      aa.stances[s] = { ...STANCE, ...stances[s] };
      aa.defensive[s] = { ...DEF, ...defensive };
    }
    return aa;
  }
  /** Eye yaw offset from the backward base (aim 0), degrees. */
  const offsetDeg = (p: PoseState) => wrapAngle(p.eyeYaw - Math.PI) / DEG;

  it('stanceOf covers each stance', () => {
    const m = (o: Partial<Motion & { slowWalk: boolean }>) => ({ ...STAND, slowWalk: false, ...o });
    assert.equal(stanceOf(m({})), 'standing');
    assert.equal(stanceOf(m({ slowWalk: true })), 'standing', 'slow walk held while standing still');
    assert.equal(stanceOf(m({ speedFraction: 1 })), 'moving');
    assert.equal(stanceOf(m({ speedFraction: 0.3, slowWalk: true })), 'slowwalking');
    assert.equal(stanceOf(m({ speedFraction: 1, duck: 1 })), 'crouching');
    assert.equal(stanceOf(m({ duck: 1, onGround: false })), 'airborne', 'air beats crouch');
    assert.equal(stanceOf(m({ onGround: false, slowWalk: true })), 'airborne');
  });

  it('the stance config selects the yaw base and offset', () => {
    const aa = withDefensive({ enabled: false }, {
      standing: { base: 'backward' }, moving: { base: 'left' }, airborne: { base: 'right' },
      crouching: { base: 'spin' }, slowwalking: { base: 'backward', yawOffsetDeg: 30 },
    });
    const yaw = (motion: Motion, slowWalk = false, tick = 64) => stepPose(INITIAL_POSE, 0, aa, motion, tick, LATE_CSGO, { ...CTX, slowWalk }).eyeYaw;
    assert.ok(Math.abs(wrapAngle(yaw(STAND) - Math.PI)) < EPS);
    assert.ok(Math.abs(wrapAngle(yaw(RUN) - Math.PI / 2)) < EPS);
    assert.ok(Math.abs(wrapAngle(yaw(AIR) + Math.PI / 2)) < EPS);
    // Spin at 180 deg/s: tick 64 is half a turn.
    assert.ok(Math.abs(wrapAngle(yaw(CROUCH) - Math.PI)) < EPS);
    assert.ok(Math.abs(wrapAngle(yaw(CROUCH, false, 32) - Math.PI / 2)) < EPS);
    assert.ok(Math.abs(wrapAngle(yaw(SLOW, true) - (Math.PI + 30 * DEG))) < EPS);
    assert.ok(Math.abs(wrapAngle(yaw(SLOW, false) - Math.PI / 2)) < EPS, 'the same speed without slow walk is moving');
  });

  it('each stance uses its own jitter and desync', () => {
    const aa = withDefensive({ enabled: false }, { standing: { desyncDeg: 50 }, moving: { desyncDeg: 10, jitterDeg: 20 } });
    const s = stepPose(INITIAL_POSE, 0, aa, STAND, 1, LATE_CSGO, CTX);
    assert.ok(Math.abs(desyncDeg(s) - 50) < EPS);
    assert.equal(s.eyeOffsetDeg, 0);
    const r = stepPose(INITIAL_POSE, 0, aa, RUN, 1, LATE_CSGO, CTX);
    assert.ok(Math.abs(desyncDeg(r) - 10) < EPS);
    assert.equal(Math.abs(r.eyeOffsetDeg), 20);
  });

  it('random pitch is deterministic from the seed and tick and changes every 4 ticks', () => {
    const aa = withDefensive({ pitch: 'random' });
    const pitchAt = (tick: number, seed: number) => stepPose(INITIAL_POSE, 0, aa, STAND, tick, LATE_CSGO, { ...CTX, seed }).pitch;
    for (const seed of [0, 7, 0x5eed13]) {
      let prev = INITIAL_POSE;
      for (let tick = 0; tick < 64; tick++) {
        const next = stepPose(prev, 0, aa, STAND, tick, LATE_CSGO, { ...CTX, seed });
        assert.equal(next.pitch, pitchAt(tick, seed), `seed ${seed} tick ${tick}: independent of the previous pose`);
        // Brief degrees are CS degrees (down positive); pose pitch is radians, up positive.
        const expected = -P + 2 * P * mulberry32(seed ^ Math.floor(tick / 4))();
        assert.ok(Math.abs(next.pitch + expected * DEG) < EPS, `seed ${seed} tick ${tick}: mulberry32(seed ^ floor(tick / 4))`);
        if (tick % 4 !== 0) assert.equal(next.pitch, prev.pitch, `seed ${seed} tick ${tick}: held inside the interval`);
        else if (tick > 0) assert.notEqual(next.pitch, prev.pitch, `seed ${seed} tick ${tick}: a new value`);
        prev = next;
      }
    }
    assert.notEqual(pitchAt(4, 1), pitchAt(4, 2), 'the seed matters');
  });

  it('a flick cycle is 4 ticks on (+120 deg x side) and 4 off, alternating side each flick', () => {
    const aa = withDefensive({ yaw: 'flick' });
    for (let tick = 0; tick < 32; tick++) {
      const p = stepPose(INITIAL_POSE, 0, aa, STAND, tick, LATE_CSGO, CTX);
      const on = tick % 8 < 4;
      const side = Math.floor(tick / 8) % 2 === 0 ? 1 : -1;
      assert.ok(Math.abs(offsetDeg(p) - (on ? 120 * side : 0)) < EPS, `tick ${tick}: offset ${offsetDeg(p)}`);
    }
  });

  it('an on-peek flick is phased by the window: the first FLICK_TICKS commands on (x peekSide), the rest off, at any tick', () => {
    const aa = withDefensive({ always: false, onPeek: true, yaw: 'flick' });
    assert.ok(Math.abs(LATE_CSGO.maxPitchDeg - 68.75) < 0.01, 'precondition: P below 89');
    for (const start of [0, 1, 2, 3, 4, 5, 6, 7, 1001]) {
      for (const side of [1, -1] as const) {
        for (let w = 0; w < PEEK_TICKS; w++) {
          for (const tick of [start + w, start]) { // advancing, or frozen (a charge inside the window)
            const p = stepPose(INITIAL_POSE, 0, aa, STAND, tick, LATE_CSGO, { ...CTX, peekTicksLeft: PEEK_TICKS - w, peekSide: side });
            assert.ok(Math.abs(offsetDeg(p) - (w < FLICK_TICKS ? 120 * side : 0)) < EPS, `start ${start} side ${side} w ${w} tick ${tick}: ${offsetDeg(p)}`);
          }
        }
      }
    }
    // Another trigger active as well: the tick phase.
    const both = withDefensive({ always: false, onPeek: true, inAir: true, yaw: 'flick' });
    const air = { speedFraction: 0, duck: 0, onGround: false };
    assert.ok(Math.abs(offsetDeg(stepPose(INITIAL_POSE, 0, both, air, 4, LATE_CSGO, { ...CTX, peekTicksLeft: PEEK_TICKS })) - 0) < EPS, 'in air: tick 4 is off');
    const always = withDefensive({ always: true, onPeek: true, yaw: 'flick' });
    assert.ok(Math.abs(offsetDeg(stepPose(INITIAL_POSE, 0, always, STAND, 8, LATE_CSGO, { ...CTX, peekTicksLeft: PEEK_TICKS })) + 120) < EPS, 'always: tick 8 is the -120 flick');
  });

  it('spin, random and sideways defensive yaw', () => {
    const spin = stepPose(INITIAL_POSE, 0, withDefensive({ yaw: 'spin' }), STAND, 32, LATE_CSGO, CTX);
    assert.ok(Math.abs(wrapAngle(spin.eyeYaw - Math.PI / 2)) < EPS, 'the stance base becomes the spin');
    for (let tick = 0; tick < 16; tick++) {
      const side = stepPose(INITIAL_POSE, 0, withDefensive({ yaw: 'sideways' }), STAND, tick, LATE_CSGO, CTX);
      assert.ok(Math.abs(Math.abs(offsetDeg(side)) - 90) < EPS);
      const next = stepPose(INITIAL_POSE, 0, withDefensive({ yaw: 'sideways' }), STAND, tick + 1, LATE_CSGO, CTX);
      assert.ok(Math.abs(offsetDeg(side) + offsetDeg(next)) < EPS, `tick ${tick}: alternates each tick`);
    }
    const r = (t: number) => stepPose(INITIAL_POSE, 0, withDefensive({ yaw: 'random' }), STAND, t, LATE_CSGO, { ...CTX, seed: 3 });
    const seen = new Set<number>();
    for (let tick = 0; tick < 64; tick++) {
      assert.equal(r(tick).eyeYaw, r(tick - (tick % 4)).eyeYaw, `tick ${tick}: held for 4 ticks`);
      seen.add(Math.round(offsetDeg(r(tick))));
    }
    assert.ok(seen.size >= 10, `random offsets vary (${[...seen].join(', ')})`);
  });

  it('peekTicksLeft > 0 activates onPeek; inAir needs the airborne stance', () => {
    const aa = withDefensive({ always: false, onPeek: true, yaw: 'sideways', pitch: 'down' });
    assert.equal(offsetDeg(stepPose(INITIAL_POSE, 0, aa, STAND, 5, LATE_CSGO, CTX)), 0, 'no peek: inactive');
    for (const peekTicksLeft of [1, PEEK_TICKS]) {
      const p = stepPose(INITIAL_POSE, 0, aa, STAND, 5, LATE_CSGO, { ...CTX, peekTicksLeft });
      assert.ok(Math.abs(Math.abs(offsetDeg(p)) - 90) < EPS);
      assert.ok(Math.abs(p.pitch + P * DEG) < EPS, 'down: the era pitch limit');
    }
    const air = withDefensive({ always: false, inAir: true, pitch: 'up' });
    assert.ok(Math.abs(stepPose(INITIAL_POSE, 0, air, AIR, 5, LATE_CSGO, CTX).pitch - P * DEG) < EPS, 'up: the era pitch limit, in the air');
    assert.equal(stepPose(INITIAL_POSE, 0, air, STAND, 5, LATE_CSGO, CTX).pitch, 0, 'on the ground: inactive');
  });

  it('inactive defensive leaves the pose identical to the plain stance', () => {
    const configs = [
      withDefensive({ enabled: false }),
      withDefensive({ always: false, inAir: true, yaw: 'flick', pitch: 'random' }),
      withDefensive({ always: false, onPeek: true, yaw: 'spin', pitch: 'jitter' }),
      withDefensive({ enabled: false, always: true, inAir: true, onPeek: true, yaw: 'random', pitch: 'up' }),
    ];
    const reference = uniformAntiAim({ ...STANCE, jitterDeg: 20 });
    for (const aa of configs) {
      for (const s of V2_STANCES) aa.stances[s] = { ...STANCE, jitterDeg: 20 };
      let a: PoseState = { ...INITIAL_POSE, pitch: 0.3 };
      let b = a;
      for (let tick = 0; tick < 24; tick++) {
        a = stepPose(a, tick * 0.1, aa, STAND, tick, LATE_CSGO, { ...CTX, seed: 9 });
        b = stepPose(b, tick * 0.1, reference, STAND, tick, LATE_CSGO, { ...CTX, seed: 9 });
        assert.deepEqual(a, b, `tick ${tick}`);
      }
      assert.equal(a.pitch, 0.3, 'the incoming pitch is carried');
    }
  });

  it('pitch stays within the era pitch limit (R58) in every mode; desync limits stay maxDesync', () => {
    for (const pitch of ['down', 'up', 'zero', 'random', 'jitter'] as const) {
      for (const yaw of ['off', 'flick', 'spin', 'random', 'sideways'] as const) {
        const aa = withDefensive({ pitch, yaw }, { standing: { desyncDeg: 58 }, moving: { desyncDeg: 58 } });
        let prev: PoseState | undefined;
        for (let tick = 0; tick < 40; tick++) {
          const p = stepPose(INITIAL_POSE, 0, aa, tick % 2 ? RUN : STAND, tick, LATE_CSGO, { ...CTX, seed: tick * 977 });
          assert.ok(Math.abs(p.pitch) <= P * DEG + EPS, `${pitch}/${yaw} tick ${tick}: pitch ${p.pitch / DEG}`);
          assert.ok(desyncDeg(p) <= maxDesync(tick % 2 ? 1 : 0, LATE_CSGO) + EPS, `${pitch}/${yaw} tick ${tick}: desync ${desyncDeg(p)}`);
          assert.ok(!Object.is(p.pitch, -0));
          if (pitch === 'jitter' && prev) assert.ok(Math.abs(p.pitch + prev.pitch) < EPS && Math.abs(Math.abs(p.pitch) - P * DEG) < EPS, 'alternates +-P');
          if (pitch === 'zero') assert.equal(p.pitch, 0);
          prev = p;
        }
      }
    }
  });

  it('uniformAntiAim copies one stance to all five, defensive off', () => {
    const aa = uniformAntiAim(STANCE, true);
    assert.deepEqual(Object.keys(aa.stances).sort(), [...V2_STANCES].sort());
    for (const s of V2_STANCES) {
      assert.deepEqual(aa.stances[s], STANCE);
      assert.deepEqual(aa.defensive[s], NO_DEFENSIVE);
      assert.notEqual(aa.stances[s], STANCE, 'copies, not shared objects');
    }
    assert.equal(aa.inverted, true);
  });
});
