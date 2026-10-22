import { clamp, normalize, type Vec3 } from '../math';
import { makeRay } from '../raycast';
import type { CollisionWorld } from '../collision';
import type { WeaponDef } from '../weapons';
import type { ObservableRecord } from './animation';
import { armoredDamage, hvhHitchance, hvhHitDamage, traceHvhCover, traceHvhMatrices, type HitchanceHypothesis } from './ballistics';
import { buildHvhMatrix, matrixPoints, pointSafety, rayHvhMatrix, type HvhHitgroup, type HvhMatrix } from './geometry';
import { recordValidity, type HypothesisSource, type ResolverSystem, type ShotReason } from './resolver';
export interface RageSettings {
  resolverPolicy?: import('./resolver').ResolverPolicy;
  preferBodyBelow?: number;
  bodyAfterMisses?: number;
  groups?: HvhHitgroup[];
  priority?: 'crosshair' | 'distance' | 'health';
  burstReady?: boolean;
  resolver: boolean; forceSafe: boolean; preferSafe: boolean; body: 'off' | 'prefer' | 'force' | 'lethal';
  minDamage: number; hpRelative?: number; hitchance: number; pointScale: number; maxRecords: number;
  damageWeight: number; safetyWeight: number; accuracyWeight: number; confidenceWeight: number;
}
export const DEFAULT_RAGE: RageSettings = { resolver: true, forceSafe: false, preferSafe: true, body: 'off',
  minDamage: 20, hitchance: 0.55, pointScale: 0.65, maxRecords: 3, damageWeight: 1, safetyWeight: 20, accuracyWeight: 15, confidenceWeight: 15 };
