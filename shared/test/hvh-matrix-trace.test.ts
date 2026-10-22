import assert from 'node:assert/strict';
import { it } from 'node:test';
import {
  MAPS, WEAPONS, buildHvhMatrix, createCollisionWorld, hvhHitDamage, hvhHitchance, hvhWeapon, makeRay, mulberry32,
  rayHvhMatrix, softBoxTest, traceHvhCover, traceHvhMatrices, pelletDirections, hvhSpread,
  type CollisionWorld, type HitchanceHypothesis, type HvhMatrix, type Vec3, type WeaponDef,
} from '../src/index';

const world = createCollisionWorld(MAPS.mirage);
const isSoft = softBoxTest(MAPS.mirage, () => undefined);

/** A shooter's eye and a target chicken somewhere on Mirage's nav, seeded. */
function scene(random: () => number): { eye: Vec3; matrices: HvhMatrix[] } {
  const nav = MAPS.mirage.nav!;
  const a = nav[Math.floor(random() * nav.length)]!, b = nav[Math.floor(random() * nav.length)]!;
  const eye = { x: a.x, y: (a.y ?? 0) + 1.3, z: a.z };
  const origin = { x: b.x, y: b.y ?? 0, z: b.z };
  const matrices = [0, 1, 2].map((n) => buildHvhMatrix(origin, random() * Math.PI * 2 + n, 1, 0));
  return { eye, matrices };
}

function toward(eye: Vec3, m: HvhMatrix, random: () => number): Vec3 {
  const box = m.boxes[Math.floor(random() * m.boxes.length)]!;
  const d = { x: box.center.x - eye.x + (random() - 0.5) * 0.6, y: box.center.y - eye.y + (random() - 0.5) * 0.6, z: box.center.z - eye.z + (random() - 0.5) * 0.6 };
  const n = Math.hypot(d.x, d.y, d.z);
  return { x: d.x / n, y: d.y / n, z: d.z / n };
}

it('traceHvhMatrices gives the same hits and damage as traceHvhCover + rayHvhMatrix across Mirage', () => {
  const random = mulberry32(7);
  const w = hvhWeapon(WEAPONS.rifle);
  let hits = 0;
  for (let i = 0; i < 600; i++) {
    const { eye, matrices } = scene(random);
    const ray = makeRay(eye, toward(eye, matrices[0]!, random));
    const range = i % 3 ? w.range : 12;
    const cover = traceHvhCover(ray, world, range, isSoft);
    const expected = matrices.map((m) => {
      const hit = rayHvhMatrix(ray, m, cover.wallDistance);
      return hit && { hit, damage: hvhHitDamage(w, hit, cover) };
    });
    const traced = traceHvhMatrices(ray, matrices, world, range, isSoft);
    const actual = traced.hits.map((hit) => hit && { hit, damage: hvhHitDamage(w, hit, traced.cover) });
    assert.deepEqual(actual, expected, `ray ${i}`);
    hits += expected.filter(Boolean).length;
  }
  assert.ok(hits > 100, `the scenes exercise hits (${hits})`);
});

it('traceHvhMatrices does not trace the world when the ray misses every matrix', () => {
  let queries = 0;
  const counting: CollisionWorld = Object.create(world, {
    cellIds: { value: (...args: Parameters<CollisionWorld['cellIds']>) => { queries++; return world.cellIds(...args); } },
  });
  // The counter itself works: a ray that reaches the matrix does trace the world.
  traceHvhMatrices(makeRay({ x: 0, y: 1, z: 20 }, { x: 0, y: 0, z: -1 }), [buildHvhMatrix({ x: 0, y: 0, z: 0 }, 0, 1, 0)], counting, 100, isSoft);
  assert.ok(queries > 0, 'a reaching ray traces the world');
  queries = 0;
  const m = buildHvhMatrix({ x: 0, y: 0, z: 0 }, 0, 1, 0);
  const traced = traceHvhMatrices(makeRay({ x: 0, y: 1, z: 20 }, { x: 1, y: 0, z: 0 }), [m], counting, 100, isSoft);
  assert.deepEqual(traced.hits, [null]);
  assert.equal(queries, 0);
});

/** hvhHitchance before this change, kept verbatim as the reference. */
function referenceHitchance(w: WeaponDef, eye: Vec3, direction: Vec3, speed: number, airborne: boolean, ads: boolean,
  hypotheses: readonly HitchanceHypothesis[], samples: number, heat: number) {
  let hits = 0, damage = 0;
  const weight = hypotheses.reduce((n, h) => n + h.probability, 0);
  if (weight <= 0) return { chance: 0, damage: 0, samples };
  for (let n = 0; n < samples; n++) {
    const trial = hypotheses.map(() => 0);
    for (const dir of pelletDirections(w, direction, hvhSpread(w, speed, airborne, ads, heat), 4177 + n * 7919)) {
      const ray = makeRay(eye, dir), cover = traceHvhCover(ray, world, w.range, isSoft);
      hypotheses.forEach((h, i) => {
        const hit = rayHvhMatrix(ray, h.matrix, cover.wallDistance);
        if (hit) trial[i]! += hvhHitDamage(w, hit, cover);
      });
    }
    trial.forEach((amount, i) => { if (amount > 0) { const p = hypotheses[i]!.probability / weight; hits += p; damage += amount * p; } });
  }
  return { chance: Math.min(1, hits / samples), damage: hits ? damage / hits : 0, samples };
}

it('hvhHitchance is unchanged across Mirage', () => {
  const random = mulberry32(11);
  for (let i = 0; i < 60; i++) {
    const w = hvhWeapon(i % 2 ? WEAPONS.rifle : WEAPONS.shotgun);
    const { eye, matrices } = scene(random);
    const hypotheses = matrices.map((matrix, n) => ({ matrix, probability: [0.6, 0.3, 0.1][n]! }));
    const dir = toward(eye, matrices[0]!, random);
    const speed = random() * 5, airborne = random() < 0.2, ads = random() < 0.3;
    assert.deepEqual(
      hvhHitchance(w, eye, dir, matrices[0]!, speed, airborne, ads, world, isSoft, 16, 0, hypotheses),
      referenceHitchance(w, eye, dir, speed, airborne, ads, hypotheses, 16, 0),
      `scene ${i}`);
  }
});
