import { CHICKEN_POSE } from '../../chickenPose';

export interface EraTable {
  id: string;
  tickRate: 64;
  maxProcessTicks: number;
  /** Ticks a DT or hide-shots charge stores (the charging stop's length), all spent by one burst. */
  chargeTicks: number;
  maxChoke: number;
  lagCompWindowMs: number;
  maxDesyncDeg: number;
  /** Largest |pitch| a pose may take, degrees (the hitbox head pose clamps here too). */
  maxPitchDeg: number;
  desyncRunFalloff: number;
  lagCompBreakHulls: number;
}

export const LATE_CSGO: EraTable = Object.freeze({
  id: 'late-csgo',
  tickRate: 64,
  maxProcessTicks: 16,
  chargeTicks: 32,
  maxChoke: 14,
  lagCompWindowMs: 200,
  maxDesyncDeg: 58,
  // CHICKEN_POSE.pitchLimit (1.2 rad, about 68.75 deg): beyond it the head pose no longer moves.
  maxPitchDeg: (CHICKEN_POSE.pitchLimit * 180) / Math.PI,
  desyncRunFalloff: 0.5,
  lagCompBreakHulls: 2,
});

export function validateEra(t: EraTable): string[] {
  const errors: string[] = [];
  // Written as !(ok) so a NaN field fails the check instead of slipping through a false comparison.
  if (!(t.maxChoke <= t.maxProcessTicks)) {
    errors.push('maxChoke exceeds maxProcessTicks');
  }
  if (!(Number.isInteger(t.chargeTicks) && t.chargeTicks >= 1 && t.chargeTicks <= 64)) {
    errors.push('chargeTicks not an integer in [1,64]');
  }
  if (!(t.desyncRunFalloff >= 0 && t.desyncRunFalloff <= 1)) {
    errors.push('desyncRunFalloff out of range [0,1]');
  }
  return errors;
}

export function lagCompWindowTicks(t: EraTable): number {
  return Math.floor((t.lagCompWindowMs * t.tickRate) / 1000);
}
