import { clamp, wrapAngle } from '../../math';
import { mulberry32 } from '../../rng';
import type { EraTable } from './era';

/*
 * Conventions (from legacy shared/src/hvh.ts):
 * - Yaw is in radians, wrapped to [-PI, PI) with math.wrapAngle. Positive yaw turns left:
 *   base offsets are backward = +PI, left = +PI/2, right = -PI/2 (hvh.ts:147).
 * - Config angles (yawOffsetDeg, jitterDeg, desyncDeg) are degrees. Jitter clamps to
 *   0..HVH.maxJitter (45) (hvh.ts:86,111); the yaw offset clamps to -180..180.
 * - Desync side is +1 normally and -1 when inverted; body = eye + desync * side (hvh.ts:146,150).
 *   A positive body offset is 'left', negative is 'right', zero is 'center'.
 * - Jitter desync (ruling R18): when the clamped jitterDeg > 0 the real side alternates with the
 *   jitter phase. Phase 0 keeps the inverted-derived side (left normally, right inverted); phase 1
 *   takes the opposite. So with inverted=false: phase 0 -> 'left', phase 1 -> 'right'; inverted
 *   flips the whole mapping. With jitterDeg 0 the side is constant from inverted alone.
 * - Jitter: phase 1 adds +jitter, phase 0 adds -jitter (hvh.ts:148). The phase flips once per
 *   stepPose call, i.e. once per executed command.
 * - Spin rotates at the legacy default spinSpeed of 180 deg/s (hvh.ts:88), computed from the tick
 *   at 64 Hz so it stays deterministic.
 * - Stances (stanceOf): airborne over crouching over standing; a grounded player above
 *   MOVING_SPEED_FRACTION is moving, or slowwalking with slow walk held. Each stance has its own
 *   StanceAA and DefensiveAA.
 * - pitch is carried over from prev (the caller passes its look / visual pitch in) unless a
 *   defensive pattern is active.
 * - Defensive patterns (round redesign Part B) change the real pose only: no charge, no tickbase
 *   shift, no lag-compensation effect. Active when enabled and any trigger holds: inAir and
 *   airborne, onPeek and ctx.peekTicksLeft > 0, or always. Every value is a function of
 *   (seed, tick, ctx), so prediction and replay hold:
 *   - Pitch degrees are CS degrees (down positive); the pose pitch is radians with up positive,
 *     so down is a negative pitch. The magnitude P is 89 within the era's limit (R58):
 *     P = min(89, era.maxPitchDeg), 68.75 in LATE_CSGO. down P, up -P, zero 0, random (a new
 *     value in [-P, P) every 4 ticks: -P + 2P * mulberry32(seed ^ floor(tick / 4))()), jitter
 *     (+-P alternating each tick, even ticks down).
 *   - Yaw on top of the stance base and offset: flick (+120 deg x side for 4 ticks, then 4 off;
 *     side +1 on even flicks, -1 on odd), spin (the base becomes the spin), random (the same
 *     generator's second value: an offset in [-180, 180) every 4 ticks), sideways (+-90
 *     alternating each tick, even ticks +90).
 *   - An on-peek flick (onPeek the only active trigger) is phased by the window instead, so it
 *     fires as the enemy appears: window commands w < FLICK_TICKS (w = PEEK_TICKS - peekTicksLeft)
 *     at +120 x ctx.peekSide, the rest off. With PEEK_TICKS 4 the flick fills the whole window.
 *     The server alternates peekSide per window.
 *   - PEEK_TICKS is 4, not 8 (round redesign Task 10 balance sweep): an 8-command window kept the
 *     pitch-down override up through the opponent's first aimed shot, hiding the head behind the
 *     chest, and on-peek won 64-66% against off; at 4 it is about even (docs/hvh/balance-report.md).
 *   - Jitter and desync still apply, and desync stays within maxDesync.
 */

export type Side = 'left' | 'right' | 'center';

export type V2Stance = 'standing' | 'moving' | 'airborne' | 'crouching' | 'slowwalking';
export const V2_STANCES: readonly V2Stance[] = ['standing', 'moving', 'airborne', 'crouching', 'slowwalking'];

export interface StanceAA {
  base: 'backward' | 'left' | 'right' | 'spin';
  yawOffsetDeg: number;
  jitterDeg: number;
  desyncDeg: number;
}

