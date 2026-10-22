import { WEAPONS } from '@game/shared';
import { V2_STANCES, type V2Stance } from '@game/shared/hvh/v2';
import type { Dev } from '../Dev';
import type { Binding, Control, Tab } from '../controls';
import { buildTabs } from '../tabs';
import { SKEET_PROFILE_IDS, skeetProfileId } from './model';
import { NATIVE_CONFIG_PATHS } from './nativeFields';

/** Each tab's picker selection, for this page session (not part of the saved config). */
const picks = new Map<string, string>();
const pick = (tab: string, first: string): Binding<string> => ({ get: () => picks.get(tab) ?? first, set: v => void picks.set(tab, v) });

const WEAPON_ICONS: Record<string, string> = { ssg08: '⌖', scar20: '⁂', deserteagle: '◖', r8: '⟳' };
const STANCE_ICONS: Record<V2Stance, string> = { standing: '▮', moving: '➜', airborne: '⤒', crouching: '▄', slowwalking: '⋯' };
const STANCE_NAMES: Record<V2Stance, string> = { standing: 'Standing', moving: 'Moving', airborne: 'In air', crouching: 'Crouching', slowwalking: 'Slow walk' };

/** SDK tab order, with native game features in place of Source-engine hooks. */
export function buildSkeetTabs(dev: Dev): Tab[] {
  const lab = buildTabs(dev);
  const sections = (id: string) => lab.find(t => t.id === id)!.sections;
  const toggle = (label: string, path: string, hint?: string): Control => ({ type: 'toggle', label, path, hint });
  const slider = (label: string, path: string, unit?: string, hint?: string): Control => ({ type: 'slider', label, path, unit, hint });
  const select = (label: string, path: string, hint?: string): Control => ({ type: 'select', label, path, hint });
  const info = (label: string, value: () => string, hint?: string): Control => ({ type: 'info', label, value, hint });
  const key = (label: string, path: string): Control => ({ type: 'key', label, path });
  const weaponPicker: Control = { type: 'picker', label: 'Weapon', keywords: 'profile scout auto deagle revolver', bind: pick('rage', SKEET_PROFILE_IDS[0]),
    options: SKEET_PROFILE_IDS.map(id => ({ value: id, label: WEAPONS[id].name, icon: WEAPON_ICONS[id]! })),
    sections: id => {
      const path = `skeet.profiles.${id}`;
      return [
        slider('Hit chance', `${path}.hitchance`, '%', 'Includes movement spread, recoil, cover and safe-point checks'),
        slider('Minimum damage', `${path}.minDamage`, 'HP', 'Estimated health damage after armor; lethal shots can pass'),
        { type: 'select', label: 'Hitboxes', path: `${path}.bodyAim`, options: [{ value: 'off', label: 'Head first' }, { value: 'prefer', label: 'Prefer body' }, { value: 'lethal', label: 'Body if lethal' }] },
        toggle('Multipoint', `${path}.multipoint`),
        slider('Point scale', `${path}.pointScale`, '%', 'Samples inside the chicken head and body hitboxes'),
        toggle('Safe points', `${path}.safePoints`, 'Require the ray to hit across observed stance uncertainty'),
        toggle('Auto-stop', `${path}.autoStop`),
        ...(WEAPONS[id as keyof typeof WEAPONS].scope ? [toggle('Auto-scope', `${path}.autoScope`, 'Scopes while tracking a target beyond 12 m')] : []),
      ];
    } };
  // R57: defensive on/off is stored per stance, and this one toggle writes all five.
  const defensive: Control = { type: 'toggle', label: 'Defensive', hint: 'On for every stance or off for every stance (shows on if any stance is on). Each stance sets its own pattern under its icon',
    bind: { get: () => V2_STANCES.some(s => dev.config.hvh.v2AntiAim.defensive[s].enabled), set: v => { for (const s of V2_STANCES) dev.set(`hvh.v2AntiAim.defensive.${s}.enabled`, v); } } };
  const stancePicker: Control = { type: 'picker', label: 'Stance', keywords: 'standing moving air crouch slow walk yaw jitter desync defensive', bind: pick('antiaim', V2_STANCES[0]!),
    options: V2_STANCES.map(s => ({ value: s, label: STANCE_NAMES[s], icon: STANCE_ICONS[s] })),
    sections: s => [
      select('Yaw base', `hvh.v2AntiAim.stances.${s}.base`), slider('Yaw offset', `hvh.v2AntiAim.stances.${s}.yawOffsetDeg`, '°'),
      slider('Jitter', `hvh.v2AntiAim.stances.${s}.jitterDeg`, '°', 'Capped at 45°'), slider('Desync', `hvh.v2AntiAim.stances.${s}.desyncDeg`, '°', 'Movement limits the usable desync'),
      toggle('Defensive in air', `hvh.v2AntiAim.defensive.${s}.inAir`), toggle('Defensive on peek', `hvh.v2AntiAim.defensive.${s}.onPeek`, 'When an enemy becomes visible'),
      toggle('Defensive always', `hvh.v2AntiAim.defensive.${s}.always`),
      select('Defensive pitch', `hvh.v2AntiAim.defensive.${s}.pitch`), select('Defensive yaw', `hvh.v2AntiAim.defensive.${s}.yaw`, 'Flick snaps the yaw for a few ticks'),
    ] };
  // Misc keeps one control per setting: the native menu owns bunny hop, air strafe, crosshair, hitmarker and
  // third person; status readouts and the profiles' auto-stop switch live elsewhere.
  const nativeOwned = new Set(Object.values(NATIVE_CONFIG_PATHS));
  const miscItems = (items: Control[]) => items.filter(c => c.type !== 'info' && c.label !== 'Third person'
    && !('path' in c && c.path && (nativeOwned.has(c.path) || c.path === 'hvh.movement.autoStop')))
    .map(c => c.type === 'buttons' && c.label === 'Crosshair' ? { ...c, label: 'Crosshair style' } : c);
  const recipe = (label: string, run: () => void): Control => ({ type: 'buttons', label, items: [{ label: 'Apply', run: () => { run(); dev.menuRefresh(); dev.notify(`${label} applied`, 'good'); } }] });
  return [
    { id: 'rage', label: 'Rage', icon: '⌖', configKey: ['rage.aim', 'hvh.aim', 'skeet.profiles'], sections: [
      sections('aim')[1]!,
      { title: 'Shot overrides', icon: 'ϟ', items: [
        toggle('Autowall', 'hvh.aim.autowall', 'Uses shared thickness-based penetration'),
        key('Force body aim', 'hvh.aim.bodyKey'), slider('Damage override threshold', 'hvh.aim.damageOverride', 'HP'), key('Damage override key', 'hvh.aim.overrideKey'),
        info('Active profile', () => { const w = dev.runtime.currentSession?.weapons.def; return w ? `${w.name} · ${WEAPONS[skeetProfileId(w)].name} profile` : 'Join a match to see your weapon profile'; }),
      ] },
      { title: 'Weapon profiles', icon: '◎', items: [weaponPicker] },
      sections('aim')[4]!,
    ] },
    { id: 'antiaim', label: 'Anti-aim', icon: '↻', configKey: ['hvh.antiAim', 'hvh.invertKey', 'hvh.v2AntiAim', 'hvh.exploit', 'skeet.antiAim', 'skeet.resolver'], sections: [
      { title: 'Anti-aim', icon: '↻', items: [
        toggle('Enable anti-aim', 'hvh.antiAim.enabled'),
        toggle('At targets', 'skeet.antiAim.atTargets'), toggle('Freestanding', 'skeet.antiAim.freestanding', 'Tests incoming damage at alternative head and body matrices'),
        key('Invert desync', 'hvh.invertKey'), defensive,
      ] },
      { title: 'Stances', icon: '◇', items: [stancePicker] },
      ...sections('exploits'),
      { title: 'Resolver', icon: '◈', items: [
        select('Resolver mode', 'skeet.resolver.mode', 'Adaptive compares movement layers, body-update timing and shot feedback. Center assumes eye yaw'), slider('History samples', 'skeet.resolver.history'), slider('History window', 'skeet.resolver.memoryMs', 'ms'),
        slider('Prefer body below confidence', 'skeet.resolver.preferBodyBelow', '%'), slider('Prefer body after misses', 'skeet.resolver.missedShots', 'shots', '0 disables this fallback. Counts only server-confirmed assisted shots'),
        info('Stance reading', () => dev.runtime.resolverInfo), info('Hidden body', () => 'Colored matrices are resolver guesses. Enemy body yaw stays on the server.'),
      ] },
      ...sections('network').map(s => ({...s,items:s.items.filter(c => !('path' in c) || !['hvh.core.fakeLag','hvh.core.fakeLagMode'].includes(c.path ?? ''))})),
    ] },
    { id: 'fakelag', label: 'Fake lag', icon: '⌁', configKey: 'skeet.fakeLag', sections: [
      {title:'Tickbase choke',icon:'⌁',items:[toggle('Fake lag','skeet.fakeLag.enabled','HvH only; held commands are sent as choke intents'),
        slider('Choke limit','skeet.fakeLag.limit','ticks','1–14 (era maxChoke); legacy rooms cap at 12'),
        select('Choke mode','skeet.fakeLag.mode'),toggle('Break on shot','skeet.fakeLag.breakOnShot','Sends pending commands and exposes a fresh update when firing'),
        info('Tradeoff',()=> 'Delayed updates · normal hitboxes and weapon timers','Your own command delivery is delayed too. Fake lag never grants invulnerability or extra movement time.')]}]},
    { id: 'legit', label: 'Trigger', icon: '◎', configKey: 'legit.trigger', sections: [sections('aim')[3]!] },
    { id: 'visuals', label: 'Visuals', icon: '◈', configKey: ['visuals', 'legit.wall', 'world'], sections: [...sections('visuals'), ...sections('world')] },
    { id: 'misc', label: 'Misc', icon: '☰', configKey: ['misc', 'hvh.feedback', 'skeet.indicators', 'legit.move', 'hvh.movement', 'settings'], sections: [
      { title: 'HUD', icon: '▤', items: [toggle('Keybind list', 'skeet.indicators.binds'), toggle('Watermark', 'skeet.indicators.watermark'), ...miscItems(sections('telemetry')[0]!.items)] },
      { title: 'Movement', icon: '➶', items: miscItems(sections('movement').flatMap(s => s.items)) },
      ...sections('settings'),
    ] },
    { id: 'skins', label: 'Skins', icon: '✦', configKey: ['skeet.cosmetics', 'weapons.selected'], sections: [
      { title: 'Weapon finish', icon: '✦', items: [toggle('Custom weapon tint', 'skeet.cosmetics.enabled'), { type: 'color', label: 'Finish color', path: 'skeet.cosmetics.tint' },
        { type: 'buttons', label: 'Inspect', items: [{ label: 'Inspect weapon', run: () => dev.runtime.currentSession?.inspectWeapon(), disabled: () => !dev.runtime.currentSession }] },
        info('Preview', () => 'Local first-person weapon finish'),
      ] }, ...sections('weapons'),
    ] },
    { id: 'configs', label: 'Configs', icon: '▣', sections: sections('configs') },
    { id: 'extensions', label: 'Extensions', icon: '⌘', sections: [
      { title: 'Native recipes', icon: '⌘', wide: true, items: [
        recipe('Precision safe points', () => { const c = structuredClone(dev.config); for (const id of ['ssg08', 'scar20'] as const) Object.assign(c.skeet.profiles[id], { hitchance: 85, safePoints: true, pointScale: 35, autoScope: true }); dev.replaceConfig(c); }),
        recipe('Ground peek', () => { const c = structuredClone(dev.config); c.hvh.movement.peekAssist = true; dev.replaceConfig(c); }),
        recipe('Defensive peek', () => {
          const c = structuredClone(dev.config); c.hvh.movement.peekAssist = true;
          for (const s of V2_STANCES) c.hvh.v2AntiAim.defensive[s] = { ...c.hvh.v2AntiAim.defensive[s], enabled: true, onPeek: true, yaw: 'flick' };
          dev.replaceConfig(c);
        }),
        info('Recipe library', () => 'Apply a recipe, adjust its settings, then save it as a config.'),
        info('Controller hooks', () => 'Command, observations, candidates, anti-aim, shot results and rendering. Add typed controllers in the game source.'),
      ] },
    ] },
  ];
}
