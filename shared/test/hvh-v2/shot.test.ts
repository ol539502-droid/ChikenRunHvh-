import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CollisionWorld } from '../../src/collision';
import { PLAYER_HULL_WIDTH } from '../../src/constants';
import type { Vec3 } from '../../src/math';
import { makeRay } from '../../src/raycast';
import { rayHvhMatrix } from '../../src/hvh/geometry';
import { WEAPONS, pelletDirections } from '../../src/weapons';
import { LATE_CSGO } from '../../src/hvh/v2/era';
import type { Observation, PoseState } from '../../src/hvh/v2/pose';
import { RecordHistory } from '../../src/hvh/v2/records';
import { createResolverMemory, learnFromVerdict } from '../../src/hvh/v2/resolver';
import {
  type ShotContext,
  type WorldTrace,
  type WorldTracer,
  collisionWorldTracer,
  poseMatrix,
  processShot,
} from '../../src/hvh/v2/shot';

const DEG = Math.PI / 180;
/** Real body 58 deg to the left of the eyes. Head centre then sits at x = -0.271 (x = +0.271 if mirrored). */
const POSE: PoseState = { eyeYaw: 0, bodyYaw: 58 * DEG, pitch: 0, jitterPhase: 0, realSide: 'left', eyeOffsetDeg: 0 };
const HEAD_X = 0.32 * Math.sin(58 * DEG);
const CHEST: Vec3 = { x: 0, y: 0.95, z: 10 };
const REAL_HEAD: Vec3 = { x: -HEAD_X, y: 1.4, z: 10 };
const MIRROR_HEAD: Vec3 = { x: HEAD_X, y: 1.4, z: 10 };
const FORWARD: Vec3 = { x: 0, y: 0, z: -1 };
/** A positive eye offset makes the resolver guess 'right' (the mirror of the real 'left'). */
const GUESS_RIGHT: Observation[] = [{ tick: 98, eyeYaw: 0, eyeOffsetDeg: 20, speedFraction: 0, duck: 0 }];

const open: WorldTracer = { trace: (_o, _d, range) => ({ wallDistance: range, passages: [] }) };
const fixed = (t: WorldTrace): WorldTracer => ({ trace: () => t });

function history(extra: (h: RecordHistory) => void = () => {}): RecordHistory {
  const h = new RecordHistory(LATE_CSGO, PLAYER_HULL_WIDTH);
  for (let t = 90; t <= 100; t++) h.push({ tick: t, position: { x: 0, y: 0, z: 0 }, pose: POSE, valid: true });
  extra(h);
  return h;
}

function ctx(over: Partial<ShotContext> = {}, target: Partial<NonNullable<ShotContext['target']>> = {}): ShotContext {
  return {
    shooterId: 's1',
    tick: 100,
    bullet: 1,
    aim: { origin: CHEST, dir: FORWARD },
    weaponId: 'pistol',
    ticksSinceLastShot: 64,
    target: { id: 't1', history: history(), alive: true, hp: 100, ...target },
    viewTick: 98,
    resolver: createResolverMemory(),
    observations: [],
    world: open,
    spreadSeed: 1234,
    ...over,
  };
}

// HvH pistol: 24 damage x 1.6 (hvhWeapon boost for weapons under 50 damage), chest multiplier 1.
const PISTOL_CHEST = 24 * 1.6;

