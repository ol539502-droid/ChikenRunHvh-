import { mulberry32 } from '../rng';
import { boxToAabb, crate, hut, mirrored, type BoxKind, type MapBox, type MapDef } from './types';

/**
 * Graveyard (Zombie Apocalypse): a walled night cemetery with a merchant's hut in the middle
 * where the survivors start, two crypts, rows of tombstones and low iron fences to hide behind.
 * Round it, outside the cemetery wall: a cornfield (north-west), an abandoned farm with a barn
 * and a silo (north-east), a village of narrow alleys (south-west), a chapel (south) and an open
 * meadow with a campfire (south-east). Zombies come from anywhere. North is -Z.
 */

const HALF = 88;
/** The cemetery wall, with a gate in each side (the choke points into the middle). */
const WALL = 42;
const GATE = 5;

const GRAVE_STONE = 0x8d9199;
const stone = (x: number, z: number, w = 0.9, h = 1.3, d = 0.35): MapBox => ({ kind: 'stone', x, z, w, h, d, color: GRAVE_STONE });
/** A low iron fence section (you can shoot and see over it, not walk through it). */
const fence = (x: number, z: number, w: number, d: number): MapBox => ({ kind: 'metal', x, z, w, h: 1.1, d, color: 0x2b2d33 });

/** A row of tombstones along X, `n` of them `gap` metres apart, starting at `x`. */
function graves(x: number, z: number, n: number, gap = 2.6): MapBox[] {
  return Array.from({ length: n }, (_, i) => stone(x + i * gap, z));
}

/** A waypoint just inside and just outside every doorway, so zombies follow survivors indoors. */
const DOORS: { x: number; z: number }[] = [];

/** A hut (see `hut`) whose doorways are added to the waypoints. */
function house(cx: number, cz: number, w: number, d: number, h: number, doors: readonly ('n' | 's' | 'e' | 'w')[], kind: BoxKind, wallSize?: number, doorWidth?: number, doorHeight?: number): MapBox[] {
  const step = 1.5;
  for (const side of doors) {
    const nx = side === 'e' ? 1 : side === 'w' ? -1 : 0;
    const nz = side === 's' ? 1 : side === 'n' ? -1 : 0;
    const x = cx + (nx * w) / 2;
    const z = cz + (nz * d) / 2;
    DOORS.push({ x: x + nx * step, z: z + nz * step }, { x: x - nx * step, z: z - nz * step });
  }
  return hut(cx, cz, w, d, h, doors, kind, wallSize, doorWidth, doorHeight);
}

// The +X/+Z quarter of the cemetery, mirrored into the other three.
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

/** The cemetery wall: two pieces a side, with the gate between them. */
function cemeteryWall(): MapBox[] {
  const out: MapBox[] = [];
  const t = 0.6;
  // North and south walls run corner to corner; east and west fit between them.
  const outer = WALL + t / 2;
  const inner = WALL - t / 2;
  for (const s of [-1, 1]) {
    for (const half of [-1, 1]) {
      out.push({ kind: 'stone', x: (half * (outer + GATE / 2)) / 2, z: s * WALL, w: outer - GATE / 2, h: 2.2, d: t, color: 0x6a6e76 });
      out.push({ kind: 'stone', x: s * WALL, z: (half * (inner + GATE / 2)) / 2, w: t, h: 2.2, d: inner - GATE / 2, color: 0x6a6e76 });
    }
  }
  return out;
}

/**
 * Tall corn in rows along X, 4 m apart (2.8 m aisles), with 3 m lanes across the rows at the
 * given X positions. Aisles and lanes sit on the waypoint grid lines, so zombies get through.
 */
function cornfield(x0: number, x1: number, z0: number, z1: number, lanes: readonly number[]): MapBox[] {
  const out: MapBox[] = [];
  const cuts = [x0, ...lanes.flatMap((l) => [l - 1.5, l + 1.5]), x1];
  for (let z = z0; z <= z1; z += 4) {
    for (let i = 0; i < cuts.length; i += 2) {
      const a = cuts[i]!;
      const b = cuts[i + 1]!;
      out.push({ kind: 'hay', x: (a + b) / 2, z, w: b - a, h: 2.6, d: 1.2, color: 0x5d5a26 });
    }
  }
  return out;
}

