import { clamp, wrapAngle, type Vec3 } from '../math';
import { SIM_DT } from '../constants';

export interface AnimationInput { eyeYaw: number; desiredDelta: number; speed: number; crouch: number; grounded: boolean; weaponSpeed?: number; active: boolean }
export interface AuthoritativeAnimation {
  eyeYaw: number; bodyYaw: number; lowerBodyYaw: number; maxDelta: number; stoppedTicks: number;
  crouch: number; speed: number; grounded: boolean; turnWeight: number; nextBodyUpdate: number;
}
export function createAnimation(yaw = 0): AuthoritativeAnimation {
  return { eyeYaw: yaw, bodyYaw: yaw, lowerBodyYaw: yaw, maxDelta: 0, stoppedTicks: 0,
    crouch: 0, speed: 0, grounded: true, turnWeight: 0, nextBodyUpdate: 0 };
}
/** Rules of this game's animation, not offsets from a foreign engine. */
export function maximumBodyDelta(speed: number, crouch: number, grounded: boolean, weaponSpeed = 1): number {
  const fraction = clamp(speed / (6 * weaponSpeed), 0, 1);
  return (58 - fraction * 30 - crouch * 8 - (grounded ? 0 : 18)) * Math.PI / 180;
}
export function stepAnimation(s: AuthoritativeAnimation, input: AnimationInput, tick: number): void {
  const previous = s.bodyYaw;
  s.eyeYaw = wrapAngle(input.eyeYaw); s.speed = input.speed; s.grounded = input.grounded;
  s.crouch += clamp(input.crouch - s.crouch, -SIM_DT * 8, SIM_DT * 8);
  s.maxDelta = input.active ? maximumBodyDelta(input.speed, s.crouch, input.grounded, input.weaponSpeed) : 0;
  const delta = clamp(input.desiredDelta, -s.maxDelta, s.maxDelta);
  const goal = wrapAngle(s.eyeYaw + delta);
  const rate = input.speed > 0.3 ? 540 : input.grounded ? 360 : 240;
  s.bodyYaw = wrapAngle(previous + clamp(wrapAngle(goal - previous), -rate * Math.PI / 180 * SIM_DT, rate * Math.PI / 180 * SIM_DT));
  // A large eye turn can move the body immediately to the legal boundary, never outside it.
  s.bodyYaw = wrapAngle(s.eyeYaw + clamp(wrapAngle(s.bodyYaw - s.eyeYaw), -s.maxDelta, s.maxDelta));
  s.turnWeight = clamp(Math.abs(wrapAngle(s.bodyYaw - previous)) / (Math.PI / 8), 0, 1);
  if (input.speed > 0.3 && input.grounded) {
    s.stoppedTicks = 0; s.lowerBodyYaw = s.bodyYaw; s.nextBodyUpdate = tick + 14;
  } else {
    s.stoppedTicks++;
    if (input.grounded && tick >= s.nextBodyUpdate) { s.lowerBodyYaw = s.bodyYaw; s.nextBodyUpdate = tick + 72; }
  }
}

/** Explicit allow-list: no bodyYaw, inverter, enemy config, or authoritative bones. */
export interface ObservableRecord {
  pid: number; tick: number; t: number; origin: Vec3; velocity: Vec3; eyeYaw: number; lowerBodyYaw: number;
  speed: number; crouch: number; grounded: boolean; turnWeight: number; alive: boolean; hp: number; armor: number;
  fired: boolean; concealed: boolean; defensive: boolean;
  /** Observable physical head pitch; never a hidden-body orientation. */
  pitch?: number;
}
export function copyObservableRecord(r: ObservableRecord): ObservableRecord {
  return { pid: r.pid, tick: r.tick, t: r.t, origin: { x: r.origin.x, y: r.origin.y, z: r.origin.z },
    velocity: { x: r.velocity.x, y: r.velocity.y, z: r.velocity.z }, eyeYaw: r.eyeYaw, lowerBodyYaw: r.lowerBodyYaw,
    speed: r.speed, crouch: r.crouch, grounded: r.grounded, turnWeight: r.turnWeight, alive: r.alive,
    hp: r.hp, armor: r.armor, fired: r.fired, concealed: r.concealed, defensive: r.defensive, pitch: r.pitch ?? 0 };
}
export function observableRecord(pid: number, tick: number, t: number, origin: Vec3, velocity: Vec3,
  a: AuthoritativeAnimation, hp: number, armor: number, alive: boolean, fired = false, concealed = false, defensive = false): ObservableRecord {
  return { pid, tick, t, origin: { ...origin }, velocity: { ...velocity }, eyeYaw: a.eyeYaw,
    lowerBodyYaw: a.lowerBodyYaw, speed: a.speed, crouch: a.crouch, grounded: a.grounded,
    turnWeight: Math.round(a.turnWeight * 4) / 4, hp, armor, alive, fired: fired && !concealed, concealed, defensive };
}
