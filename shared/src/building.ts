import type { Aabb } from './collision';

/** Sandbox blocks sit on a grid of cubes this big (same as a crate). */
export const BLOCK_SIZE = 1.2;
export const MAX_BLOCKS = 800;
/** Blocks can be placed this far from the eye. */
export const BUILD_RANGE = 9;
export const MAX_BUILD_HEIGHT = 16;
/** Collision ids for blocks start here, after the map's static boxes. */
export const BLOCK_ID_BASE = 100_000;

export function blockAabb(cx: number, cy: number, cz: number): Aabb {
  return {
    minX: cx * BLOCK_SIZE,
    maxX: (cx + 1) * BLOCK_SIZE,
    minY: cy * BLOCK_SIZE,
    maxY: (cy + 1) * BLOCK_SIZE,
    minZ: cz * BLOCK_SIZE,
    maxZ: (cz + 1) * BLOCK_SIZE,
  };
}

export function cellOf(x: number, y: number, z: number): { cx: number; cy: number; cz: number } {
  return { cx: Math.floor(x / BLOCK_SIZE), cy: Math.floor(y / BLOCK_SIZE), cz: Math.floor(z / BLOCK_SIZE) };
}

export function cellKey(cx: number, cy: number, cz: number): string {
  return `${cx},${cy},${cz}`;
}
