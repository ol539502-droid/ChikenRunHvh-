import { PLAYER } from '../constants';
import type { CollisionWorld } from '../collision';
import { damageAt, pelletDirections, type WeaponDef } from '../weapons';
import { hvhSpread } from './weapons';
import { CSGO_HITGROUP } from './v2/arsenal';
import { makeRay, rayAabb, raycastWorld, type Ray } from '../raycast';
import type { Vec3 } from '../math';
import { rayHvhMatrix, type HvhHit, type HvhHitgroup, type HvhMatrix } from './geometry';

export interface BallisticTrace { wallDistance: number; passages: { entry: number; exit: number; loss: number }[] }
/** Thickness-based penetration shared by server execution and every targeting prediction. */
export function traceHvhCover(ray: Ray, world: CollisionWorld, range: number, isSoft?: (id: number) => boolean): BallisticTrace {
  // The see-through boxes plus the soft ones already passed (seeThrough is large on Mirage; never copied).
  const passed = new Set<number>(), passages: BallisticTrace['passages'] = [];
  const skip = { has: (id: number) => world.seeThrough.has(id) || passed.has(id) };
  for (let n = 0; n < 3; n++) {
    const hit = raycastWorld(ray, world, range, skip);
    if (!hit) return { wallDistance: range, passages };
    if (hit.id === undefined || !isSoft?.(hit.id) || passages.length >= 2) return { wallDistance: hit.t, passages };
    const box = world.get(hit.id);
    if (!box) return { wallDistance: hit.t, passages };
    const endpoint = { x: ray.ox + ray.dx * range, y: ray.oy + ray.dy * range, z: ray.oz + ray.dz * range };
    const reverse = makeRay(endpoint, { x: -ray.dx, y: -ray.dy, z: -ray.dz });
    const backwardsEntry = rayAabb(reverse, box, range);
    const exit = backwardsEntry < 0 ? range : range - backwardsEntry;
    const thickness = Math.max(0, exit - hit.t);
    passages.push({ entry: hit.t, exit, loss: Math.exp(-thickness * 0.22) * 0.82 });
    passed.add(hit.id);
  }
  return { wallDistance: range, passages };
}
/**
 * traceHvhCover followed by rayHvhMatrix for each matrix, with the same hits and damage, but the
 * world (the costly part on big maps) is traced only when the ray reaches a matrix, and first only
 * as far as the farthest hit: nothing in the world before it means no wall stops and no passage
 * weakens any hit, so the full trace is needed only when something is in the way. On that fast path
 * `cover` is {range, no passages}: right for these hits (coverDamageScale), not a full trace.
 */
export function traceHvhMatrices(ray: Ray, matrices: readonly HvhMatrix[], world: CollisionWorld, range: number,
  isSoft?: (id: number) => boolean): { cover: BallisticTrace; hits: (HvhHit | null)[] } {
  const open = matrices.map(m => rayHvhMatrix(ray, m, range));
  const reach = open.reduce((t, hit) => hit ? Math.max(t, hit.t) : t, -1);
  if (reach < 0) return { cover: { wallDistance: range, passages: [] }, hits: open };
  if (!raycastWorld(ray, world, reach, world.seeThrough)) return { cover: { wallDistance: range, passages: [] }, hits: open };
  const cover = traceHvhCover(ray, world, range, isSoft);
  return { cover, hits: matrices.map(m => rayHvhMatrix(ray, m, cover.wallDistance)) };
}
export function coverDamageScale(cover: BallisticTrace, t: number): number {
  return cover.passages.filter(p => p.entry < t).reduce((n, p) => n * p.loss, 1);
}
function csgoHitgroup(group: HvhHitgroup): number {
  return group === 'stomach' || group === 'pelvis' || group === 'leg' ? CSGO_HITGROUP[group] : CSGO_HITGROUP.other;
}
export function hvhHitDamage(w: WeaponDef, hit: HvhHit, cover: BallisticTrace): number {
  const multiplier = hit.headshot ? w.headshotMultiplier : w.csgo ? csgoHitgroup(hit.group)
    : hit.group === 'stomach' ? 1.15 : hit.group === 'leg' ? 0.75 : 1;
  return damageAt(w, hit.t) * multiplier * coverDamageScale(cover, hit.t);
}
export function afterArmor(damage: number, armor: number): number { return damage - Math.min(armor, damage * PLAYER.armorAbsorb); }
/**
 * Damage after armor as the shot deals it: a CS:GO weapon (v2, shot.ts) against any armor takes
 * x armorPen on every hitgroup but the leg (armor never wears down); other weapons keep the legacy
 * soak (afterArmor). `group` undefined counts as covered.
 */
export function armoredDamage(w: WeaponDef, damage: number, group: HvhHitgroup | undefined, armor: number): number {
  if (!w.csgo) return afterArmor(damage, armor);
  return armor > 0 && group !== 'leg' ? damage * w.csgo.armorPen : damage;
}
/** `damage`: the mean damage of a hit, after hvhHitchance's `armor`. */
export interface HitchanceResult { chance: number; damage: number; samples: number }
export interface HitchanceHypothesis { matrix: HvhMatrix; probability: number }
export function hvhHitchance(w: WeaponDef, eye: Vec3, direction: Vec3, matrix: HvhMatrix, speed: number,
  airborne: boolean, ads: boolean, world: CollisionWorld, isSoft?: (id: number) => boolean, samples = 32, heat = 0,
  hypotheses: readonly HitchanceHypothesis[] = [{ matrix, probability: 1 }], armor = 0): HitchanceResult {
  let hits = 0, damage = 0;
  const weight = hypotheses.reduce((n, h) => n + h.probability, 0);
  if (weight <= 0) return { chance: 0, damage: 0, samples };
  const matrices = hypotheses.map(h => h.matrix);
  for (let n = 0; n < samples; n++) {
    const trial = hypotheses.map(() => 0);
    for (const dir of pelletDirections(w, direction, hvhSpread(w, speed, airborne, ads, heat), 4177 + n * 7919)) {
      const { cover, hits } = traceHvhMatrices(makeRay(eye, dir), matrices, world, w.range, isSoft);
      // CS:GO armor is per hitgroup, so per pellet; the legacy soak applies to the mean below.
      hits.forEach((hit, i) => { if (hit) trial[i]! += w.csgo ? armoredDamage(w, hvhHitDamage(w, hit, cover), hit.group, armor) : hvhHitDamage(w, hit, cover); });
    }
    trial.forEach((amount, i) => { if (amount > 0) { const p = hypotheses[i]!.probability / weight; hits += p; damage += amount * p; } });
  }
  const mean = hits ? damage / hits : 0;
  return { chance: Math.min(1, hits / samples), damage: w.csgo ? mean : afterArmor(mean, armor), samples };
}