describe('Shot pipeline (v2)', () => {
  it('hit: spread ray hits the real pose', () => {
    const v = processShot(ctx());
    assert.equal(v.cause, 'hit');
    assert.equal(v.hitgroup, 'chest');
    assert.ok(Math.abs(v.damage! - PISTOL_CHEST) < 1e-9);
    assert.ok(Math.abs(v.remainingHp! - (100 - PISTOL_CHEST)) < 1e-9);
    assert.equal(v.guessed, 'left');
    assert.equal(v.real, 'left');
    assert.equal(v.targetId, 't1');
    assert.equal(v.shooterId, 's1');
    assert.equal(v.tick, 100);
    assert.equal(v.bullet, 1);
  });

  it('hit: remaining hp never goes below zero', () => {
    const v = processShot(ctx({}, { hp: 10 }));
    assert.equal(v.cause, 'hit');
    assert.equal(v.remainingHp, 0);
  });

  it('resolver: aim hits the guessed pose but not the real one', () => {
    const v = processShot(ctx({ aim: { origin: MIRROR_HEAD, dir: FORWARD }, observations: GUESS_RIGHT }));
    assert.equal(v.cause, 'resolver');
    assert.equal(v.guessed, 'right');
    assert.equal(v.real, 'left');
    assert.equal(v.damage, undefined);
  });

  it('resolver miss teaches the resolver, so the next shot hits', () => {
    const c = ctx({ aim: { origin: REAL_HEAD, dir: FORWARD }, observations: GUESS_RIGHT });
    const mirrored = processShot({ ...c, aim: { origin: MIRROR_HEAD, dir: FORWARD } });
    assert.equal(mirrored.cause, 'resolver');
    learnFromVerdict(c.resolver, 't1', mirrored.guessed!, mirrored.cause);
    const next = processShot({ ...c, aim: { origin: REAL_HEAD, dir: FORWARD } });
    assert.equal(next.guessed, 'left');
    assert.equal(next.cause, 'hit');
    assert.equal(next.hitgroup, 'head');
  });

  it('spread: the deviated ray misses the real pose', () => {
    const spread = 0.3;
    // Pick a seed whose (independently computed) direction lands far off the head at the target plane.
    let seed = 1;
    for (; seed < 1000; seed++) {
      const d = pelletDirections(WEAPONS.pistol, FORWARD, spread, seed)[0]!;
      const k = 10 / -d.z;
      const dx = d.x * k;
      const dy = d.y * k;
      if (dy > 0.4 || Math.abs(dx) > 1) break;
    }
    const v = processShot(ctx({ aim: { origin: REAL_HEAD, dir: FORWARD }, spread, spreadSeed: seed }));
    assert.equal(v.cause, 'spread');
    assert.equal(v.guessed, 'left');
    assert.equal(v.real, 'left');
    assert.equal(v.damage, undefined);
  });

  it('spread: a shot at nothing with no target', () => {
    const v = processShot(ctx({ target: undefined }));
    assert.equal(v.cause, 'spread');
    assert.equal(v.targetId, undefined);
  });

  it('invalidRecord: an expired view tick never resolves', () => {
    const c = ctx({ viewTick: 80 });
    const v = processShot(c);
    assert.equal(v.cause, 'invalidRecord');
    assert.equal(v.invalidCause, 'expired');
    assert.equal(v.guessed, undefined);
    assert.equal(c.resolver.byTarget.size, 0);
  });

  it('invalidRecord: a record broken by a later teleport (lagcompBreak)', () => {
    const teleported = history((h) => h.push({ tick: 101, position: { x: 5, y: 0, z: 0 }, pose: POSE, valid: true }));
    const v = processShot(ctx({}, { history: teleported }));
    assert.equal(v.cause, 'invalidRecord');
    assert.equal(v.invalidCause, 'lagcompBreak');
  });

  it('a future view tick is clamped to the current tick', () => {
    // Records after ctx.tick have moved away; an unclamped select would pick tick 102.
    const h = history((x) => {
      x.push({ tick: 101, position: { x: 1.5, y: 0, z: 0 }, pose: POSE, valid: true });
      x.push({ tick: 102, position: { x: 3, y: 0, z: 0 }, pose: POSE, valid: true });
    });
    const v = processShot(ctx({ viewTick: 105 }, { history: h }));
    assert.equal(v.cause, 'hit');
  });

  it('crouch shrinks the hitboxes: a standing head shot misses at duck 1', () => {
    const aim = { origin: REAL_HEAD, dir: FORWARD };
    const standing = processShot(ctx({ aim }));
    assert.equal(standing.cause, 'hit');
    assert.equal(standing.hitgroup, 'head');
    const crouched = new RecordHistory(LATE_CSGO, PLAYER_HULL_WIDTH);
    for (let t = 90; t <= 100; t++) crouched.push({ tick: t, position: { x: 0, y: 0, z: 0 }, pose: POSE, valid: true, duck: 1 });
    // Scale 0.7 puts the head top near y = 1.05, below the aim; guessed = real here, so it is spread.
    const v = processShot(ctx({ aim }, { history: crouched }));
    assert.equal(v.cause, 'spread');
    assert.equal(v.guessed, 'left');
    assert.equal(v.real, 'left');
  });

  it('observations after ctx.tick do not affect the guess when viewTick > tick', () => {
    const observations: Observation[] = [
      ...GUESS_RIGHT,
      // At tick 103 (future): a negative offset would make the guess 'left'.
      { tick: 103, eyeYaw: 0, eyeOffsetDeg: -20, speedFraction: 0, duck: 0 },
    ];
    const v = processShot(ctx({ viewTick: 105, observations }));
    assert.equal(v.cause, 'hit');
    assert.equal(v.guessed, 'right');
  });

  it('obstruction: a non-penetrable wall in front of the target', () => {
    const c = ctx({ world: fixed({ wallDistance: 5, material: 'concrete', passages: [] }) });
    const v = processShot(c);
    assert.equal(v.cause, 'obstruction');
    assert.equal(v.material, 'concrete');
    assert.equal(v.guessed, undefined);
    assert.equal(c.resolver.byTarget.size, 0);
  });

  it('obstruction: damage fully absorbed by penetration', () => {
    const world = fixed({ wallDistance: 120, passages: [{ entry: 5, exit: 6, loss: 0.01, material: 'wood' }] });
    const v = processShot(ctx({ world }));
    assert.equal(v.cause, 'obstruction');
    assert.equal(v.material, 'wood');
  });

  it('a wall behind the target does not obstruct', () => {
    const v = processShot(ctx({ world: fixed({ wallDistance: 15, material: 'concrete', passages: [] }) }));
    assert.equal(v.cause, 'hit');
  });

  it('rejected: unknown weapon', () => {
    const v = processShot(ctx({ weaponId: 'nope' }));
    assert.equal(v.cause, 'rejected');
    assert.equal(v.reason, 'unknown weapon');
  });

  it('rejected: invalid aim', () => {
    for (const dir of [{ x: 0, y: 0, z: 0 }, { x: Number.NaN, y: 0, z: -1 }]) {
      const v = processShot(ctx({ aim: { origin: CHEST, dir } }));
      assert.equal(v.cause, 'rejected');
      assert.equal(v.reason, 'invalid aim');
    }
    const v = processShot(ctx({ aim: { origin: { x: Infinity, y: 0, z: 0 }, dir: FORWARD } }));
    assert.equal(v.reason, 'invalid aim');
  });

  it('dt respects slow weapon interval', () => {
    // Sniper: 1700 ms -> ceil(1700 * 64 / 1000) = 109 ticks, far more than a 14-tick DT shift.
    const v = processShot(ctx({ weaponId: 'sniper', bullet: 2, ticksSinceLastShot: 14 }));
    assert.equal(v.cause, 'rejected');
    assert.equal(v.reason, 'fire interval');
    assert.equal(v.bullet, 2);
  });

  it('fire interval boundary: pistol 220 ms is 15 ticks', () => {
    assert.equal(processShot(ctx({ ticksSinceLastShot: 14 })).reason, 'fire interval');
    assert.equal(processShot(ctx({ ticksSinceLastShot: 15 })).cause, 'hit');
  });

  it('second dt bullet on dead target', () => {
    const v = processShot(ctx({ bullet: 2 }, { alive: false }));
    assert.equal(v.cause, 'rejected');
    assert.equal(v.reason, 'target already dead');
    assert.equal(v.damage, undefined);
  });

  it('same seed same verdict', () => {
    for (const over of [{}, { spread: 0.3 }, { aim: { origin: MIRROR_HEAD, dir: FORWARD }, observations: GUESS_RIGHT }]) {
      assert.deepEqual(processShot(ctx(over)), processShot(ctx(over)));
    }
  });
});

