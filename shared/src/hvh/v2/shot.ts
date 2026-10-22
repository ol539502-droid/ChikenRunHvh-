import type { CollisionWorld } from '../../collision';
import { clamp, wrapAngle, type Vec3 } from '../../math';
import { makeRay, raycastWorld, type Ray } from '../../raycast';
import { WEAPONS, isWeaponId, pelletDirections, type WeaponDef } from '../../weapons';
import { hvhHitDamage, traceHvhCover } from '../ballistics';
import { buildHvhMatrix, rayHvhMatrix, type HvhHit, type HvhMatrix } from '../geometry';
import { hvhSpread, hvhWeapon } from '../weapons';
import { LATE_CSGO } from './era';
import type { Observation, PoseState, Side } from './pose';
import type { InvalidCause, LagRecord, RecordHistory } from './records';
import { peekResolve, resolve, type ResolverMemory, type VerdictCause } from './resolver';

/*
 * One deterministic shot pipeline: every bullet gets exactly one cause, first match wins:
 *   rejected -> invalidRecord -> obstruction -> hit -> resolver -> spread.
 * ('tickbase' is never produced here; the room creates those from tickbase rejects.)
 *
 * Rules:
 * - Weapon: WEAPONS[weaponId] tuned by hvhWeapon (hvh/weapons.ts). Projectile and melee weapons
 *   are not hitscan and are rejected as 'unknown weapon'.
 * - Fire interval: WeaponDef.fireInterval is milliseconds (weapons.ts:33), so the interval in ticks
 *   is ceil(fireInterval * 64 / 1000); rejected when it exceeds ticksSinceLastShot.
 * - No target: nothing to explain, so the shot is 'spread' (no world trace, no resolve).
 * - view = min(viewTick, tick), used for RecordHistory.select, peekResolve and resolve, so records
 *   and observations after the current tick never count.
 * - Hitbox matrices use buildHvhMatrix(position, pose.bodyYaw, 1 - duck * 0.3, pose.pitch), the
 *   legacy crouch scale (rage.ts:55,97); duck is clamped to 0..1, absent = 0. The guessed pose mirrors bodyYaw to the guessed side with the same
 *   desync magnitude ('center' puts bodyYaw on eyeYaw).
 * - Obstruction is judged on the un-deviated aim, at the nearest hit on the real or guessed pose
 *   (guessed via the pure peekResolve, so obstructed shots never touch resolver memory): blocked
 *   when the world stops the bullet first, or when penetration and armor leave < ABSORBED_DAMAGE.
 *   If the aim hits neither pose there is nothing to obstruct.
 * - resolve() runs once, only after the record is valid and not obstructed; guessed/real are set
 *   on every verdict after that point (hit, resolver, spread).
 * - Spread: pelletDirections(weapon, aim, spread, spreadSeed) (weapons.ts), the only randomness.
 *   ctx.spread overrides the cone; the default is the standing hvhSpread. Multi-pellet weapons sum
 *   pellet damage; hitgroup is the pellet that dealt the most.
 * - Damage: hvhHitDamage (ballistics.ts): damageAt falloff x hitgroup multiplier x penetration loss.
 *   An armored target takes x w.csgo.armorPen on every hitgroup but 'leg', per pellet; weapons
 *   without csgo ignore armor, and armor never wears down. remainingHp = max(0, hp - damage). Values stay unrounded.
 */

/** A penetrated surface; structurally a BallisticTrace passage plus its material name. */
export interface WorldPassage { entry: number; exit: number; loss: number; material: string }
/** Where a bullet stops (wallDistance = range if nothing stops it) and what it passed through. */
export interface WorldTrace { wallDistance: number; material?: string; passages: WorldPassage[] }
export interface WorldTracer { trace(origin: Vec3, dir: Vec3, range: number): WorldTrace }

/** `armored`: armor and helmet (never wears down). */
export interface ShotTarget { id: string; history: RecordHistory; alive: boolean; hp: number; armored?: boolean }

export interface ShotContext {
  shooterId: string;
  tick: number;
  bullet: 1 | 2;
  aim: { origin: Vec3; dir: Vec3 };
  weaponId: string;
  ticksSinceLastShot: number;
  target?: ShotTarget;
  viewTick: number;
  resolver: ResolverMemory;
  observations: readonly Observation[];
  world: WorldTracer;
  spreadSeed: number;
  /** Cone half-angle, radians (e.g. hvhSpread with movement). Defaults to the standing spread. */
  spread?: number;
}

