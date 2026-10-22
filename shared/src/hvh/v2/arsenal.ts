import type { WeaponId } from '../../weapons';

/*
 * The v2 HvH arsenal: four CS:GO weapons, defined in weapons.ts with a `csgo` block. Their numbers
 * are the final CS:GO build's items_game.txt (2023-05-31, CS:GO 1568):
 * https://github.com/SteamTracking/GameTracking-CS2/blob/64b7772ba263a87083c3979c769c5919aae78337/csgo/scripts/items/items_game.txt
 * They are HvH-only: shops, buy menus, loadouts, Arms Race, Training and the inventory skip them.
 */

/** The buy menu's main guns. */
export const HVH_MAINS = ['ssg08', 'scar20'] as const;
/** The buy menu's pistols. */
export const HVH_PISTOLS = ['deserteagle', 'r8'] as const;

const ARSENAL_IDS: ReadonlySet<WeaponId> = new Set([...HVH_MAINS, ...HVH_PISTOLS]);

export function isHvhArsenal(id: WeaponId): boolean {
  return ARSENAL_IDS.has(id);
}

/**
 * CS:GO hitgroup damage multipliers. Head is the weapon's `headshotMultiplier` (the Deagle's is
 * 3.9); CS:GO's stomach hitgroup includes the pelvis.
 */
export const CSGO_HITGROUP = { head: 4, stomach: 1.25, pelvis: 1.25, leg: 0.75, other: 1 } as const;
