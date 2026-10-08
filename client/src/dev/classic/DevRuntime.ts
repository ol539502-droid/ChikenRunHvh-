import * as THREE from 'three';
import { CROUCH, HITBOX, PLAYER, SIM_DT, airStrafeInput, moveSpeedFor, makeRay, normalize, raycastWorld, wrapAngle, type InputFrame, type Vec3 } from '@game/shared';
import { baseFov } from '../../game/CameraRig';
import type { DevHooks, GameSession } from '../../game/GameSession';
import type { RemotePlayer } from '../../game/RemotePlayers';
import type { Dev } from './Dev';
import { DevDebug3D } from './DevDebug3D';
import { DevOverlay } from './DevOverlay';

const PITCH_MIN = -1.25;
const PITCH_MAX = 1.1;
const DEG = Math.PI / 180;
/** Rage aim waits this long before moving to a new target when instant switching is off. */
const SWITCH_DELAY_MS = 350;
const JUMP_BUFFER_MS = 160;
const FREECAM_SPEED = 14;

/** Draws only where something is in front (GreaterDepth): the hidden parts of a chicken. */
function xrayMaterial(): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({ depthFunc: THREE.GreaterDepth, depthWrite: false, fog: false, blending: THREE.AdditiveBlending, toneMapped: false });
}

export interface Candidate {
  pid: number;
  r: RemotePlayer;
  point: THREE.Vector3;
  /** Angle from the crosshair, radians. */
  angle: number;
  distance: number;
  hp: number;
  visible: boolean;
}

/**
 * The gameplay side of the developer tools, plugged into the match through DevHooks.
 * Does nothing unless the server has confirmed developer access in this room.
 */
export class DevRuntime implements DevHooks {
  private readonly dev: Dev;
  readonly overlay: DevOverlay;
  private debug3d: DevDebug3D | null = null;
  private session: GameSession | null = null;

  // Aim state.
  private legitPid = 0;
  private legitSince = 0;
  private ragePid = 0;
  private rageSwitchAt = 0;
  private rageAim: Vec3 | null = null;
  private triggerSince = 0;
  private triggerReady = false;
  private pulse = false;

  // Movement helpers.
  private lastJump = false;
  private jumpBufferUntil = 0;
  private lastYaw = 0;

  // Wallhack: one shared silhouette material, recoloured from the config.
  private readonly xrayEnemy = xrayMaterial();
  private readonly xrayTeam = xrayMaterial();

  // Spin bot.
  private spinYaw = 0;
  private spinning: { yaw: number; pitch: number } | null = null;

  // Cameras.
  private freeCamActive = false;
  private readonly freePos = new THREE.Vector3();
  private anchorYaw = 0;
  private anchorPitch = 0;
  /** pid being spectated (0 = none). */
  spectatePid = 0;
  private lastFireDown = false;
  private lastSpectatorMode = false;

  private readonly v1 = new THREE.Vector3();
  private readonly v2 = new THREE.Vector3();

  constructor(dev: Dev) {
    this.dev = dev;
    this.overlay = new DevOverlay(dev);
  }

  get currentSession(): GameSession | null {
    return this.session;
  }

