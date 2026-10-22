import {
  BLOCK_ID_BASE,
  MONKEYS,
  DEFAULT_MODS,
  SIM_DT,
  ZOMBIE,
  buildNavGraph,
  createCollisionWorld,
  chestPoint,
  clamp,
  eyeHeightOf,
  findPath,
  makeRay,
  raycastWorld,
  sanitizeMods,
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
import type { MonkeyData, MonkeyMind } from './MonkeyMind';

/** How fast a zombie turns to face what it is chasing (radians per second). */
const TURN_SPEED = 7;
/** The way is rechecked this often (ms); in between a zombie keeps its heading. */
const THINK_MS = 260;
/** Waypoint routes are recomputed this often (ms). */
const PATH_MS = 1500;
/** Within this range a zombie closes in from its own side, at most this far round from you. */
const SURROUND_RANGE = 10;
const SURROUND_RADIUS = 2.4;
/** Stuck twice: waypoints only, for this long. */
const FORCE_PATH_MS = 3500;
/** Hunters count the zombies this close to each survivor. */
const HUNT_CROWD_RANGE = 12;
/** A runner's second swipe comes this long after the first. */
const RUNNER_FOLLOW_UP_MS = 170;

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
  /** Sprinter: the burst in progress ends at `sprintUntil`; the next may start at `nextSprint`. */
  sprintUntil: number;
  nextSprint: number;
  /** Which way round it closes in (radians from the way it came, about ±1.6). */
  side: number;
  /** Goes for the survivor with the fewest zombies on them (hunts the ones who hide). */
  hunter: boolean;
  targetPid: number;
  /** Reeling from a hit until then (no attacks, barely moves). */
  staggerUntil: number;
  /** Times in a row it got stuck, and until when it only follows waypoints. */
  stuck: number;
  forcePathUntil: number;
  /** Runner: the second swipe. */
  followUpAt: number;
  /** When everyone was last told it flinched. */
  lastFlinchAt: number;
  /** Exploder: when its lit fuse runs out (0 = not lit), and whether it has burst. */
  fuseAt: number;
  burst?: boolean;
  /** Monkey (story events): what it's doing (see MonkeyMind). */
  monkey?: MonkeyData;
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
  /** Every zombie in the room. */
  zombies(): Iterable<Zombie>;
  /** Exploder: the fuse is lit (everyone hears it). */
  fuse(z: Zombie): void;
  /** Exploder: it bursts. */
  burst(z: Zombie, now: number): void;
  /** Monkeys (story events): where they go and how fast (MonkeyMind). */
  monkeyMind?: MonkeyMind;
}

/**
 * Waypoint graphs, one per map, linked over the map's own boxes only (blocks the survivors
 * build come and go; zombies chew through those). Built once, on the first room of the map.
 */
const NAV_GRAPHS = new Map<MapDef['id'], NavGraph | null>();

function navGraph(map: MapDef): NavGraph | null {
  if (!NAV_GRAPHS.has(map.id)) NAV_GRAPHS.set(map.id, map.nav ? buildNavGraph(map.nav, createCollisionWorld(map), map.navLinks, map.navLinksChecked) : null);
  return NAV_GRAPHS.get(map.id)!;
}

/**
 * Zombie behaviour. Walk at the nearest survivor, steering round things; when a wall is in the
 * way, follow waypoints round it. From wave 6: some zombies circle round to come from the side.
 * Sprinters shamble, then sprint in short bursts when close. Bosses slam the ground. Anything
 * blocking the way that a survivor built gets attacked.
 */
export class ZombieBrain {
  private readonly nav: NavGraph | null;

  /** Routes still allowed this tick (see beginTick). */
  private pathBudget: number = MONKEYS.pathsPerTick;

  constructor(private readonly host: ZombieHost) {
    this.nav = navGraph(host.map);
  }

  /** Once per server tick, before the zombies think. */
  beginTick(): void {
    this.pathBudget = MONKEYS.pathsPerTick;
  }

