import {
  WEAPONS,
  PROJECTILES,
  SIM_DT,
  SMOKE_DURATION_MS,
  blastFalloff,
  chestPoint,
  directionFromAngles,
  makeRay,
  normalize,
  bodyScale,
  rayChicken,
  raycastWorld,
  round,
  stepProjectile,
  type ProjectileBody,
  type ProjectileDef,
  type ProjectileKind,
  type KillCause,
  type ProjectileSpawn,
  type SmokeEvent,
  type Vec3,
  FLASH,
  flashBlindMs,
} from '@game/shared';
import type { GameRoom } from './GameRoom';
import type { ServerPlayer } from './ServerPlayer';

/** The thrower can't blow themselves up on their own hand for this long. */
const OWNER_GRACE_MS = 200;

interface Projectile {
  id: number;
  kind: ProjectileKind;
  def: ProjectileDef;
  ownerPid: number;
  ownerSeq: number;
  body: ProjectileBody;
  bornAt: number;
  fuseAt: number;
  cause: KillCause;
  /** Set when it flew into a chicken (bolts use it for direct damage). */
  struck: { target: ServerPlayer; headshot: boolean } | null;
}

/** Eggs, smoke grenades and rockets: simulated here at 60 Hz, the server is the authority on where they go off. */
export class ProjectileSystem {
  private readonly room: GameRoom;
  private readonly active = new Map<number, Projectile>();
  private smokes: SmokeEvent[] = [];
  private nextId = 1;

  constructor(room: GameRoom) {
    this.room = room;
  }

  /** Launches a projectile from `origin` along `dir` and tells everyone. */
/**
   * @param cause what kills count as (thrown eggs: 'egg'; the Egg Launcher's: 'launcher')
   */
  launch(kind: ProjectileKind, owner: ServerPlayer, origin: Vec3, dir: Vec3, ownerSeq: number, now: number, speedScale = 1, cause: KillCause = kind === 'rocket' ? 'rocket' : kind === 'bolt' ? 'crossbow' : 'egg'): void {
    const def = PROJECTILES[kind];
    const d = normalize(dir);
    const speed = def.speed * speedScale;
    const p: Projectile = {
      id: this.nextId++,
      kind,
      def,
      ownerPid: owner.pid,
      ownerSeq,
      body: { x: origin.x, y: origin.y, z: origin.z, vx: d.x * speed, vy: d.y * speed + def.upBoost, vz: d.z * speed },
      bornAt: now,
      fuseAt: now + def.fuseMs,
      cause,
      struck: null,
    };
    this.active.set(p.id, p);
    this.room.io.to(this.room.channel).emit('projectile', this.toSpawn(p));
  }

  /** Projectiles in flight and smoke clouds still hanging around, for players who join mid-match. */
  joinState(now: number): { projectiles: ProjectileSpawn[]; smokes: SmokeEvent[] } {
    this.smokes = this.smokes.filter((s) => s.until > now);
    return { projectiles: [...this.active.values()].map((p) => this.toSpawn(p)), smokes: [...this.smokes] };
  }

  /** Smoke clouds still hanging in the air (bots can't see through them). */
  activeSmokes(now: number): readonly SmokeEvent[] {
    this.smokes = this.smokes.filter((s) => s.until > now);
    return this.smokes;
  }

  clear(): void {
    this.active.clear();
    this.smokes = [];
  }

  update(now: number): void {
    for (const p of this.active.values()) {
      const b = p.body;
      const prev = { x: b.x, y: b.y, z: b.z };
      let hit = stepProjectile(b, p.def, SIM_DT, this.room.world);

      if (p.def.explodeOnImpact) {
        const player = this.hitPlayer(p, prev, now);
        if (player) {
          b.x = player.point.x;
          b.y = player.point.y;
          b.z = player.point.z;
          p.struck = { target: player.target, headshot: player.headshot };
          hit = true;
        }
      }

      const far = this.room.map.halfSize + 60;
      if (Math.abs(b.x) > far || Math.abs(b.z) > far || b.y < -5 || b.y > 200) {
        this.active.delete(p.id);
        continue;
      }
      if (hit || now >= p.fuseAt) this.detonate(p, now);
    }
  }

  /** First chicken the projectile passed through this tick, if any. */
  private hitPlayer(p: Projectile, prev: Vec3, now: number): { point: Vec3; target: ServerPlayer; headshot: boolean } | null {
    const b = p.body;
    const dx = b.x - prev.x;
    const dy = b.y - prev.y;
    const dz = b.z - prev.z;
    const len = Math.hypot(dx, dy, dz);
    if (len < 1e-6) return null;
    const ray = makeRay(prev, { x: dx / len, y: dy / len, z: dz / len });
    let best = Infinity;
    let struck: { target: ServerPlayer; headshot: boolean } | null = null;
    for (const target of this.room.players.values()) {
      if (!target.alive || target.vehicle) continue;
      if (target.pid === p.ownerPid && now - p.bornAt < OWNER_GRACE_MS) continue;
      const hit = rayChicken(ray, target.state.x, target.state.y, target.state.z, target.yaw, len + p.def.radius, bodyScale(target.state), target.hvhMode ? target.fakePitch : target.pitch);
      if (hit && hit.t < best) {
        best = hit.t;
        struck = { target, headshot: hit.headshot };
      }
    }
    if (!struck) return null;
    return { point: { x: ray.ox + ray.dx * best, y: ray.oy + ray.dy * best, z: ray.oz + ray.dz * best }, ...struck };
  }