  private get active(): boolean {
    return this.dev.active && this.session !== null;
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  attach(session: GameSession): void {
    this.session = session;
    this.debug3d = new DevDebug3D(session);
    this.reset();
    this.dev.sessionStarted();
  }

  detach(session: GameSession): void {
    if (this.session !== session) return;
    this.debug3d?.dispose();
    this.debug3d = null;
    this.session = null;
    this.overlay.clear();
    this.reset();
    this.dev.sessionEnded();
  }

  private reset(): void {
    this.spinning = null;
    this.legitPid = this.ragePid = this.spectatePid = 0;
    this.rageAim = null;
    this.triggerReady = false;
    this.freeCamActive = false;
  }

  /** The server confirmed (or withdrew) our modifiers: predict with exactly those. */
  applyServerMods(): void {
    const s = this.session;
    if (!s) return;
    const mods = this.dev.active ? this.dev.status.mods : null;
    s.local.mods = mods;
    s.weapons.mods = mods;
  }

  // ---------------------------------------------------------------------------
  // Hooks
  // ---------------------------------------------------------------------------

  beforeFrame(session: GameSession, _dt: number, now: number): void {
    const c = this.dev.config;
    const input = this.dev.input;
    session.weapons.forceAutomatic = this.active && c.rage.weapon.automatic;
    this.applyHud();
    if (!this.active || !session.local.alive) {
      this.ragePid = this.legitPid = 0;
      this.rageAim = null;
      this.triggerReady = false;
      this.updateCameraModes(session, false);
      return;
    }
    this.updateCameraModes(session, true);
    if (this.freeCamActive || this.spectatePid) {
      // Clicking while spectating moves on to the next player.
      const down = input.firing;
      if (this.spectatePid && down && !this.lastFireDown) this.spectatePid = this.nextSpectateTarget(session, this.spectatePid);
      this.lastFireDown = down;
      return;
    }

    this.updateRage(session, now);
    if (!c.rage.aim.enabled) this.updateLegit(session, _dt, now);
    this.updateTrigger(session, now);
  }

  modifyFrame(session: GameSession, frame: InputFrame): InputFrame {
    // `active` is already off in HvH and ranked (the server decides); an extra HvH-only check here
    // left anti-aim and the movement helpers dead everywhere.
    if (!this.active) return frame;
    const c = this.dev.config;
    const s = session.local.state;

    if (this.freeCamActive || this.spectatePid) {
      if (this.freeCamActive) this.moveFreeCam(frame);
      // The chicken stays where it is, facing where it was.
      return { ...frame, forward: 0, right: 0, jump: false, yaw: this.anchorYaw, pitch: this.anchorPitch };
    }

    const out = { ...frame };
    const moving = out.forward !== 0 || out.right !== 0;
    const now = performance.now();

    if (c.legit.move.jumpAssist) {
      // Jump pressed just before landing still counts.
      if (frame.jump && !this.lastJump && !s.onGround) this.jumpBufferUntil = now + JUMP_BUFFER_MS;
      if (s.onGround && now < this.jumpBufferUntil) {
        out.jump = true;
        out.autoHop = true;
        this.jumpBufferUntil = 0;
      }
    }
    this.lastJump = frame.jump;

    if (c.legit.move.bhop && frame.jump) out.autoHop = true;
    if (c.misc.autoJump && moving) out.jump = out.autoHop = true;
    if (c.legit.move.assist && s.onGround && out.forward > 0 && this.obstacleAhead(session, out)) out.jump = true;

    if (c.legit.move.autoStrafe && !s.onGround && out.right === 0) {
      Object.assign(out,airStrafeInput(out,s,wrapAngle(out.yaw-this.lastYaw),SIM_DT,PLAYER.speed*moveSpeedFor(session.weapons.weapon)));
    }
    this.lastYaw = frame.yaw;
    return this.antiAim(out);
  }

  /**
   * Spin bot: send a spinning yaw (what others see, and where your head hitbox is), and rotate
   * the movement keys by the difference so you still walk where the camera faces. Shots are
   * unaffected: they carry their own direction.
   */
  private antiAim(frame: InputFrame): InputFrame {
    const a = this.dev.config.rage.antiAim;
    const m = this.dev.config.rage.move;
    if (!a.spin || m.fly || m.noclip || this.session?.local.car) {
      this.spinning = null;
      return frame;
    }
    const step = a.speed * DEG * SIM_DT;
    if (a.direction === 'jitter') this.spinYaw = frame.yaw + Math.PI + (Math.random() - 0.5) * Math.min(Math.PI, step * 6);
    else this.spinYaw = wrapAngle(this.spinYaw + (a.direction === 'right' ? -step : step));
    const yaw = wrapAngle(this.spinYaw);

    // World-space walk direction for the real yaw...
    let f = frame.forward;
    let r = frame.right;
    const len = Math.hypot(f, r);
    if (len > 1) {
      f /= len;
      r /= len;
    }
    const sy = Math.sin(frame.yaw);
    const cy = Math.cos(frame.yaw);
    const dx = -sy * f + cy * r;
    const dz = -cy * f - sy * r;
    // ...expressed as forward/right relative to the spinning yaw.
    const ss = Math.sin(yaw);
    const cs = Math.cos(yaw);
    const pitch = a.pitch === 'down' ? -1.2 : a.pitch === 'up' ? 1.05 : frame.pitch;
    this.spinning = { yaw, pitch };
    return { ...frame, yaw, pitch, forward: -ss * dx - cs * dz, right: cs * dx - ss * dz };
  }

  bodyAngles(): { yaw: number; pitch: number } | null {
    return this.active && this.session?.local.alive && !this.freeCamActive && !this.spectatePid ? this.spinning : null;
  }

  wantsFire(): boolean {
    if (!this.active) return false;
    const c = this.dev.config;
    const want = this.triggerReady || (c.rage.aim.enabled && c.rage.aim.autoTarget && this.rageAim !== null);
    if (!want) return false;
    const w = this.session?.weapons;
    if (w && (w.def.automatic || w.forceAutomatic)) return true;
    // Semi-automatic guns need a fresh press for every shot.
    this.pulse = !this.pulse;
    return this.pulse;
  }

  aimOverride(_session: GameSession, eye: Vec3): Vec3 | null {
    if (!this.active || !this.dev.config.rage.aim.enabled || !this.rageAim) return null;
    return normalize({ x: this.rageAim.x - eye.x, y: this.rageAim.y - eye.y, z: this.rageAim.z - eye.z });
  }

  recoilScale(): number {
    if (!this.active) return 1;
    const c = this.dev.config;
    return c.rage.weapon.noRecoil ? 0 : c.weapons.recoil;
  }

  blocksShooting(): boolean {
    return this.active && (this.freeCamActive || this.spectatePid !== 0);
  }

  controlCamera(session: GameSession, _dt: number): boolean {
    if (!this.active) return false;
    const cam = session.camera;
    const input = this.dev.input;
    if (this.freeCamActive) {
      cam.position.copy(this.freePos);
      cam.rotation.set(input.pitch, input.yaw, 0, 'YXZ');
    } else if (this.spectatePid) {
      const r = session.remotes.get(this.spectatePid);
      if (!r) {
        this.spectatePid = this.dev.config.misc.spectator ? this.nextSpectateTarget(session, 0) : 0;
        return this.spectatePid !== 0 && this.controlCamera(session, _dt);
      }
      // Over the shoulder of the spectated player, looking where they look.
      const yaw = r.yaw;
      cam.position.set(r.position.x + Math.sin(yaw) * 3.8, r.position.y + 2.1, r.position.z + Math.cos(yaw) * 3.8);
      cam.lookAt(r.position.x - Math.sin(yaw) * 4, r.position.y + 1.2, r.position.z - Math.cos(yaw) * 4);
    } else {
      return false;
    }
    if (cam.fov !== baseFov()) {
      cam.fov = baseFov();
      cam.updateProjectionMatrix();
    }
    return true;
  }

  afterFrame(session: GameSession, _dt: number): void {
    const on = this.active;
    this.debug3d?.update(on ? this.dev.config : null);
    this.overlay.render(on ? session : null, this);
  }

  /** Developer wallhack: shows hidden chickens through walls (only where something is in front). */
  xrayFor(session: GameSession, r: RemotePlayer): THREE.Material | null {
    const w = this.dev.config.legit.wall;
    if (!this.active || !w.enabled || !r.alive) return null;
    this.xrayEnemy.color.set(w.enemyColor);
    this.xrayTeam.color.set(w.teamColor);
    this.xrayEnemy.opacity = this.xrayTeam.opacity = w.opacity;
    const friendly = session.isFriendly(r.info);
    if (friendly ? !w.teammates : !w.enemies) return null;
    return friendly ? this.xrayTeam : this.xrayEnemy;
  }

  // ---------------------------------------------------------------------------
  // Aim
  // ---------------------------------------------------------------------------

  /** Enemy chickens with the chosen aim point, angle from the crosshair and visibility. */
  candidates(session: GameSession, part: 'head' | 'body' | 'nearest', skipFriendly: boolean): Candidate[] {
    const cam = session.camera;
    const forward = cam.getWorldDirection(this.v1);
    const eye = session.eye();
    const out: Candidate[] = [];
    for (const [pid, r] of session.remotes.players) {
      if (!r.alive || (skipFriendly && session.isFriendly(r.info))) continue;
      const k = r.latest?.crouching ? CROUCH.scale : 1;
      const head = new THREE.Vector3(r.position.x - Math.sin(r.yaw) * HITBOX.headForward * k, r.position.y + HITBOX.headHeight * k, r.position.z - Math.cos(r.yaw) * HITBOX.headForward * k);
      const body = new THREE.Vector3(r.position.x, r.position.y + HITBOX.bodyHeight * 0.55 * k, r.position.z);
      const angleTo = (p: THREE.Vector3) => forward.angleTo(this.v2.subVectors(p, cam.position));
      let point = part === 'head' ? head : body;
      if (part === 'nearest' && angleTo(head) < angleTo(body)) point = head;
      const distance = Math.hypot(point.x - eye.x, point.y - eye.y, point.z - eye.z);
      out.push({ pid, r, point, angle: angleTo(point), distance, hp: r.latest?.hp ?? PLAYER.maxHealth, visible: this.visible(session, eye, point, distance) });
    }
    return out;
  }

  private visible(session: GameSession, eye: Vec3, p: THREE.Vector3, distance: number): boolean {
    const dir = { x: (p.x - eye.x) / distance, y: (p.y - eye.y) / distance, z: (p.z - eye.z) / distance };
    const hit = raycastWorld(makeRay(eye, dir), session.collision, distance);
    return !hit || hit.t >= distance - 0.25;
  }

  /** Yaw/pitch that put the camera's centre on `p`. */
  private anglesTo(session: GameSession, p: THREE.Vector3): { yaw: number; pitch: number } {
    const c = session.camera.position;
    const dx = p.x - c.x;
    const dy = p.y - c.y;
    const dz = p.z - c.z;
    return { yaw: Math.atan2(-dx, -dz), pitch: Math.max(PITCH_MIN, Math.min(PITCH_MAX, Math.atan2(dy, Math.hypot(dx, dz)))) };
  }

  private keyHeld(code: string): boolean {
    return code === '' || this.dev.input.isDown(code);
  }

  private updateLegit(session: GameSession, dt: number, now: number): void {
    const a = this.dev.config.legit.aim;
    const input = this.dev.input;
    const conditions = a.whileFiring || a.whileAds;
    const conditionMet = !conditions || (a.whileFiring && input.firing) || (a.whileAds && input.aiming);
    if (!a.enabled || !this.keyHeld(a.key) || !conditionMet) {
      this.legitPid = 0;
      return;
    }
    const best = this.candidates(session, a.target, a.teamCheck)
      .filter((t) => t.angle <= a.fov * DEG && (!a.visCheck || t.visible))
      .sort((x, y) => x.angle - y.angle)[0];
    if (!best) {
      this.legitPid = 0;
      return;
    }
    if (best.pid !== this.legitPid) {
      this.legitPid = best.pid;
      this.legitSince = now;
    }
    if (now - this.legitSince < a.reaction) return;
    // Ease towards the target: smoother = slower, strength scales the pull.
    const k = (1 - Math.exp((-dt * 30) / a.smooth)) * (a.strength / 100);
    const want = this.anglesTo(session, best.point);
    input.yaw = wrapAngle(input.yaw + wrapAngle(want.yaw - input.yaw) * k);
    input.pitch = Math.max(PITCH_MIN, Math.min(PITCH_MAX, input.pitch + (want.pitch - input.pitch) * k));
  }

  private updateRage(session: GameSession, now: number): void {
    const a = this.dev.config.rage.aim;
    this.rageAim = null;
    if (!a.enabled) {
      this.ragePid = 0;
      return;
    }
    const list = this.candidates(session, a.hitbox, true).filter((t) => t.visible && t.angle <= a.fov * DEG);
    let target = a.lock ? list.find((t) => t.pid === this.ragePid) : undefined;
    if (!target) {
      if (this.ragePid !== 0) {
        // Lost the previous target.
        if (!a.instantSwitch) this.rageSwitchAt = now + SWITCH_DELAY_MS;
        this.ragePid = 0;
      }
      if (now < this.rageSwitchAt) return;
      const by = { health: (t: Candidate) => t.hp, distance: (t: Candidate) => t.distance, crosshair: (t: Candidate) => t.angle }[a.priority];
      target = list.sort((x, y) => by(x) - by(y))[0];
    }
    if (!target) return;
    this.ragePid = target.pid;
    this.rageAim = target.point.clone();
    if (!a.silent) {
      const want = this.anglesTo(session, target.point);
      this.dev.input.yaw = want.yaw;
      this.dev.input.pitch = want.pitch;
    }
  }

  private updateTrigger(session: GameSession, now: number): void {
    const t = this.dev.config.legit.trigger;
    if (!t.enabled || !this.keyHeld(t.key)) {
      this.triggerReady = false;
      this.triggerSince = 0;
      return;
    }
    const onTarget = this.candidates(session, 'nearest', true).some((c) => c.angle <= t.fov * DEG && (!t.visCheck || c.visible));
    if (!onTarget) {
      this.triggerSince = 0;
      this.triggerReady = false;
      return;
    }
    if (!this.triggerSince) this.triggerSince = now;
    this.triggerReady = now - this.triggerSince >= t.delay;
  }

  /** The pid of the target the aim tools are on (for the ESP highlight). */
  get focusPid(): number {
    return this.ragePid || this.legitPid;
  }

  // ---------------------------------------------------------------------------
  // Movement and cameras
  // ---------------------------------------------------------------------------

  /** Something jumpable right in front of us (Movement assistance hops over it). */
  private obstacleAhead(session: GameSession, f: InputFrame): boolean {
    const s = session.local.state;
    const dx = -Math.sin(f.yaw) * f.forward + Math.cos(f.yaw) * f.right;
    const dz = -Math.cos(f.yaw) * f.forward - Math.sin(f.yaw) * f.right;
    const len = Math.hypot(dx, dz) || 1;
    const dir = { x: dx / len, y: 0, z: dz / len };
    const reach = PLAYER.radius + 0.45;
    const low = raycastWorld(makeRay({ x: s.x, y: s.y + 0.3, z: s.z }, dir), session.collision, reach);
    if (!low || low.id === -1) return false;
    // Only if it's low enough to clear with a jump.
    const high = raycastWorld(makeRay({ x: s.x, y: s.y + 1.25, z: s.z }, dir), session.collision, reach + 0.3);
    return !high;
  }

  private moveFreeCam(frame: InputFrame): void {
    const input = this.dev.input;
    const yaw = input.yaw;
    const pitch = input.pitch;
    const step = FREECAM_SPEED * SIM_DT * this.dev.config.rage.move.speed;
    const fx = -Math.sin(yaw) * Math.cos(pitch);
    const fy = Math.sin(pitch);
    const fz = -Math.cos(yaw) * Math.cos(pitch);
    this.freePos.x += (fx * frame.forward + Math.cos(yaw) * frame.right) * step;
    this.freePos.y += (fy * frame.forward + (frame.jump ? 1 : 0)) * step;
    this.freePos.z += (fz * frame.forward - Math.sin(yaw) * frame.right) * step;
    this.freePos.y = Math.max(0.2, this.freePos.y);
  }

  /** Starts / stops free camera and spectator mode as the config changes. */
  private updateCameraModes(session: GameSession, allowed: boolean): void {
    const m = this.dev.config.misc;
    const input = this.dev.input;
    const wantFree = allowed && m.freeCam;
    if (wantFree && !this.freeCamActive) {
      this.freeCamActive = true;
      this.freePos.copy(session.camera.position);
      this.anchorYaw = input.yaw;
      this.anchorPitch = input.pitch;
    } else if (!wantFree && this.freeCamActive) {
      this.freeCamActive = false;
      input.yaw = this.anchorYaw;
      input.pitch = this.anchorPitch;
    }
    if (this.lastSpectatorMode && !m.spectator) this.spectatePid = 0;
    this.lastSpectatorMode = m.spectator;
    if (allowed && !this.freeCamActive && m.spectator && !this.spectatePid) {
      this.spectatePid = this.nextSpectateTarget(session, 0);
      this.anchorYaw = input.yaw;
      this.anchorPitch = input.pitch;
    }
    if (!allowed || this.freeCamActive) this.spectatePid = 0;
  }

  /** Start spectating someone from the Players tab (0 stops). */
  spectate(pid: number): void {
    if (pid && !this.spectatePid) {
      this.anchorYaw = this.dev.input.yaw;
      this.anchorPitch = this.dev.input.pitch;
    }
    this.spectatePid = pid;
  }

  private nextSpectateTarget(session: GameSession, after: number): number {
    const pids = [...session.remotes.players.keys()].sort((a, b) => a - b);
    if (pids.length === 0) return 0;
    return pids.find((p) => p > after) ?? pids[0]!;
  }

  private applyHud(): void {
    const on = this.active;
    // The public HvH panel owns these choices while the private classic panel is inactive.
    if (!on && this.session?.mode.id === 'hvh') return;
    const m = this.dev.config.misc;
    const hud = this.dev.hud;
    hud.showCrosshair = !on || m.crosshair;
    hud.showHitmarker = !on || m.hitmarker;
    hud.showDamageIndicators = !on || m.damageIndicator;
  }
}
