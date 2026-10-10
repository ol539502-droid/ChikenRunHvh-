import { h, storage } from '../ui/dom';
import { defaultConfig, getPath, setPath, sanitizeConfig } from './config';
import { keyName, renderControl, type Control, type Rendered, type Section, type Tab } from './controls';
import type { Dev } from './Dev';
import { applyTheme } from './passkey';
import { buildTabs } from './tabs';

const POSITION_KEY = 'chikengun:dev-pos';
/** Live values (player list, readouts) refresh this often while the menu is open. */
const LIVE_REFRESH_MS = 250;
let lastTab = 'aim';

interface Placed {
  control: Control;
  rendered: Rendered;
}

/** The developer menu window. Built entirely from the tab definitions in tabs.ts. */
export class DevMenu {
  private readonly dev: Dev;
  private readonly tabs: Tab[];
  private readonly root: HTMLElement;
  private readonly window: HTMLElement;
  private readonly tabBar = h('nav', { class: 'dev-tabs', role: 'tablist' });
  private readonly nav = h('aside', { class: 'dev-nav' });
  private readonly panel = h('main', { class: 'dev-panel' });
  private readonly pill = h('span', { class: 'dev-pill' });
  private readonly search = h('input', { class: 'dev-search', type: 'search', placeholder: 'Find a feature…', 'aria-label': 'Search features' });
  private readonly configSelect = h('select', { class: 'dev-select', 'aria-label': 'Config' });
  private readonly hint = h('span', { class: 'dev-hint' });
  private placed: Placed[] = [];
  private tab: string;
  private readonly timer: number;
  private readonly unsubscribe: () => void;

