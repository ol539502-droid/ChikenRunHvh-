import {
  ITEMS,
  PLAYER,
  eyeHeightOf,
  SIM_DT,
  SNAPSHOT_RATE,
  SOURCE_MOVE,
  WEAPONS,
  type WeaponId,
  buildNavGraph,
  chestPoint,
  clamp,
  directionFromAngles,
  findPath,
  makeRay,
  moveSpeedFor,
  normalize,
  raycastWorld,
  wrapAngle,
  walkable,
  type Appearance,
  type InputFrame,
  type NavGraph,
  type NavPoint,
  type Vec3,
  type Team,
} from '@game/shared';
import { DEFAULT_RAGE, scanRage, unpackPlayer, defaultSkeetAntiAim, hvhWeapon, type ObservableRecord, type ShotCandidate } from '@game/shared';
import { hammerTicks, stepHammerHold } from '@game/shared/hvh/v2';
import type { BotGoal, GameRoom } from './GameRoom';
import type { ServerPlayer } from './ServerPlayer';

const NAMES = ['Clucky', 'Nugget', 'Drumstick', 'Feathers', 'Eggbert', 'Henrietta', 'Cluckington', 'Pollo', 'Rooster Ray', 'Wingman', 'Yolko', 'Popcorn', 'Scrambles', 'Kiev', 'Omelette', 'Sunny'];

/** Tuning: how human the bots feel. */
const REACTION_MS = 450;
const TURN_SPEED = 3.6;
const AIM_ERROR = 0.09;
const VISION_RANGE = 45;
const PREFERRED_MIN = 7;
const PREFERRED_MAX = 18;
/** With a melee weapon: close in to this distance, bunny hopping while further than MELEE_HOP_FROM. */
const MELEE_CLOSE = 1.2;
const MELEE_HOP_FROM = 4;
const PERCEIVE_MS = 200;
const SMOKE_BLOCK_RADIUS = 3.6;

interface Brain {
  hvhLifeState?: ServerPlayer['state'];
  hvhCandidate?: ShotCandidate | null;
  hvhNextScan?: number;
  hvhReturnUntil?: number;
  hvhAnchor?: Vec3;
  hvhNextObserve?: number;
  hvhObserved?: number[];
  /** The R8 hammer: commands sent in the current trigger hold (stepHammerHold, as the server counts), and the gun it is on. */
  hvhHammerHold?: number;
  hvhHammerWeapon?: WeaponId;
  p: ServerPlayer;
  seq: number;
  shot: number;
  throwSeq: number;
  target: ServerPlayer | null;
  trackStart: number;
  errYaw: number;
  errPitch: number;
  nextErrorRoll: number;
  waypoint: NavPoint | null;
  strafe: 1 | -1;
  strafeUntil: number;
  progressAt: number;
  progressPos: { x: number; z: number };
  jumpTicks: number;
  nextPerceive: number;
  nextSwitch: number;
  /** Route to the mode goal (ChikenBomb), recomputed now and then. */
  path: NavPoint[];
  pathGoal: NavPoint | null;
  nextPath: number;
}

function pick<T>(list: readonly T[]): T {
  return list[Math.floor(Math.random() * list.length)]!;
}

function randomAppearance(): Appearance {
  const keys = (slot: string) => ITEMS.filter((i) => i.slot === slot).map((i) => i.key);
  return { skin: pick(keys('skin')), hat: Math.random() < 0.6 ? pick(keys('hat')) : 'none', beak: pick(keys('beak')), shoes: Math.random() < 0.5 ? pick(keys('shoes')) : 'none' };
}

/** Hitchance spread samples per estimate for bot scans (players' rage uses the default 32). */
const HVH_BOT_SAMPLES = 12;