export interface DefensiveAA {
  enabled: boolean;
  inAir: boolean;
  onPeek: boolean;
  always: boolean;
  pitch: 'down' | 'up' | 'zero' | 'random' | 'jitter';
  yaw: 'off' | 'flick' | 'spin' | 'random' | 'sideways';
}

export interface AntiAimConfig {
  stances: Record<V2Stance, StanceAA>;
  inverted: boolean;
  defensive: Record<V2Stance, DefensiveAA>;
}

/** What stepPose needs besides the config: the player's seed, the peek window, slow walk held. */
export interface PoseContext {
  seed: number;
  /** Commands left in the on-peek window (the server sets PEEK_TICKS when an enemy appears). */
  peekTicksLeft: number;
  slowWalk: boolean;
  /** The side of the current on-peek window's flick (default +1); the server alternates it per window. */
  peekSide?: 1 | -1;
}

export interface Motion {
  speedFraction: number;
  duck: number;
  onGround: boolean;
}

export interface PoseState {
  /** radians, wrapped */
  eyeYaw: number;
  /** radians, wrapped */
  bodyYaw: number;
  /** radians, wrapped */
  pitch: number;
  jitterPhase: 0 | 1;
  realSide: Side;
  /** Signed jitter offset of the eyes from the base yaw, degrees. Visible to opponents. */
  eyeOffsetDeg: number;
}

/** What an opponent can see of a pose. Never contains bodyYaw or realSide. */
export interface Observation {
  tick: number;
  eyeYaw: number;
  eyeOffsetDeg: number;
  speedFraction: number;
  duck: number;
}

export const MAX_JITTER_DEG = 45;
export const SPIN_DEG_PER_SEC = 180;
/** Commands the on-peek trigger stays active after an enemy becomes visible (tuned by the balance sweep). */
export const PEEK_TICKS = 4;
/** Ticks a random defensive pitch or yaw is held. */
export const DEFENSIVE_RANDOM_TICKS = 4;
/** A flick is FLICK_TICKS on, then FLICK_TICKS off. */
export const FLICK_TICKS = 4;
export const FLICK_DEG = 120;
export const DEFENSIVE_PITCH_DEG = 89;
/** At or below this speed fraction a grounded player is standing (0.3 m/s at run speed). */
export const MOVING_SPEED_FRACTION = 0.05;
/** At or above this duck amount a grounded player is crouching. */
export const CROUCH_DUCK = 0.5;

export const NO_DEFENSIVE: Readonly<DefensiveAA> = Object.freeze({
  enabled: false, inAir: false, onPeek: false, always: false, pitch: 'down', yaw: 'off',
});

export const INITIAL_POSE: PoseState = Object.freeze({
  eyeYaw: 0,
  bodyYaw: 0,
  pitch: 0,
  jitterPhase: 0,
  realSide: 'center',
  eyeOffsetDeg: 0,
});

const DEG = Math.PI / 180;
const BASE_OFFSET = { backward: Math.PI, left: Math.PI / 2, right: -Math.PI / 2 } as const;

/** One stance config for all five stances, defensive off (single-stance loadouts, tests). */
export function uniformAntiAim(stance: StanceAA, inverted = false): AntiAimConfig {
  const stances = {} as Record<V2Stance, StanceAA>;
  const defensive = {} as Record<V2Stance, DefensiveAA>;
  for (const s of V2_STANCES) {
    stances[s] = { ...stance };
    defensive[s] = { ...NO_DEFENSIVE };
  }
  return { stances, inverted, defensive };
}

export function stanceOf(motion: Motion & { slowWalk: boolean }): V2Stance {
  if (!motion.onGround) return 'airborne';
  if (motion.duck >= CROUCH_DUCK) return 'crouching';
  if (motion.speedFraction <= MOVING_SPEED_FRACTION) return 'standing';
  return motion.slowWalk ? 'slowwalking' : 'moving';
}

export function defensiveActive(d: DefensiveAA, stance: V2Stance, peekTicksLeft: number): boolean {
  return d.enabled && ((d.inAir && stance === 'airborne') || (d.onPeek && peekTicksLeft > 0) || d.always);
}

export function maxDesync(speedFraction: number, era: EraTable): number {
  return era.maxDesyncDeg * (1 - era.desyncRunFalloff * clamp(speedFraction, 0, 1));
}

/** Non-negative remainder, so every tick keeps the same cycles. */
const mod = (a: number, n: number) => ((a % n) + n) % n;

