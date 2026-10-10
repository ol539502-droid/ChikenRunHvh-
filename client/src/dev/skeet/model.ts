import { defaultHvhCore, defaultSkeetAntiAim, type HvhCoreSettings, type SkeetAntiAim, type WeaponDef } from '@game/shared';
import type { DevConfig } from '../config';
import { defaultNativeValues } from './nativeFields';

export const SKEET_GROUPS = ['general', 'pistols', 'rifles', 'snipers', 'shotguns', 'smgs', 'heavy'] as const;
export type SkeetGroup = typeof SKEET_GROUPS[number];
export interface WeaponProfile {
  enabled: boolean;
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
  profiles: Record<SkeetGroup, WeaponProfile>;
  resolver: { mode: 'adaptive' | 'center'; history: number; memoryMs: number; preferBodyBelow: number; missedShots: number };
  antiAim: SkeetAntiAim;
  fakeLag: { enabled: boolean; limit: number; mode: HvhCoreSettings['fakeLagMode']; breakOnShot: boolean };
  indicators: { resolver: boolean; binds: boolean; watermark: boolean };
  cosmetics: { enabled: boolean; tint: string };
}
export function defaultSkeetConfig(): SkeetConfig {
  const base: WeaponProfile = { enabled: true, minDamage: 20, hitchance: 60, bodyAim: 'lethal', multipoint: true,
    pointScale: 50, safePoints: true, autoStop: true, autoScope: false };
  const profiles = Object.fromEntries(SKEET_GROUPS.map(id => [id, { ...base }])) as SkeetConfig['profiles'];
  Object.assign(profiles.snipers, { minDamage: 45, hitchance: 75, pointScale: 35, autoScope: true });
  Object.assign(profiles.shotguns, { minDamage: 25, hitchance: 55, bodyAim: 'prefer' });
  Object.assign(profiles.smgs, { minDamage: 12, hitchance: 55 });
  return { native: defaultNativeValues(), profiles, resolver: { mode: 'adaptive', history: 8, memoryMs: 700,
    preferBodyBelow: 60, missedShots: 2 }, antiAim: defaultSkeetAntiAim(),
    fakeLag: { enabled: false, limit: 6, mode: 'static', breakOnShot: true },
    indicators: { resolver: true, binds: true, watermark: true }, cosmetics: { enabled: false, tint: '#b6d77a' } };
}
export function skeetWeaponGroup(w: WeaponDef): SkeetGroup {
  if (w.melee || w.projectile) return 'general';
  if (w.scope) return 'snipers';
  if (w.pellets > 1) return 'shotguns';
  if (['pistol', 'mpistol', 'revolver', 'deagle', 'fiveseven', 'dualies', 'silenced'].includes(w.id)) return 'pistols';
  if (['smg'].includes(w.id)) return 'smgs';
  if (['minigun', 'lmg'].includes(w.id)) return 'heavy';
  return 'rifles';
}
export function skeetProfile(c: DevConfig, w: WeaponDef): WeaponProfile {
  const specific = c.skeet.profiles[skeetWeaponGroup(w)];
  return specific.enabled ? specific : c.skeet.profiles.general;
}
/** Keep the shared runtime, while each panel supplies its own decisions and weapon policy. */
export function skeetEffectiveConfig(c: DevConfig, w: WeaponDef): DevConfig {
  const profile = skeetProfile(c, w);
  return { ...c, hvh: { ...c.hvh, core: skeetFakeLagCore(c), aim: { ...c.hvh.aim, minDamage: profile.minDamage,
    hitchance: profile.hitchance, bodyAim: profile.bodyAim }, movement: { ...c.hvh.movement, autoStop: profile.autoStop } } };
}

export function skeetFakeLagCore(c: DevConfig): HvhCoreSettings {
  const lag = c.skeet.fakeLag;
  return {...defaultHvhCore(),...c.hvh.core, fakeLag: lag.enabled ? lag.limit : 0, fakeLagMode: lag.mode, fakeLagBreakOnShot: lag.breakOnShot};
}
