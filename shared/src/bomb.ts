import type { Team } from './maps/types';
import { WEAPONS, weaponAllowed, type WeaponId } from './weapons';
import { HVH_PISTOLS } from './hvh/v2/arsenal';

/** ChikenBomb: chikenT (team 1) plant the bomb, chikenCT (team 2) defuse it. */
export const BOMB = {
  /** Free play before the first round: respawns on, buying is free. */
  warmupMs: 40_000,
  /** Start of every round: players are frozen in spawn. */
  freezeMs: 15_000,
  /** Buying remains open for five seconds after players can move. */
  buyMs: 20_000,
  /** The round itself (1:55). */
  roundMs: 115_000,
  /** Results banner between rounds. */
  roundEndMs: 5_000,
  plantMs: 3_000,
  /** Fuse once planted. */
  fuseMs: 40_000,
  defuseMs: 10_000,
  kitDefuseMs: 5_000,
  /** Reach to defuse (from the bomb) and to pick a dropped bomb up. */
  defuseRange: 1.9,
  pickupRange: 1.3,
  /** The explosion: kills anyone close, hurts further out. */
  blastRadius: 14,
  blastDamage: 500,
  /** Competitive matches switch sides after 15 and end at 30 rounds. */
  halfTimeAfter: 15,
  maxRounds: 30,
  roundsToWin: 16,
} as const;

export const ECONOMY = {
  start: 800,
  max: 16_000,
  kill: 300,
  /** Knife (any melee) kills pay much more. */
  meleeKill: 1_500,
  win: 3_250,
  /** Bomb wins (exploded / defused) pay a little extra. */
  bombWin: 3_500,
  loss: 1_400,
  /** Each round lost in a row adds this to the loss bonus, up to lossMax. */
  lossStep: 500,
  lossMax: 3_400,
  /** Every chikenT gets this when they lose a round after planting. */
  plantedLoss: 800,
  plant: 300,
  defuse: 300,
} as const;

export type BuyKind = 'weapon' | 'armor' | 'eggs' | 'smoke' | 'flash' | 'kit';

/** Buy menu columns. A pistol takes the pistol slot; every other gun is your one main gun. */
export type BuyCategory = 'equipment' | 'pistol' | 'mid' | 'rifle' | 'grenade';

export const BUY_CATEGORIES: readonly { id: BuyCategory; name: string }[] = [
  { id: 'equipment', name: 'Equipment' },
  { id: 'pistol', name: 'Pistols' },
  { id: 'mid', name: 'Mid-Tier' },
  { id: 'rifle', name: 'Rifles' },
  { id: 'grenade', name: 'Grenades' },
];

export interface BuyItem {
  id: string;
  name: string;
  price: number;
  kind: BuyKind;
  category: BuyCategory;
  weapon?: WeaponId;
  /** Only this team can buy it. */
  team?: 1 | 2;
}

const gun = (weapon: WeaponId, price: number, category: BuyCategory, team?: 1 | 2): BuyItem => ({ id: weapon, name: WEAPONS[weapon].name, price, kind: 'weapon', category, weapon, ...(team ? { team } : {}) });

/** The buy menu, column by column (prices roughly like CS2's). */
export const BUY_ITEMS: readonly BuyItem[] = [
  gun('pistol', 200, 'pistol'),
  gun('silenced', 200, 'pistol'),
  gun('dualies', 300, 'pistol'),
  gun('fiveseven', 500, 'pistol'),
  gun('mpistol', 500, 'pistol'),
  gun('revolver', 600, 'pistol'),
  gun('deagle', 700, 'pistol'),
  gun('smg', 1_250, 'mid'),
  gun('shotgun', 1_100, 'mid'),
  gun('autoshotgun', 2_000, 'mid'),
  gun('lmg', 5_200, 'mid'),
  gun('minigun', 6_000, 'mid'),
  gun('burst', 2_050, 'rifle'),
  gun('ak47', 2_700, 'rifle', 1),
  gun('m4a1', 3_100, 'rifle', 2),
  gun('rifle', 2_700, 'rifle', 1),
  gun('golden', 3_100, 'rifle', 2),
  gun('battle', 3_000, 'rifle'),
  gun('scout', 1_700, 'rifle'),
  gun('crossbow', 1_900, 'rifle'),
  gun('sniper', 4_750, 'rifle'),
  gun('launcher', 3_500, 'mid'),
  gun('rocket', 5_000, 'mid'),
  { id: 'armor', name: 'Kevlar Vest', price: 650, kind: 'armor', category: 'equipment' },
  { id: 'kit', name: 'Defuse Kit', price: 400, kind: 'kit', category: 'equipment', team: 2 },
  { id: 'flash', name: 'Flashbang', price: 200, kind: 'flash', category: 'grenade' },
  { id: 'smoke', name: 'Smoke Grenade', price: 300, kind: 'smoke', category: 'grenade' },
  { id: 'eggs', name: 'HE Egg', price: 300, kind: 'eggs', category: 'grenade' },
];
export const BUY_ITEMS_BY_ID: ReadonlyMap<string, BuyItem> = new Map(BUY_ITEMS.map((i) => [i.id, i]));

