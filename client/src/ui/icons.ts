import type { ModeId } from '@game/shared';

/**
 * The menus' icons: small drawings in thick strokes (they take the text colour), instead of
 * emoji, so they look the same on every phone and match the chunky buttons. 24 x 24 grid.
 */
const PATHS = {
  play: '<path d="M7 4.5v15l12-7.5z" fill="currentColor"/>',
  chicken: '<path d="M8 20c-3-1-4-4-3-7 1-3 3-4 3-7a4 4 0 0 1 8 0c0 1 0 2-1 3l4 1-4 2c2 2 2 5 0 7-2 1-5 2-7 1z"/><path d="M9 4.5c0-2 2-3 3-2"/><circle cx="12" cy="6.5" r=".8" fill="currentColor"/>',
  swords: '<path d="M4 4l10 10M20 4L10 14M6 15l3 3M18 15l-3 3M4 20l3-3M20 20l-3-3"/>',
  team: '<circle cx="8.5" cy="8" r="3"/><circle cx="16.5" cy="9" r="2.5"/><path d="M3 20c0-4 2.5-6 5.5-6s5.5 2 5.5 6M14 15c3 0 6 1 6 5"/>',
  duel: '<path d="M5 19L17 7M17 7l1-3 2 2-3 1M19 19L7 7M7 7L6 4 4 6l3 1"/>',
  medal: '<path d="M8 3l4 6 4-6"/><circle cx="12" cy="15" r="5.5"/><path d="M12 12.3l.9 1.8 2 .3-1.5 1.4.4 2-1.8-1-1.8 1 .4-2-1.5-1.4 2-.3z" fill="currentColor" stroke-width="1"/>',
  bomb: '<circle cx="11" cy="14" r="6.5"/><path d="M15.5 9.5L18 7M18 7l1.5-1.5M18 7l2 1"/>',
  eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3" fill="currentColor"/>',
  ladder: '<path d="M5 20h4v-5h4v-5h4V5h3"/><path d="M17 3l3 2-3 2"/>',
  knife: '<path d="M4 20l5-5M9 15l2 2M9 15l10-10c1 3-1 7-5 9"/>',
  flag: '<path d="M6 21V4M6 4h11l-2.5 4L17 12H6"/>',
  bricks: '<rect x="3" y="5" width="18" height="14" rx="1"/><path d="M3 12h18M9 5v7M15 12v7"/>',
  skull: '<path d="M5 11a7 7 0 0 1 14 0v3l-2 1v4H7v-4l-2-1z"/><circle cx="9.5" cy="11.5" r="1.5" fill="currentColor"/><circle cx="14.5" cy="11.5" r="1.5" fill="currentColor"/><path d="M11 19v-2M13 19v-2"/>',
  basket: '<path d="M3 9h18l-2 10H5z"/><path d="M8 9l3-5M16 9l-3-5M9 13v3M15 13v3"/>',
  calendar: '<rect x="3.5" y="5" width="17" height="15" rx="1.5"/><path d="M3.5 10h17M8 3v4M16 3v4"/><path d="M8 14.5l2 2 4-4"/>',
  trophy: '<path d="M7 4h10v5a5 5 0 0 1-10 0z"/><path d="M7 6H4c0 3 1 4 3 4.5M17 6h3c0 3-1 4-3 4.5M12 14v3M8 20h8M9.5 17h5"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.7.3-1 .8-1 1.5v.7"/><circle cx="12" cy="17" r=".9" fill="currentColor"/>',
  hide: '<path d="M3 3l18 18M10.5 6c.5-.1 1-.1 1.5-.1 6 0 9.5 6.1 9.5 6.1a17 17 0 0 1-2.4 3M6.5 7.6A16 16 0 0 0 2.5 12S6 18.5 12 18.5c1.6 0 3-.4 4.2-1"/>',
  dice: '<rect x="4" y="4" width="16" height="16" rx="3"/><circle cx="9" cy="9" r="1.2" fill="currentColor"/><circle cx="15" cy="15" r="1.2" fill="currentColor"/><circle cx="15" cy="9" r="1.2" fill="currentColor"/><circle cx="9" cy="15" r="1.2" fill="currentColor"/>',
  bot: '<rect x="5" y="8" width="14" height="11" rx="2"/><path d="M12 8V5M10 4h4"/><circle cx="9.5" cy="13" r="1.4" fill="currentColor"/><circle cx="14.5" cy="13" r="1.4" fill="currentColor"/><path d="M3 12v4M21 12v4"/>',
  person: '<circle cx="12" cy="8" r="3.5"/><path d="M5 20c0-4 3-6.5 7-6.5s7 2.5 7 6.5"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  key: '<circle cx="8" cy="12" r="4"/><path d="M12 12h9M17 12v3M20 12v2"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  coin: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5v9M9.5 10c0-1 1-1.5 2.5-1.5s2.5.7 2.5 1.7-1 1.5-2.5 1.8-2.5.8-2.5 1.8 1 1.7 2.5 1.7 2.5-.5 2.5-1.5"/>',
  back: '<path d="M15 5l-7 7 7 7"/>',
  target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.4" fill="currentColor"/>',
  egg: '<path d="M12 3c3.5 0 6.5 5.5 6.5 10a6.5 6.5 0 0 1-13 0C5.5 8.5 8.5 3 12 3z"/>',
  smoke: '<path d="M7 18a4 4 0 0 1 0-8 5 5 0 0 1 9.5-1A4 4 0 0 1 17 18z"/>',
  flash: '<path d="M13 2L5 13h6l-1 9 8-11h-6z" fill="currentColor"/>',
} as const;

export type IconName = keyof typeof PATHS;

/** An icon as an element (decorative: hidden from screen readers; the button's text names it). */
export function icon(name: IconName, cls = ''): HTMLElement {
  const el = document.createElement('span');
  el.className = `ico${cls ? ` ${cls}` : ''}`;
  el.setAttribute('aria-hidden', 'true');
  el.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">${PATHS[name]}</svg>`;
  return el;
}

export const MODE_ICON: Record<ModeId, IconName> = {
  ffa: 'chicken', tdm: 'swords', squad: 'team', duel: 'duel', face: 'medal', bomb: 'bomb', hvh: 'eye',
  arms: 'ladder', knife: 'knife', ctf: 'flag', sandbox: 'bricks', zombie: 'skull', training: 'target',
};