  update(z: Zombie, now: number): void {
    const p = z.p;
    if (!p.alive) return;
    const survivors = this.host.survivors();
    if (survivors.length === 0) return;

    // Hunters go for whoever has the fewest zombies on them (the one hiding away from the
    // fight), picked again now and then; everyone else for the nearest survivor.
    if (z.hunter && now >= z.nextThink) z.targetPid = this.loneliest(survivors, z)?.pid ?? 0;
    let target = (z.hunter && survivors.find((s) => s.pid === z.targetPid)) || survivors[0]!;
    if (!z.hunter) {
      let best = Infinity;
      for (const s of survivors) {
        const d = Math.hypot(s.state.x - p.state.x, s.state.z - p.state.z);
        if (d < best) {
          best = d;
          target = s;
        }
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
    if (z.kind === 'sprinter') this.sprint(z, dist, now);
    // Exploder: in reach, it lights its fuse; when the fuse runs out, it bursts.
    if (z.kind === 'exploder') {
      if (z.fuseAt === 0 && dist <= z.stats.reach + 0.4) {
        z.fuseAt = now + ZOMBIE.exploder.fuseMs;
        this.host.fuse(z);
      } else if (z.fuseAt > 0 && now >= z.fuseAt) {
        this.host.burst(z, now);
        return;
      }
    }
    // Just shot: it reels for a moment (longer after a headshot), and can't hit back.
    const staggered = now < z.staggerUntil;
    // Monkeys: MonkeyMind decides where they go (null: straight for you, with the pack's flanking).
    const lurkAt: NavPoint | null = z.kind === 'monkey' && this.host.monkeyMind ? this.host.monkeyMind.update(z, target, dist, now, now >= z.nextThink, staggered) : null;

    if (now >= z.nextThink) {
      z.nextThink = now + THINK_MS;
      const away = lurkAt ? Math.hypot(lurkAt.x - p.state.x, lurkAt.z - p.state.z) : 0;
      if (!lurkAt) z.heading = this.chooseHeading(z, target, dist, now);
      else if (away <= 1) z.heading = { x: 0, z: 0 };
      // Up in the ceiling: straight over the tiles to the hole (the waypoints are down below).
      else if (z.monkey?.state === 'ceiling') z.heading = { x: (lurkAt.x - p.state.x) / away, z: (lurkAt.z - p.state.z) / away };
      else z.heading = this.chooseHeading(z, target, dist, now, lurkAt);
    }

    const pace = staggered ? 0.2 : 1;
    let moveX = frozen ? 0 : z.heading.x * pace;
    let moveZ = frozen ? 0 : z.heading.z * pace;
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
      const dir = { x: aim.x / aimLen, y: aim.y / aimLen, z: aim.z / aimLen };
      if (now >= z.nextAttack && !staggered && z.kind !== 'exploder') {
        z.nextAttack = now + z.stats.attackMs;
        this.host.swing(z, dir, now);
        // Runners claw twice in quick succession.
        if (z.kind === 'runner') z.followUpAt = now + RUNNER_FOLLOW_UP_MS;
      } else if (z.followUpAt > 0 && now >= z.followUpAt) {
        z.followUpAt = 0;
        if (!staggered) this.host.swing(z, dir, now);
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
      if (moved < 0.5 && len > 0.01 && dist > z.stats.reach && !staggered) {
        z.jumpTicks = 10;
        z.strafe = z.strafe === 1 ? -1 : 1;
        z.nextPath = 0;
        z.nextThink = 0;
        // Stuck twice running: stop trusting the straight line, follow the waypoints for a while.
        if (++z.stuck >= 2) z.forcePathUntil = now + FORCE_PATH_MS;
      } else if (moved >= 0.5) z.stuck = 0;
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
  /** `goalAt`: walk there instead of at the target (a monkey going back to its lair). */
  private chooseHeading(z: Zombie, target: ServerPlayer, dist: number, now: number, goalAt?: NavPoint): { x: number; z: number } {
    const p = z.p;
    const from = { x: p.state.x, y: p.state.y, z: p.state.z };
    let goal: NavPoint = goalAt ?? { x: target.state.x, y: target.state.y, z: target.state.z };
    if (goalAt) dist = Infinity;

    // Late waves: some zombies circle round to the side before closing in.
    if (z.flank !== 0 && z.flanking && !goalAt) {
      if (dist < ZOMBIE.smart.flankDistance * 0.7) z.flanking = false;
      else {
        const ux = (from.x - goal.x) / dist;
        const uz = (from.z - goal.z) / dist;
        goal = { x: goal.x + -uz * z.flank * ZOMBIE.smart.flankDistance, y: goal.y, z: goal.z + ux * z.flank * ZOMBIE.smart.flankDistance };
      }
    }

    // Close in from its own side (fanned round the way it came), so a crowd surrounds you
    // instead of queueing up behind each other.
    if (dist < SURROUND_RANGE && dist > z.stats.reach * 0.8) {
      const a = Math.atan2(from.z - goal.z, from.x - goal.x) + z.side;
      const r = Math.min(SURROUND_RADIUS, dist * 0.45);
      const ring = { x: goal.x + Math.cos(a) * r, y: goal.y, z: goal.z + Math.sin(a) * r };
      if (walkable(from, ring, this.host.world)) goal = ring;
    }

    // With a wall in the way (or after getting stuck), follow waypoints round it.
    const forced = now < z.forcePathUntil;
    if (z.wave >= ZOMBIE.smart.pathFromWave && (forced || !walkable(from, goal, this.host.world))) {
      if (this.nav) {
        const moved = !z.pathTarget || Math.hypot(z.pathTarget.x - goal.x, z.pathTarget.z - goal.z) > 3;
        // Only a few routes are worked out per tick (all zombies together); the rest wait a tick.
        if ((moved || now >= z.nextPath || z.path.length === 0) && this.pathBudget > 0) {
          this.pathBudget--;
          z.path = findPath(this.nav, from, goal, this.host.world, !forced);
          z.pathTarget = goal;
          z.nextPath = now + PATH_MS;
        }
        // Reached a waypoint, or the next one is already in a straight line: on to the next.
        while (z.path.length > 1 && (Math.hypot(z.path[0]!.x - from.x, z.path[0]!.z - from.z) < 1 || (!forced && walkable(from, z.path[1]!, this.host.world)))) z.path.shift();
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

  /** The survivor with the fewest zombies near them (ties: the closest one to `z`). */
  private loneliest(survivors: readonly ServerPlayer[], z: Zombie): ServerPlayer | undefined {
    let best: ServerPlayer | undefined;
    let bestScore = Infinity;
    for (const s of survivors) {
      let crowd = 0;
      for (const o of this.host.zombies()) {
        if (o !== z && o.p.alive && Math.hypot(o.p.state.x - s.state.x, o.p.state.z - s.state.z) < HUNT_CROWD_RANGE) crowd++;
      }
      // A zombie counts for 1000 m: the crowd decides, distance only breaks ties.
      const score = crowd * 1000 + Math.hypot(s.state.x - z.p.state.x, s.state.z - z.p.state.z);
      if (score < bestScore) {
        bestScore = score;
        best = s;
      }
    }
    return best;
  }

  /** Sprinter: a burst of speed now and then, when close enough to see its prey. */
  private sprint(z: Zombie, dist: number, now: number): void {
    const s = ZOMBIE.sprint;
    const sprinting = now < z.sprintUntil;
    if (!sprinting && now >= z.nextSprint && dist < s.within && dist > z.stats.reach) {
      z.sprintUntil = now + s.burstMs;
      z.nextSprint = z.sprintUntil + s.restMs[0] + Math.random() * (s.restMs[1] - s.restMs[0]);
      z.p.mods = sanitizeMods({ speed: s.speed }, DEFAULT_MODS);
      // Close already: it leaps out of the dark at you.
      if (dist < s.leapWithin) z.jumpTicks = 8;
    } else if (!sprinting && z.p.mods?.speed !== z.stats.speed) {
      z.p.mods = sanitizeMods({ speed: z.stats.speed }, DEFAULT_MODS);
    }
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
