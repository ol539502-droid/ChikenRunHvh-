// Collision from the map's source brushes (tools/import_mirage_vmf.mts) plus the old prop boxes.
import data from './mirage-data.json';
// Drawn walls with no collision behind them (props the source has no shape for; tools/patch_mirage_walls.mts). Kept last: box order sets collision IDs.
import walls from './mirage-walls.json';
// Invisible boxes that stop shots where nothing is drawn (tools/mirage_clips.mts): made player clips
// like the source's own (shots, sight and grenades pass; chickens don't).
import clips from './mirage-clips.json';
// The upright ladder props (tools/mirage_ladders.mts).
import ladders from './mirage-ladders.json';
import { type MapBox, type MapDef, type SpawnPoint } from './types';

const clipIds = new Set(clips);
/**
 * The ladder in the room over the Tunnel tops out in open air: three planks to step onto at the
 * top (drawn and solid), leaving the gap the ladder comes up through.
 */
const LADDER_BOARDS: MapBox[] = [
  { kind: 'wood', x: -26.275, y: 8.92, z: 3.475, w: 3.35, h: 0.05, d: 0.35 },
  { kind: 'wood', x: -26.275, y: 8.92, z: 3.9, w: 3.35, h: 0.05, d: 0.4 },
  { kind: 'wood', x: -26.675, y: 8.92, z: 4.55, w: 2.55, h: 0.05, d: 0.8 },
];
const index = new Map(data.nav.map((p, i) => [p.id, i]));
const bases = [1, 2].map((team) => {
  const spawn = data.spawns.find((p) => p.team === team)!;
  return data.nav.reduce((a, b) => Math.hypot(a.x - spawn.x, a.z - spawn.z) <= Math.hypot(b.x - spawn.x, b.z - spawn.z) ? a : b);
});

/** Original Mirage coordinates: 40 Source units per metre, Source Z=-400 at ground zero. */
export const MIRAGE: MapDef = {
  id: 'mirage', name: 'Mirage', ground: 'sand', mesh: '/maps/mirage.glb',
  radar: { image: '/maps/mirage-radar.png', x: -80.75, z: -42.825, size: 128 },
  // Its outermost collision reaches x = -104.5.
  halfSize: 110,
  // The playable part.
  grassHalf: 66,
  boxes: [...(data.boxes as MapBox[]).map((box, i) => clipIds.has(i) ? { ...box, clip: true } : box), ...LADDER_BOARDS, ...walls as MapBox[]],
  spawns: data.spawns as SpawnPoint[],
  loot: [], vehicles: [],
  flags: bases.map((p, i) => ({ team: (i + 1) as 1 | 2, x: p.x, y: p.y, z: p.z })),
  bombSites: [
    { id: 'A', x: -11, y: 5.7, z: 54.2, radius: 4 },
    { id: 'B', x: -51.2, y: 6.1, z: -6.4, radius: 4 },
  ],
  buyZones: [
    { team: 1, x: 31.2, z: 3.4, radius: 8.3 },
    { team: 2, x: -45.6, z: 46.6, radius: 11.9 },
  ],
  nav: data.nav,
  navLinks: data.nav.map((p) => p.links.flatMap((id) => index.has(id) ? [index.get(id)!] : [])),
  // Re-checking all 12,052 links at run time took ~14 s per room.
  navLinksChecked: true,
  ladders,
};
