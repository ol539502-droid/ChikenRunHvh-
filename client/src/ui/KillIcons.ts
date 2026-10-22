import { KILL_FLAGS, WEAPON_IDS, type KillCause, type WeaponId } from '@game/shared';

/**
 * Kill feed icons, drawn as small inline SVG (white, they take the text colour): a silhouette for
 * what did the killing, and a symbol for each way it was done. Plain strings, no DOM, so the
 * mapping can be tested.
 */

export type WeaponShape = 'pistol' | 'smg' | 'rifle' | 'sniper' | 'shotgun' | 'lmg' | 'launcher' | 'crossbow' | 'knife' | 'katana' | 'pan' | 'egg' | 'car' | 'bomb' | 'world';

/** Which silhouette each weapon (or other cause of death) gets. */
const SHAPE_OF: Record<WeaponId, WeaponShape> = {
  pistol: 'pistol', mpistol: 'pistol', revolver: 'pistol', deagle: 'pistol', fiveseven: 'pistol', dualies: 'pistol', silenced: 'pistol',
  deserteagle: 'pistol', r8: 'pistol',
  smg: 'smg',
  rifle: 'rifle', burst: 'rifle', battle: 'rifle', golden: 'rifle', ak47: 'rifle', m4a1: 'rifle',
  sniper: 'sniper', scout: 'sniper', ssg08: 'sniper', scar20: 'sniper',
  shotgun: 'shotgun', autoshotgun: 'shotgun',
  lmg: 'lmg', minigun: 'lmg',
  rocket: 'launcher', launcher: 'launcher',
  crossbow: 'crossbow',
  knife: 'knife', goldknife: 'knife', butterfly: 'knife', karambit: 'knife', m9: 'knife', daggers: 'knife',
  katana: 'katana',
  pan: 'pan',
};

export function weaponShape(cause: KillCause): WeaponShape {
  if (cause === 'egg') return 'egg';
  if (cause === 'car') return 'car';
  if (cause === 'bomb') return 'bomb';
  if (cause === 'world') return 'world';
  return SHAPE_OF[cause] ?? 'rifle';
}

/** The inside of each silhouette (a 64 × 20 box, pointing right). */
const SHAPES: Record<WeaponShape, string> = {
  pistol: '<path d="M12 5h30v6H30l-2 3h-3l-1 5h-6l1-8h-7z"/><rect x="42" y="6" width="6" height="3"/>',
  smg: '<path d="M6 8h8l2 -2h24v6H28l-1 8h-4l1-8h-6l-2 3H6z"/><rect x="40" y="7" width="12" height="3"/>',
  rifle: '<path d="M2 8l9-1 3-2h30v3h14v2H44l-2 2H32l-1 6h-5l1-6h-8l-1 5h-5l1-5H8l-2 3H2z"/>',
  sniper: '<path d="M2 9l8-1 3-2h26v2h24v2H38l-2 2H28l-1 5h-4l1-5h-9l-1 4H8L6 14H2z"/><rect x="16" y="2" width="14" height="3" rx="1"/><rect x="21" y="5" width="2" height="2"/>',
  shotgun: '<path d="M2 8l8-1 4-1h46v3H40v2h-8l-2 2H18l-1 4h-4l1-5H8l-2 3H2z"/><rect x="30" y="10" width="11" height="3" rx="1"/>',
  lmg: '<path d="M2 8l8-1 3-2h30v3h16v2H44l-2 2H34v5H22v-5h-4l-1 4h-5l1-4H8l-2 3H2z"/>',
  launcher: '<rect x="6" y="5" width="48" height="8" rx="3"/><path d="M54 5l7 4-7 4z"/><path d="M20 13h6l-1 6h-5z"/>',
  crossbow: '<path d="M30 3v14M6 7q24-9 52 0" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/><path d="M26 8h10v3H26z"/><path d="M12 11l18 2-2 3z"/>',
  knife: '<path d="M6 11L36 5c3 0 6 2 7 5l-1 2L10 14z"/><rect x="42" y="8" width="16" height="5" rx="2"/><rect x="38" y="6" width="3" height="9" rx="1"/>',
  katana: '<path d="M2 12L44 8l16 1-1 2-17 1z"/><rect x="44" y="6" width="3" height="8" rx="1"/><rect x="47" y="8" width="15" height="4" rx="2"/>',
  pan: '<circle cx="22" cy="10" r="9"/><rect x="31" y="8" width="28" height="4" rx="2"/>',
  egg: '<ellipse cx="32" cy="10" rx="7" ry="9"/>',
  car: '<path d="M6 12l5-6h26l8 5h8v5H6z"/><circle cx="18" cy="16" r="3.5" stroke="#000" stroke-width="1"/><circle cx="46" cy="16" r="3.5" stroke="#000" stroke-width="1"/>',
  bomb: '<circle cx="30" cy="12" r="7"/><path d="M34 6l5-4M40 1l2 3M37 2l3 1" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/>',
  world: '<path d="M32 2l3 6 6 1-4 5 1 6-6-3-6 3 1-6-4-5 6-1z"/>',
};

