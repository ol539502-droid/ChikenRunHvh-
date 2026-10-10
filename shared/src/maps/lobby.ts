import { block, crate, hut, type MapBox, type MapDef } from './types';

/**
 * Courtyard: the title screen's own map (no game mode uses it, so nobody can pick it). A sandstone
 * house in the middle of a wide sandy yard, a wooden pergola, green hedges, a few palms and
 * crates. The chicken on the title screen runs a big oval round the house (LOBBY_LAP), so the
 * house, pergola, palms and hedges all pass behind it.
 */

/** The title screen's running track: an oval round the house (centre and half-widths, in metres). */
export const LOBBY_LAP = { x: 0, z: 0, a: 18, b: 15 } as const;

const HEDGE = 0x3f8f3f;
const hedge = (x: number, z: number, w: number, d: number): MapBox => ({ kind: 'metal', x, z, w, h: 2.2, d, color: HEDGE });

/** A stylised palm: a wooden trunk with a flat green crown. */
function palm(x: number, z: number): MapBox[] {
  return [block('wood', x, z, 0.5, 4, 0.5), { kind: 'metal', x, y: 4, z, w: 3.4, h: 0.5, d: 3.4, color: 0x2f7d32 }];
}

/** A pergola: four posts with wooden slats across the top. */
function pergola(cx: number, cz: number): MapBox[] {
  const out: MapBox[] = [];
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) out.push(block('wood', cx + sx * 2.8, cz + sz * 1.9, 0.35, 2.6, 0.35));
  for (let i = -3; i <= 3; i++) out.push(block('wood', cx + i * 0.85, cz, 0.3, 0.2, 4.6, 2.6));
  return out;
}

const BOXES: MapBox[] = [
  // The house in the middle, with a door in the north and south walls.
  ...hut(0, 0, 12, 9, 4.4, ['n', 's'], 'sandstone'),
  // A long sandstone wall behind everything on the north side.
  block('sandstone', 0, -28, 44, 3.2, 0.8),
  ...pergola(19, 15),
  // Green hedges along the east and south edges.
  hedge(30, 0, 1.4, 50),
  hedge(0, 30, 50, 1.4),
  ...palm(-20, 14),
  ...palm(22, -14),
  ...palm(-22, -12),
  // A few crates beside the house (inside the running track).
  crate(7, -2.5),
  crate(7, -1.3),
  crate(7, -1.9, 1.2, 1.2),
];

export const LOBBY: MapDef = {
  id: 'lobby',
  name: 'Courtyard',
  halfSize: 34,
  // Packed dirt and sand with grass flecks (painted, title screen only).
  ground: 'yard',
  boxes: BOXES,
  // Never used by a mode, but a map needs somewhere to stand.
  spawns: [
    { x: 0, z: 16 },
    { x: 6, z: 15 },
    { x: -6, z: 15 },
    { x: 0, z: -16 },
    { x: 6, z: -15 },
    { x: -6, z: -15 },
  ],
  loot: [],
  vehicles: [],
  flags: [],
};
