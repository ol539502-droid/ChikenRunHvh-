import { TRAINING_GUNS, TRAINING_KNIVES, WEAPONS, isMelee, type WeaponId } from '@game/shared';
import { clear, h } from './dom';
import { gunIcon } from './GunIcons';
import { icon, type IconName } from './icons';

type Grenade = 'egg' | 'smoke' | 'flash';
const GRENADES: readonly { id: Grenade; name: string; key: string; icon: IconName }[] = [
  { id: 'egg', name: 'Eggs', key: 'G', icon: 'egg' },
  { id: 'smoke', name: 'Smoke', key: 'Q', icon: 'smoke' },
  { id: 'flash', name: 'Flashbang', key: 'Z', icon: 'flash' },
];

/**
 * Training's weapon menu (B): every gun, every knife and the grenades, all free. Picking one
 * asks the server for it (Training rooms only); B or Esc closes. Pure DOM; the session feeds it.
 */
export class TrainingMenu {
  readonly root = h('div', { class: 'tr-overlay', hidden: true, role: 'dialog', 'aria-label': 'Training weapons' });
  private readonly status = h('p', { class: 'tr-status', role: 'status', 'aria-live': 'polite' });
  private readonly guns = h('div', { class: 'tr-grid' });
  private readonly knives = h('div', { class: 'tr-grid' });
  private readonly grenades = h('div', { class: 'tr-grid tr-grenades' });
  private loadout: readonly WeaponId[] = [];
  onPick: ((id: WeaponId) => void) | null = null;
  onGrenade: ((id: Grenade) => void) | null = null;
  onClose: (() => void) | null = null;

  constructor(container: HTMLElement) {
    const close = h('button', { type: 'button', class: 'icon-btn tr-close', 'aria-label': 'Close', onclick: () => this.onClose?.() }, icon('close'));
    this.root.append(
      h(
        'div',
        { class: 'tr-window panel' },
        h('header', { class: 'tr-head' }, h('h2', null, 'Weapons'), h('span', { class: 'tr-keys' }, 'B or Esc to close'), close),
        h('h3', null, 'Guns'),
        this.guns,
        h('h3', null, 'Knives'),
        this.knives,
        h('h3', null, 'Grenades'),
        this.grenades,
        this.status,
      ),
    );
    this.root.addEventListener('click', (e) => {
      if (e.target === this.root) this.onClose?.();
    });
    container.append(this.root);
  }

  get open(): boolean {
    return !this.root.hidden;
  }

  setOpen(open: boolean, loadout: readonly WeaponId[]): void {
    this.root.hidden = !open;
    if (open) {
      this.loadout = loadout;
      this.render();
      window.addEventListener('keydown', this.onKey, true);
    } else window.removeEventListener('keydown', this.onKey, true);
  }

  /** After a pick: mark what you're holding now, or say why not. */
  update(loadout: readonly WeaponId[], message = '', bad = false): void {
    this.loadout = loadout;
    this.status.textContent = message;
    this.status.classList.toggle('bad', bad);
    if (this.open) this.render();
  }

  private render(): void {
    const item = (id: WeaponId) => {
      const pic = gunIcon(id);
      const b = h(
        'button',
        { type: 'button', class: `tr-item${this.loadout.includes(id) ? ' active' : ''}`, onclick: () => this.onPick?.(id) },
        pic ? h('img', { src: pic.url, alt: '', width: pic.width, height: pic.height }) : h('span', { class: 'tr-noimg' }),
        h('span', { class: 'tr-name' }, WEAPONS[id].name),
      );
      return b;
    };
    clear(this.guns);
    clear(this.knives);
    clear(this.grenades);
    this.guns.append(...TRAINING_GUNS.map(item));
    this.knives.append(...TRAINING_KNIVES.filter((id) => isMelee(id)).map(item));
    this.grenades.append(
      ...GRENADES.map((g) =>
        h('button', { type: 'button', class: 'tr-item', onclick: () => this.onGrenade?.(g.id) }, icon(g.icon, 'tr-gicon'), h('span', { class: 'tr-name' }, `${g.name} · refill`), h('kbd', null, g.key)),
      ),
    );
  }

  private onKey = (e: KeyboardEvent): void => {
    if (e.code !== 'KeyB' && e.key !== 'Escape') return;
    if (e.repeat) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    this.onClose?.();
  };

  dispose(): void {
    window.removeEventListener('keydown', this.onKey, true);
    this.root.remove();
  }
}