/** Server-side AI chickens. They play through the same input/fire/throw paths as humans. */
export class BotSystem {
  private readonly room: GameRoom;
  private readonly brains = new Map<number, Brain>();
  /** Waypoint links for maps that have them, built on first use. */
  private nav: NavGraph | null = null;
  /**
   * The one bot that may run an HvH rage scan this tick (scans are costly on big maps): the most
   * overdue one, so when the server runs slow every bot's scans slow down evenly and none starve.
   */
  private hvhScanner: Brain | null = null;
  private usedNames = new Set<string>();

  constructor(room: GameRoom) {
    this.room = room;
  }

  get count(): number {
    return this.brains.size;
  }

  add(): boolean {
    let name = pick(NAMES);
    for (let i = 0; i < NAMES.length && this.usedNames.has(name); i++) name = NAMES[(NAMES.indexOf(name) + 1) % NAMES.length]!;
    this.usedNames.add(name);
    const res = this.room.join(null, { userId: null, name: `🤖 ${name}`, appearance: randomAppearance(), loadout: ['rifle', 'shotgun', 'pistol'], bot: true, rank: 1 + Math.floor(Math.random() * 6) });
    if (!res.ok) return false;
    const p = this.room.players.get(res.selfPid)!;
    if (this.room.mode.id === 'hvh') {
      p.hvhEnabled = true; p.hvhPanel = 'skeet';
      p.hvh.antiAim.enabled = true; p.hvh.antiAim.desync = [22, 35, 45][p.pid % 3]!;
      p.hvh.exploit = 'off';
      p.hvh.skeet = defaultSkeetAntiAim(); p.hvh.skeet.freestanding = true;
      p.hvh.skeet.desyncMode = p.pid % 3 === 1 ? 'alternate' : 'static';
      for (const state of Object.values(p.hvh.skeet.states)) {
        state.desync = Math.min(state.desync, p.hvh.antiAim.desync); state.jitter = Math.min(state.jitter, 12);
      }
    }
    const now = performance.now();
    this.brains.set(p.pid, {
      p,
      seq: 0,
      shot: 0,
      throwSeq: 0,
      target: null,
      trackStart: 0,
      errYaw: 0,
      errPitch: 0,
      nextErrorRoll: 0,
      waypoint: null,
      strafe: Math.random() < 0.5 ? 1 : -1,
      strafeUntil: 0,
      progressAt: now,
      progressPos: { x: p.state.x, z: p.state.z },
      jumpTicks: 0,
      nextPerceive: 0,
      nextSwitch: 0,
      path: [],
      pathGoal: null,
      nextPath: 0,
    });
    return true;
  }

  /** Removes one bot (to make room for a human), from `team` if given and it has one. */
  /** Removes the newest bot (of `team`, when given); with `deadFirst`, the newest dead one if any bot is dead. */
  removeOne(team: Team = 0, deadFirst = false): boolean {
    const brains = [...this.brains.values()].filter((b) => !team || b.p.info.team === team);
    const last = (deadFirst ? brains.filter((b) => !b.p.alive).pop() : undefined) ?? brains.pop();
    if (!last) return false;
    this.brains.delete(last.p.pid);
    this.usedNames.delete(last.p.info.name.replace('🤖 ', ''));
    this.room.removePlayer(last.p);
    return true;
  }

  forget(pid: number): void {
    this.brains.delete(pid);
  }

  update(now: number): void {
    this.hvhScanner = null;
    // Only living bots reach thinkHvh's scan; a dead one must not take the slot.
    if (this.room.mode.id === 'hvh') for (const b of this.brains.values()) {
      const next = b.hvhNextScan ?? 0;
      if (b.p.alive && now >= next && (!this.hvhScanner || next < (this.hvhScanner.hvhNextScan ?? 0))) this.hvhScanner = b;
    }
    for (const b of this.brains.values()) {
      if (!this.room.players.has(b.p.pid)) {
        this.brains.delete(b.p.pid);
        continue;
      }
      this.think(b, now);
    }
  }

  // ---------------------------------------------------------------------------

