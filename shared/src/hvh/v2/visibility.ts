import type { CollisionWorld } from '../../collision';
import type { Vec3 } from '../../math';
import { makeRay, raycastWorld } from '../../raycast';
import { chickenHeadCenter } from '../../chickenPose';
import { buildHvhMatrix } from '../geometry';
import { unpackPlayer, type PackedPlayer } from '../../protocol';

/** `yaw` is the body yaw the hitboxes face (default 0); only the head point depends on it. */
export interface SightTarget { x: number; y: number; z: number; crouch: number; yaw?: number }

// Head and chest centres of an unscaled chicken at the origin. buildHvhMatrix scales every centre
// linearly about the origin, so `origin + offset * scale` is its centre without rebuilding the
// whole skeleton per enemy per command. The chest sits on the axis (yaw-independent); the head
// is offset forward, so it is placed per enemy yaw as buildHvhMatrix does (chickenHeadCenter).
const ORIGIN: Vec3 = { x: 0, y: 0, z: 0 };
const CHEST_OFFSET = buildHvhMatrix(ORIGIN, 0).boxes.find(b => b.group === 'chest')!.center;

/**
 * The sight targets a snapshot shows its viewer (R56): every living player in it that `isEnemy`
 * accepts, at its public position, crouch and yaw (the eye yaw; the body yaw is never sent). The
 * client predicts sight from its latest snapshot and the server traces the list of the snapshot
 * the command names, so both run enemyVisible on the same numbers.
 */
export function snapshotSightTargets(players: readonly PackedPlayer[], isEnemy: (pid: number) => boolean): SightTarget[] {
  const targets: SightTarget[] = [];
  for (const packed of players) {
    const s = unpackPlayer(packed);
    if (s.alive && isEnemy(s.pid)) targets.push({ x: s.x, y: s.y, z: s.z, crouch: s.crouchAmount ?? (s.crouching ? 1 : 0), yaw: s.yaw });
  }
  return targets;
}

/**
 * Whether any enemy is in actual line of sight from `eye`: its head or chest point (crouch scale as
 * in rage.ts, the head turned to the enemy's yaw) with no world box before it. Ignores the HvH
 * wallhack by design, and player clips (`world.seeThrough`) do not block sight. At most two
 * raycasts per enemy; stops at the first one seen.
 */
export function enemyVisible(eye: Vec3, enemies: readonly SightTarget[], world: CollisionWorld): boolean {
  for (const e of enemies) {
    const scale = 1 - e.crouch * 0.3;
    for (const o of [chickenHeadCenter(ORIGIN, e.yaw ?? 0), CHEST_OFFSET]) {
      const dx = e.x + o.x * scale - eye.x, dy = e.y + o.y * scale - eye.y, dz = e.z + o.z * scale - eye.z;
      const dist = Math.hypot(dx, dy, dz);
      if (dist === 0) return true;
      const dir = { x: dx / dist, y: dy / dist, z: dz / dist };
      if (!raycastWorld(makeRay(eye, dir), world, dist, world.seeThrough)) return true;
    }
  }
  return false;
}

/**
 * One viewer's last enemyVisible, kept for the next call (M6): the same eye, the same targets (by
 * value, Object.is) and the same world (unchanged CollisionWorld.revision; player clips are fixed
 * with the map) give the same answer, so a player standing still against still enemies (a choke
 * batch, the on-peek watch every command) traces once. Answers are exactly enemyVisible's.
 */
export class SightMemo {
  private eye: Vec3 | null = null;
  private targets: SightTarget[] = [];
  private world: CollisionWorld | null = null;
  private revision = -1;
  private result = false;
  /** enemyVisible calls made (tests and profiling). */
  traces = 0;

  visible(eye: Vec3, enemies: readonly SightTarget[], world: CollisionWorld): boolean {
    if (this.eye && this.world === world && this.revision === world.revision && sameVec(this.eye, eye) && sameTargets(this.targets, enemies)) return this.result;
    this.traces++;
    this.eye = { x: eye.x, y: eye.y, z: eye.z };
    this.targets = enemies.map((e) => ({ ...e }));
    this.world = world;
    this.revision = world.revision;
    return (this.result = enemyVisible(eye, enemies, world));
  }
}

function sameVec(a: Vec3, b: Vec3): boolean {
  return Object.is(a.x, b.x) && Object.is(a.y, b.y) && Object.is(a.z, b.z);
}

function sameTargets(a: readonly SightTarget[], b: readonly SightTarget[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const p = a[i]!, q = b[i]!;
    if (!sameVec(p, q) || !Object.is(p.crouch, q.crouch) || !Object.is(p.yaw ?? 0, q.yaw ?? 0)) return false;
  }
  return true;
}
