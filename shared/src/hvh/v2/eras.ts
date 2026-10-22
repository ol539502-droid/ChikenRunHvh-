import { LATE_CSGO, type EraTable } from './era';

/**
 * The four era profiles the legacy HvH panel offered, as era tables, plus LATE_CSGO (the default
 * and the only table the server runs). Selecting one in the panel is stored in the config only.
 * Legacy profiles kept a few real limits; every other field had no legacy value and uses LATE_CSGO's.
 */
function legacyProfile(id: string, overrides: Partial<EraTable> = {}): EraTable {
  return Object.freeze({
    ...LATE_CSGO,
    id,
    // Legacy choke limit: fakeLagTicks and CommandChoker clamp to 0-12 commands.
    maxChoke: 12,
    // Legacy rewind window: MAX_REWIND_MS (300 ms) in record validity.
    lagCompWindowMs: 300,
    // Legacy desync limit: HVH.maxDesync (58 deg), the same in every legacy era.
    maxDesyncDeg: 58,
    // Legacy charge: the 32-unit charge maps onto the 32-tick charge-and-burst model.
    chargeTicks: 32,
    // maxProcessTicks, desyncRunFalloff and lagCompBreakHulls had no legacy equivalent: LATE_CSGO's values.
    ...overrides,
  });
}

export const DEFAULT_ERA_ID = 'late-csgo';

export const ERAS: Readonly<Record<string, EraTable>> = Object.freeze({
  // Legacy also rotated the requested yaw base by 90 deg; that is a pose rule, not an era-table field.
  legacy: legacyProfile('legacy'),
  desync: legacyProfile('desync'),
  tickbase: legacyProfile('tickbase'),
  defensive: legacyProfile('defensive'),
  [DEFAULT_ERA_ID]: LATE_CSGO,
});
