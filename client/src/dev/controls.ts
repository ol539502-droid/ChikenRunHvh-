import { h } from '../ui/dom';
import { CHOICES, RANGES } from './config';
import type { Dev } from './Dev';

/** Reads/writes a value that doesn't live in the dev config (camera mode, FOV...). */
export interface Binding<T> {
  get(): T;
  set(value: T): void;
}

interface Base {
  label: string;
  /** Extra words that should find this control in the search. */
  keywords?: string;
  hint?: string;
}

export type Control =
  | (Base & { type: 'toggle' | 'check'; path?: string; bind?: Binding<boolean> })
  | (Base & { type: 'slider'; path?: string; bind?: Binding<number>; min?: number; max?: number; step?: number; unit?: string; digits?: number })
  | (Base & { type: 'select'; path?: string; bind?: Binding<string>; options?: { value: string; label: string }[] })
  | (Base & { type: 'key'; path: string })
  | (Base & { type: 'color'; path: string })
  | (Base & { type: 'buttons'; items: { label: string; run: () => void; tone?: 'primary' | 'danger'; disabled?: () => boolean }[] })
  | (Base & { type: 'info'; value: () => string })
  | (Base & { type: 'custom'; render: () => HTMLElement & { refresh?: () => void } });

export interface Section {
  title: string;
  icon: string;
  items: Control[];
  /** Spans both columns. */
  wide?: boolean;
}

export interface Tab {
  id: string;
  label: string;
  icon: string;
  /** The part of the dev config this tab edits (for "Reset tab"). */
  configKey?: string | readonly string[];
  sections: Section[];
}

/** A rendered control plus a way to re-read its value after the config changed elsewhere. */
export interface Rendered {
  el: HTMLElement;
  refresh(): void;
}

/** Human names for key codes in keybind buttons. */
export function keyName(code: string): string {
  if (!code) return 'Always';
  const mouse: Record<string, string> = { Mouse0: 'Mouse 1', Mouse1: 'Mouse 3', Mouse2: 'Mouse 2', Mouse3: 'Mouse 4', Mouse4: 'Mouse 5' };
  if (mouse[code]) return mouse[code]!;
  return code.replace(/^Key/, '').replace(/^Digit/, '').replace(/Left$|Right$/, (m) => ` ${m[0]}`);
}

const label = (text: string, hint?: string) => h('div', { class: 'dev-label' }, h('span', null, text), hint ? h('small', null, hint) : null);

