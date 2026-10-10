import * as THREE from 'three';
import { TEAM_COLORS, bodyScale, damp, lerp, lerpAngle, unpackPlayer, type PlayerInfo, type PlayerState, type WeaponId, type WorldSnapshot } from '@game/shared';
import { Chicken } from './models/Chicken';
import { NameTag } from './models/NameTag';

/** Upper bound on buffered snapshots per player (~3 s at 20 Hz), e.g. while the tab is hidden. */
const MAX_BUFFER = 60;

interface Sample {
  t: number;
  s: PlayerState;
}

export class RemotePlayer {
  info: PlayerInfo;
  readonly chicken: Chicken;
  private tag: NameTag;
  /** On your team: only teammates show a name above their head (enemies don't). */
  private friendly: boolean;
  private readonly buffer: Sample[] = [];
  private readonly lastPosition = new THREE.Vector3();
  private hasRendered = false;
  private speed = 0;
  /** The most recent state (for HUD, aim checks...). */
  latest: PlayerState | null = null;
  /** Position as currently drawn. */
  readonly position = new THREE.Vector3();
  yaw = 0;
  fakeYaw = 0;
  pitch = 0;
  scale = 1;
  alive = true;
  /**
   * FaceChiken fog of war: the server stopped sending this enemy because you can't see them.
   * Hidden (and not hit-testable) until they show up again.
   */
  culled = false;

  constructor(info: PlayerInfo, friendly: boolean) {
    this.info = info;
    this.friendly = friendly;
    this.chicken = new Chicken(info.appearance, info.team);
    this.tag = new NameTag(info.name, friendly || info.team === 0 ? 0xffffff : TEAM_COLORS[info.team], info.dev);
    this.chicken.root.add(this.tag.sprite);
    // Hidden until the first snapshot tells us where it is.
    this.chicken.root.visible = false;
  }

  update(info: PlayerInfo, friendly: boolean): void {
    const nameChanged = info.name !== this.info.name || info.team !== this.info.team || info.dev !== this.info.dev;
    this.info = info;
    this.friendly = friendly;
    this.chicken.setAppearance(info.appearance);
    this.chicken.setTeam(info.team);
    if (nameChanged) {
      this.tag.dispose();
      this.tag = new NameTag(info.name, friendly || info.team === 0 ? 0xffffff : TEAM_COLORS[info.team], info.dev);
      this.chicken.root.add(this.tag.sprite);
    }
  }

  latestAt = 0;

  push(t: number, s: PlayerState): void {
    // Back in sight after fog of war: start from here, don't slide over from where we last saw them.
    if (this.culled) {
      this.culled = false;
      this.buffer.length = 0;
      this.chicken.root.visible = true;
    }
    this.latestAt = t;
    this.buffer.push({ t, s });
    this.latest = s;
    if (this.buffer.length > MAX_BUFFER) this.buffer.shift();
  }

  /** After a respawn, forget the old trail so we don't slide across the map. */
  teleport(t: number, x: number, y: number, z: number, yaw: number): void {
    const base = this.latest ?? null;
    if (!base) return;
    this.buffer.length = 0;
    this.push(t, { ...base, x, y, z, yaw, alive: true });
    this.alive = true;
    this.chicken.setDead(false);
  }

  /** Drivers are drawn in their buggy's seat instead of where the snapshot says. */
  sitAt(position: THREE.Vector3, yaw: number): void {
    this.chicken.root.position.copy(position);
    this.chicken.root.rotation.y = yaw;
    this.position.copy(position);
  }

  kill(): void {
    this.alive = false;
    this.chicken.setDead(true);
  }

