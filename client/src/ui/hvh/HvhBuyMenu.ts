import { WEAPONS, type WeaponId } from '@game/shared';
import { HVH_MAINS, HVH_PISTOLS } from '@game/shared/hvh/v2';
import { gunPicture, prepareGunIcons } from '../GunIcons';
import { formatTime, h, storage } from '../dom';

/*
 * The v2 HvH round-start buy menu: one main and one pistol, both free. The model is pure (tests);
 * the view is a thin DOM layer styled like the ChikenBomb BuyMenu, without the money line. The
 * last pick is remembered (localStorage, best effort), so closing the menu keeps it.
 */

export type HvhBuyCategoryId = 'main' | 'pistol';

export interface HvhBuyCategory {
  id: HvhBuyCategoryId;
  name: string;
  items: readonly WeaponId[];
}

export interface HvhBuySelection {
  main: WeaponId;
  pistol: WeaponId;
}

/** Where the last pick is kept. */
export const HVH_BUY_STORAGE_KEY = 'chiken.hvhBuy';

/** Best-effort key-value storage (dom.ts `storage` in the browser). */
export interface HvhBuyStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
}

const CATEGORIES: readonly HvhBuyCategory[] = [
  { id: 'main', name: 'Main', items: HVH_MAINS },
  { id: 'pistol', name: 'Pistol', items: HVH_PISTOLS },
];
const DEFAULT_PICK: HvhBuySelection = { main: 'ssg08', pistol: 'deserteagle' };

function categoryOf(id: unknown): HvhBuyCategoryId | null {
  return CATEGORIES.find((c) => c.items.includes(id as WeaponId))?.id ?? null;
}

export class HvhBuyModel {
  readonly categories = CATEGORIES;
  private pickState: HvhBuySelection = { ...DEFAULT_PICK };

  constructor(private readonly store: HvhBuyStore = storage) {
    const saved = this.load();
    if (categoryOf(saved.main) === 'main') this.pickState.main = saved.main as WeaponId;
    if (categoryOf(saved.pistol) === 'pistol') this.pickState.pistol = saved.pistol as WeaponId;
  }

  private load(): Partial<Record<HvhBuyCategoryId, unknown>> {
    try {
      return (JSON.parse(this.store.get(HVH_BUY_STORAGE_KEY) ?? 'null') as Partial<Record<HvhBuyCategoryId, unknown>> | null) ?? {};
    } catch {
      // Unreadable or broken: the default.
      return {};
    }
  }

  get selected(): Readonly<HvhBuySelection> {
    return this.pickState;
  }

  /** Puts `id` in its slot and remembers it; returns the slot, or null for ids outside the arsenal. */
  pick(id: string): HvhBuyCategoryId | null {
    const category = categoryOf(id);
    if (!category) return null;
    this.pickState = { ...this.pickState, [category]: id as WeaponId };
    try {
      this.store.set(HVH_BUY_STORAGE_KEY, JSON.stringify(this.pickState));
    } catch {
      // Not remembered; the pick still counts for now.
    }
    return category;
  }

  /**
   * The server refused a pick: show what the player really carries (`loadout`, from playerUpdated).
   * The saved pick stays, so the next buy window asks for it again. Returns whether anything changed.
   */
  sync(loadout: readonly string[]): boolean {
    let next = this.pickState;
    for (const id of loadout) {
      const category = categoryOf(id);
      if (category && next[category] !== id) next = { ...next, [category]: id as WeaponId };
    }
    if (next === this.pickState) return false;
    this.pickState = next;
    return true;
  }
}

/** Keys typed into chat (or any text field) are not menu keys. */
export function isTypingTarget(el: { tagName?: string; isContentEditable?: boolean } | null): boolean {
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable === true);
}

/**
 * What a key does in the menu: pick card `pick` (0-based), close it, or nothing (the game gets the
 * key). The passive freeze menu leaves 1–4 to the game (weapon slots) and B too (the game's B
 * opens it with the mouse); Esc closes it.
 */
export function menuKey(e: { key: string; code: string }, passive: boolean, items: number): { pick: number } | 'close' | null {
  if (e.key === 'Escape' || (!passive && e.code === 'KeyB')) return 'close';
  if (!passive && /^[1-9]$/.test(e.key) && Number(e.key) <= items) return { pick: Number(e.key) - 1 };
  return null;
}

/** Two columns (Main, Pistol); 1–4 pick and B / Esc close (passive: B opens it to pick, Esc closes). */
export class HvhBuyMenu {
  readonly root = h('div', { class: 'buy-overlay hvh-buy' });
  private readonly timer = h('span', { class: 'buy-timer' });
  private readonly status = h('div', { class: 'buy-status', role: 'status', 'aria-live': 'polite' });
  private readonly hint = h('small', null, '1–4 pick · B / Esc close');
  private readonly cards = new Map<WeaponId, HTMLButtonElement>();
  onPick: ((id: WeaponId) => void) | null = null;
  onClose: (() => void) | null = null;
  /** Opened passive (freeze time's auto-open): the game keeps the mouse and the slot keys. */
  private passive = false;

