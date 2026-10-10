import { lerp, lerpAngle, MAX_REWIND_MS } from '@game/shared';

export interface HistorySample {
  broken?: boolean;
  t: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch?: number;
  alive: boolean;
  /** Body scale (smaller while crouched). */
  scale: number;
}

/**
 * Recent positions of one player, recorded every server tick. Used to rewind targets to the
 * moment a shooter saw them (lag compensation).
 */
export class History {
  private readonly samples: HistorySample[] = [];
  private readonly capacity: number;

  constructor(capacity = 90) {
    this.capacity = capacity;
  }

  push(sample: HistorySample): void {
    const last = this.samples.at(-1);
    if (last && Math.hypot(last.x - sample.x, last.y - sample.y, last.z - sample.z) > 8) sample = { ...sample, broken: true };
    this.samples.push(sample);
    if (this.samples.length > this.capacity) this.samples.shift();
  }

  clear(): void {
    this.samples.length = 0;
  }
  /** Never clamp an invalid historical command into an unrelated valid life or teleport. */
  atValid(t: number, now: number): HistorySample | null {
    const first = this.samples[0], last = this.samples.at(-1);
    if (!first || !last || t < first.t || t > now + 16 || now - t > MAX_REWIND_MS) return null;
    const sample = this.at(t);
    return sample?.alive && !sample.broken ? sample : null;
  }

  /** Interpolated state at time `t`, clamped to the recorded range. */
  at(t: number): HistorySample | null {
    const s = this.samples;
    if (s.length === 0) return null;
    if (t <= s[0]!.t) return s[0]!;
    const last = s[s.length - 1]!;
    if (t >= last.t) return last;
    // Binary search for the last sample at or before t.
    let lo = 0;
    let hi = s.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (s[mid]!.t <= t) lo = mid;
      else hi = mid;
    }
    const a = s[lo]!;
    const b = s[hi]!;
    const k = (t - a.t) / (b.t - a.t);
    return {
      t,
      x: lerp(a.x, b.x, k),
      y: lerp(a.y, b.y, k),
      z: lerp(a.z, b.z, k),
      yaw: lerpAngle(a.yaw, b.yaw, k),
      pitch: lerp(a.pitch ?? 0, b.pitch ?? 0, k),
      alive: a.alive && b.alive,
      scale: lerp(a.scale, b.scale, k),
      broken: a.broken || b.broken,
    };
  }
}
