import type { ShotVerdict } from './shot';
import type { TickbaseReject } from './tickbase';

/*
 * Hit-log copy for every VerdictCause. Damage is rounded to an integer for display (GameRoom
 * rounds damage the same way, Math.round); remaining HP is round(hp before) - round(damage), so
 * the two shown numbers add up. The verdict keeps exact values.
 * Missing fields render as '?' so a malformed verdict still produces a line.
 */

const TICKBASE_REASONS: Record<TickbaseReject, string> = {
  dtNotCharged: 'double tap not charged',
  hsNotCharged: 'hide shots not charged',
};

/** The `reason` to put on a 'tickbase' verdict built from a tickbase reject. */
export function tickbaseVerdictReason(reject: TickbaseReject): string {
  return TICKBASE_REASONS[reject];
}

function int(n: number | undefined): string {
  return n === undefined || !Number.isFinite(n) ? '?' : String(Math.round(n));
}

/** Remaining HP from the rounded HP-before minus the rounded damage, so the shown numbers add up. */
function remaining(v: ShotVerdict): string {
  const { damage, remainingHp } = v;
  if (damage === undefined || remainingHp === undefined || !Number.isFinite(damage) || !Number.isFinite(remainingHp)) {
    return int(remainingHp);
  }
  // remainingHp is 0 on overkill, so this is 0 there too.
  return String(Math.max(0, Math.round(remainingHp + damage) - Math.round(damage)));
}

export function formatVerdict(v: ShotVerdict, nameOf: (id: string) => string): string {
  switch (v.cause) {
    case 'hit':
      return `Hit ${v.targetId === undefined ? '?' : nameOf(v.targetId)} in the ${v.hitgroup ?? '?'} for ${int(v.damage)} (${remaining(v)} remaining)`;
    case 'resolver':
      return `Missed shot due to resolver (guessed ${v.guessed ?? '?'}, real ${v.real ?? '?'})`;
    case 'spread':
      return 'Missed shot due to spread';
    case 'invalidRecord':
      return `Missed shot: target record invalid (${v.invalidCause ?? '?'})`;
    case 'obstruction':
      return `Missed shot: blocked by ${v.material ?? '?'}`;
    case 'tickbase':
      return `Shot not fired: ${v.reason ?? '?'}`;
    case 'rejected':
      return `Shot rejected: ${v.reason ?? '?'}`;
    default: {
      const unreachable: never = v.cause;
      return unreachable;
    }
  }
}
