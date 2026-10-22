import type { CollisionWorld } from './collision';
import { isSpaceFree } from './physics';
import { makeRay, raycastWorld } from './raycast';
import { SOURCE_MOVE } from './movement';
import type { Aabb } from './collision';

export interface NavPoint {
  x: number;
  y?: number;
  z: number;
}

/** Waypoints, and which ones are linked (an index list per point). */
export interface NavGraph {
  points: readonly NavPoint[];
  links: readonly (readonly number[])[];
}

/** Two spots are linked when they're this close and nothing blocks a chicken walking between them. */
const MAX_LINK = 26;
/** Checked at knee and head height, and a body-width either side, so links never clip a corner. */
const HEIGHTS = [SOURCE_MOVE.stepHeight + 0.05, 1.3];
const SIDE = 0.45;

/** True if a chicken can walk in a straight line from `a` to `b`. */
export function walkable(a: NavPoint, b: NavPoint, world: CollisionWorld): boolean {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const dy = (b.y ?? 0) - (a.y ?? 0);
  const dist = Math.hypot(dx, dy, dz);
  if (dist < 1e-6) return true;
  const dir = { x: dx / dist, y: dy / dist, z: dz / dist };
  const nx = -dir.z * SIDE;
  const nz = dir.x * SIDE;
  for (const y of HEIGHTS) {
    for (const side of [-1, 0, 1]) {
      const origin = { x: a.x + nx * side, y: (a.y ?? 0) + y, z: a.z + nz * side };
      if (raycastWorld(makeRay(origin, dir), world, dist)) return false;
    }
  }
  if (a.y !== undefined || b.y !== undefined) {
    const steps = Math.max(1, Math.ceil(dist / 0.25));
    let floor = a.y ?? 0;
    const nearby: Aabb[] = [];
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const x = a.x + dx * t, z = a.z + dz * t;
      let top = floor <= SOURCE_MOVE.stepHeight ? 0 : -Infinity;
      for (const box of world.query(x - SIDE, z - SIDE, x + SIDE, z + SIDE, nearby)) {
        if (box.minX >= x + SIDE || box.maxX <= x - SIDE || box.minZ >= z + SIDE || box.maxZ <= z - SIDE) continue;
        if (box.maxY <= floor + SOURCE_MOVE.stepHeight + 0.001 && box.maxY >= floor - SOURCE_MOVE.stepHeight - 0.001) top = Math.max(top, box.maxY);
      }
      if (!Number.isFinite(top) || !isSpaceFree(x, top, z, world)) return false;
      floor = top;
    }
    if (Math.abs(floor - (b.y ?? 0)) > SOURCE_MOVE.stepHeight) return false;
  }
  return true;
}

/**
 * Spots spread over every part of the map a chicken can walk to from `starts`: a flood fill over
 * a grid `step` metres apart, each step a straight walkable line. Free-for-all modes spawn and
 * roam here so nobody bunches up at the handful of spawn points.
 */
export function openSpots(starts: readonly NavPoint[], world: CollisionWorld, halfSize: number, step = 4): NavPoint[] {
  const cells = Math.floor((halfSize * 2 - 2) / step);
  const at = (i: number) => -halfSize + 1 + step * (i + 0.5);
  const seen = new Set<number>();
  const out: NavPoint[] = [];
  const queue: [number, number][] = [];
  const visit = (i: number, j: number, from: NavPoint) => {
    if (i < 0 || j < 0 || i >= cells || j >= cells || seen.has(i * cells + j)) return;
    const spot = { x: at(i), z: at(j) };
    if (!isSpaceFree(spot.x, 0, spot.z, world) || !walkable(from, spot, world)) return;
    seen.add(i * cells + j);
    out.push(spot);
    queue.push([i, j]);
  };
  for (const s of starts) {
    const i = Math.round((s.x + halfSize - 1) / step - 0.5);
    const j = Math.round((s.z + halfSize - 1) / step - 0.5);
    visit(i, j, s);
  }
  while (queue.length > 0) {
    const [i, j] = queue.shift()!;
    const from = { x: at(i), z: at(j) };
    visit(i + 1, j, from);
    visit(i - 1, j, from);
    visit(i, j + 1, from);
    visit(i, j - 1, from);
  }
  return out;
}