describe('Armor and helmet (v2)', () => {
  const RECORD = { tick: 100, position: { x: 0, y: 0, z: 0 }, pose: POSE, valid: true };
  /** Distance from `origin` straight ahead to the real pose's nearest hitbox. */
  const reach = (origin: Vec3): number => rayHvhMatrix(makeRay(origin, FORWARD), poseMatrix(RECORD, POSE), 200)!.t;
  // The head 5 m away: back the origin off until the head surface is exactly 5 m out.
  const HEAD_AT_5: Vec3 = { ...REAL_HEAD, z: REAL_HEAD.z - reach(REAL_HEAD) + 5 };
  // Left leg sphere: local (-0.16, 0.16, 0) turned by the 58 deg body yaw (geometry.ts).
  const LEG: Vec3 = { x: -0.16 * Math.cos(58 * DEG), y: 0.16, z: 10 };
  const ssg = (aim: Vec3, armored?: boolean) =>
    processShot(ctx({ weaponId: 'ssg08', ticksSinceLastShot: 128, aim: { origin: aim, dir: FORWARD }, spread: 0 }, { armored }));

  it('an armored head hit takes the weapon armor penetration', () => {
    assert.ok(Math.abs(reach(HEAD_AT_5) - 5) < 1e-9);
    const v = ssg(HEAD_AT_5, true);
    assert.equal(v.cause, 'hit');
    assert.equal(v.hitgroup, 'head');
    const expected = 88 * 0.98 ** (5 / 12.5) * 4 * 0.85;
    assert.ok(Math.abs(v.damage! - expected) < 1e-9, `${v.damage} vs ${expected}`);
    assert.equal(v.remainingHp, 0);
  });

  it('the same hit unarmored has no penetration factor', () => {
    const v = ssg(HEAD_AT_5);
    assert.equal(v.hitgroup, 'head');
    assert.ok(Math.abs(v.damage! - 88 * 0.98 ** (5 / 12.5) * 4) < 1e-9);
    assert.deepEqual(ssg(HEAD_AT_5, false), v);
  });

  it('armor covers the stomach and pelvis', () => {
    for (const [group, y] of [['stomach', 0.6], ['pelvis', 0.36]] as const) {
      const aim = { x: 0, y, z: 10 };
      const v = ssg(aim, true);
      assert.equal(v.hitgroup, group);
      assert.ok(Math.abs(v.damage! - 88 * 0.98 ** (reach(aim) / 12.5) * 1.25 * 0.85) < 1e-9, group);
    }
  });

  it('armor does not cover the legs', () => {
    const armored = ssg(LEG, true);
    assert.equal(armored.cause, 'hit');
    assert.equal(armored.hitgroup, 'leg');
    assert.ok(Math.abs(armored.damage! - 88 * 0.98 ** (reach(LEG) / 12.5) * 0.75) < 1e-9);
    assert.deepEqual(armored, ssg(LEG, false));
  });

  it('weapons outside the CS:GO arsenal ignore armor', () => {
    const v = processShot(ctx({ weaponId: 'rifle', spread: 0 }, { armored: true }));
    assert.equal(v.hitgroup, 'chest');
    // HvH rifle: 17 damage x 1.6 boost, no falloff inside 40 m, chest multiplier 1.
    assert.ok(Math.abs(v.damage! - 17 * 1.6) < 1e-9);
    assert.deepEqual(v, processShot(ctx({ weaponId: 'rifle', spread: 0 })));
  });

  it('a wall that leaves under 1 damage after armor fully absorbs the shot', () => {
    const aim = { x: 0, y: 0.6, z: 10 };
    const full = ssg(aim).damage!;
    // Through the wall, 1.05 damage reaches an unarmored stomach; armor (x 0.85) leaves 0.89.
    const wall = fixed({ wallDistance: 200, passages: [{ entry: 1, exit: 1.1, loss: 1.05 / full, material: 'wood' }] });
    const through = (armored: boolean) =>
      processShot(ctx({ weaponId: 'ssg08', ticksSinceLastShot: 128, aim: { origin: aim, dir: FORWARD }, spread: 0, world: wall }, { armored }));
    assert.equal(through(false).cause, 'hit');
    assert.ok(Math.abs(through(false).damage! - 1.05) < 1e-9);
    const armored = through(true);
    assert.equal(armored.cause, 'obstruction');
    assert.equal(armored.material, 'wood');
  });
});

describe('collisionWorldTracer', () => {
  const wall = { minX: -2, maxX: 2, minY: 0, maxY: 3, minZ: 4.5, maxZ: 5 };
  const materialOf = (id: number): string => (id === 0 ? 'wood' : id === 1 ? 'concrete' : 'ground');

  it('stops at a solid box and names its material', () => {
    const world = collisionWorldTracer(new CollisionWorld(64, [{ ...wall, minZ: 9, maxZ: 9.5 }, wall]), (id) => id === 0, materialOf);
    const v = processShot(ctx({ world }));
    assert.equal(v.cause, 'obstruction');
    assert.equal(v.material, 'concrete');
  });

  it('penetrates a soft box with the thickness loss', () => {
    const world = collisionWorldTracer(new CollisionWorld(64, [wall]), (id) => id === 0, materialOf);
    const t = world.trace(CHEST, FORWARD, 120);
    assert.equal(t.passages.length, 1);
    assert.equal(t.passages[0]!.material, 'wood');
    const v = processShot(ctx({ world }));
    assert.equal(v.cause, 'hit');
    assert.ok(Math.abs(v.damage! - PISTOL_CHEST * Math.exp(-0.5 * 0.22) * 0.82) < 1e-3); // spread tilts the ray slightly
  });
});
