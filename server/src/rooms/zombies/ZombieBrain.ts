import {
  BLOCK_ID_BASE,
  SIM_DT,
  ZOMBIE,
  buildNavGraph,
  chestPoint,
  clamp,
  eyeHeightOf,
  findPath,
  makeRay,
  raycastWorld,
  walkable,
  wrapAngle,
  type CollisionWorld,
  type InputFrame,
  type MapDef,
  type NavGraph,
  type NavPoint,
  type ZombieKind,
  type ZombieStats,
} from '@game/shared';
import type { ServerPlayer } from '../ServerPlayer';

/** How fast a zombie turns to face what it is chasing (radians per second). */
const TURN_SPEED = 7;
/** The way is rechecked this often (ms); in between a zombie keeps its heading. */
const THINK_MS = 260;
/** Waypoint routes are recomputed this often (ms). */
const PATH_MS = 1500;

/** One zombie: the chicken that is its body, and what the AI remembers about it. */
export interface Zombie {
  p: ServerPlayer;
  kind: ZombieKind;
  stats: ZombieStats;
  /** Its real health (the body's `hp` is its share of this, 0–100). */
  maxHp: number;
  wave: number;
  /** Takes a curved route to come at the survivors from the side (late waves). */
  flank: 1 | -1 | 0;
  flanking: boolean;
  seq: number;
  shot: number;
  strafe: 1 | -1;
  nextThink: number;
  heading: { x: number; z: number };
  path: NavPoint[];
  pathTarget: NavPoint | null;
  nextPath: number;
  nextAttack: number;
  progressAt: number;
  progressPos: { x: number; z: number };
  jumpTicks: number;
  /** Boss: when the next ground slam may start, and when the one in progress lands. */
  nextSlam: number;
  slamAt: number;
  summoned: boolean;
  /** When it died (to remove the body after a moment). */
  diedAt: number | null;
}

/** What the AI needs from the room. */
export interface ZombieHost {
  readonly world: CollisionWorld;
  readonly map: MapDef;
  /** Survivors who are alive. */
  survivors(): ServerPlayer[];
  input(p: ServerPlayer, frame: InputFrame): void;
  /** A melee swing along `dir` (the room's normal fire path). */
  swing(z: Zombie, dir: { x: number; y: number; z: number }, now: number): void;
  /** A zombie is chewing on a player-built block. */
  hitBlock(blockId: number, damage: number): void;
  /** Boss: the ground slam lands. */
  slam(z: Zombie, now: number): void;
  /** Boss: calls more zombies. */
  summon(z: Zombie, now: number): void;
}

/**
 * Zombie behaviour. Wave 1–2: walk straight at the nearest survivor, steering round things.
 * From wave 3: when a wall is in the way, follow waypoints round it. From wave 6: some zombies
 * circle round to come from the side. Bosses slam the ground. Anything blocking the way that a
 * survivor built gets attacked.
 */
export class ZombieBrain {
  private nav: NavGraph | null = null;

  constructor(private readonly host: ZombieHost) {}