  /** Renders the player as it was at `renderTime` (server clock), interpolating between snapshots. */
  render(renderTime: number, dt: number): void {
    if (this.culled) {
      this.chicken.root.visible = false;
      return;
    }
    const buf = this.buffer;
    // Drop samples we've fully moved past, keeping the one just before renderTime.
    while (buf.length >= 2 && buf[1]!.t <= renderTime) buf.shift();
    const a = buf[0];
    if (!a) return;
    const b = buf[1];
    let s = a.s;
    const root = this.chicken.root;

    if (!b || renderTime <= a.t) {
      this.position.set(s.x, s.y, s.z);
      this.yaw = s.yaw;
    } else {
      const t = (renderTime - a.t) / (b.t - a.t);
      this.position.set(lerp(a.s.x, b.s.x, t), lerp(a.s.y, b.s.y, t), lerp(a.s.z, b.s.z, t));
      this.yaw = lerpAngle(a.s.yaw, b.s.yaw, t);
      if (t >= 0.5) s = b.s;
    }
    root.position.copy(this.position);
    const fakeYaw = b && renderTime > a.t ? lerpAngle(a.s.fakeYaw ?? a.s.yaw, b.s.fakeYaw ?? b.s.yaw, (renderTime-a.t)/(b.t-a.t)) : s.fakeYaw ?? this.yaw;
    this.fakeYaw = fakeYaw;
    this.pitch = b && renderTime > a.t ? lerp(a.s.fakePitch ?? a.s.pitch, b.s.fakePitch ?? b.s.pitch, (renderTime-a.t)/(b.t-a.t)) : s.fakePitch ?? s.pitch;
    this.chicken.setAim(this.pitch);
    if (this.alive) root.rotation.y = fakeYaw;
    // Kill events or snapshots can mark a player dead; only a spawn event (teleport) revives them.
    // Otherwise the delayed, interpolated samples would briefly bring the corpse back to life.
    if (!s.alive && this.alive) this.kill();
    if (!this.chicken.isDead) root.visible = true;
    this.tag.sprite.visible = this.alive && this.friendly;
    this.tag.animate(performance.now() / 1000);
    this.chicken.setWeapon(s.weapon as WeaponId);
    this.chicken.setJetpack(s.fuel > 0, s.jetting);
    const crouchAmount = b && renderTime > a.t
      ? lerp(a.s.crouchAmount ?? (a.s.crouching ? 1 : 0),b.s.crouchAmount ?? (b.s.crouching ? 1 : 0),(renderTime-a.t)/(b.t-a.t))
      : s.crouchAmount ?? (s.crouching ? 1 : 0);
    this.scale = bodyScale({crouching:s.crouching,crouchAmount});
    this.chicken.setCrouch(s.crouching,crouchAmount);

    if (this.hasRendered && dt > 0) {
      const moved = Math.hypot(this.position.x - this.lastPosition.x, this.position.z - this.lastPosition.z);
      this.speed = damp(this.speed, moved / dt, 10, dt);
    }
    this.lastPosition.copy(this.position);
    this.hasRendered = true;
    this.chicken.animate(dt, this.speed, s.onGround);
  }

  dispose(): void {
    this.tag.dispose();
    this.chicken.dispose();
  }
}

/** Everyone except the local player, rendered slightly in the past for smooth motion. */
export class RemotePlayers {
  private readonly scene: THREE.Scene;
  readonly players = new Map<number, RemotePlayer>();

  constructor(scene: THREE.Scene) {
    this.scene = scene;
  }

  get size(): number {
    return this.players.size;
  }

  get(pid: number): RemotePlayer | undefined {
    return this.players.get(pid);
  }

  add(info: PlayerInfo, friendly: boolean): void {
    const existing = this.players.get(info.pid);
    if (existing) {
      existing.update(info, friendly);
      return;
    }
    const player = new RemotePlayer(info, friendly);
    this.players.set(info.pid, player);
    this.scene.add(player.chicken.root);
  }

  remove(pid: number): void {
    this.players.get(pid)?.dispose();
    this.players.delete(pid);
  }

  pushSnapshot(snapshot: WorldSnapshot, selfPid: number): void {
    const seen = new Set<number>();
    for (const packed of snapshot.p) {
      if (packed[0] === selfPid) continue;
      const state = unpackPlayer(packed);
      seen.add(state.pid);
      this.players.get(state.pid)?.push(snapshot.t, state);
    }
    // Players the server left out (fog of war in FaceChiken) go out of sight.
    for (const [pid, player] of this.players) if (!seen.has(pid) && player.latest) player.culled = true;
  }

  render(renderTime: number, dt: number): void {
    for (const player of this.players.values()) player.render(renderTime, dt);
  }

  dispose(): void {
    for (const player of this.players.values()) player.dispose();
    this.players.clear();
  }
}
