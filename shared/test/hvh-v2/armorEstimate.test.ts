import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CollisionWorld } from '../../src/collision';
import { PLAYER_HULL_WIDTH } from '../../src/constants';
import { normalize, type Vec3 } from '../../src/math';
import { WEAPONS } from '../../src/weapons';
import { hvhWeapon } from '../../src/hvh/weapons';
import type { ObservableRecord } from '../../src/hvh/animation';
import { ResolverSystem } from '../../src/hvh/resolver';
import { DEFAULT_RAGE, scanRage } from '../../src/hvh/rage';
import { LATE_CSGO } from '../../src/hvh/v2/era';
import type { PoseState } from '../../src/hvh/v2/pose';
import { RecordHistory } from '../../src/hvh/v2/records';
import { createResolverMemory } from '../../src/hvh/v2/resolver';
import { processShot, type WorldTracer } from '../../src/hvh/v2/shot';
import type { HvhHitgroup } from '../../src/hvh/geometry';

/*
 * I2: the ragebot and the bots estimate v2 damage as the v2 shot deals it. A CS:GO weapon against
 * armor takes x armorPen on every hitgroup but the leg (shot.ts), not the legacy soak.
 */

const EYE: Vec3 = { x: 0, y: 1.3, z: 10 };
const ORIGIN: Vec3 = { x: 0, y: 0, z: -5 };
const POSE: PoseState = { eyeYaw: 0, bodyYaw: 0, pitch: 0, jitterPhase: 0, realSide: 'center', eyeOffsetDeg: 0 };
const open: WorldTracer = { trace: (_o, _d, range) => ({ wallDistance: range, passages: [] }) };

const record = (armor: number): ObservableRecord => ({ pid: 2, tick: 6, t: 100, origin: ORIGIN, velocity: { x: 0, y: 0, z: 0 },
  eyeYaw: 0, lowerBodyYaw: 0, speed: 0, crouch: 0, grounded: true, turnWeight: 0, alive: true, hp: 100, armor,
  fired: false, concealed: false, defensive: false });

function candidate(weapon: 'ssg08' | 'scar20' | 'deserteagle', group: HvhHitgroup, armor: number) {
  const r = record(armor), resolver = new ResolverSystem();
  resolver.observe(r);
  return scanRage({ now: 100, eye: EYE, w: hvhWeapon(WEAPONS[weapon]), speed: 0, airborne: false, ads: true,
    world: new CollisionWorld(100), records: [r], resolver, samples: 64,
    settings: { ...DEFAULT_RAGE, resolver: false, preferSafe: false, groups: [group], pointScale: 0, minDamage: 1, hitchance: 0 } });
}

function shotDamage(weapon: string, dir: Vec3, armored: boolean): { damage: number; group: string } {
  const history = new RecordHistory(LATE_CSGO, PLAYER_HULL_WIDTH);
  for (let t = 90; t <= 100; t++) history.push({ tick: t, position: ORIGIN, pose: POSE, valid: true });
  const v = processShot({ shooterId: 's', tick: 100, bullet: 1, aim: { origin: EYE, dir }, weaponId: weapon, ticksSinceLastShot: 640,
    target: { id: 't', history, alive: true, hp: 100, armored }, viewTick: 100, resolver: createResolverMemory(),
    observations: [], world: open, spreadSeed: 1, spread: 0 });
  assert.equal(v.cause, 'hit');
  return { damage: v.damage!, group: v.hitgroup! };
}

describe('v2 armor in the damage estimates (I2)', () => {
  for (const weapon of ['ssg08', 'scar20', 'deserteagle'] as const) {
    for (const group of ['chest', 'stomach', 'leg'] as const) {
      it(`${weapon} ${group}: scanRage's candidate damage equals processShot's on an armored target`, () => {
        const c = candidate(weapon, group, 100);
        assert.ok(c, 'a candidate');
        assert.equal(c.group, group);
        const real = shotDamage(weapon, normalize(c.direction), true);
        assert.equal(real.group, group);
        assert.ok(Math.abs(c.damage - real.damage) < real.damage * 1e-3, `estimate ${c.damage} vs shot ${real.damage}`);
      });
    }
  }

  it('an unarmored CS:GO target is estimated at full damage', () => {
    const c = candidate('ssg08', 'chest', 0);
    assert.ok(c);
    const real = shotDamage('ssg08', normalize(c.direction), false).damage;
    assert.ok(Math.abs(c.damage - real) < real * 1e-3, `estimate ${c.damage} vs shot ${real}`);
  });

  it('a legacy weapon keeps the legacy soak', () => {
    const r = record(100), resolver = new ResolverSystem();
    resolver.observe(r);
    const scan = (armor: number) => scanRage({ now: 100, eye: EYE, w: hvhWeapon(WEAPONS.sniper), speed: 0, airborne: false, ads: true,
      world: new CollisionWorld(100), records: [{ ...r, armor }], resolver, samples: 64,
      settings: { ...DEFAULT_RAGE, resolver: false, preferSafe: false, groups: ['chest'], pointScale: 0, minDamage: 1, hitchance: 0 } });
    const bare = scan(0)!, armored = scan(100)!;
    assert.ok(Math.abs(armored.damage - (bare.damage - Math.min(100, bare.damage * 0.5))) < 1e-6);
  });
});
