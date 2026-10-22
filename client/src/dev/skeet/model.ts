import { defaultHvhCore, defaultSkeetAntiAim, type HvhCoreSettings, type SkeetAntiAim, type WeaponDef } from '@game/shared';
import { DEFAULT_ERA_ID, HVH_MAINS, HVH_PISTOLS } from '@game/shared/hvh/v2';
import type { DevConfig } from '../config';
import { defaultNativeValues } from './nativeFields';

/** One weapon profile per v2 arsenal gun: SSG 08, SCAR-20, Desert Eagle, R8 Revolver. */
export const SKEET_PROFILE_IDS = [...HVH_MAINS, ...HVH_PISTOLS] as const;
export type SkeetProfileId = typeof SKEET_PROFILE_IDS[number];
export interface WeaponProfile {
  minDamage: number;
  hitchance: number;
  bodyAim: 'off' | 'prefer' | 'lethal';
  multipoint: boolean;
  pointScale: number;
  safePoints: boolean;
  autoStop: boolean;
  autoScope: boolean;
}
export interface SkeetConfig {
  native: Record<string, number>;
  profiles: Record<SkeetProfileId, WeaponProfile>;
  resolver: { mode: 'adaptive' | 'center'; history: number; memoryMs: number; preferBodyBelow: number; missedShots: number };
  antiAim: SkeetAntiAim;
  fakeLag: { enabled: boolean; limit: number; mode: HvhCoreSettings['fakeLagMode']; breakOnShot: boolean };
  indicators: { binds: boolean; watermark: boolean };
  cosmetics: { enabled: boolean; tint: string };
  /** Selected era table (an ERAS key). Stored only: the server always runs LATE_CSGO. */
  era: string;
}
export function defaultSkeetConfig(): SkeetConfig {
  const pistol: WeaponProfile = { minDamage: 20, hitchance: 60, bodyAim: 'lethal', multipoint: true,
    pointScale: 50, safePoints: true, autoStop: true, autoScope: false };
  const sniper: WeaponProfile = { ...pistol, minDamage: 45, hitchance: 75, pointScale: 35, autoScope: true };
  const profiles: SkeetConfig['profiles'] = { ssg08: { ...sniper }, scar20: { ...sniper }, deserteagle: { ...pistol }, r8: { ...pistol } };
  return { native: defaultNativeValues(), profiles, resolver: { mode: 'adaptive', history: 8, memoryMs: 700,
    preferBodyBelow: 60, missedShots: 2 }, antiAim: defaultSkeetAntiAim(),
    fakeLag: { enabled: false, limit: 6, mode: 'static', breakOnShot: true },
    indicators: { binds: true, watermark: true }, cosmetics: { enabled: false, tint: '#b6d77a' }, era: DEFAULT_ERA_ID };
}
/**
 * The weapon's own profile. Legacy-room guns: scoped ones use the Scout's; everything else uses the
 * Deagle's, whose defaults are the old base profile, so legacy rooms aim as before by default (R68).
 */
export function skeetProfileId(w: WeaponDef): SkeetProfileId {
  if ((SKEET_PROFILE_IDS as readonly string[]).includes(w.id)) return w.id as SkeetProfileId;
  return w.scope ? 'ssg08' : 'deserteagle';
}
export function skeetProfile(c: DevConfig, w: WeaponDef): WeaponProfile {
  return c.skeet.profiles[skeetProfileId(w)];
}
/** Keep the shared runtime, while each panel supplies its own decisions and weapon policy. */
export function skeetEffectiveConfig(c: DevConfig, w: WeaponDef): DevConfig {
  const profile = skeetProfile(c, w);
  return { ...c, hvh: { ...c.hvh, core: skeetFakeLagCore(c), aim: { ...c.hvh.aim, minDamage: profile.minDamage,
    hitchance: profile.hitchance, bodyAim: profile.bodyAim }, movement: { ...c.hvh.movement, autoStop: profile.autoStop } } };
}

export function skeetFakeLagCore(c: DevConfig): HvhCoreSettings {
  const lag = c.skeet.fakeLag;
  // Anti-bruteforce was removed from the panel: legacy rooms read it as off until cutover.
  return {...defaultHvhCore(),...c.hvh.core, antiBruteforce: false, fakeLag: lag.enabled ? lag.limit : 0, fakeLagMode: lag.mode, fakeLagBreakOnShot: lag.breakOnShot};
}