const BARN_RED = 0x5a2620;
const FARM: MapBox[] = [
  // The barn: big doors south and west, hay bales inside to hide behind.
  ...house(64, -66, 16, 12, 6, ['s', 'w'], 'wood', 0.4, 3.2, 3.6).map((b) => (b.kind === 'wood' ? { ...b, color: BARN_RED } : b)),
  { kind: 'hay', x: 60, z: -69, w: 2.4, h: 1.2, d: 1.4 },
  { kind: 'hay', x: 60, z: -69, y: 1.2, w: 1.2, h: 1.2, d: 1.4 },
  { kind: 'hay', x: 69, z: -63, w: 1.4, h: 1.2, d: 2.4 },
  // The farmhouse, doors south and east.
  ...house(26, -72, 9, 7, 3.2, ['s', 'e'], 'wood'),
  // The silo and a rusty tractor.
  { kind: 'metal', x: 79, z: -50, w: 5, h: 10, d: 5, color: 0x4b4f55 },
  { kind: 'car', x: 50, z: -52, w: 2.2, h: 1.6, d: 3.4, color: 0x5b3a22 },
  // A broken paddock fence and a water trough.
  { kind: 'wood', x: 38, z: -56, w: 9, h: 1.1, d: 0.2, color: 0x4a3b2c },
  { kind: 'wood', x: 34, z: -62, w: 0.2, h: 1.1, d: 8, color: 0x4a3b2c },
  { kind: 'metal', x: 46, z: -77, w: 3, h: 0.7, d: 1, color: 0x3a3d42 },
  crate(72, -78),
  crate(73.2, -78),
  crate(72.6, -78, 1.2, 1.2),
];

/** The abandoned village: blocks of houses with 3 m alleys between them (on the waypoint lines). */
function village(): MapBox[] {
  const xs: [number, number][] = [[-86, -77.5], [-74.5, -61.5], [-58.5, -45.5], [-42.5, -29.5], [-26.5, -16]];
  const zs: [number, number][] = [[47, 58.5], [61.5, 74.5], [77.5, 86]];
  const out: MapBox[] = [];
  xs.forEach(([a, b], i) => zs.forEach(([c, d], j) => {
    if (i === 2 && j === 1) return; // a small square in the middle
    if ((i + j) % 3 === 1) {
      // A house you can go into, with a door onto two alleys.
      out.push(...house((a + b) / 2, (c + d) / 2, b - a, d - c, 4, ['n', 'e'], 'brick'));
      return;
    }
    out.push({ kind: 'brick', x: (a + b) / 2, z: (c + d) / 2, w: b - a, h: 4 + ((i * 7 + j * 3) % 4) * 0.6, d: d - c });
  }));
  // Junk in the square.
  out.push(crate(-50, 65), crate(-48.8, 65.4), { kind: 'car', x: -54.5, z: 70.5, w: 2, h: 1.5, d: 4, color: 0x2e3238 });
  return out;
}

const SOUTH: MapBox[] = [
  // A small stone chapel, the door to the north.
  ...house(22, 66, 10, 14, 5, ['n'], 'stone'),
  { kind: 'stone', x: 22, z: 70, w: 3, h: 1, d: 1.2, color: GRAVE_STONE },
  // Old graves outside the wall.
  ...graves(6.5, 54.5, 4),
  ...graves(29.5, 49.5, 3),
  // The meadow: open, with a campfire ring and two logs to sit on.
  ...[0, 1, 2, 3, 4, 5].map((i): MapBox => ({ kind: 'stone', x: 66 + Math.cos((i * Math.PI) / 3) * 1.3, z: 66 + Math.sin((i * Math.PI) / 3) * 1.3, w: 0.5, h: 0.35, d: 0.5, color: 0x55585e })),
  { kind: 'wood', x: 66, z: 69.4, w: 3, h: 0.45, d: 0.6, color: 0x4a3b2c },
  { kind: 'wood', x: 62.6, z: 66, w: 0.6, h: 0.45, d: 3, color: 0x4a3b2c },
];

