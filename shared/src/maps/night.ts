import { boxToAabb, crate, hut, mirrored, type MapBox, type MapDef } from './types';

/**
 * Graveyard (Zombie Apocalypse): a walled night cemetery with a merchant's hut in the middle
 * where the survivors start, two crypts, rows of tombstones and low iron fences to hide behind.
 * Zombies come in from the edges. North is -Z.
 */

const GRAVE_STONE = 0x8d9199;
const stone = (x: number, z: number, w = 0.9, h = 1.3, d = 0.35): MapBox => ({ kind: 'stone', x, z, w, h, d, color: GRAVE_STONE });
/** A low iron fence section (you can shoot and see over it, not walk through it). */
const fence = (x: number, z: number, w: number, d: number): MapBox => ({ kind: 'metal', x, z, w, h: 1.1, d, color: 0x2b2d33 });

/** A row of tombstones along X, `n` of them `gap` metres apart, starting at `x`. */
function graves(x: number, z: number, n: number, gap = 2.6): MapBox[] {
  return Array.from({ length: n }, (_, i) => stone(x + i * gap, z));
}

// The +X/+Z quarter, mirrored into the other three.
const QUARTER: MapBox[] = [
  ...graves(7, 8, 4),
  ...graves(7, 12, 4),
  ...graves(7, 16, 4),
  fence(22, 7, 6, 0.3),
  fence(25.2, 10, 0.3, 6),
  crate(30, 28),
  crate(31.2, 28),
  crate(30.6, 28, 1.2, 1.2),
  fence(14, 30, 7, 0.3),
  stone(34, 14, 1.4, 2, 0.5),
  stone(11, 31, 1.4, 2, 0.5),
];

const BOXES: MapBox[] = [
  // The merchant's hut in the middle: doors on every side.
  ...hut(0, 0, 7, 6, 3.2, ['n', 's', 'e', 'w'], 'wood'),
  { kind: 'crate', x: 0, z: 0, w: 1.4, h: 1.0, d: 0.9, color: 0x6b4a2b },
  // Two crypts.
  ...hut(-24, -22, 10, 8, 3.6, ['e', 's'], 'stone'),
  ...hut(24, 24, 9, 8, 3.4, ['n', 'w'], 'stone'),
  ...QUARTER.flatMap((box) => mirrored(box)),
];

/** Waypoints on an 8 m grid, wherever nothing is standing: zombies find their way round walls by them. */
function navGrid(halfSize: number): { x: number; z: number }[] {
  const solids = BOXES.map(boxToAabb);
  const out: { x: number; z: number }[] = [];
  for (let x = -halfSize + 4; x <= halfSize - 4; x += 8) {
    for (let z = -halfSize + 4; z <= halfSize - 4; z += 8) {
      const free = !solids.some((b) => x > b.minX - 1 && x < b.maxX + 1 && z > b.minZ - 1 && z < b.maxZ + 1 && b.minY < 2);
      if (free) out.push({ x, z });
    }
  }
  return out;
}

const HALF = 44;

export const NIGHT: MapDef = {
  id: 'night',
  name: 'Graveyard',
  halfSize: HALF,
  ground: 'grass',
  boxes: BOXES,
  spawns: [
    // The survivors: round the merchant's hut.
    { x: 0, z: 8, team: 1 },
    { x: 5, z: 6, team: 1 },
    { x: -5, z: 6, team: 1 },
    { x: 0, z: -8, team: 1 },
    { x: 5, z: -6, team: 1 },
    { x: -5, z: -6, team: 1 },
    // The zombies: all round the edge.
    ...[-36, -18, 0, 18, 36].flatMap((v) => [
      { x: v, z: -HALF + 3, team: 2 as const },
      { x: v, z: HALF - 3, team: 2 as const },
      { x: -HALF + 3, z: v, team: 2 as const },
      { x: HALF - 3, z: v, team: 2 as const },
    ]),
  ],
  loot: [],
  vehicles: [],
  flags: [],
  nav: navGrid(HALF),
};
