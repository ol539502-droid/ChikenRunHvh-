import { PLAYER } from './constants';
import type { WeaponId } from './weapons';

/**
 * Zombie Apocalypse: every number of the mode lives here (waves, zombie strength, bosses, the
 * shop, building), so the mode can be tuned from one place. The server runs the waves; the
 * client only shows them.
 */

export type ZombieKind = 'walker' | 'sprinter' | 'runner' | 'brute' | 'boss';

export interface ZombieBase {
  /** Health at wave 1 (a boss: before the boss-number bonus). */
  hp: number;
  /** Walking speed as a share of a player's running speed. */
  speed: number;
  /** Damage of one hit. */
  damage: number;
  /** Time between two hits. */
  attackMs: number;
  /** How close it must be to hit. */
  reach: number;
  /** Money for the kill. */
  reward: number;
}

export const ZOMBIE = {
  /** Survivors in one room (zombies are extra). */
  maxHumans: 4,
  /** Preparation before every wave: the shop is open. */
  prepMs: 10_000,
  startMoney: 150,
  /** Most zombies alive at once; the rest of a wave spawns as the first ones die. */
  maxAlive: 24,
  spawnEveryMs: 380,
  /** New zombies appear at least this far from every survivor. */
  spawnMinDistance: 24,
  /** ...and when there is room, at most this far from the nearest one. */
  spawnMaxDistance: 55,
  /** How long a dead zombie lies there before it is removed. */
  corpseMs: 1600,
  /** Dead survivors come back at the start of the next wave. */
  bossEvery: 5,
  /** Money to every survivor still standing when a wave is cleared. */
  clearBonus: { base: 40, perWave: 10 },
  /** Zombies per wave (not counting the boss). */
  count: { base: 6, perWave: 2.5, cap: 60 },
  /** Which zombies show up, and from which wave. */
  mix: { sprinterFromWave: 2, sprinterShare: 0.18, runnerFromWave: 3, runnerShare: 0.25, bruteFromWave: 5, bruteShare: 0.12 },
  /** Sprinters shamble, then sprint in short bursts when close (speed as a share of a player's run). */
  sprint: { speed: 1.3, burstMs: 900, restMs: [1800, 3200] as readonly [number, number], within: 30, leapWithin: 7 },
  base: {
    walker: { hp: 60, speed: 0.55, damage: 10, attackMs: 950, reach: 1.7, reward: 12 },
    sprinter: { hp: 45, speed: 0.45, damage: 9, attackMs: 800, reach: 1.6, reward: 20 },
    runner: { hp: 35, speed: 0.95, damage: 8, attackMs: 700, reach: 1.6, reward: 18 },
    brute: { hp: 240, speed: 0.5, damage: 26, attackMs: 1300, reach: 2.1, reward: 45 },
    boss: { hp: 1400, speed: 0.7, damage: 36, attackMs: 1100, reach: 2.8, reward: 400 },
  } satisfies Record<ZombieKind, ZombieBase>,
  /** How much stronger everything gets every wave after the first. */
  perWave: { hp: 0.15, speed: 0.025, speedCap: 1.15, damage: 0.08, attackFaster: 0.02, attackFloor: 0.55 },
  boss: {
    /** Extra health for every boss before this one (boss 1, 2, 3...). */
    hpPerBoss: 0.6,
    rewardPerBoss: 120,
    slam: { everyMs: 6500, windupMs: 900, radius: 5.5, damage: 34, knockback: 9 },
    /** At this share of health left, the boss calls more zombies (once). */
    summon: { atHp: 0.5, count: 5 },
  },
  /** How smart zombies get: waypoint paths around walls, then flanking. */
  smart: { pathFromWave: 1, flankFromWave: 6, flankShare: 0.4, flankDistance: 9, flankEndsAt: 7 },
  /** C places a wall of blocks that vanishes after `ttlMs`; zombies can break it. */
  build: { ttlMs: 10_000, width: 3, height: 2, ahead: 2.7, blockHp: 70, cooldownMs: 1200, maxBlocks: 48, kind: 'wood' as const },
  /** Gun upgrades: damage bonus per level, and what each level costs. */
  upgrade: { max: 5, perLevel: 0.25, prices: [150, 250, 400, 600, 900] as readonly number[] },
} as const;