export function buildNavGraph(points: readonly NavPoint[], world: CollisionWorld, importedLinks?: readonly (readonly number[])[], linksChecked = false): NavGraph {
  // Imported links (Mirage's nav) are kept only where a chicken can still walk them straight.
  // linksChecked: the map data was made with every link already walked (MapDef.navLinksChecked).
  const links: number[][] = points.map((_, i) => linksChecked ? [...(importedLinks?.[i] ?? [])]
    : (importedLinks?.[i] ?? []).filter((j) => walkable(points[i]!, points[j]!, world)));
  for (let i = 0; i < points.length; i++) {
    if (i < (importedLinks?.length ?? 0)) continue;
    for (let j = i + 1; j < points.length; j++) {
      const a = points[i]!;
      const b = points[j]!;
      if (Math.hypot(a.x - b.x, a.z - b.z) > MAX_LINK || !walkable(a, b, world)) continue;
      links[i]!.push(j);
      links[j]!.push(i);
    }
  }
  return { points, links };
}

/** The waypoint nearest to `p` that `p` can walk straight to (or just the nearest one). */
export function nearestNavPoint(graph: NavGraph, p: NavPoint, world: CollisionWorld): number {
  // Nearest first, so the (costly) walk check stops at the first one that passes.
  const dist = graph.points.map((q) => Math.hypot(q.x - p.x, (q.y ?? 0) - (p.y ?? 0), q.z - p.z));
  const order = dist.map((_, i) => i).sort((a, b) => dist[a]! - dist[b]! || a - b);
  for (const i of order) if (walkable(p, graph.points[i]!, world)) return i;
  return order[0] ?? 0;
}

/**
 * Shortest route of waypoints from `from` to `to` (Dijkstra; the graphs are tiny). Ends at `to`
 * itself. Empty if there's no waypoint graph; a direct line if they can see each other.
 */
export function findPath(graph: NavGraph, from: NavPoint, to: NavPoint, world: CollisionWorld, direct = true): NavPoint[] {
  if (graph.points.length === 0 || (direct && walkable(from, to, world))) return [to];
  const start = nearestNavPoint(graph, from, world);
  const goal = nearestNavPoint(graph, to, world);
  const dist = graph.points.map(() => Infinity);
  const prev = graph.points.map(() => -1);
  const done = graph.points.map(() => false);
  dist[start] = 0;
  for (;;) {
    let u = -1;
    for (let i = 0; i < dist.length; i++) if (!done[i] && dist[i]! < Infinity && (u < 0 || dist[i]! < dist[u]!)) u = i;
    if (u < 0 || u === goal) break;
    done[u] = true;
    for (const v of graph.links[u]!) {
      const p = graph.points[u]!;
      const q = graph.points[v]!;
      const alt = dist[u]! + Math.hypot(p.x - q.x, p.z - q.z);
      if (alt < dist[v]!) {
        dist[v] = alt;
        prev[v] = u;
      }
    }
  }
  if (dist[goal] === Infinity) return [to];
  const route: NavPoint[] = [to];
  for (let i = goal; i >= 0; i = prev[i]!) route.unshift(graph.points[i]!);
  return route;
}

/** How many waypoints `start` can reach (for tests: every spot should reach every other). */
export function reachableCount(graph: NavGraph, start = 0): number {
  const seen = new Set([start]);
  const queue = [start];
  while (queue.length > 0) {
    const u = queue.shift()!;
    for (const v of graph.links[u]!) {
      if (seen.has(v)) continue;
      seen.add(v);
      queue.push(v);
    }
  }
  return seen.size;
}