  private eye(p: ServerPlayer): Vec3 {
    return { x: p.state.x, y: p.state.y + eyeHeightOf(p.state), z: p.state.z };
  }

  /** Can `p` see `target`? Walls and smoke clouds block vision. */
  private canSee(p: ServerPlayer, target: ServerPlayer): boolean {
    if (performance.now() < p.blindUntil) return false;
    const eye = this.eye(p);
    const chest = chestPoint(target.state.x, target.state.y, target.state.z);
    const dx = chest.x - eye.x;
    const dy = chest.y - eye.y;
    const dz = chest.z - eye.z;
    const dist = Math.hypot(dx, dy, dz);
    if (dist > VISION_RANGE) return false;
    if (dist < 0.01) return true;
    const dir = { x: dx / dist, y: dy / dist, z: dz / dist };
    const wall = raycastWorld(makeRay(eye, dir), this.room.world, dist - 0.3, this.room.world.seeThrough);
    if (wall) return false;
    for (const s of this.room.projectiles.activeSmokes(performance.now())) {
      // Distance from the smoke centre to the line of sight.
      const t = clamp((s.x - eye.x) * dir.x + (s.y + 1.2 - eye.y) * dir.y + (s.z - eye.z) * dir.z, 0, dist);
      const px = eye.x + dir.x * t - s.x;
      const py = eye.y + dir.y * t - (s.y + 1.2);
      const pz = eye.z + dir.z * t - s.z;
      if (Math.hypot(px, py, pz) < SMOKE_BLOCK_RADIUS) return false;
    }
    return true;
  }

  private pickTarget(b: Brain): ServerPlayer | null {
    const p = b.p;
    // Stick with a target we can still see.
    if (b.target && b.target.alive && this.room.players.has(b.target.pid) && this.canSee(p, b.target)) return b.target;
    let best: ServerPlayer | null = null;
    let bestDist = Infinity;
    for (const t of this.room.players.values()) {
      if (t === p || !t.alive || this.room.areTeammates(p, t)) continue;
      if (performance.now() < t.shieldUntil) continue;
      const d = Math.hypot(t.state.x - p.state.x, t.state.z - p.state.z);
      if (d < bestDist && this.canSee(p, t)) {
        best = t;
        bestDist = d;
      }
    }
    return best;
  }

  private newWaypoint(b: Brain): void {
    const s = pick(this.room.roamSpots());
    b.waypoint = this.room.map.mesh ? { x: s.x, y: s.y, z: s.z } : { x: s.x + (Math.random() - 0.5) * 4, z: s.z + (Math.random() - 0.5) * 4 };
  }

