import * as THREE from 'three';
import {
  CROUCH,
  SIM_DT,
  damp,
  copyMoveState,
  createMoveState,
  lerp,
  stepCar,
  stepPlayer,
  type CarState,
  type CollisionWorld,
  type InputCommand,
  type InputFrame,
  type HvhStateEvent,
  type MoveMods,
  type MoveState,
  type PlayerInfo,
  type PlayerState,
  type VehicleState,
  withUpgrades,
  DEFAULT_MODS,
  type UpgradeEffects,
} from '@game/shared';
import { holdForCharge, movementSteps, type CommandIntent, type TickContext } from '@game/shared/hvh/v2';
import { NO_SIGHT, PredictedTickbase } from '../hvh/PredictedTickbase';
import { Chicken } from './models/Chicken';

/** Beyond this prediction error (metres) we teleport instead of smoothing, e.g. after a respawn. */
const SNAP_DISTANCE = 2;
/** How quickly a small prediction error is smoothed out of the rendered position. */
const ERROR_DECAY = 12;
/** Safety cap in case the server stops acknowledging inputs (~2 s). */
const MAX_PENDING = 120;

/**
 * The player on this machine, using client-side prediction:
 *  - every tick we apply our own input immediately (no waiting for the server),
 *  - keep the inputs the server hasn't confirmed yet,
 *  - and when a snapshot arrives, rewind to the server's state and replay those inputs.
 */
export class LocalPlayer {
  tactical = false;
  /** Smoothed position to render and point the camera at. */
  readonly position = new THREE.Vector3();
  readonly chicken: Chicken;
  readonly state: MoveState;
  /** Latest authoritative state from the server (health, ammo, grenades...). */
  server: PlayerState;

  private readonly prev = new THREE.Vector3();
  private readonly errorOffset = new THREE.Vector3();
  /**
   * Inputs the server hasn't confirmed yet, with the hop cap of the weapon held at the time and
   * the movement steps predicted for them (HvH v2: 0 charging, 1 + chargeTicks on a burst).
   */
  private pending: { frame: InputFrame; hopMax: number; speed: number; steps: number }[] = [];
  private speed = 0;
  /** Predicted buggy while driving, else null. */
  car: CarState | null = null;
  vehicleId = 0;
  /** Smoothed body scale for the camera height (1 standing, smaller crouched). */
  eyeScale = 1;
  /** Developer movement modifiers confirmed by the server (null = normal movement). */
  mods: MoveMods | null = null;
  /** Chicken upgrades the server applies here (PvE modes only), predicted the same way. */
  upgrades: UpgradeEffects | null = null;
  /** A story event's speed-ups (1 = normal), as the server applies them. */
  eventSpeed = 1;
  /** HvH v2 tickbase prediction; the server only reports it (hvhState) when running the v2 engine. */
  readonly tickbase = new PredictedTickbase();
  /** True after the first hvhState, i.e. the room runs the v2 engine. */
  hvhV2 = false;
  /** The world of the last snapshot reconcile, which an hvhState correction replays in (null: none yet). */
  private replayWorld: CollisionWorld | null = null;

  constructor(scene: THREE.Scene, info: PlayerInfo, spawn: PlayerState) {
    this.server = spawn;
    this.state = copyMoveState(spawn, createMoveState(0, 0, 0));
    this.prev.set(spawn.x, spawn.y, spawn.z);
    this.position.copy(this.prev);
    this.chicken = new Chicken(info.appearance, info.team);
    this.chicken.setWeapon(spawn.weapon);
    scene.add(this.chicken.root);
  }

  get alive(): boolean {
    return this.server.alive;
  }

  get onGround(): boolean {
    return this.state.onGround;
  }