/** Dead trees on the east and west sides, a tool shed, a wrecked truck. */
function woods(): MapBox[] {
  const rand = mulberry32(13);
  const out: MapBox[] = [];
  for (const side of [-1, 1]) {
    for (let i = 0; i < 9; i++) {
      // Between the waypoint lines (…, 52, 60, 68 …), so they don't cut the routes.
      const x = side * (48.5 + Math.floor(rand() * 4) * 8 + rand() * 2);
      const z = -39.5 + Math.floor(rand() * 10) * 8 + rand() * 2;
      out.push({ kind: 'wood', x, z, w: 0.7, h: 6 + rand() * 3, d: 0.7, color: 0x2e2822 });
    }
  }
  out.push({ kind: 'car', x: -64, z: -8, w: 2.4, h: 2, d: 5, color: 0x3d4a52 });
  out.push(...house(-66, 24, 7, 6, 3, ['e'], 'wood'));
  out.push(crate(72, 8), crate(72, 9.2), crate(72, 8.6, 1.2, 1.2));
  return out;
}

const BOXES: MapBox[] = [
  // The merchant's hut in the middle: doors on every side.
  ...house(0, 0, 7, 6, 3.2, ['n', 's', 'e', 'w'], 'wood'),
  { kind: 'crate', x: 0, z: 0, w: 1.4, h: 1.0, d: 0.9, color: 0x6b4a2b },
  // Two crypts.
  ...house(-24, -22, 10, 8, 3.6, ['e', 's'], 'stone'),
  ...house(24, 24, 9, 8, 3.4, ['n', 'w'], 'stone'),
  ...QUARTER.flatMap((box) => mirrored(box)),
  ...cemeteryWall(),
  ...cornfield(-85, -16, -86, -50, [-76, -52, -28]),
  ...FARM,
  ...village(),
  ...SOUTH,
  ...woods(),
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
  // Both sides of each cemetery gate.
  const gates = [-1, 1].flatMap((s) => [WALL - 2, WALL + 2].flatMap((r) => [{ x: s * r, z: 0 }, { x: 0, z: s * r }]));
  return [...out, ...DOORS, ...gates];
}

const NAV = navGrid(HALF);

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
    // The zombies: anywhere away from the hut (the room picks ones far from every survivor).
    ...NAV.filter((p) => Math.hypot(p.x, p.z) > 16).map((p) => ({ ...p, team: 2 as const })),
  ],
  loot: [],
  vehicles: [],
  flags: [],
  nav: NAV,
  // Lanterns on walls, and the campfire.
  lamps: [
    { x: 0, y: 2.6, z: 3.25, color: 0xffa040 },
    { x: 0, y: 2.6, z: -3.25, color: 0xffa040 },
    { x: -18.75, y: 2.6, z: -20.5, color: 0xc0281c },
    { x: 25.8, y: 2.6, z: 19.75, color: 0xc0281c },
    { x: 3.4, y: 1.9, z: -WALL - 0.4, color: 0xff8a30 },
    { x: -3.4, y: 1.9, z: WALL + 0.4, color: 0xff8a30 },
    { x: 58, y: 2.6, z: -59.75, color: 0xff9a40 },
    { x: 30.75, y: 2.4, z: -70, color: 0xffb060 },
    { x: 24.2, y: 2.6, z: 58.75, color: 0xc0281c },
    { x: -45.25, y: 2.6, z: 56, color: 0xc0281c },
    { x: -63, y: 2.6, z: 77.25, color: 0xff8a30 },
    { x: 66, y: 0.3, z: 66, color: 0xff7a20, fire: true },
  ],
};