  private think(b: Brain, now: number): void {
    const p = b.p;
    if (!p.alive) {
      b.target = null;
      return;
    }
    if (this.room.mode.id === 'hvh') { this.thinkHvh(b, now); return; }

    if (now >= b.nextPerceive) {
      b.nextPerceive = now + PERCEIVE_MS;
      const target = this.pickTarget(b);
      if (target !== b.target) b.trackStart = now;
      b.target = target;
    }
    if (now >= b.nextErrorRoll) {
      b.nextErrorRoll = now + 400 + Math.random() * 300;
      b.errYaw = (Math.random() * 2 - 1) * AIM_ERROR;
      b.errPitch = (Math.random() * 2 - 1) * AIM_ERROR * 0.6;
    }

    let moveX = 0;
    let moveZ = 0;
    let lookYaw = p.yaw;
    let lookPitch = p.pitch;
    let jump = false;
    const target = b.target;
    const goal = this.room.botGoal(p);

    if (target) {
      const eye = this.eye(p);
      const chest = chestPoint(target.state.x, target.state.y, target.state.z);
      const dx = chest.x - eye.x;
      const dy = chest.y - eye.y;
      const dz = chest.z - eye.z;
      const flat = Math.hypot(dx, dz);
      // Aim error shrinks the longer the bot tracks the same target.
      const settle = Math.max(0.25, 1 - (now - b.trackStart) / 1500);
      const wantYaw = Math.atan2(-dx, -dz) + b.errYaw * settle;
      const wantPitch = Math.atan2(dy, flat) + b.errPitch * settle;
      lookYaw = p.yaw + clamp(wrapAngle(wantYaw - p.yaw), -TURN_SPEED * SIM_DT, TURN_SPEED * SIM_DT);
      lookPitch = p.pitch + clamp(wantPitch - p.pitch, -TURN_SPEED * SIM_DT, TURN_SPEED * SIM_DT);

      const tx = dx / (flat || 1);
      const tz = dz / (flat || 1);
      // With a melee weapon: build running momentum, then hop while closing the gap.
      const melee = WEAPONS[p.weapon].melee !== undefined;
      if (flat > (melee ? MELEE_CLOSE : PREFERRED_MAX)) {
        moveX += tx;
        moveZ += tz;
        if (melee && flat > MELEE_HOP_FROM && (!p.state.onGround || p.state.horizontalSpeed >= PLAYER.speed * 0.85)) jump = true;
      } else if (!melee && flat < PREFERRED_MIN) {
        moveX -= tx;
        moveZ -= tz;
      }
      if (now >= b.strafeUntil) {
        b.strafe = Math.random() < 0.5 ? 1 : -1;
        b.strafeUntil = now + 700 + Math.random() * 1300;
      }
      const strafe = melee ? 0.35 : 0.8;
      moveX += -tz * b.strafe * strafe;
      moveZ += tx * b.strafe * strafe;

      this.useWeapons(b, flat, Math.abs(wrapAngle(Math.atan2(-dx, -dz) - lookYaw)), now);
      // Planting / defusing: keep shooting, but don't step off the spot.
      if (goal?.use) moveX = moveZ = 0;
    } else if (goal?.use) {
      lookPitch = p.pitch * 0.9;
    } else if (goal) {
      const next = this.nextStep(b, goal, now);
      const wx = next.x - p.state.x;
      const wz = next.z - p.state.z;
      const d = Math.hypot(wx, wz);
      if (d > 0.1) {
        moveX = wx / d;
        moveZ = wz / d;
        lookYaw = p.yaw + clamp(wrapAngle(Math.atan2(-moveX, -moveZ) - p.yaw), -TURN_SPEED * SIM_DT, TURN_SPEED * SIM_DT);
      }
      lookPitch = p.pitch * 0.9;
    } else {
      if (!b.waypoint || Math.hypot(b.waypoint.x - p.state.x, b.waypoint.z - p.state.z) < 2) this.newWaypoint(b);
      const next = this.room.map.mesh ? this.nextStep(b, b.waypoint!, now) : b.waypoint!;
      const wx = next.x - p.state.x;
      const wz = next.z - p.state.z;
      const d = Math.hypot(wx, wz) || 1;
      moveX = wx / d;
      moveZ = wz / d;
      lookYaw = p.yaw + clamp(wrapAngle(Math.atan2(-moveX, -moveZ) - p.yaw), -TURN_SPEED * SIM_DT, TURN_SPEED * SIM_DT);
      lookPitch = p.pitch * 0.9;
    }

    ({ moveX, moveZ, jump } = this.recoverMovement(b, now, moveX, moveZ, jump, !target));

    // World-space movement → forward/right relative to where the bot looks.
    const fx = -Math.sin(lookYaw);
    const fz = -Math.cos(lookYaw);
    const frame: InputFrame = {
      seq: ++b.seq,
      forward: clamp(moveX * fx + moveZ * fz, -1, 1),
      right: clamp(moveX * -fz + moveZ * fx, -1, 1),
      jump: jump && (!p.state.onGround || !p.state.jumpHeld),
      yaw: wrapAngle(lookYaw),
      pitch: clamp(lookPitch, -1.2, 1.2),
      use: goal?.use === true,
    };
    this.room.handleInput(p, frame);
  }