  /**
   * @param hopMax bunny-hop cap for the weapon in hand (the server uses the same, see hopMaxFor).
   * @param plan HvH v2: the command's intent (its choke bit may be undecided) and enemy sight. The
   *   predicted tickbase action picks the movement steps, as on the server: none while charging,
   *   1 + chargeTicks on a burst, else one. Without it (or outside v2) the frame runs one step.
   */
  predict(frame: InputFrame, world: CollisionWorld, hopMax: number, speed = 1, plan?: { intent: CommandIntent; ctx: TickContext }): void {
    this.prev.set(this.state.x, this.state.y, this.state.z);
    const steps = this.hvhV2 && plan ? movementSteps(this.tickbase.peek(frame.seq, plan.intent, plan.ctx)) : 1;
    this.step(frame, world, hopMax, speed, steps);
    // Animation speed per step, so the burst's teleport does not read as a sprint.
    this.speed = Math.hypot(this.state.x - this.prev.x, this.state.z - this.prev.z) / (SIM_DT * Math.max(1, steps));
    this.pending.push({ frame, hopMax, speed, steps });
    if (this.pending.length > MAX_PENDING) this.pending.shift();
  }

  /**
   * Attaches the intent for the server and, on a v2 room, predicts the command's tickbase step now,
   * with the sight `predict` used, so the next command's movement sees this one's charge.
   */
  command(frame: InputFrame, intent: CommandIntent, clientTick: number, ctx: TickContext = NO_SIGHT): InputCommand {
    if (this.hvhV2) this.tickbase.apply(frame.seq, intent, ctx);
    return { ...frame, intent, clientTick };
  }

  /**
   * Called when a command leaves for the server: legacy rooms get the plain frame. In v2, the
   * commands the simulated link lost before it will never run: their prediction is taken back.
   */
  emitted(cmd: InputCommand): InputCommand | InputFrame {
    if (!this.hvhV2 || !cmd.intent) { const { intent: _i, clientTick: _t, sightT: _s, ...frame } = cmd; return frame; }
    const lost = this.tickbase.sent(cmd.seq);
    if (lost.length) this.pending = this.pending.filter((p) => !lost.includes(p.frame.seq));
    return cmd;
  }

  /** Our own death (v2): the server reset the tickbase and runs later commands without it. */
  onOwnDeath(): void {
    if (this.hvhV2) this.tickbase.reset(undefined, false);
  }

  onHvhState(e: HvhStateEvent): void {
    this.hvhV2 = true;
    const before = this.pending.map((p) => this.stepsOf(p));
    this.tickbase.reconcile(e.tickbase, e.lastAckSeq);
    // The server sends a tick's hvhState before the snapshot that acknowledges the same commands
    // (snapshots run on their own timer, between ticks), so that snapshot replays the corrected
    // actions. If a snapshot already acknowledged them, a correction that changes a pending
    // command's movement (a stop or a burst predicted wrongly) is replayed from it now.
    const covered = this.server.ack >= e.lastAckSeq;
    if (covered && this.replayWorld && !this.car && this.pending.some((p, i) => this.stepsOf(p) !== before[i])) this.replay(this.replayWorld);
  }

  /** v2: a pending command's movement steps after the latest hvhState. */
  private stepsOf(p: { frame: InputFrame; steps: number }): number {
    return (this.hvhV2 ? this.tickbase.stepsFor(p.frame.seq) : undefined) ?? p.steps;
  }

  private step(frame: InputFrame, world: CollisionWorld, hopMax: number, speed: number, steps: number): void {
    // A developer froze us: the server ignores our inputs, so don't predict any movement.
    if (this.server.frozen) { this.state.horizontalSpeed = 0; return; }
    if (this.car) return this.drive(frame, world);
    // The v2 charging stop: no step, no gravity, every velocity zeroed (HvhRoom.move).
    if (steps === 0) return holdForCharge(this.state);
    for (let i = 0; i < steps; i++) stepPlayer(this.state, frame, SIM_DT, world, this.moveMods(), hopMax, speed, this.tactical);
  }

  private moveMods(): MoveMods | null {
    const mods = withUpgrades(this.mods, this.upgrades);
    if (this.eventSpeed === 1) return mods;
    const base = mods ?? DEFAULT_MODS;
    return { ...base, speed: base.speed * this.eventSpeed };
  }

