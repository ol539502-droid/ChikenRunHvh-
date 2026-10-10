import { crate, hut, mirrored, type MapBox, type MapDef } from './types';

/**
 * Frostbite: a snowy outpost. Wooden cabins (bullets go through their walls) around an icy
 * square, a flag base at each end for Capture the Flag. North is -Z; the map is symmetric.
 */

const ICE = 0xbfe4f5;

const ice = (x: number, z: number, w: number, h: number, d: number): MapBox => ({ kind: 'stone', x, z, w, h, d, color: ICE });

// The +X/+Z quarter, mirrored into the other three.
const QUARTER: MapBox[] = [
  ...hut(14, 12, 8, 7, 3.2, ['w', 'n'], 'wood', 0.3, 1.6, 2.2),
  crate(19.5, 17),
  crate(19.5, 18.2),
  ice(22, 24, 3, 1.4, 1),
  ice(8, 4, 3.4, 1.1, 0.8),
];

export const FROSTBITE: MapDef = {
  id: 'frostbite',
  name: 'Frostbite',
  halfSize: 38,
  ground: 'snow',
  boxes: [
    // The icy square in the middle.
    ice(0, 0, 2, 3, 2),
    // A cabin at each base, and one on each side of the square.
    ...hut(0, 24, 9, 6, 3.4, ['n', 'e', 'w'], 'wood', 0.3, 1.6, 2.2),
    ...hut(0, -24, 9, 6, 3.4, ['s', 'e', 'w'], 'wood', 0.3, 1.6, 2.2),
    ...hut(26, 0, 7, 7, 3.2, ['w', 'e'], 'wood', 0.3, 1.6, 2.2),
    ...hut(-26, 0, 7, 7, 3.2, ['w', 'e'], 'wood', 0.3, 1.6, 2.2),
    crate(0, 12),
    crate(0, -12),
    ...QUARTER.flatMap((box) => mirrored(box)),
  ],
  spawns: [
    { x: -20, z: 32, team: 1 },
    { x: -10, z: 33, team: 1 },
    { x: 10, z: 33, team: 1 },
    { x: 20, z: 32, team: 1 },
    { x: -7, z: 29, team: 1 },
    { x: 7, z: 29, team: 1 },
    { x: -20, z: -32, team: 2 },
    { x: -10, z: -33, team: 2 },
    { x: 10, z: -33, team: 2 },
    { x: 20, z: -32, team: 2 },
    { x: -7, z: -29, team: 2 },
    { x: 7, z: -29, team: 2 },
    ...mirrored({ x: 32, z: 12 }),
  ],
  loot: [...mirrored({ x: 14, z: 12 }), { x: 0, y: 3, z: 0 }],
  vehicles: [],
  flags: [
    { team: 1, x: 0, z: 31 },
    { team: 2, x: 0, z: -31 },
  ],
};
