import { spreadFor, type WeaponDef } from '../weapons';
const tuned = new Map<string, WeaponDef>();
/** HvH keeps each weapon's magazine, reload and cadence, with an accuracy-focused FPS ruleset. */
export function hvhWeapon(w: WeaponDef): WeaponDef {
  // The CS:GO arsenal is already balanced for HvH.
  if (w.projectile || w.melee || w.csgo) return w;
  let result = tuned.get(w.id);
  if (!result) {
    result = { ...w, damage: w.damage * (w.pellets > 1 ? 1.2 : w.damage < 50 ? 1.6 : 1),
      headshotMultiplier: w.pellets > 1 ? w.headshotMultiplier : Math.max(3, w.headshotMultiplier),
      spread: w.spread * (w.pellets > 1 ? 0.8 : 0.45), moveSpread: w.moveSpread * 1.4, airSpread: w.airSpread * 1.25 };
    tuned.set(w.id, result);
  }
  return result;
}
export function hvhSpread(w: WeaponDef, speed: number, air: boolean, ads: boolean, heat = 0): number {
  return spreadFor(w, speed, air, ads) + w.spread * Math.min(3, Math.max(0, heat)) * (ads ? 0.35 : 0.75);
}