/** The (pitch, yaw) uniforms of the random interval holding `tick`. */
function defensiveRandom(seed: number, tick: number): [number, number] {
  const next = mulberry32(seed ^ Math.floor(tick / DEFENSIVE_RANDOM_TICKS));
  const pitch = next();
  return [pitch, next()];
}

/** Defensive pitch in CS degrees (down positive), magnitude at most `max`. */
function defensivePitchDeg(mode: DefensiveAA['pitch'], tick: number, seed: number, max: number): number {
  switch (mode) {
    case 'down': return max;
    case 'up': return -max;
    case 'zero': return 0;
    case 'random': return -max + 2 * max * defensiveRandom(seed, tick)[0];
    case 'jitter': return mod(tick, 2) === 0 ? max : -max;
  }
}

/**
 * Defensive yaw offset on top of the base, degrees ('spin' replaces the base instead). `window`
 * (commands into an on-peek window, with its side) phases the flick instead of the tick.
 */
function defensiveYawDeg(mode: DefensiveAA['yaw'], tick: number, seed: number, window: { w: number; side: 1 | -1 } | null): number {
  switch (mode) {
    case 'off':
    case 'spin': return 0;
    case 'flick':
      if (window) return window.w < FLICK_TICKS ? FLICK_DEG * window.side : 0;
      if (mod(tick, 2 * FLICK_TICKS) >= FLICK_TICKS) return 0;
      return mod(Math.floor(tick / (2 * FLICK_TICKS)), 2) === 0 ? FLICK_DEG : -FLICK_DEG;
    case 'random': return -180 + 360 * defensiveRandom(seed, tick)[1];
    case 'sideways': return mod(tick, 2) === 0 ? 90 : -90;
  }
}

export function stepPose(
  prev: PoseState,
  aimYaw: number,
  aa: AntiAimConfig,
  motion: Motion,
  tick: number,
  era: EraTable,
  ctx: PoseContext,
): PoseState {
  const stance = stanceOf({ ...motion, slowWalk: ctx.slowWalk });
  const st = aa.stances[stance];
  const def = aa.defensive[stance];
  const active = defensiveActive(def, stance, ctx.peekTicksLeft);
  const yawBase =
    st.base === 'spin' || (active && def.yaw === 'spin')
      ? aimYaw + ((tick * SPIN_DEG_PER_SEC) / era.tickRate) * DEG
      : aimYaw + BASE_OFFSET[st.base];
  // On peek alone (no always, no in-air while airborne): phased by the window.
  const peekOnly = active && !def.always && !(def.inAir && stance === 'airborne');
  const window = peekOnly ? { w: PEEK_TICKS - ctx.peekTicksLeft, side: ctx.peekSide ?? 1 } : null;
  const offsetDeg = clamp(st.yawOffsetDeg, -180, 180) + (active ? defensiveYawDeg(def.yaw, tick, ctx.seed, window) : 0);
  const base = yawBase + offsetDeg * DEG;
  const jitterPhase: 0 | 1 = prev.jitterPhase === 1 ? 0 : 1;
  const jitter = clamp(st.jitterDeg, 0, MAX_JITTER_DEG);
  // jitter === 0 must yield +0, never -0.
  const eyeOffsetDeg = jitter === 0 ? 0 : jitterPhase === 1 ? jitter : -jitter;
  const eyeYaw = wrapAngle(base + eyeOffsetDeg * DEG);

  const desync = Math.min(Math.max(st.desyncDeg, 0), maxDesync(motion.speedFraction, era));
  const baseSide = aa.inverted ? -1 : 1;
  const side = jitter > 0 && jitterPhase === 1 ? -baseSide : baseSide;
  const bodyYaw = wrapAngle(eyeYaw + desync * side * DEG);
  const realSide: Side = desync === 0 ? 'center' : side > 0 ? 'left' : 'right';

  // CS degrees (down positive) to pose radians (up positive); zero stays +0.
  const csPitch = active ? defensivePitchDeg(def.pitch, tick, ctx.seed, Math.min(DEFENSIVE_PITCH_DEG, era.maxPitchDeg)) : 0;
  const pitch = !active ? prev.pitch : csPitch === 0 ? 0 : -csPitch * DEG;

  return { eyeYaw, bodyYaw, pitch, jitterPhase, realSide, eyeOffsetDeg };
}

export function publicObservation(p: PoseState, motion: Motion, tick: number): Observation {
  return {
    tick,
    eyeYaw: p.eyeYaw,
    eyeOffsetDeg: p.eyeOffsetDeg,
    speedFraction: motion.speedFraction,
    duck: motion.duck,
  };
}