  constructor(dev: Dev, onClose: () => void) {
    this.dev = dev;
    this.tab = lastTab;
    this.tabs = buildTabs(dev);
    if (!this.tabs.some((t) => t.id === this.tab)) this.tab = this.tabs[0]!.id;

    const close = h('button', { type: 'button', class: 'dev-icon-btn', 'aria-label': 'Close menu' }, '✕');
    close.addEventListener('click', onClose);
    const header = h(
      'header',
      { class: 'dev-header' },
      h('div', { class: 'dev-brand' }, h('span', { class: 'dev-logo' }, '◆'), h('b', null, 'CHICKEN'), h('span', null, '//HVH LAB')),
      this.pill,
      this.search,
      close,
    );
    for (const t of this.tabs) {
      const b = h('button', { type: 'button', class: 'dev-tab', role: 'tab', 'data-tab': t.id }, h('span', { class: 'dev-tab-icon', 'aria-hidden': 'true' }, t.icon), t.label);
      b.addEventListener('click', () => {
        this.search.value = '';
        this.show(t.id);
        dev.click();
      });
      this.tabBar.append(b);
    }
    this.tabBar.addEventListener('keydown', (e) => {
      if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key)) return;
      e.preventDefault();
      const current = this.tabs.findIndex(t => t.id === this.tab);
      const index = e.key === 'Home' ? 0 : e.key === 'End' ? this.tabs.length - 1 : (current + (e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : -1) + this.tabs.length) % this.tabs.length;
      this.search.value = '';
      this.show(this.tabs[index]!.id);
      const button = this.tabBar.children[index] as HTMLElement;
      button.focus();
      button.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    });
    this.search.addEventListener('input', () => this.render());

    const reset = h('button', { type: 'button', class: 'dev-btn' }, 'Reset tab');
    reset.addEventListener('click', () => this.resetTab());
    const load = h('button', { type: 'button', class: 'dev-btn' }, 'Load');
    load.addEventListener('click', () => this.quickConfig('load'));
    const save = h('button', { type: 'button', class: 'dev-btn primary' }, 'Save');
    save.addEventListener('click', () => this.quickConfig('save'));
    const footer = h('footer', { class: 'dev-footer' }, reset, h('span', { class: 'dev-spacer' }), this.hint, this.configSelect, load, save);

    this.window = h('div', { class: 'dev-window', role: 'dialog', 'aria-label': 'HvH Lab panel' }, header, this.tabBar, h('div', { class: 'dev-body' }, this.nav, this.panel), footer);
    this.root = h('div', { class: 'dev-root dev-layer' }, this.window);
    document.body.append(this.root);
    this.makeDraggable(header);
    this.restorePosition();

    this.unsubscribe = dev.onChange(() => this.onConfigChange());
    window.addEventListener('keydown', this.onKey, true);
    this.timer = window.setInterval(() => this.liveRefresh(), LIVE_REFRESH_MS);
    this.onConfigChange();
    this.show(this.tab);
  }

  dispose(): void {
    window.removeEventListener('resize', this.onResize);
    window.clearInterval(this.timer);
    window.removeEventListener('keydown', this.onKey, true);
    this.unsubscribe();
    this.root.classList.add('closing');
    const root = this.root;
    window.setTimeout(() => root.remove(), 160 * this.dev.config.settings.animSpeed);
  }

  /** Re-read every control (after loading a config or a reset). */
  refreshAll(): void {
    for (const p of this.placed) p.rendered.refresh();
    this.fillConfigSelect();
  }

  private show(id: string): void {
    this.tab = lastTab = id;
    for (const b of this.tabBar.children) {
      const active = (b as HTMLElement).dataset.tab === id;
      b.classList.toggle('active', active);
      b.setAttribute('aria-selected', String(active));
    }
    this.render();
  }

  private render(): void {
    const q = this.search.value.trim().toLowerCase();
    this.placed = [];
    if (q) {
      const results: Section[] = [];
      for (const t of this.tabs) {
        for (const s of t.sections) {
          const items = s.items.filter((c) => `${c.label} ${c.keywords ?? ''} ${c.hint ?? ''} ${s.title} ${t.label}`.toLowerCase().includes(q));
          if (items.length) results.push({ ...s, title: `${t.label} › ${s.title}`, items });
        }
      }
      this.renderSections(results, results.length ? null : `Nothing matches “${this.search.value}”.`);
      return;
    }
    const tab = this.tabs.find((t) => t.id === this.tab)!;
    this.renderSections(tab.sections, null);
  }

  private renderSections(sections: Section[], empty: string | null): void {
    this.nav.replaceChildren();
    const cards = sections.map((s, i) => {
      const body = h('div', { class: 'dev-card-body' });
      for (const control of s.items) {
        const rendered = renderControl(this.dev, control);
        this.placed.push({ control, rendered });
        body.append(rendered.el);
      }
      const card = h('section', { class: `dev-card${s.wide ? ' wide' : ''}`, id: `dev-sec-${i}` }, h('h3', null, h('span', { class: 'dev-card-icon' }, s.icon), s.title), body);
      const link = h('button', { type: 'button', class: 'dev-nav-item' }, h('span', null, s.icon), s.title);
      link.addEventListener('click', () => {
        card.scrollIntoView({ behavior: this.dev.config.settings.animSpeed > 0 ? 'smooth' : 'auto', block: 'start' });
        card.classList.remove('flash');
        void card.offsetWidth;
        card.classList.add('flash');
      });
      this.nav.append(link);
      return card;
    });
    this.panel.replaceChildren(empty ? h('div', { class: 'dev-empty big' }, empty) : h('div', { class: 'dev-grid' }, ...cards));
    this.panel.scrollTop = 0;
  }

  private liveRefresh(): void {
    for (const p of this.placed) {
      const t = p.control.type;
      if (t === 'info' || t === 'custom' || t === 'buttons') p.rendered.refresh();
    }
    this.updatePill();
  }

  private onConfigChange(): void {
    applyTheme(this.root, this.dev.config.settings);
    this.onResize();
    this.hint.textContent = `${keyName(this.dev.config.settings.menuKey)} to toggle`;
    this.updatePill();
    this.fillConfigSelect();
  }

  private updatePill(): void {
    const d = this.dev;
    const inMatch = d.runtime.currentSession !== null;
    const [text, kind, title] = !inMatch
      ? [d.status.publicHvh ? 'JOIN HVH TO ACTIVATE' : 'NOT IN MATCH', 'idle', 'Settings are saved for your next eligible match.']
      : d.active
        ? [d.status.profile === 'hvh' ? 'HVH · SHARED RULES' : 'PRIVATE PRACTICE', 'on', 'Normal stats and server-governed abilities.']
        : ['ACCESS REQUIRED', 'locked', 'Join HvH with public access enabled, or unlock developer access.'];
    if (this.pill.textContent !== text) {
      this.pill.textContent = text;
      this.pill.dataset.kind = kind;
      this.pill.title = title;
    }
  }

  private fillConfigSelect(): void {
    const names = this.dev.configs.map((c) => c.name);
    const key = names.join('|');
    if (this.configSelect.dataset.key === key) return;
    const keep = this.configSelect.value;
    this.configSelect.dataset.key = key;
    this.configSelect.replaceChildren(...names.map((n) => h('option', { value: n }, n)));
    if (names.includes(keep)) this.configSelect.value = keep;
  }

  private quickConfig(op: 'load' | 'save'): void {
    const named = this.dev.configs.find((c) => c.name === this.configSelect.value);
    if (!named) return this.dev.notify('Create a config in the Configs tab first', 'bad');
    if (op === 'load') {
      this.dev.replaceConfig(sanitizeConfig(structuredClone(named.config)));
      this.refreshAll();
      this.dev.notify(`Loaded “${named.name}”`, 'good');
    } else {
      named.config = sanitizeConfig(structuredClone(this.dev.config));
      this.dev.saveConfigList();
      this.dev.notify(`Saved “${named.name}”`, 'good');
    }
  }

  private resetTab(): void {
    const tab = this.tabs.find((t) => t.id === this.tab);
    if (!tab?.configKey) return this.dev.notify('Nothing to reset on this tab');
    const fresh = defaultConfig();
    const next = structuredClone(this.dev.config);
    for (const path of typeof tab.configKey === 'string' ? [tab.configKey] : tab.configKey) setPath(next, path, structuredClone(getPath(fresh, path)));
    this.dev.replaceConfig(next);
    this.refreshAll();
    this.dev.notify(`${tab.label} reset to defaults`, 'good');
  }

  private onKey = (e: KeyboardEvent): void => {
    if (e.key !== 'Escape' || document.querySelector('.dev-capturing')) return;
    e.stopPropagation();
    if (this.search.value) {
      this.search.value = '';
      this.render();
      return;
    }
    this.window.querySelector<HTMLButtonElement>('.dev-icon-btn')?.click();
  };

  // ---------------------------------------------------------------------------
  // Dragging
  // ---------------------------------------------------------------------------

  private makeDraggable(handle: HTMLElement): void {
    handle.addEventListener('pointerdown', (e) => {
      if ((e.target as HTMLElement).closest('input, button, select')) return;
      e.preventDefault();
      const rect = this.window.getBoundingClientRect();
      const dx = e.clientX - rect.left;
      const dy = e.clientY - rect.top;
      handle.setPointerCapture(e.pointerId);
      this.window.classList.add('dragging');
      const move = (ev: PointerEvent) => this.place(ev.clientX - dx, ev.clientY - dy);
      const up = () => {
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', up);
        this.window.classList.remove('dragging');
        const r = this.window.getBoundingClientRect();
        storage.set(POSITION_KEY, JSON.stringify({ x: r.left, y: r.top }));
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up);
    });
    window.addEventListener('resize', this.onResize);
  }

  private onResize = (): void => {
    const r = this.window.getBoundingClientRect();
    this.place(r.left, r.top);
  };

  /** Keep the scaled window on screen, including while its opening animation is running. */
  private place(x: number, y: number): void {
    const scale = this.dev.config.settings.scale;
    const maxX = Math.max(0, window.innerWidth - Math.min(this.window.offsetWidth * scale, window.innerWidth));
    const maxY = Math.max(0, window.innerHeight - Math.min(this.window.offsetHeight * scale, window.innerHeight));
    this.window.style.left = `${Math.round(Math.min(maxX, Math.max(0, x)))}px`;
    this.window.style.top = `${Math.round(Math.min(maxY, Math.max(0, y)))}px`;
  }

  private restorePosition(): void {
    try {
      const saved = JSON.parse(storage.get(POSITION_KEY) ?? 'null') as { x?: unknown; y?: unknown } | null;
      if (saved && typeof saved.x === 'number' && typeof saved.y === 'number') {
        this.place(saved.x, saved.y);
        return;
      }
    } catch {
      // Fall through to centring.
    }
    const r = this.window.getBoundingClientRect();
    this.place((window.innerWidth - r.width) / 2, Math.max(8, (window.innerHeight - r.height) / 2));
  }
}