export interface ShotCandidate {
  target: number; record: ObservableRecord; source: HypothesisSource; yaw: number; point: Vec3; group: HvhHitgroup;
  direction: Vec3; damage: number; chance: number; safety: number; confidence: number; score: number; lethal: boolean; scope: boolean; stop?: boolean; stopSpeed?: number;
}
export interface RageScan {
  heat?: number;
  viewDirection?: Vec3;
  forceDirection?: Vec3;
  allowScope?: boolean;
  allowStop?: boolean;
  /** Preferred auto-stop speed; stationary remains the fallback when walking cannot meet accuracy. */
  stopSpeed?: number;
  scoreCandidate?: (candidate: ShotCandidate) => number;
  playerRules?: ReadonlyMap<number, { ignore: boolean; body: boolean }>;
  /** Spread samples per hitchance estimate (default 32). */
  samples?: number;
  now: number; eye: Vec3; w: WeaponDef; speed: number; airborne: boolean; ads: boolean; world: CollisionWorld;
  records: readonly ObservableRecord[]; resolver: ResolverSystem; settings: RageSettings; isSoft?: (id: number) => boolean; currentTarget?: number;
}
/** Cheap geometry gates precede spread samples. Bound expensive work independently of display Hz. */
export function scanRage(input: RageScan): ShotCandidate | null {
  if (input.w.projectile || input.w.melee) return null;
  const { settings: s } = input, cheap: ShotCandidate[] = [];
  // Spread can hit other groups; legacy armor applies to the whole pellet sum. An upper bound: the leg takes no CS:GO armor.
  const maximumDamage = input.w.damage * input.w.pellets * Math.max(input.w.headshotMultiplier, 1.15);
  const uncertaintyByRecord = new Map<ObservableRecord, HitchanceHypothesis[]>();
  const counts = new Map<number, number>();
  for (const record of input.records) {
    const rule = input.playerRules?.get(record.pid); if (rule?.ignore) continue;
    if (recordValidity(record, input.now) !== 'VALID') continue;
    const count = counts.get(record.pid) ?? 0; if (count >= s.maxRecords) continue; counts.set(record.pid, count + 1);
    if (armoredDamage(input.w, maximumDamage, 'leg', record.armor) < (s.hpRelative === undefined ? Math.min(record.hp, s.minDamage) : record.hp + s.hpRelative)) continue;
    const r = input.resolver.resolve(record, s.resolver, undefined, s.resolverPolicy);
    const plausible = s.resolver ? r : input.resolver.resolve(record, true, undefined, s.resolverPolicy);
    uncertaintyByRecord.set(record, r.hypotheses.map(h => ({ probability: h.probability,
      matrix: buildHvhMatrix(record.origin, h.yaw, 1 - record.crouch * 0.3, record.pitch) })));
    const hypotheses = r.hypotheses.slice(0, 3), all = plausible.hypotheses.filter(h => h.probability >= 0.04 || ['LEFT', 'CENTER', 'RIGHT'].includes(h.source)).map(h => buildHvhMatrix(record.origin, h.yaw, 1 - record.crouch * 0.3, record.pitch));
    for (const h of hypotheses) {
      const matrix = buildHvhMatrix(record.origin, h.yaw, 1 - record.crouch * 0.3, record.pitch);
      const body = rule?.body || s.body === 'force' || r.confidence < (s.preferBodyBelow ?? 0)
        || ((s.bodyAfterMisses ?? 0) > 0 && r.misses >= s.bodyAfterMisses!);
      const groups: HvhHitgroup[] = body ? ['stomach', 'chest', 'pelvis'] : s.groups ?? ['head', 'stomach', 'chest'];
      const pointScale = s.pointScale <= 0 ? 0 : clamp(s.pointScale * (0.5 + r.confidence * 0.5) / (1 + input.speed * 0.06), 0.15, 0.85);
      for (const { point } of matrixPoints(matrix, groups, pointScale)) {
        const direction = input.forceDirection ?? normalize({ x: point.x - input.eye.x, y: point.y - input.eye.y, z: point.z - input.eye.z });
        const { cover, hits: [hit] } = traceHvhMatrices(makeRay(input.eye, direction), [matrix], input.world, input.w.range, input.isSoft);
        if (!hit) continue;
        const group = hit.group;
        const damage = armoredDamage(input.w, hvhHitDamage(input.w, hit, cover) * input.w.pellets, group, record.armor);
        const rayPoint = input.forceDirection ? { x: input.eye.x + direction.x * 100, y: input.eye.y + direction.y * 100, z: input.eye.z + direction.z * 100 } : point;
        const safety = pointSafety(input.eye, rayPoint, all, group === 'head' ? ['head'] : ['chest', 'stomach', 'pelvis', 'arm', 'leg']);
        if (s.forceSafe && safety < 1) continue;
        const lethal = damage * (s.burstReady ? 2 : 1) >= record.hp;
        const confidence = group === 'head' ? h.probability : Math.max(h.probability, safety);
        const score = damage * confidence * s.damageWeight + safety * (s.preferSafe ? s.safetyWeight : 0)
          + r.confidence * s.confidenceWeight + (lethal ? 80 * safety : 0) - (input.now - record.t) * 0.035
          + (s.body === 'prefer' && group !== 'head' ? 12 : 0) + (s.body === 'lethal' && lethal && group !== 'head' ? 35 : 0)
          + (record.pid === input.currentTarget ? 8 : 0) - (record.defensive ? 18 : 0)
          - (s.priority === 'health' ? record.hp * 0.12 : s.priority === 'distance' ? Math.hypot(point.x - input.eye.x, point.z - input.eye.z) * 0.5
            : input.viewDirection ? (1 - direction.x * input.viewDirection.x - direction.y * input.viewDirection.y - direction.z * input.viewDirection.z) * 15 : 0);
        cheap.push({ target: record.pid, record, source: h.source, yaw: h.yaw, point, group, direction,
          damage, safety, chance: 0, confidence: r.confidence, score, lethal, scope: false });
      }
    }
  }
  cheap.sort((a, b) => b.score - a.score);
  if (input.scoreCandidate) { cheap.slice(0, 16).forEach(c => c.score += input.scoreCandidate!(c)); cheap.sort((a, b) => b.score - a.score); }
  let best: ShotCandidate | null = null;
  // Reserve first slots for points meeting damage; spread-only prospects remain eligible below.
  const shortlist = cheap.filter(c => c.damage >= (s.hpRelative === undefined ? Math.min(c.record.hp, s.minDamage) : c.record.hp + s.hpRelative)).slice(0, 4);
  // Keep room for a body fallback instead of spending the whole budget on duplicate head points.
  const seen = new Set<number>();
  for (const c of cheap) if (c.group !== 'head' && !seen.has(c.target)) {
    seen.add(c.target); if (!shortlist.includes(c)) shortlist.push(c); if (shortlist.length >= 7) break;
  }
  for (const c of cheap) { if (shortlist.length >= 8) break; if (!shortlist.includes(c)) shortlist.push(c); }
  for (const c of shortlist) {
    const matrix = buildHvhMatrix(c.record.origin, c.yaw, 1 - c.record.crouch * 0.3, c.record.pitch);
    const uncertainty = uncertaintyByRecord.get(c.record)!;
    const estimateAt = (speed: number, ads: boolean) => hvhHitchance(input.w, input.eye, c.direction, matrix, speed, input.airborne, ads, input.world, input.isSoft, input.samples ?? 32, input.heat, uncertainty, c.record.armor);
    const minimumDamage = s.hpRelative === undefined ? Math.min(c.record.hp, s.minDamage) : c.record.hp + s.hpRelative;
    const sufficient = (estimate: ReturnType<typeof hvhHitchance>) => estimate.chance >= s.hitchance && estimate.damage >= minimumDamage;
    let estimate = estimateAt(input.speed, input.ads);
    const scopeAllowed = input.w.scope && !input.ads && input.allowScope !== false;
    if (!sufficient(estimate) && scopeAllowed) {
      const scoped = estimateAt(input.speed, true);
      if (sufficient(scoped)) { estimate = scoped; c.scope = true; }
    }
    if (!sufficient(estimate) && input.speed > 0.5 && !input.airborne && input.allowStop !== false) {
      const preferred = clamp(input.stopSpeed ?? 0, 0, input.speed);
      stop: for (const speed of preferred > 0 ? [preferred, 0] : [0]) for (const ads of scopeAllowed ? [input.ads, true] : [input.ads]) {
        const stopped = estimateAt(speed, ads);
        if (sufficient(stopped)) { estimate = stopped; c.stop = true; c.stopSpeed = speed; c.scope = ads && !input.ads; break stop; }
      }
    }
    if (!sufficient(estimate)) continue;
    c.chance = estimate.chance; c.damage = estimate.damage;
    if (!c.stop && !input.airborne && input.allowStop !== false && (input.stopSpeed ?? 0) > 0) {
      const walking = estimateAt(input.stopSpeed!,input.ads || c.scope);
      // Keep a stationary fallback after stopping; otherwise the next scan starts walking again
      // before the weapon can fire, repeatedly losing its required accuracy.
      c.stopSpeed = sufficient(walking) ? input.stopSpeed : 0;
    }
    c.score += c.chance * s.accuracyWeight;
    if (!best || c.score > best.score) best = c;
  }
  return best;
}
export interface ShotIntent { target: number; recordT: number; source: HypothesisSource; yaw: number; safety?: number }
export interface ShotAudit { target: number; source: HypothesisSource; reason: ShotReason; recordT: number; damage: number; headshot?: boolean }
/** Post-shot audit owns ground truth. It returns only a classification, never hidden orientation. */
export function auditShot(intent: ShotIntent, eye: Vec3, direction: Vec3, actualDirections: readonly Vec3[],
  authoritative: HvhMatrix | null, recordValid: boolean, world: CollisionWorld, w: WeaponDef, isSoft?: (id: number) => boolean): ShotReason {
  if (!recordValid) return 'RECORD_INVALID'; if (!authoritative) return 'TARGET_DIED';
  const predicted = buildHvhMatrix(authoritative.origin, intent.yaw, authoritative.scale, authoritative.pitch);
  const straight = makeRay(eye, direction), cover = traceHvhCover(straight, world, w.range, isSoft);
  const predictedHit = rayHvhMatrix(straight, predicted, w.range), trueHit = rayHvhMatrix(straight, authoritative, w.range);
  if (predictedHit && cover.wallDistance < predictedHit.t) return 'OCCLUSION';
  const actualHit = actualDirections.some(dir => { const ray = makeRay(eye, dir); const obstacle = traceHvhCover(ray, world, w.range, isSoft); return !!rayHvhMatrix(ray, authoritative, obstacle.wallDistance); });
  if (actualHit) return 'HIT';
  if (predictedHit && !trueHit) return 'RESOLVER';
  if (trueHit) return 'SPREAD';
  return 'PREDICTION';
}