  constructor(container: HTMLElement, readonly model = new HvhBuyModel()) {
    const close = h('button', { type: 'button', class: 'buy-close', 'aria-label': 'Close the buy menu' }, '✕');
    close.addEventListener('click', () => this.onClose?.());
    const columns = h('div', { class: 'buy-columns' });
    let number = 0;
    for (const [categoryIndex, cat] of model.categories.entries()) {
      const grid = h('div', { class: 'buy-grid' });
      for (const id of cat.items) {
        const card = h(
          'button',
          { type: 'button', class: 'buy-card', 'data-item': id },
          h('span', { class: 'buy-number', 'aria-hidden': 'true' }, ++number),
          h('img', { class: 'buy-pic', alt: '', src: gunPicture(id, 'gold')?.url ?? '', 'data-weapon': id }),
          h('span', { class: 'buy-name' }, WEAPONS[id].name),
          h('span', { class: 'buy-price' }, 'Free'),
        );
        card.addEventListener('click', () => this.pick(id));
        this.cards.set(id, card);
        grid.append(card);
      }
      columns.append(h('section', { class: `buy-cat cat-${cat.id}` }, h('h3', null, h('span', { 'aria-hidden': 'true' }, categoryIndex + 1), cat.name), grid));
    }
    this.root.append(h(
      'div',
      { class: 'buy-window', role: 'dialog', 'aria-label': 'Buy menu', 'aria-modal': 'true' },
      h('header', { class: 'buy-head' }, h('span', null, 'Loadout'), this.timer, close),
      columns,
      h('footer', { class: 'buy-foot' }, this.status, this.hint),
    ));
    this.root.addEventListener('click', (e) => {
      if (e.target === this.root) this.onClose?.();
    });
    this.root.hidden = true;
    container.append(this.root);
    this.render();
  }

  get open(): boolean {
    return !this.root.hidden;
  }

  /**
   * `passive` (freeze time's auto-open): no dimmed backdrop and clicks pass through around the
   * window, so a frozen player still sees, looks and pre-aims.
   */
  setOpen(open: boolean, passive = false): void {
    if (open === this.open) return;
    this.root.hidden = !open;
    this.passive = open && passive;
    this.root.classList.toggle('passive', this.passive);
    this.hint.textContent = this.passive ? 'B to pick · Esc close' : '1–4 pick · B / Esc close';
    if (open) {
      this.say('');
      prepareGunIcons();
      window.addEventListener('keydown', this.onKey, true);
    } else {
      window.removeEventListener('keydown', this.onKey, true);
    }
  }

  /** Freeze time left (null: warmup, no limit). */
  setSecondsLeft(seconds: number | null): void {
    this.timer.textContent = seconds === null ? 'Warmup' : `Freeze time ${formatTime(seconds * 1000)}`;
  }

  say(text: string, bad = false): void {
    this.status.textContent = text;
    this.status.classList.toggle('bad', bad);
  }

  /** Swaps in the shaded gun pictures as they get drawn. */
  update(): void {
    if (!this.open) return;
    for (const img of this.root.querySelectorAll<HTMLImageElement>('img[data-weapon]')) {
      const picture = gunPicture(img.dataset.weapon as WeaponId, 'gold');
      if (picture && img.getAttribute('src') !== picture.url) img.src = picture.url;
    }
  }

  dispose(): void {
    this.setOpen(false);
    this.root.remove();
  }

  /** The server refused a pick: the cards show the loadout the player kept. */
  sync(loadout: readonly string[]): void {
    if (this.model.sync(loadout)) this.render();
  }

  private pick(id: WeaponId): void {
    if (!this.model.pick(id)) return;
    this.render();
    this.onPick?.(id);
  }

  private render(): void {
    const { main, pistol } = this.model.selected;
    for (const [id, card] of this.cards) {
      const selected = id === main || id === pistol;
      card.classList.toggle('owned', selected);
      card.setAttribute('aria-pressed', String(selected));
      card.querySelector('.buy-price')!.textContent = selected ? 'Selected' : 'Free';
    }
  }

  private onKey = (e: KeyboardEvent): void => {
    if (e.repeat || isTypingTarget(document.activeElement)) return;
    const items = this.model.categories.flatMap((c) => c.items);
    const action = menuKey(e, this.passive, items.length);
    if (action === null) return;
    if (action === 'close') this.onClose?.();
    else this.pick(items[action.pick]!);
    e.preventDefault();
    e.stopImmediatePropagation();
  };
}
