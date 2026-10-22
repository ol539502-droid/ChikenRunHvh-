/*
 * HUD text for round-based matches. A v2 HvH room plays rounds (shared rounds.ts: first to 13,
 * sides swap after 12), not the HvH mode's kill limit, which is the legacy engine's (modes.ts keeps
 * that description: the menu cannot know the server's engine before joining).
 */
import type { ModeDef } from '@game/shared';

/** A rounds match's win condition, as the HUD shows it. */
export interface RoundsRule {
  readonly roundsToWin: number;
  readonly halfAfter: number;
}

/** The objective line for a v2 HvH rounds match. */
export function roundsObjective(rule: RoundsRule): string {
  return `First to ${rule.roundsToWin} rounds · sides switch after ${rule.halfAfter}`;
}

/** The number a team score counts up to: rounds to win in a rounds match, else the mode's limit. */
export function scoreTarget(mode: ModeDef, rule: RoundsRule | null): number {
  return rule ? rule.roundsToWin : mode.scoreLimit;
}

/**
 * The warmup banner in its last 5 seconds: the next round is `played + 1` (a warmup's round is the
 * rounds played: 0 before the first, more after a pause). Empty before then and while it waits.
 */
export function warmupBanner(played: number, leftMs: number | null): string {
  return leftMs !== null && leftMs < 5000 ? `Round ${played + 1} in ${Math.max(1, Math.ceil(leftMs / 1000))}` : '';
}
