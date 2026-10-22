import { WALLBANG, armoredDamage, damageAt, makeRay, pelletDirections, rayChicken, raycastPenetrating, raycastWorld, wallbangScale, spreadFor, wrapAngle, type CollisionWorld, type Vec3, type WeaponDef, type Ray } from '@game/shared';

export interface ShotTarget { x: number; y: number; z: number; yaw: number; scale: number; hp: number; armor: number; pitch?: number }
export interface ShotEstimate { damage: number; chance: number }
/** Fixed trial seeds estimate accuracy; they do not predict the next server shot seed. */
export function estimateShot(w: WeaponDef, eye: Vec3, direction: Vec3, target: ShotTarget, horizontalSpeed: number, airborne: boolean, ads: boolean, world?: CollisionWorld, isSoft?: (id:number)=>boolean, trace?: (ray: Ray, range: number) => {t:number;headshot:boolean;scale:number} | null): ShotEstimate {
  if (w.projectile || w.melee) return { damage: 0, chance: 0 };
  let hits = 0;
  let total = 0;
  const trials = w.pellets > 1 ? 16 : 32;
  for (let n = 0; n < trials; n++) {
    let damage = 0;
    for (const dir of pelletDirections(w, direction, spreadFor(w, horizontalSpeed, airborne, ads), 4177 + n * 7919)) {
      const ray = makeRay(eye, dir);
      const traced = trace?.(ray, w.range);
      const hit = trace ? traced : rayChicken(ray, target.x, target.y, target.z, target.yaw, w.range, target.scale, target.pitch);
      if (!hit) continue;
      let scale = traced?.scale ?? 1;
      if (!trace && world) {
        if (isSoft) {
          const cover = raycastPenetrating(ray,world,hit.t,isSoft,WALLBANG.maxBoxes);
          if(cover.wall && cover.wall.t<hit.t-0.01)continue;
          scale = wallbangScale(cover.soft,hit.t);
        } else {
          const cover = raycastWorld(ray, world, hit.t);
          if (cover && cover.t < hit.t - 0.01) continue;
        }
      }
      damage += damageAt(w, hit.t) * (hit.headshot ? w.headshotMultiplier : 1) * scale;
    }
    // The legacy trace has no hitgroups, so a CS:GO weapon's armor counts on the whole hit.
    if (damage > 0) { hits++; total += armoredDamage(w, damage, undefined, target.armor); }
  }
  return { damage: hits ? total / hits : 0, chance: hits / trials * 100 };
}
export function shotGate(estimate: ShotEstimate, minDamage: number, minChance: number, hp: number, elapsed: number, reaction: number): string {
  if (elapsed < Math.max(0, reaction)) return 'Acquiring target';
  if (estimate.damage < minDamage && estimate.damage < hp) return 'Waiting for damage';
  if (estimate.chance < minChance || estimate.chance === 0) return 'Waiting for accuracy';
  return 'Ready';
}
export function boundedTurn(current: number, desired: number, degreesPerSecond: number, dt: number): number {
  const step = Math.min(540, Math.max(90, degreesPerSecond)) * Math.PI / 180 * Math.max(0, Math.min(0.05, dt));
  return wrapAngle(current + Math.min(step, Math.max(-step, wrapAngle(desired - current))));
}
/** Return steering is ordinary movement intent, transformed into camera space. */
export function peekSteering(from: Vec3, anchor: Vec3, yaw: number): { forward: number; right: number } | null {
  const dx = anchor.x - from.x, dz = anchor.z - from.z;
  const d = Math.hypot(dx, dz);
  if (d < 0.2 || Math.abs(anchor.y - from.y) > 0.7) return null;
  const k = Math.min(1, d / 0.65);
  return { forward: (-Math.sin(yaw) * dx - Math.cos(yaw) * dz) / d * k, right: (Math.cos(yaw) * dx - Math.sin(yaw) * dz) / d * k };
}
