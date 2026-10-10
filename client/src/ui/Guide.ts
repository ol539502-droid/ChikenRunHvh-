import { MODES, MODE_IDS } from '@game/shared';
import { BINDS, getKeybinds, keyLabel } from '../keybinds';
import { h } from './dom';
import { MODE_ICON, icon } from './icons';
import { openModal, type ModalHandle } from './Modal';

let current: ModalHandle | null = null;

/**
 * The F1 guide: how to play and what to do, for new players. Controls come from your own key
 * bindings, and the modes from the game's mode list, so neither goes out of date.
 */
export function toggleGuide(onClose?: () => void): void {
  if (current) {
    current.close();
    return;
  }
  const keys = getKeybinds();
  const k = (id: (typeof BINDS)[number]['id']) => h('kbd', null, keyLabel(keys[id]));
  const fixed = (label: string) => h('kbd', null, label);
  const row = (label: string, ...caps: HTMLElement[]) => h('div', { class: 'guide-key' }, h('span', null, label), h('span', { class: 'guide-caps' }, ...caps));

  const section = (title: string, ...children: (Node | string)[]) => h('section', { class: 'guide-section' }, h('h3', null, title), ...children);
  const content = h(
    'div',
    { class: 'guide' },
    section(
      'First steps',
      h('ol', null,
        h('li', null, 'Press ', h('b', null, 'PLAY'), ' to jump into a match with bots, or open ', h('b', null, 'Change mode'), ' to pick another one.'),
        h('li', null, 'New here? Try ', h('b', null, 'Training'), ' first: any gun, targets that don’t shoot back, and nothing counts.'),
        h('li', null, 'Kill chickens, earn coins, and spend them in the ', h('b', null, 'Shop'), ' on hats, skins and new weapons.'),
        h('li', null, 'Tap ', h('b', null, 'Save progress'), ' to make an account, so your coins and level are never lost.'),
      ),
    ),
    section(
      'Moving',
      row('Walk', k('forward'), k('left'), k('back'), k('right')),
      row('Jump (hold it to bunny hop)', k('jump')),
      row('Crouch', k('crouch'), fixed('Ctrl')),
      row('Slow walk', k('slowWalk')),
      row('First / third person', k('camera')),
    ),
    section(
      'Fighting',
      row('Shoot', fixed('Left click')),
      row('Aim / scope (snipers: again to zoom)', fixed('Right click')),
      row('Reload', k('reload')),
      row('Guns 1-4, melee 5', fixed('1'), fixed('2'), fixed('3'), fixed('4'), fixed('5')),
      row('Inspect your weapon', k('inspect')),
      row('Egg, smoke, flashbang', k('egg'), k('smoke'), k('flash')),
    ),
    section(
      'Other keys',
      row('Scoreboard', fixed('Tab')),
      row('Chat (everyone) / team chat', k('chat'), k('teamChat')),
      row('Switch team', k('team')),
      row('Buy menu, shop, build, Training weapons', k('build')),
      row('Get in a buggy, plant or defuse', k('use')),
      row('Flashlight (Zombie Apocalypse)', k('flashlight')),
      row('Pause and menu', fixed('Esc')),
      row('This guide', fixed('F1')),
      h('p', { class: 'muted' }, 'Change any key in Settings › Keys.'),
    ),
    section(
      'Modes',
      h('div', { class: 'guide-modes' },
        ...MODE_IDS.map((id) => h('div', { class: 'guide-mode' }, icon(MODE_ICON[id], 'guide-mode-icon'), h('div', null, h('b', null, MODES[id].name), h('span', null, MODES[id].description))))),
    ),
    section(
      'Good to know',
      h('ul', null,
        h('li', null, h('b', null, 'Levels'), ' only move in ', h('b', null, 'FaceChiken'), ' (ranked, real players only). Every other mode is for fun and coins.'),
        h('li', null, h('b', null, 'HvH'), ' is the mode where cheat panels are allowed for everyone. Cheats are not allowed anywhere else, and ranked has an anti-cheat.'),
        h('li', null, h('b', null, 'Daily challenges'), ' reset every day and pay extra coins.'),
        h('li', null, 'Someone being rude or cheating? Pause and choose ', h('b', null, 'Report a player'), '.'),
      ),
    ),
  );
  current = openModal('How to play', content, {
    wide: true,
    onClose: () => {
      current = null;
      onClose?.();
    },
  });
}
