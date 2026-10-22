import { CELL_SIZE, type Aabb, type CollisionWorld } from './collision';
import type { Vec3 } from './math';
import { CHICKEN_POSE } from './chickenPose';
import { rayHvhChicken } from './hvh/geometry';

export interface Ray {
  ox: number;
  oy: number;
  oz: number;
  /** Must be normalized. */
  dx: number;
  dy: number;
  dz: number;
}

export interface RayHit {
  t: number;
  nx: number;
  ny: number;
  nz: number;
  /** Collision id of the box that was hit, or -1 for the ground. */
  id?: number;
}

export function makeRay(origin: Vec3, dir: Vec3): Ray {
  return { ox: origin.x, oy: origin.y, oz: origin.z, dx: dir.x, dy: dir.y, dz: dir.z };
}

export function pointOnRay(ray: Ray, t: number): Vec3 {
  return { x: ray.ox + ray.dx * t, y: ray.oy + ray.dy * t, z: ray.oz + ray.dz * t };
}

/** Slab test. Returns the entry distance (0 if the origin is inside) or -1, and the hit normal in `out`. */
export function rayAabb(ray: Ray, b: Aabb, maxT: number, out?: RayHit): number {
  let tMin = 0;
  let tMax = maxT;
  let axis = -1;
  let sign = 0;
  // The slab test, one axis at a time (unrolled: this is the hottest function of every ray).
  for (let i = 0; i < 3; i++) {
    const oi = i === 0 ? ray.ox : i === 1 ? ray.oy : ray.oz;
    const di = i === 0 ? ray.dx : i === 1 ? ray.dy : ray.dz;
    const lo = i === 0 ? b.minX : i === 1 ? b.minY : b.minZ;
    const hi = i === 0 ? b.maxX : i === 1 ? b.maxY : b.maxZ;
    if (Math.abs(di) < 1e-12) {
      if (oi < lo || oi > hi) return -1;
      continue;
    }
    let t1 = (lo - oi) / di;
    let t2 = (hi - oi) / di;
    let s = -1;
    if (t1 > t2) {
      const t = t1; t1 = t2; t2 = t;
      s = 1;
    }
    if (t1 > tMin) {
      tMin = t1;
      axis = i;
      sign = s;
    }
    if (t2 < tMax) tMax = t2;
    if (tMin > tMax) return -1;
  }
  if (out) {
    out.t = tMin;
    out.nx = axis === 0 ? sign : 0;
    out.ny = axis === 1 ? sign : 0;
    out.nz = axis === 2 ? sign : 0;
  }
  return tMin;
}

/** Returns the entry distance or -1. */
export function raySphere(ray: Ray, cx: number, cy: number, cz: number, radius: number, maxT: number): number {
  const lx = ray.ox - cx;
  const ly = ray.oy - cy;
  const lz = ray.oz - cz;
  const b = lx * ray.dx + ly * ray.dy + lz * ray.dz;
  const c = lx * lx + ly * ly + lz * lz - radius * radius;
  if (c > 0 && b > 0) return -1;
  const disc = b * b - c;
  if (disc < 0) return -1;
  const t = Math.max(0, -b - Math.sqrt(disc));
  return t <= maxT ? t : -1;
}

/** Nearest hit against the ground plane (y = 0) and every solid box (except `skip`), within `maxT`. */
export function raycastWorld(ray: Ray, world: CollisionWorld, maxT: number, skip?: { has(id: number): boolean }): RayHit | null {
  // A non-finite ray, or a NaN or negative range, hits nothing (and must not walk the grid forever).
  if (!Number.isFinite(ray.ox + ray.oz + ray.dx + ray.dz) || !(maxT >= 0)) return null;
  let best: RayHit | null = null;
  if (ray.dy < 0 && ray.oy >= 0) {
    const t = -ray.oy / ray.dy;
    if (t <= maxT) best = { t, nx: 0, ny: 1, nz: 0, id: -1 };
  }
  const hit: RayHit = { t: 0, nx: 0, ny: 0, nz: 0 };
  const seen = new Set<number>();
  // Nearest hit; an exact tie goes to the lowest id (the ground, -1, first), as a scan of every box would.
  const visit = (cx: number, cz: number): void => {
    const ids = world.cellIds(cx, cz);
    if (!ids) return;
    for (const id of ids) {
      if (seen.has(id) || skip?.has(id)) continue;
      seen.add(id);
      const t = rayAabb(ray, world.get(id)!, best ? best.t : maxT, hit);
      if (t >= 0 && (!best || t < best.t || (t === best.t && id < best.id!))) best = { ...hit, id };
    }
  };
  // Walk only the grid cells the ray crosses in XZ, nearest first (Amanatides & Woo), and stop once
  // the best hit lies before the next cell: a box is registered in every cell its footprint touches.
  let cx = Math.floor(ray.ox / CELL_SIZE), cz = Math.floor(ray.oz / CELL_SIZE);
  const stepX = ray.dx > 0 ? 1 : -1, stepZ = ray.dz > 0 ? 1 : -1;
  const flatX = Math.abs(ray.dx) < 1e-12, flatZ = Math.abs(ray.dz) < 1e-12;
  let nextX = flatX ? Infinity : ((cx + (stepX > 0 ? 1 : 0)) * CELL_SIZE - ray.ox) / ray.dx;
  let nextZ = flatZ ? Infinity : ((cz + (stepZ > 0 ? 1 : 0)) * CELL_SIZE - ray.oz) / ray.dz;
  const deltaX = flatX ? Infinity : CELL_SIZE / Math.abs(ray.dx), deltaZ = flatZ ? Infinity : CELL_SIZE / Math.abs(ray.dz);
  visit(cx, cz);
  for (;;) {
    const enter = Math.min(nextX, nextZ);
    // The slack covers rounding between this crossing distance and rayAabb's.
    if (enter > maxT + 1e-6 || (best && (best as RayHit).t < enter - 1e-6)) break;
    if (nextX === nextZ) {
      // Through a corner: the two side cells hold boxes that only touch the corner.
      visit(cx + stepX, cz); visit(cx, cz + stepZ);
      cx += stepX; cz += stepZ; nextX += deltaX; nextZ += deltaZ;
    } else if (nextX < nextZ) { cx += stepX; nextX += deltaX; }
    else { cz += stepZ; nextZ += deltaZ; }
    visit(cx, cz);
  }
  return best;
}

/** Hit volumes of a chicken, relative to its feet. */
export const HITBOX = {
  bodyRadius: 0.42,
  bodyHeight: 1.12,
  headRadius: CHICKEN_POSE.headRadius,
  headHeight: CHICKEN_POSE.headHeight,
  /** The head sits forward of the body centre, in the facing direction. */
  headForward: CHICKEN_POSE.headForward,
} as const;

export interface ChickenHit {
  t: number;
  headshot: boolean;
}

/** Ray against one chicken standing at (x, y, z) facing `yaw`; `scale` < 1 while crouched. */
export function rayChicken(ray: Ray, x: number, y: number, z: number, yaw: number, maxT: number, scale = 1, pitch = 0): ChickenHit | null {
  return rayHvhChicken(ray, x, y, z, yaw, maxT, scale, pitch);
}

/** Distance from a point to a chicken's chest (for splash damage). */
export function chestPoint(x: number, y: number, z: number): Vec3 {
  return { x, y: y + 0.7, z };
}