export function isBossWave(wave: number): boolean {
  return wave > 0 && wave % ZOMBIE.bossEvery === 0;
}

/** 1 for the first boss, 2 for the second... (0 on waves with no boss). */
export function bossNumber(wave: number): number {
  return isBossWave(wave) ? wave / ZOMBIE.bossEvery : 0;
}

/** How many ordinary zombies a wave has. */
export function waveCount(wave: number): number {
  return Math.min(ZOMBIE.count.cap, Math.round(ZOMBIE.count.base + ZOMBIE.count.perWave * (wave - 1)));
}

/** The zombies of a wave, in the order they appear (the boss last, with a horde around it). */
export function waveKinds(wave: number): ZombieKind[] {
  const n = waveCount(wave);
  const m = ZOMBIE.mix;
  const runners = wave >= m.runnerFromWave ? Math.round(n * m.runnerShare) : 0;
  const brutes = wave >= m.bruteFromWave ? Math.max(1, Math.round(n * m.bruteShare)) : 0;
  const sprinters = wave >= m.sprinterFromWave ? Math.max(1, Math.round(n * m.sprinterShare)) : 0;
  const kinds: ZombieKind[] = [];
  for (let i = 0; i < n; i++) kinds.push(i < brutes ? 'brute' : i < brutes + runners ? 'runner' : i < brutes + runners + sprinters ? 'sprinter' : 'walker');
  // Shuffled in a fixed pattern, so every wave plays the same way for everyone.
  const mixed = kinds.map((kind, i) => ({ kind, order: (i * 7919 + wave * 104729) % 1009 })).sort((a, b) => a.order - b.order).map((x) => x.kind);
  if (isBossWave(wave)) mixed.push('boss');
  return mixed;
}

export interface ZombieStats extends ZombieBase {
  kind: ZombieKind;
}

/** What one zombie of this kind is like on this wave. */
export function zombieStats(kind: ZombieKind, wave: number): ZombieStats {
  const b = ZOMBIE.base[kind];
  const k = ZOMBIE.perWave;
  const w = Math.max(0, wave - 1);
  const boss = kind === 'boss' ? 1 + ZOMBIE.boss.hpPerBoss * Math.max(0, bossNumber(wave) - 1) : 1;
  return {
    kind,
    hp: Math.round(b.hp * (1 + k.hp * w) * boss),
    speed: Math.min(k.speedCap, b.speed + k.speed * w),
    damage: Math.round(b.damage * (1 + k.damage * w)),
    attackMs: Math.round(b.attackMs * Math.max(k.attackFloor, 1 - k.attackFaster * w)),
    reach: b.reach,
    reward: b.reward + (kind === 'boss' ? ZOMBIE.boss.rewardPerBoss * Math.max(0, bossNumber(wave) - 1) : 0),
  };
}

/** Damage multiplier of a gun at an upgrade level. */
export function upgradeMultiplier(level: number): number {
  return 1 + ZOMBIE.upgrade.perLevel * Math.max(0, Math.min(ZOMBIE.upgrade.max, level));
}

// ---------------------------------------------------------------------------
// The shop
// ---------------------------------------------------------------------------

export type ZombieShopKind = 'heal' | 'armor' | 'ammo' | 'egg' | 'weapon' | 'upgrade';

export interface ZombieShopItem {
  id: string;
  kind: ZombieShopKind;
  name: string;
  icon: string;
  text: string;
  /** Fixed price (upgrades: see ZOMBIE.upgrade.prices). */
  price: number;
  weapon?: WeaponId;
  /** Health restored. */
  amount?: number;
}