/** Weapons that go in the pistol slot (the rest are main guns), with the v2 HvH arsenal's pistols. */
const SIDEARMS = new Set<WeaponId>([...BUY_ITEMS.filter((i) => i.category === 'pistol').map((i) => i.weapon!), ...HVH_PISTOLS]);

export function isSidearm(id: WeaponId): boolean {
  return SIDEARMS.has(id);
}

/**
 * Holding E to plant (the carrier, on the ground on a site) or to defuse (a chikenCT next to the
 * bomb) holds you in place, crouched, until you let go: no key can knock you off it by accident.
 * The client uses the same rule, so its prediction doesn't fight the server.
 */
export function bombHoldsPlayer(
  round: RoundState,
  me: { pid: number; team: Team; x: number; y: number; z: number; onGround: boolean; useHeld: boolean },
  sites: readonly { x: number; y?: number; z: number; radius: number }[],
): boolean {
  const b = round.bomb;
  if (b.action?.pid === me.pid) return me.useHeld;
  if (!me.useHeld) return false;
  if (round.phase === 'live' && b.carrier === me.pid) return me.onGround && sites.some((s) => Math.hypot(me.x - s.x, me.z - s.z) <= s.radius && Math.abs(me.y - (s.y ?? 0)) < 1.5);
  if (round.phase === 'planted' && me.team === 2) return Math.hypot(me.x - b.x, me.z - b.z) <= BOMB.defuseRange && Math.abs(me.y - b.y) < 2;
  return false;
}

/** What everyone starts each life with (survivors keep what they bought). */
export const BOMB_START_LOADOUT: readonly WeaponId[] = ['pistol', 'knife'];

export type RoundPhase = 'warmup' | 'buy' | 'live' | 'planted' | 'over';
export type RoundEndReason = 'exploded' | 'defused' | 'eliminated' | 'time';
export type SiteId = 'A' | 'B';

export interface BombAction {
  pid: number;
  kind: 'plant' | 'defuse';
  /** Server times (ms). */
  startedAt: number;
  endsAt: number;
}

export interface BombState {
  /** pid carrying it, 0 if it's on the ground or planted. */
  carrier: number;
  /** Where it lies (dropped or planted); meaningless while carried. */
  x: number;
  y: number;
  z: number;
  site: SiteId | null;
  /** Server time of the explosion once planted. */
  explodeAt: number | null;
  /** Someone planting or defusing right now. */
  action: BombAction | null;
}

export interface RoundState {
  phase: RoundPhase;
  /** 0 during warmup, then 1, 2, ... */
  round: number;
  /** Server time (ms) the current phase ends, or null. */
  endsAt: number | null;
  /** Server time (ms) buying closes for this round. */
  buyEndsAt: number | null;
  bomb: BombState;
  /** Set while phase is 'over'. */
  winner: Team;
  reason: RoundEndReason | null;
}

export function noBomb(): BombState {
  return { carrier: 0, x: 0, y: 0, z: 0, site: null, explodeAt: null, action: null };
}

/** Can this team buy this item at all? */
export function canTeamBuy(item: BuyItem, team: Team): boolean {
  return item.team === undefined || item.team === team;
}

/** On sale for `team` in a mode: its team's items, and no special guns where the mode is CS-only. */
export function canBuy(item: BuyItem, team: Team, csOnly: boolean | undefined): boolean {
  return canTeamBuy(item, team) && (!item.weapon || weaponAllowed(item.weapon, csOnly));
}