export function shapeSvg(shape: WeaponShape): string {
  return `<svg class="kf-weapon" viewBox="0 0 64 20" width="54" height="17" fill="currentColor" aria-hidden="true">${SHAPES[shape]}</svg>`;
}

export type TagKind = 'blind' | 'noscope' | 'smoke' | 'wallbang' | 'air' | 'headshot';

/** The inside of each tag icon (a 20 × 20 box). */
const TAGS: Record<TagKind, { title: string; svg: string }> = {
  blind: {
    title: 'While blind',
    svg: '<path d="M1 10q9-9 18 0-9 9-18 0z" fill="none" stroke="currentColor" stroke-width="1.8"/><circle cx="10" cy="10" r="2.6"/><path d="M3 17L17 3" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>',
  },
  noscope: {
    title: 'No scope',
    svg: '<circle cx="10" cy="10" r="7.5" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M10 2v16M2 10h16" stroke="currentColor" stroke-width="1.4"/><path d="M3 17L17 3" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/>',
  },
  smoke: {
    title: 'Through smoke',
    svg: '<path d="M5 15a3.6 3.6 0 0 1 0-7 4.6 4.6 0 0 1 8.6-1.4A4 4 0 0 1 16 15z"/><path d="M1 9h3M0 12h2" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>',
  },
  wallbang: {
    title: 'Through a wall',
    svg: '<path d="M4 2h8v16H4z" fill="none" stroke="currentColor" stroke-width="1.8"/><circle cx="9.5" cy="10" r="0.9"/><path d="M0 10h17M13.5 6.5L18 10l-4.5 3.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>',
  },
  air: {
    title: 'In mid-air',
    svg: '<path d="M10 2L3 9h4v4h6V9h4z"/><path d="M5 16h10" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
  },
  headshot: {
    title: 'Headshot',
    svg: '<path d="M9 3a6 6 0 0 0-4 10.5V17h8v-3.5A6 6 0 0 0 9 3z"/><circle cx="6.8" cy="9" r="1.5" fill="#000"/><circle cx="11.2" cy="9" r="1.5" fill="#000"/><path d="M15 3v4M13 5h4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
  },
};

export function tagSvg(kind: TagKind): { title: string; html: string } {
  const t = TAGS[kind];
  return { title: t.title, html: `<svg class="kf-tag-icon" viewBox="0 0 20 20" width="18" height="18" fill="currentColor" aria-hidden="true">${t.svg}</svg>` };
}

/** The icons for how a kill was done, in feed order (blind goes before the killer's name, the rest after the weapon). */
export function killTags(flags: number, headshot: boolean): { before: TagKind[]; after: TagKind[] } {
  const after: TagKind[] = [];
  if (flags & KILL_FLAGS.noscope) after.push('noscope');
  if (flags & KILL_FLAGS.smoke) after.push('smoke');
  if (flags & KILL_FLAGS.wallbang) after.push('wallbang');
  if (flags & KILL_FLAGS.air) after.push('air');
  if (headshot) after.push('headshot');
  return { before: flags & KILL_FLAGS.blind ? ['blind'] : [], after };
}

/** Every weapon has a silhouette (checked by a test). */
export const ALL_CAUSES: readonly KillCause[] = [...WEAPON_IDS, 'egg', 'car', 'world', 'bomb'];