  /** While driving, inputs steer the car and the chicken rides along. */
  private drive(frame: InputFrame, world: CollisionWorld): void {
    const car = this.car!;
    stepCar(car, frame, SIM_DT, world);
    this.state.x = car.x;
    this.state.z = car.z;
    this.state.y = 0;
    this.state.vx = this.state.vy = this.state.vz = 0;
    this.state.onGround = true;
  }

  reconcile(server: PlayerState, world: CollisionWorld, car?: VehicleState): void {
    this.server = server;
    this.pending = this.pending.filter((p) => p.frame.seq > server.ack);
    this.vehicleId = server.vehicle;
    this.car = server.vehicle && car ? { x: car.x, z: car.z, yaw: car.yaw, speed: car.speed, slip: car.slip, boost: car.boost } : null;
    if (!server.alive) this.pending = [];
    this.replayWorld = world;
    this.replay(world);
  }

  /** Rewinds to the last snapshot's state and replays the pending inputs. */
  private replay(world: CollisionWorld): void {
    const bx = this.state.x;
    const by = this.state.y;
    const bz = this.state.z;

    copyMoveState(this.server, this.state);
    // v2: replay each command with its tickbase action after the latest hvhState.
    for (const p of this.pending) this.step(p.frame, world, p.hopMax, p.speed, this.stepsOf(p));

    // Normally tiny, because both sides run the same deterministic stepPlayer.
    const ex = bx - this.state.x;
    const ey = by - this.state.y;
    const ez = bz - this.state.z;
    if (ex * ex + ey * ey + ez * ez > SNAP_DISTANCE * SNAP_DISTANCE) {
      this.snap();
    } else {
      // Shift the interpolation start and carry the difference as a decaying visual offset, so
      // the rendered position doesn't jump this frame and glides onto the corrected path instead.
      this.prev.x -= ex;
      this.prev.y -= ey;
      this.prev.z -= ez;
      this.errorOffset.x += ex;
      this.errorOffset.y += ey;
      this.errorOffset.z += ez;
    }
  }

  /** Teleport (respawn): no smoothing from the old position. */
  respawnAt(x: number, y: number, z: number): void {
    const fresh = createMoveState(x, y, z);
    copyMoveState(fresh, this.state);
    this.pending = [];
    this.snap();
    this.server = { ...this.server, alive: true, x, y, z };
    // Not a snapshot's movement state: nothing to replay from until the next one.
    this.replayWorld = null;
    this.chicken.setDead(false);
    // A new life (v2): the server starts a fresh tickbase.
    if (this.hvhV2) this.tickbase.reset();
  }

  private snap(): void {
    this.errorOffset.set(0, 0, 0);
    this.prev.set(this.state.x, this.state.y, this.state.z);
  }

  /** @param alpha How far we are between the previous and current simulation tick (0..1). */
  render(alpha: number, dt: number, yaw: number, pitch: number, seat: { position: THREE.Vector3; yaw: number } | null = null): void {
    this.errorOffset.multiplyScalar(Math.exp(-ERROR_DECAY * dt));
    this.position.set(
      lerp(this.prev.x, this.state.x, alpha) + this.errorOffset.x,
      lerp(this.prev.y, this.state.y, alpha) + this.errorOffset.y,
      lerp(this.prev.z, this.state.z, alpha) + this.errorOffset.z,
    );
    const c = this.chicken;
    if (seat) {
      c.root.position.copy(seat.position);
      c.root.rotation.y = seat.yaw;
    } else {
      c.root.position.copy(this.position);
      if (this.alive) c.root.rotation.y = yaw;
    }
    c.setDead(!this.alive);
    c.setAim(pitch);
    c.setJetpack(this.state.fuel > 0, this.state.jetting);
    c.setCrouch(this.state.crouching && !seat,seat ? 0 : this.state.crouchAmount);
    this.eyeScale = damp(this.eyeScale, this.state.crouching && !seat ? CROUCH.scale : 1, 14, dt);
    c.animate(dt, this.alive && !seat ? this.speed : 0, this.state.onGround);
  }

  dispose(): void {
    this.chicken.dispose();
  }
}