export interface ShotVerdict {
  shooterId: string;
  targetId?: string;
  tick: number;
  bullet: 1 | 2;
  cause: VerdictCause;
  damage?: number;
  hitgroup?: string;
  remainingHp?: number;
  guessed?: Side;
  real?: Side;
  invalidCause?: InvalidCause;
  material?: string;
  reason?: string;
}

/** Retained damage below this counts as fully absorbed by penetration. */
export const ABSORBED_DAMAGE = 1;
const UNKNOWN_MATERIAL = 'world';

/** Wraps traceHvhCover (ballistics.ts) and names materials of the boxes it reports. */
export function collisionWorldTracer(
  world: CollisionWorld,
  isSoft: (id: number) => boolean,
  materialOf: (id: number) => string,
): WorldTracer {
  return {
    trace(origin, dir, range) {
      const ray = makeRay(origin, dir);
      const cover = traceHvhCover(ray, world, range, isSoft);
      // Replay traceHvhCover's raycast sequence to learn which ids it passed and stopped at.
      const skip = new Set<number>(world.seeThrough);
      const ids: (number | undefined)[] = [];
      for (let i = 0; i <= cover.passages.length; i++) {
        const hit = raycastWorld(ray, world, range, skip);
        ids.push(hit?.id);
        if (hit?.id !== undefined) skip.add(hit.id);
      }
      const name = (id: number | undefined): string => (id === undefined ? UNKNOWN_MATERIAL : materialOf(id));
      const out: WorldTrace = {
        wallDistance: cover.wallDistance,
        passages: cover.passages.map((p, i) => ({ ...p, material: name(ids[i]) })),
      };
      if (cover.wallDistance < range) out.material = name(ids[cover.passages.length]);
      return out;
    },
  };
}

export function fireIntervalTicks(w: WeaponDef, tickRate: number = LATE_CSGO.tickRate): number {
  return Math.ceil((w.fireInterval * tickRate) / 1000);
}

/**
 * The R8's hammer pull in commands, rounded up like the fire interval (0 for every other gun): bullet
 * 1 needs this many commands run with the trigger held before the shot's command.
 */
export function hammerTicks(w: WeaponDef, tickRate: number = LATE_CSGO.tickRate): number {
  return w.csgo?.hammerMs ? Math.ceil((w.csgo.hammerMs * tickRate) / 1000) : 0;
}

/**
 * Commands a pulled-back hammer waits for the shot (250 ms: the R8's cycle after a quick re-press,
 * a switch, a scan). Past it the hammer drops and the held trigger pulls it again, so it cannot be
 * kept cocked for an instant shot at any time (CS:GO fires a held R8 as soon as it is back).
 */
export const HAMMER_GRACE = 16;

/**
 * The trigger hold after one more command: the held commands so far (this one included), 0 when
 * it is up. A hold already past hammerTicks + HAMMER_GRACE starts over at this command. The server,
 * the client's prediction and the bots all step it once per command; a command fires bullet 1 when
 * the commands before it, `hold - 1`, reach hammerTicks.
 */
export function stepHammerHold(hold: number, held: boolean, w: WeaponDef): number {
  if (!held) return 0;
  return hold > hammerTicks(w) + HAMMER_GRACE ? 1 : hold + 1;
}

function finite(v: Vec3): boolean {
  return Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);
}

/** Hitbox matrix of a lag record in `pose` (crouch-scaled); the tracing processShot uses. */
export function poseMatrix(record: LagRecord, pose: PoseState): HvhMatrix {
  const duck = clamp(Number.isFinite(record.duck) ? record.duck! : 0, 0, 1);
  return buildHvhMatrix(record.position, pose.bodyYaw, 1 - duck * 0.3, pose.pitch);
}

/** The record's pose with bodyYaw mirrored onto `side`, keeping the desync magnitude. */
export function guessedPose(real: PoseState, side: Side): PoseState {
  const magnitude = Math.abs(wrapAngle(real.bodyYaw - real.eyeYaw));
  const sign = side === 'left' ? 1 : side === 'right' ? -1 : 0;
  return { ...real, bodyYaw: wrapAngle(real.eyeYaw + magnitude * sign), realSide: side };
}

function nearest(a: HvhHit | null, b: HvhHit | null): HvhHit | null {
  return a && b ? (a.t <= b.t ? a : b) : a ?? b;
}

/** The damage of one pellet's hit, after the target's armor (`armorPen`, absent when unarmored). */
function pelletDamage(w: WeaponDef, hit: HvhHit, trace: WorldTrace, armorPen: number | undefined): number {
  return hvhHitDamage(w, hit, trace) * (armorPen !== undefined && hit.group !== 'leg' ? armorPen : 1);
}

