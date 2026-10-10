import type { Aabb } from '../collision';

export type MapId = 'farm' | 'town' | 'flat' | 'sandstown' | 'harbor' | 'frostbite' | 'factory' | 'night' | 'lobby';

export type BoxKind = 'crate' | 'hay' | 'stone' | 'brick' | 'wood' | 'roof' | 'concrete' | 'car' | 'metal' | 'sandstone';

/** A solid block in the level. `x`/`z` are the centre, `y` is the bottom (defaults to the ground). */
export interface MapBox {
  kind: BoxKind;
  x: number;
  y?: number;
  z: number;
  w: number;
  h: number;
  d: number;
  /** Optional paint colour (e.g. parked cars). */
  color?: number;
}

/** Team 0 = no team (free-for-all), 1 = red, 2 = blue. */
export type Team = 0 | 1 | 2;

export interface SpawnPoint {
  x: number;
  z: number;
  /** Team-mode spawns; points without a team are only used in free-for-all modes. */
  team?: 1 | 2;
}

/** Where a loot box floats. `y` is the surface it hovers over. */
export interface LootSpot {
  x: number;
  y?: number;
  z: number;
}

export interface VehicleSpot {
  x: number;
  z: number;
  yaw: number;
}

export interface FlagSpot {
  team: 1 | 2;
  x: number;
  z: number;
}

export type GroundStyle = 'grass' | 'town' | 'flat' | 'sand' | 'dock' | 'snow' | 'factory' | 'yard';

/** A ChikenBomb plant zone: a circle on the ground. */
export interface BombSite {
  id: 'A' | 'B';
  x: number;
  z: number;
  radius: number;
}

export interface MapDef {
  id: MapId;
  name: string;
  /** The playable area is the square [-halfSize, halfSize] on X and Z. */
  halfSize: number;
  ground: GroundStyle;
  boxes: readonly MapBox[];
  spawns: readonly SpawnPoint[];
  loot: readonly LootSpot[];
  vehicles: readonly VehicleSpot[];
  flags: readonly FlagSpot[];
  /** ChikenBomb plant zones. */
  bombSites?: readonly BombSite[];
  /**
   * Open spots bots use to find their way through walls: any two that can see each other are
   * linked. Only needed on maps with long detours (Sandstown).
   */
  nav?: readonly { x: number; z: number }[];
}

export function boxToAabb(box: MapBox): Aabb {
  const y = box.y ?? 0;
  return {
    minX: box.x - box.w / 2,
    maxX: box.x + box.w / 2,
    minY: y,
    maxY: y + box.h,
    minZ: box.z - box.d / 2,
    maxZ: box.z + box.d / 2,
  };
}

/** Mirrors something into all four quadrants (skips duplicates when a coordinate is 0). */
export function mirrored<T extends { x: number; z: number }>(item: T): T[] {
  const out: T[] = [];
  for (const sx of item.x === 0 ? [1] : [1, -1]) {
    for (const sz of item.z === 0 ? [1] : [1, -1]) {
      out.push({ ...item, x: item.x * sx, z: item.z * sz });
    }
  }
  return out;
}

export const CRATE_SIZE = 1.2;

export function crate(x: number, z: number, size = CRATE_SIZE, y = 0): MapBox {
  return { kind: 'crate', x, y, z, w: size, h: size, d: size };
}

export function block(kind: BoxKind, x: number, z: number, w: number, h: number, d: number, y = 0): MapBox {
  return { kind, x, y, z, w, h, d };
}

/** Hollow walls with centered doorways; box order determines collision IDs. */
export function hut(cx: number, cz: number, w: number, d: number, h: number, doors: readonly ('n' | 's' | 'e' | 'w')[], kind: BoxKind,
  wallSize = 0.35, doorWidth = 1.8, doorHeight = 2.3): MapBox[] {
  const out: MapBox[] = [];
  for (const side of ['n', 's', 'w', 'e'] as const) {
    const alongX = side === 'n' || side === 's';
    const length = alongX ? w : d - 2 * wallSize;
    const fixed = side === 'n' ? cz - d / 2 + wallSize / 2 : side === 's' ? cz + d / 2 - wallSize / 2 : side === 'w' ? cx - w / 2 + wallSize / 2 : cx + w / 2 - wallSize / 2;
    const centre = alongX ? cx : cz;
    const piece = (from: number, to: number, y: number, height: number) => {
      const mid = (from + to) / 2, len = to - from;
      out.push(alongX ? block(kind, mid, fixed, len, height, wallSize, y) : block(kind, fixed, mid, wallSize, height, len, y));
    };
    if (!doors.includes(side)) piece(centre - length / 2, centre + length / 2, 0, h);
    else {
      piece(centre - length / 2, centre - doorWidth / 2, 0, h);
      piece(centre + doorWidth / 2, centre + length / 2, 0, h);
      piece(centre - doorWidth / 2, centre + doorWidth / 2, doorHeight, h - doorHeight);
    }
  }
  out.push(block('roof', cx, cz, w, 0.3, d, h));
  return out;
}