  private detonate(p: Projectile, now: number): void {
    this.active.delete(p.id);
    const { x, y, z } = p.body;
    this.room.io.to(this.room.channel).emit('explode', { id: p.id, kind: p.kind, x: round(x, 2), y: round(y, 2), z: round(z, 2) });

    if (p.kind === 'flash') {
      this.flashAt({ x, y, z }, now);
      return;
    }
    if (p.kind === 'smoke') {
      const smoke: SmokeEvent = { x: round(x, 2), y: round(y, 2), z: round(z, 2), until: now + SMOKE_DURATION_MS };
      this.smokes.push(smoke);
      this.room.io.to(this.room.channel).emit('smoke', smoke);
      return;
    }
    const owner = this.room.players.get(p.ownerPid) ?? null;
    if (p.kind === 'bolt') {
      // A crossbow bolt: no blast, just whoever it struck.
      if (p.struck) {
        const w = WEAPONS.crossbow;
        this.room.damage(p.struck.target, owner, w.damage * (p.struck.headshot ? w.headshotMultiplier : 1), p.struck.headshot, 'crossbow', { x, y, z }, now);
      }
      return;
    }
    this.blastAt({ x, y, z }, p.def, owner, p.cause, now, p.ownerPid);
  }

  /**
   * A flashbang going off: everyone who could see it (walls block it; teammates and the thrower
   * too) is blinded for longer the closer they are and the more they were looking at it.
   */
  flashAt(at: Vec3, now: number): void {
    for (const target of this.room.players.values()) {
      if (!target.alive) continue;
      const eye = this.room.eyeOf(target);
      const dx = at.x - eye.x;
      const dy = at.y - eye.y;
      const dz = at.z - eye.z;
      const dist = Math.hypot(dx, dy, dz);
      if (dist > FLASH.range) continue;
      if (dist > 0.3 && raycastWorld(makeRay(eye, { x: dx / dist, y: dy / dist, z: dz / dist }), this.room.world, dist - 0.2)) continue;
      const ms = flashBlindMs(eye, directionFromAngles(target.lookYaw, target.pitch), at);
      if (ms <= 0) continue;
      target.blindUntil = Math.max(target.blindUntil, now + ms);
      target.socket?.emit('flashed', { ms, x: round(at.x, 2), y: round(at.y, 2), z: round(at.z, 2) });
    }
  }

  /** Splash damage and knockback, blocked by walls. Also smashes loot boxes and damages cars in range. */
  blastAt(centre: Vec3, def: ProjectileDef, owner: ServerPlayer | null, cause: KillCause, now: number, ownerPid = owner?.pid ?? 0): void {
    for (const target of this.room.players.values()) {
      if (!target.alive) continue;
      const self = target.pid === ownerPid;
      if (!self && owner && this.room.areTeammates(owner, target)) continue;

      const chest = chestPoint(target.state.x, target.state.y, target.state.z);
      const dx = chest.x - centre.x;
      const dy = chest.y - centre.y;
      const dz = chest.z - centre.z;
      const dist = Math.hypot(dx, dy, dz);
      const falloff = blastFalloff(def, dist);
      if (falloff <= 0) continue;
      if (dist > 0.05) {
        const wall = raycastWorld(makeRay(centre, { x: dx / dist, y: dy / dist, z: dz / dist }), this.room.world, dist - 0.05);
        if (wall) continue;
      }

      if (!target.vehicle) {
        // Push away from the blast and pop up into the air.
        const nx = dist > 0.05 ? dx / dist : 0;
        const nz = dist > 0.05 ? dz / dist : 0;
        const push = def.knockback * falloff;
        target.state.vx += nx * push;
        target.state.vz += nz * push;
        target.state.vy = Math.max(target.state.vy, push * 0.55);
        target.state.onGround = false;
      }

      const amount = def.damage * falloff * (self ? def.selfDamageScale : 1);
      this.room.damage(target, owner, amount, false, cause, centre, now);
    }

    this.room.loot.blast(centre, def.splashRadius, now);
    this.room.onBlast(centre, def.splashRadius, def.damage, owner, now);
  }

  private toSpawn(p: Projectile): ProjectileSpawn {
    const b = p.body;
    return {
      id: p.id,
      kind: p.kind,
      owner: p.ownerPid,
      ownerSeq: p.ownerSeq,
      x: round(b.x, 3),
      y: round(b.y, 3),
      z: round(b.z, 3),
      vx: round(b.vx, 3),
      vy: round(b.vy, 3),
      vz: round(b.vz, 3),
    };
  }
}