/** Material that stops or fully absorbs the bullet (after armor) before `hit`, or null if it gets through. */
function obstruction(w: WeaponDef, hit: HvhHit, trace: WorldTrace, armorPen: number | undefined): string | null {
  if (trace.wallDistance < hit.t) return trace.material ?? UNKNOWN_MATERIAL;
  if (pelletDamage(w, hit, trace, armorPen) >= ABSORBED_DAMAGE) return null;
  const before = trace.passages.filter((p) => p.entry < hit.t);
  return before[before.length - 1]?.material ?? UNKNOWN_MATERIAL;
}

function rejectReason(ctx: ShotContext, w: WeaponDef | null, dirLength: number): string | null {
  if (!w) return 'unknown weapon';
  if (!finite(ctx.aim.origin) || !finite(ctx.aim.dir) || !(dirLength > 0)) return 'invalid aim';
  if (fireIntervalTicks(w) > ctx.ticksSinceLastShot) return 'fire interval';
  if (ctx.target && !ctx.target.alive) return 'target already dead';
  return null;
}

export function processShot(ctx: ShotContext): ShotVerdict {
  const out: ShotVerdict = { shooterId: ctx.shooterId, tick: ctx.tick, bullet: ctx.bullet, cause: 'spread' };
  const target = ctx.target;
  if (target) out.targetId = target.id;

  const def = isWeaponId(ctx.weaponId) ? WEAPONS[ctx.weaponId] : undefined;
  const w = def && !def.projectile && !def.melee ? hvhWeapon(def) : null;
  const { origin, dir: rawDir } = ctx.aim;
  const dirLength = Math.hypot(rawDir.x, rawDir.y, rawDir.z);
  const reason = rejectReason(ctx, w, dirLength);
  if (reason !== null || !w) return { ...out, cause: 'rejected', reason: reason ?? 'unknown weapon' };
  if (!target) return out;

  const view = Math.min(ctx.viewTick, ctx.tick);
  const selection = target.history.select(view, ctx.tick);
  if ('invalid' in selection) return { ...out, cause: 'invalidRecord', invalidCause: selection.invalid };
  const record = selection.record;

  const dir = { x: rawDir.x / dirLength, y: rawDir.y / dirLength, z: rawDir.z / dirLength };
  const aimRay: Ray = makeRay(origin, dir);
  const aimTrace = ctx.world.trace(origin, dir, w.range);
  const realMatrix = poseMatrix(record, record.pose);
  const peeked = peekResolve(ctx.resolver, target.id, ctx.observations, view).side;
  const aimHit = nearest(
    rayHvhMatrix(aimRay, realMatrix, w.range),
    rayHvhMatrix(aimRay, poseMatrix(record, guessedPose(record.pose, peeked)), w.range),
  );
  const armorPen = target.armored ? w.csgo?.armorPen : undefined;
  const blockedBy = aimHit ? obstruction(w, aimHit, aimTrace, armorPen) : null;
  if (blockedBy !== null) return { ...out, cause: 'obstruction', material: blockedBy };

  const guessed = resolve(ctx.resolver, target.id, ctx.observations, view).side;
  out.guessed = guessed;
  out.real = record.pose.realSide;

  const spread = ctx.spread ?? hvhSpread(w, 0, false, false);
  let damage = 0;
  let best: { group: string; damage: number } | null = null;
  for (const d of pelletDirections(w, dir, spread, ctx.spreadSeed)) {
    const trace = ctx.world.trace(origin, d, w.range);
    const hit = rayHvhMatrix(makeRay(origin, d), realMatrix, trace.wallDistance);
    if (!hit) continue;
    const amount = pelletDamage(w, hit, trace, armorPen);
    damage += amount;
    if (!best || amount > best.damage) best = { group: hit.group, damage: amount };
  }
  if (best) {
    return { ...out, cause: 'hit', damage, hitgroup: best.group, remainingHp: Math.max(0, target.hp - damage) };
  }

  const guessedMatrix = poseMatrix(record, guessedPose(record.pose, guessed));
  const hitsGuessed = rayHvhMatrix(aimRay, guessedMatrix, aimTrace.wallDistance) !== null;
  const hitsReal = rayHvhMatrix(aimRay, realMatrix, aimTrace.wallDistance) !== null;
  return { ...out, cause: hitsGuessed && !hitsReal ? 'resolver' : 'spread' };
}