export const ZOMBIE_SHOP: readonly ZombieShopItem[] = [
  { id: 'heal-50', kind: 'heal', name: 'First aid', icon: '🩹', text: 'Restores 50 health.', price: 50, amount: 50 },
  { id: 'heal-full', kind: 'heal', name: 'Full heal', icon: '❤️', text: 'Back to full health.', price: 110, amount: PLAYER.maxHealth },
  { id: 'armor', kind: 'armor', name: 'Armor', icon: '🛡️', text: 'Full armor: it takes most of the damage.', price: 90 },
  { id: 'ammo', kind: 'ammo', name: 'Ammo refill', icon: '📦', text: 'Fills every magazine you carry.', price: 40 },
  { id: 'egg', kind: 'egg', name: 'Explosive egg', icon: '🥚', text: 'One more egg (G): area damage that clears a crowd.', price: 45 },
  { id: 'upgrade', kind: 'upgrade', name: 'Gun upgrade', icon: '⬆️', text: 'More damage for the gun in your hands (up to 5 levels).', price: ZOMBIE.upgrade.prices[0]! },
  { id: 'weapon-smg', kind: 'weapon', name: 'SMG', icon: '🔫', text: 'Fast and light.', price: 300, weapon: 'smg' },
  { id: 'weapon-shotgun', kind: 'weapon', name: 'Shotgun', icon: '🔫', text: 'Brutal up close.', price: 400, weapon: 'shotgun' },
  { id: 'weapon-rifle', kind: 'weapon', name: 'Rifle', icon: '🔫', text: 'Accurate and steady.', price: 550, weapon: 'rifle' },
  { id: 'weapon-autoshotgun', kind: 'weapon', name: 'Auto shotgun', icon: '🔫', text: 'A shotgun that keeps firing.', price: 800, weapon: 'autoshotgun' },
  { id: 'weapon-sniper', kind: 'weapon', name: 'Sniper', icon: '🎯', text: 'One shot, one zombie.', price: 900, weapon: 'sniper' },
  { id: 'weapon-lmg', kind: 'weapon', name: 'LMG', icon: '🔫', text: 'A wall of bullets.', price: 1100, weapon: 'lmg' },
  { id: 'weapon-minigun', kind: 'weapon', name: 'Minigun', icon: '⚙️', text: 'Slow to start, nothing stops it.', price: 1600, weapon: 'minigun' },
  { id: 'weapon-rocket', kind: 'weapon', name: 'Rocket launcher', icon: '🚀', text: 'Blows up whole groups. Mind yourself.', price: 2000, weapon: 'rocket' },
];

export const ZOMBIE_SHOP_BY_ID: ReadonlyMap<string, ZombieShopItem> = new Map(ZOMBIE_SHOP.map((i) => [i.id, i]));

/** The price of the next upgrade for a gun at `level` (null at the top). */
export function upgradePrice(level: number): number | null {
  return ZOMBIE.upgrade.prices[level] ?? null;
}

// ---------------------------------------------------------------------------
// What the server tells the clients
// ---------------------------------------------------------------------------

export type ZombiePhase = 'prep' | 'wave' | 'over';

export interface ZombieState {
  phase: ZombiePhase;
  /** The wave being fought, or about to start in 'prep' (0 before the first). */
  wave: number;
  /** End of 'prep' (server clock, ms), or null. */
  endsAt: number | null;
  /** Zombies alive right now, and still to come this wave. */
  alive: number;
  left: number;
  /** Zombies the survivors have killed. */
  kills: number;
  /** The boss of this wave: its health is in the normal player state (hp 0-100 = its share of health). */
  boss: { pid: number; name: string } | null;
}

/** Each survivor's own gun upgrades (weapon id → level). */
export interface ZombieGear {
  upgrades: Record<string, number>;
}

export interface ZombieJoin {
  state: ZombieState;
  gear: ZombieGear;
}
