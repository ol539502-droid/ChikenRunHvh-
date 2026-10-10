import { ARMS_LADDER } from './arms';
import { DEFAULT_MODS, type DevMods } from './dev';
import { WEAPON_IDS, isMelee, type WeaponId } from './weapons';

/**
 * Training's weapon menu: every gun (Arms Race's ladder order first, then the rest) and every
 * knife and melee weapon. All free, in Training only.
 */
export const TRAINING_GUNS: readonly WeaponId[] = [
  ...ARMS_LADDER.filter((id) => !isMelee(id)),
  ...WEAPON_IDS.filter((id) => !isMelee(id) && !ARMS_LADDER.includes(id)),
];
export const TRAINING_KNIVES: readonly WeaponId[] = WEAPON_IDS.filter((id) => isMelee(id));

/** What a Training request may ask for: a gun or knife from the lists, or a grenade refill. */
export interface TrainingGiveRequest {
  weapon?: WeaponId;
  grenade?: 'egg' | 'smoke' | 'flash';
}

/** Training never runs dry: infinite ammo, instant reload and flashbangs, on top of any developer mods. */
export function trainingMods(base: Readonly<DevMods> | null): DevMods {
  return { ...(base ?? DEFAULT_MODS), infiniteAmmo: true, instantReload: true, infiniteFlashes: true };
}

/** A Training loadout after picking `pick`: one gun and one knife; the new pick replaces its kind. */
export function trainingLoadout(current: readonly WeaponId[], pick: WeaponId): WeaponId[] {
  const gun = isMelee(pick) ? current.find((w) => !isMelee(w)) ?? 'rifle' : pick;
  const knife = isMelee(pick) ? pick : current.find((w) => isMelee(w)) ?? 'knife';
  return [gun, knife];
}