  update(z: Zombie, now: number): void {
    const p = z.p;
    if (!p.alive) return;
    const survivors = this.host.survivors();
    if (survivors.length === 0) return;

    // The nearest survivor.
    let target = survivors[0]!;
    let best = Infinity;
    for (const s of survivors) {
      const d = Math.hypot(s.state.x - p.state.x, s.state.z - p.state.z);
      if (d < best) {
        best = d;
        target = s;
      }
    }
    const dx = target.state.x - p.state.x;
    const dz = target.state.z - p.state.z;
    const dist = Math.hypot(dx, dz) || 1e-6;

    // A boss: the slam winds up (standing still), then lands; at half health it calls help.
    let frozen = false;
    if (z.kind === 'boss') {
      frozen = this.boss(z, dist, now);
    }

    if (now >= z.nextThink) {
      z.nextThink = now + THINK_MS;
      z.heading = this.chooseHeading(z, target, dist, now);
    }

    let moveX = frozen ? 0 : z.heading.x;
    let moveZ = frozen ? 0 : z.heading.z;
    let jump = false;

    // In reach: stop and hit.
    const eye = { x: p.state.x, y: p.state.y + eyeHeightOf(p.state), z: p.state.z };
    const chest = chestPoint(target.state.x, target.state.y, target.state.z);
    const aim = { x: chest.x - eye.x, y: chest.y - eye.y, z: chest.z - eye.z };
    const aimLen = Math.hypot(aim.x, aim.y, aim.z) || 1;
    if (dist <= z.stats.reach && !frozen) {
      // Stand at arm's length (players aren't solid, but a swing needs them in front).
      const gap = z.stats.reach * 0.7;
      moveX = dist > gap ? (dx / dist) * 0.25 : dist < gap * 0.6 ? -(dx / dist) * 0.5 : 0;
      moveZ = dist > gap ? (dz / dist) * 0.25 : dist < gap * 0.6 ? -(dz / dist) * 0.5 : 0;
      if (now >= z.nextAttack) {
        z.nextAttack = now + z.stats.attackMs;
        this.host.swing(z, { x: aim.x / aimLen, y: aim.y / aimLen, z: aim.z / aimLen }, now);
      }
    }

    // Steering: hop over low things; chew through blocks; go round tall things.
    const len = Math.hypot(moveX, moveZ);
    if (len > 0.01 && !frozen) {
      moveX /= len;
      moveZ /= len;
      const knee = raycastWorld(makeRay({ x: p.state.x, y: p.state.y + 0.4, z: p.state.z }, { x: moveX, y: 0, z: moveZ }), this.host.world, 1.1);
      if (knee) {
        if (knee.id !== undefined && knee.id >= BLOCK_ID_BASE) {
          // A wall the survivors built: bite it.
          if (now >= z.nextAttack) {
            z.nextAttack = now + z.stats.attackMs;
            this.host.hitBlock(knee.id - BLOCK_ID_BASE, z.stats.damage * (z.kind === 'boss' ? 2 : 1));
          }
          moveX *= 0.15;
          moveZ *= 0.15;
        } else {
          const head = raycastWorld(makeRay({ x: p.state.x, y: p.state.y + 1.45, z: p.state.z }, { x: moveX, y: 0, z: moveZ }), this.host.world, 1.4);
          if (!head) jump = true;
          else {
            [moveX, moveZ] = [-moveZ * z.strafe, moveX * z.strafe];
          }
        }
      }
    }

    // Stuck for a second: wiggle free, and pick the route again.
    if (now - z.progressAt > 1000) {
      const moved = Math.hypot(p.state.x - z.progressPos.x, p.state.z - z.progressPos.z);
      if (moved < 0.5 && len > 0.01 && dist > z.stats.reach) {
        z.jumpTicks = 10;
        z.strafe = z.strafe === 1 ? -1 : 1;
        z.nextPath = 0;
        z.nextThink = 0;
      }
      z.progressAt = now;
      z.progressPos = { x: p.state.x, z: p.state.z };
    }
    if (z.jumpTicks > 0) {
      z.jumpTicks--;
      jump = true;
    }

    // Face the survivor (or where it is going), turning at a limited speed.
    const faceYaw = dist <= z.stats.reach + 1 || frozen ? Math.atan2(-dx, -dz) : Math.atan2(-moveX || -dx, -moveZ || -dz);
    const yaw = p.yaw + clamp(wrapAngle(faceYaw - p.yaw), -TURN_SPEED * SIM_DT, TURN_SPEED * SIM_DT);
    const fx = -Math.sin(yaw);
    const fz = -Math.cos(yaw);
    this.host.input(p, {
      seq: ++z.seq,
      forward: clamp(moveX * fx + moveZ * fz, -1, 1),
      right: clamp(moveX * -fz + moveZ * fx, -1, 1),
      jump: jump && (!p.state.onGround || !p.state.jumpHeld),
      yaw: wrapAngle(yaw),
      pitch: clamp(Math.atan2(aim.y, Math.hypot(aim.x, aim.z)), -1.2, 1.2),
    });
  }

  // ---------------------------------------------------------------------------

  /** Which way to walk (a unit vector), decided a few times a second. */
  private chooseHeading(z: Zombie, target: ServerPlayer, dist: number, now: number): { x: number; z: number } {
    const p = z.p;
    const from = { x: p.state.x, z: p.state.z };
    let goal: NavPoint = { x: target.state.x, z: target.state.z };

    // Late waves: some zombies circle round to the side before closing in.
    if (z.flank !== 0 && z.flanking) {
      if (dist < ZOMBIE.smart.flankDistance * 0.7) z.flanking = false;
      else {
        const ux = (from.x - goal.x) / dist;
        const uz = (from.z - goal.z) / dist;
        goal = { x: goal.x + -uz * z.flank * ZOMBIE.smart.flankDistance, z: goal.z + ux * z.flank * ZOMBIE.smart.flankDistance };
      }
    }

    // From wave 3: with a wall in the way, follow waypoints round it.
    if (z.wave >= ZOMBIE.smart.pathFromWave && !walkable(from, goal, this.host.world)) {
      this.nav ??= this.host.map.nav ? buildNavGraph(this.host.map.nav, this.host.world) : null;
      if (this.nav) {
        const moved = !z.pathTarget || Math.hypot(z.pathTarget.x - goal.x, z.pathTarget.z - goal.z) > 3;
        if (moved || now >= z.nextPath || z.path.length === 0) {
          z.path = findPath(this.nav, from, goal, this.host.world);
          z.pathTarget = goal;
          z.nextPath = now + PATH_MS;
        }
        while (z.path.length > 1 && Math.hypot(z.path[0]!.x - from.x, z.path[0]!.z - from.z) < 2) z.path.shift();
        goal = z.path[0] ?? goal;
      }
    } else {
      z.path = [];
    }

    const gx = goal.x - from.x;
    const gz = goal.z - from.z;
    const gl = Math.hypot(gx, gz) || 1;
    return { x: gx / gl, z: gz / gl };
  }

  /** Boss behaviour. Returns true while it should stand still (the slam winding up). */
  private boss(z: Zombie, dist: number, now: number): boolean {
    const slam = ZOMBIE.boss.slam;
    if (z.slamAt > 0) {
      if (now >= z.slamAt) {
        z.slamAt = 0;
        z.nextSlam = now + slam.everyMs;
        this.host.slam(z, now);
        return false;
      }
      return true;
    }
    if (!z.summoned && z.p.hp <= 100 * ZOMBIE.boss.summon.atHp) {
      z.summoned = true;
      this.host.summon(z, now);
    }
    if (now >= z.nextSlam && dist < slam.radius + 2.5) {
      z.slamAt = now + slam.windupMs;
      return true;
    }
    return false;
  }
}