export function renderControl(dev: Pick<Dev, 'get' | 'set' | 'click'>, c: Control, ranges = RANGES, choices = CHOICES): Rendered {
  const read = <T>(path: string | undefined, bind: Binding<T> | undefined): T => (bind ? bind.get() : (dev.get(path!) as T));
  const write = <T>(path: string | undefined, bind: Binding<T> | undefined, value: T) => {
    if (bind) bind.set(value);
    else dev.set(path!, value);
  };

  switch (c.type) {
    case 'toggle':
    case 'check': {
      const input = h('input', { type: 'checkbox', class: c.type === 'toggle' ? 'dev-switch' : 'dev-check', 'aria-label': c.label });
      input.addEventListener('change', () => {
        write(c.path, c.bind, input.checked);
        dev.click();
      });
      const el = h('label', { class: `dev-row ${c.type}` }, label(c.label, c.hint), input);
      const refresh = () => (input.checked = read<boolean>(c.path, c.bind) === true);
      refresh();
      return { el, refresh };
    }
    case 'slider': {
      const range = c.path ? ranges[c.path] : undefined;
      const min = c.min ?? range?.min ?? 0;
      const max = c.max ?? range?.max ?? 1;
      const step = c.step ?? range?.step ?? 0.01;
      const digits = c.digits ?? (step >= 1 ? 0 : step >= 0.1 ? 1 : 2);
      const input = h('input', { type: 'range', class: 'dev-range', min, max, step, 'aria-label': c.label });
      const value = h('input', { type: 'number', class: 'dev-num', min, max, step, 'aria-label': `${c.label} value` });
      const fill = () => input.style.setProperty('--fill', `${((Number(input.value) - min) / (max - min)) * 100}%`);
      input.addEventListener('input', () => {
        value.value = Number(input.value).toFixed(digits);
        fill();
        write(c.path, c.bind, Number(input.value));
      });
      value.addEventListener('change', () => {
        const v = Math.min(max, Math.max(min, Number(value.value) || min));
        input.value = String(v);
        value.value = v.toFixed(digits);
        fill();
        write(c.path, c.bind, v);
      });
      const el = h('div', { class: 'dev-row slider' }, label(c.label, c.hint), h('div', { class: 'dev-slider' }, input, value, c.unit ? h('span', { class: 'dev-unit' }, c.unit) : null));
      const refresh = () => {
        const v = read<number>(c.path, c.bind);
        input.value = String(v);
        value.value = Number(v).toFixed(digits);
        fill();
      };
      refresh();
      return { el, refresh };
    }
    case 'select': {
      const options = c.options ?? (choices[c.path!] ?? []).map((v) => ({ value: v, label: v[0]!.toUpperCase() + v.slice(1) }));
      const select = h('select', { class: 'dev-select', 'aria-label': c.label }, ...options.map((o) => h('option', { value: o.value }, o.label)));
      select.addEventListener('change', () => {
        write(c.path, c.bind, select.value);
        dev.click();
      });
      const el = h('div', { class: 'dev-row' }, label(c.label, c.hint), select);
      const refresh = () => (select.value = read<string>(c.path, c.bind));
      refresh();
      return { el, refresh };
    }
    case 'key': {
      const button = h('button', { type: 'button', class: 'dev-key' });
      let capturing = false;
      const stop = () => {
        capturing = false;
        button.classList.remove('dev-capturing');
        window.removeEventListener('keydown', onKey, true);
        window.removeEventListener('mousedown', onMouse, true);
        refresh();
      };
      const onKey = (e: KeyboardEvent) => {
        e.preventDefault();
        e.stopPropagation();
        // Esc cancels; Backspace/Delete clears the bind (menu key can't be cleared).
        if (e.code === 'Escape') return stop();
        if (e.code === 'Backspace' || e.code === 'Delete') dev.set(c.path, c.path === 'settings.menuKey' ? 'Insert' : '');
        else dev.set(c.path, e.code);
        stop();
      };
      const onMouse = (e: MouseEvent) => {
        if (e.target === button && e.button === 0) return;
        e.preventDefault();
        e.stopPropagation();
        if (c.path !== 'settings.menuKey') dev.set(c.path, `Mouse${e.button}`);
        stop();
      };
      button.addEventListener('click', () => {
        if (capturing) return;
        capturing = true;
        button.classList.add('dev-capturing');
        button.textContent = 'Press a key…';
        window.addEventListener('keydown', onKey, true);
        window.setTimeout(() => window.addEventListener('mousedown', onMouse, true));
      });
      const el = h('div', { class: 'dev-row' }, label(c.label, c.hint ?? 'Click, then press a key or mouse button. Backspace clears.'), button);
      const refresh = () => {
        if (!capturing) button.textContent = keyName(String(dev.get(c.path) ?? ''));
      };
      refresh();
      return { el, refresh };
    }
    case 'color': {
      const input = h('input', { type: 'color', class: 'dev-color', 'aria-label': c.label });
      input.addEventListener('input', () => dev.set(c.path, input.value));
      const el = h('label', { class: 'dev-row' }, label(c.label, c.hint), input);
      const refresh = () => (input.value = String(dev.get(c.path)));
      refresh();
      return { el, refresh };
    }
    case 'buttons': {
      const buttons = c.items.map((item) => {
        const b = h('button', { type: 'button', class: `dev-btn ${item.tone ?? ''}` }, item.label);
        b.addEventListener('click', () => {
          dev.click();
          item.run();
        });
        return { b, item };
      });
      const el = h('div', { class: 'dev-row buttons' }, c.label ? label(c.label, c.hint) : null, h('div', { class: 'dev-btns' }, ...buttons.map((x) => x.b)));
      const refresh = () => {
        for (const { b, item } of buttons) b.disabled = item.disabled?.() ?? false;
      };
      refresh();
      return { el, refresh };
    }
    case 'info': {
      const value = h('span', { class: 'dev-info-value' });
      const el = h('div', { class: 'dev-row info' }, label(c.label, c.hint), value);
      const refresh = () => {
        const text = c.value();
        if (value.textContent !== text) value.textContent = text;
      };
      refresh();
      return { el, refresh };
    }
    case 'custom': {
      const el = c.render();
      return { el, refresh: () => el.refresh?.() };
    }
  }
}