  /** HvH bots consume the same public snapshot API as human panels, never enemy server objects. */
  private thinkHvh(b: Brain, now: number): void {
    const p = b.p, eye = this.eye(p);
    // Respawn replaces the movement state; ticks mutate it, even if no dead tick was observed.
    if (b.hvhLifeState !== p.state) {
      b.hvhLifeState = p.state;
      b.hvhAnchor = { x: p.state.x, y: p.state.y, z: p.state.z };
      b.hvhCandidate = null; b.hvhReturnUntil = b.hvhNextScan = b.hvhNextObserve = 0;
      b.hvhObserved = []; p.resolver.clear();
      b.waypoint = b.pathGoal = null; b.path = []; b.nextPath = b.jumpTicks = 0;
      b.progressAt = now; b.progressPos = { x: p.state.x, z: p.state.z };
    }
    if (now >= (b.hvhNextObserve ?? 0)) {
      b.hvhNextObserve = now + 1000 / SNAPSHOT_RATE; b.hvhObserved = [];
      for (const packed of this.room.snapshot(now, p.pid).p) {
        const s = unpackPlayer(packed);
        if (s.pid === p.pid || !s.alive || s.shielded || s.vehicle || this.room.areTeammates(p, this.room.players.get(s.pid)!)) continue;
        const r: ObservableRecord = { pid: s.pid, tick: Math.round((s.simulationTime || now) / (1000 / 64)), t: s.simulationTime || now,
          origin: { x: s.x, y: s.y, z: s.z }, velocity: { x: (s.walkVx ?? 0) + s.vx, y: s.vy, z: (s.walkVz ?? 0) + s.vz },
          eyeYaw: s.yaw, pitch: s.fakePitch ?? s.pitch, lowerBodyYaw: s.lowerBodyYaw ?? s.yaw, speed: s.horizontalSpeed, crouch: s.crouchAmount ?? (s.crouching ? 1 : 0),
          grounded: s.onGround, turnWeight: s.turnWeight ?? 0, alive: s.alive, hp: s.hp, armor: s.armor,
          fired: s.hvhRevealed ?? false, concealed: s.hvhConcealed ?? false, defensive: s.hvhDefensive ?? false,
          movementWeight: s.movementWeight, runFraction: s.runFraction, weaponSpeed: moveSpeedFor(s.weapon) };
        p.resolver.observe(r); b.hvhObserved.push(s.pid);
      }
    }
    const records = (b.hvhObserved ?? []).flatMap(pid => p.resolver.records(pid, now));
    // A due scan waits while another bot scans this tick; with nine bots that is still every ~150 ms.
    if (b === this.hvhScanner && now >= (b.hvhNextScan ?? 0)) {
      b.hvhNextScan = now + 150;
      b.hvhCandidate = scanRage({ samples: HVH_BOT_SAMPLES, now, eye, w: hvhWeapon(WEAPONS[p.weapon]), heat: p.weaponHeat, speed: p.state.horizontalSpeed, airborne: !p.state.onGround, ads: p.aiming,
        world: this.room.world, records, resolver: p.resolver, currentTarget: b.hvhCandidate?.target,
        settings: { ...DEFAULT_RAGE, hitchance: 0.6, maxRecords: 2, preferBodyBelow: 0.5, bodyAfterMisses: 2, body: 'lethal' } });
    }
    const c = b.hvhCandidate && records.some(r => r.pid === b.hvhCandidate!.target) && now - b.hvhCandidate.record.t <= 300 ? b.hvhCandidate : null;
    let x = 0, z = 0;
    if (now < (b.hvhReturnUntil ?? 0)) {
      const next = this.nextStep(b, b.hvhAnchor!, now);
      x = next.x - p.state.x; z = next.z - p.state.z;
    } else if (!c) {
      const target = records[0];
      if (target) {
        const next = this.nextStep(b, target.origin, now);
        x = next.x - p.state.x; z = next.z - p.state.z;
      }
      else {
        if (!b.waypoint || Math.hypot(b.waypoint.x - p.state.x, b.waypoint.z - p.state.z) < 2) this.newWaypoint(b);
        const next = this.nextStep(b, b.waypoint!, now); x = next.x - p.state.x; z = next.z - p.state.z;
      }
    } else if (c.stop || p.state.horizontalSpeed > 0.5) {
      x = -(p.state.walkVx ?? 0); z = -(p.state.walkVz ?? 0);
    }
    const length = Math.hypot(x, z); if (length > 0.1) { x /= length; z /= length; } else x = z = 0;
    let jump = false;
    if (!c || now < (b.hvhReturnUntil ?? 0)) {
      ({ moveX: x, moveZ: z, jump } = this.recoverMovement(b, now, x, z, false, !records.length));
    }
    const yaw = c ? Math.atan2(-c.direction.x, -c.direction.z) : p.lookYaw;
    const frame: InputFrame = { seq: ++b.seq, forward: -Math.sin(yaw) * x - Math.cos(yaw) * z,
      right: Math.cos(yaw) * x - Math.sin(yaw) * z, jump: jump && (!p.state.onGround || !p.state.jumpHeld), yaw, pitch: c ? Math.asin(c.direction.y) : 0 };
    // The R8 holds the trigger on a target for hammerTicks commands before the shot (the server counts the same commands).
    const hammer = hammerTicks(WEAPONS[p.weapon]);
    const pulling = hammer > 0 && c !== null;
    b.hvhHammerHold = stepHammerHold(b.hvhHammerWeapon === p.weapon ? b.hvhHammerHold ?? 0 : 0, pulling, WEAPONS[p.weapon]);
    b.hvhHammerWeapon = p.weapon;
    this.room.handleInput(p, pulling ? { ...frame, intent: { trigger: true } } : frame);
    if (p.mag <= 0) { this.room.handleReload(p); return; }
    if (c?.scope) p.aiming = true;
    if (c && !c.stop && !c.scope && now - c.record.t <= 300 && p.state.horizontalSpeed < 0.5 && !p.reloadUntil
      && now >= (b.hvhReturnUntil ?? 0) && now >= p.switchReadyAt && p.resource.playerTick >= p.resource.nextAttackTick
      && (hammer === 0 || b.hvhHammerHold - 1 >= hammer)) {
      const direction = normalize({ x: c.point.x - eye.x, y: c.point.y - eye.y, z: c.point.z - eye.z });
      this.room.handleFire(p, { shot: ++b.shot, command: frame.seq, weapon: p.weapon, dx: direction.x, dy: direction.y, dz: direction.z,
        t: c.record.t, aiming: p.aiming, intent: { target: c.target, source: c.source, recordT: c.record.t, yaw: c.yaw } });
      b.hvhReturnUntil = now + 400; b.hvhNextScan = 0; b.hvhHammerHold = 0;
    }
  }

