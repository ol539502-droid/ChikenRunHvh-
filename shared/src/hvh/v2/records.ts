import type { Vec3 } from '../../math';
import { type EraTable, lagCompWindowTicks } from './era';
import type { PoseState } from './pose';

/*
 * Lag-compensation record history for one player.
 *
 * Semantics:
 * - Up axis is y (physics.ts integrates gravity on s.y; the hull is 2r x height x 2r with height on y).
 *   The lag-comp break distance is horizontal only (x/z), matching CS:GO's Length2DSqr teleport
 *   check, so jumping or falling never breaks lag compensation.
 * - A record is expired when nowTick - record.tick > lagCompWindowTicks(era) (12 at 64 Hz):
 *   now-12 is still usable, now-13 is expired. A view tick older than the window is 'expired'
 *   whether or not a record exists there.
 * - Break: when a pushed record is more than lagCompBreakHulls x hullWidth horizontally from the
 *   previous record, every older record becomes 'lagcompBreak'. The new record stays valid, and
 *   the older ones stay invalid for good.
 * - An invalid record keeps the first cause it received; later breaks don't relabel it.
 * - Choke gap: a view tick with no exact record selects the last record before it, with that
 *   record's validity. If that record is expired or there is none, the answer is 'choked'.
 * - Pushed ticks must strictly increase. Records more than 2 windows behind the newest record
 *   are pruned; they are expired for any nowTick >= the newest tick, so answers don't change.
 * - Records are stored as frozen copies, so callers can't mutate history through select/records.
 */

export type InvalidCause = 'expired' | 'lagcompBreak' | 'choked';

export interface LagRecord {
  tick: number;
  position: Vec3;
  pose: PoseState;
  valid: boolean;
  invalidCause?: InvalidCause;
  /** Crouch amount 0..1; absent means standing (0). */
  duck?: number;
}

export type RecordSelection = { record: LagRecord } | { invalid: InvalidCause };

function freezeRecord(r: LagRecord, valid: boolean, invalidCause?: InvalidCause): LagRecord {
  const out: LagRecord = {
    tick: r.tick,
    position: Object.freeze({ x: r.position.x, y: r.position.y, z: r.position.z }),
    pose: Object.freeze({ ...r.pose }),
    valid,
  };
  if (!valid) out.invalidCause = invalidCause;
  if (r.duck !== undefined) out.duck = r.duck;
  return Object.freeze(out);
}

export class RecordHistory {
  private readonly window: number;
  private readonly breakDistSq: number;
  private list: LagRecord[] = [];

  constructor(era: EraTable, hullWidth: number) {
    this.window = lagCompWindowTicks(era);
    const d = era.lagCompBreakHulls * hullWidth;
    this.breakDistSq = d * d;
  }

  push(r: LagRecord): void {
    const prev = this.list[this.list.length - 1];
    if (prev && r.tick <= prev.tick) {
      throw new RangeError(`record tick ${r.tick} must be after ${prev.tick}`);
    }
    if (!r.valid && !r.invalidCause) throw new RangeError('an invalid record needs an invalidCause');
    if (prev) {
      const dx = r.position.x - prev.position.x;
      const dz = r.position.z - prev.position.z;
      if (dx * dx + dz * dz > this.breakDistSq) this.invalidate(() => true, 'lagcompBreak');
    }
    this.list.push(freezeRecord(r, r.valid, r.invalidCause));
    this.prune(r.tick);
  }

  select(viewTick: number, nowTick: number): RecordSelection {
    if (nowTick - viewTick > this.window) return { invalid: 'expired' };
    let found: LagRecord | undefined;
    for (let i = this.list.length - 1; i >= 0; i--) {
      if (this.list[i]!.tick <= viewTick) {
        found = this.list[i];
        break;
      }
    }
    if (!found) return { invalid: 'choked' };
    if (found.tick !== viewTick && nowTick - found.tick > this.window) return { invalid: 'choked' };
    return found.valid ? { record: found } : { invalid: found.invalidCause! };
  }

  /** Every retained record, oldest first, valid and invalid. For the debug overlay. */
  records(): readonly LagRecord[] {
    return Object.freeze(this.list.slice());
  }

  private invalidate(match: (r: LagRecord) => boolean, cause: InvalidCause): void {
    this.list = this.list.map((r) => (r.valid && match(r) ? freezeRecord(r, false, cause) : r));
  }

  private prune(newestTick: number): void {
    const keepFrom = newestTick - 2 * this.window;
    let drop = 0;
    while (drop < this.list.length && this.list[drop]!.tick < keepFrom) drop++;
    if (drop > 0) this.list.splice(0, drop);
  }
}