  private recoverMovement(b: Brain, now: number, moveX: number, moveZ: number, jump: boolean, roaming: boolean) {
    const p = b.p;
    // Hop over low obstacles, steer around tall ones.
    const len = Math.hypot(moveX, moveZ);
    if (len > 0.01) {
      moveX /= len;
      moveZ /= len;
      const knee = makeRay({ x: p.state.x, y: p.state.y + SOURCE_MOVE.stepHeight + 0.05, z: p.state.z }, { x: moveX, y: 0, z: moveZ });
      if (raycastWorld(knee, this.room.world, 1.1)) {
        const head = makeRay({ x: p.state.x, y: p.state.y + 1.45, z: p.state.z }, { x: moveX, y: 0, z: moveZ });
        if (!raycastWorld(head, this.room.world, 1.4)) jump = true;
        else {
          [moveX, moveZ] = [-moveZ * b.strafe, moveX * b.strafe];
          if (roaming) this.newWaypoint(b);
        }
      }
    }

    // Stuck for a second while trying to move: jump and try somewhere else.
    if (now - b.progressAt > 1000) {
      const moved = Math.hypot(p.state.x - b.progressPos.x, p.state.z - b.progressPos.z);
      if (moved < 0.6 && len > 0.01) {
        b.jumpTicks = 12;
        b.strafe = b.strafe === 1 ? -1 : 1;
        this.newWaypoint(b);
        b.nextPath = 0;
      }
      b.progressAt = now;
      b.progressPos = { x: p.state.x, z: p.state.z };
    }
    if (b.jumpTicks > 0) {
      b.jumpTicks--;
      jump = true;
    }
    return { moveX, moveZ, jump };
  }

/** The next spot to walk to on the way to `goal`, following the map's waypoints around walls. */
  private nextStep(b: Brain, goal: BotGoal, now: number): NavPoint {
    const p = b.p;
    const world = this.room.world;
    if (!this.nav && this.room.map.nav) this.nav = buildNavGraph(this.room.map.nav, world, this.room.map.navLinks, this.room.map.navLinksChecked);
    const moved = !b.pathGoal || Math.hypot(b.pathGoal.x - goal.x, b.pathGoal.z - goal.z) > 2;
    if (moved || now >= b.nextPath || b.path.length === 0) {
      const from = { x: p.state.x, y: p.state.y, z: p.state.z };
      b.path = this.nav ? findPath(this.nav, from, goal, world) : [{ x: goal.x, z: goal.z }];
      b.pathGoal = { x: goal.x, y: goal.y, z: goal.z };
      b.nextPath = now + 3000;
    }
    const from = { x: p.state.x, y: p.state.y, z: p.state.z };
    while (b.path.length > 1) {
      const next = b.path[0]!;
      const distance = Math.hypot(next.x - p.state.x, next.z - p.state.z);
      const reached = distance < 0.15 && Math.abs((next.y ?? 0) - p.state.y) <= SOURCE_MOVE.stepHeight;
      if (!reached && (distance >= 0.6 || !walkable(from, b.path[1]!, world))) break;
      b.path.shift();
    }
    return b.path[0]!;
  }

  private useWeapons(b: Brain, dist: number, yawError: number, now: number): void {
    const p = b.p;
    const loadout = p.info.loadout;
    const wantShotgun = dist < PREFERRED_MIN && loadout.includes('shotgun');
    const wanted = loadout.indexOf(wantShotgun ? 'shotgun' : 'rifle');
    if (wanted >= 0 && wanted !== p.weaponSlot && now >= b.nextSwitch) {
      b.nextSwitch = now + 1500;
      this.room.handleSwitch(p, wanted);
      return;
    }
    if (p.mag <= 0) {
      this.room.handleReload(p);
      return;
    }
    const w = WEAPONS[p.weapon];
    const reacted = now - b.trackStart > REACTION_MS;
    if (reacted && yawError < 0.12 && dist < w.range * 0.8 && this.room.phase !== 'ended') {
      const dir = directionFromAngles(p.yaw, p.pitch);
      this.room.handleFire(p, { shot: ++b.shot, weapon: p.weapon, dx: dir.x, dy: dir.y, dz: dir.z, t: now, aiming: false });
    }
    // Now and then, lob an egg at mid range.
    if (p.eggs > 0 && dist > 8 && dist < 18 && reacted && Math.random() < 0.004) {
      const dir = directionFromAngles(p.yaw, p.pitch + 0.22);
      this.room.handleThrow(p, { kind: 'egg', seq: ++b.throwSeq, dx: dir.x, dy: dir.y, dz: dir.z });
    }
  }
}
