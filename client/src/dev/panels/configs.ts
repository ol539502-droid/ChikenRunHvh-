import { h } from '../../ui/dom';
import { cleanName, exportConfig, importConfig, sanitizeConfig } from '../config';
import type { Dev } from '../Dev';

/** Configs tab: save, load, delete, rename, create, export and import named configs. */
export function configsPanel(dev: Dev): HTMLElement & { refresh: () => void } {
  return renderConfigsPanel(dev, { sanitizeConfig, importConfig, exportConfig });
}

/** Read-only configs shown above the saved ones (mega?dev only). */
export interface Builtins<T> {
  list: readonly { name: string; description: string; tag: string; color: string; build(current: T): T }[];
  /** Reset to default. */
  reset(current: T): T;
  /** Compared after a load to tell "Custom (modified)". */
  print(config: T): string;
}

/** Which config each menu last loaded, and how it looked then. */
const loaded = new WeakMap<object, { name: string; print: string }>();

export function renderConfigsPanel<T>(dev: {
  config: T;
  configs: { name: string; config: T }[];
  saveConfigList(): void;
  replaceConfig(config: T): void;
  menuRefresh(): void;
  click(): void;
  notify(text: string, kind?: 'info' | 'good' | 'bad'): void;
}, schema: {
  sanitizeConfig(raw: unknown): T;
  importConfig(text: string): { name: string; config: T; reset?: string[] };
  exportConfig(named: { name: string; config: T }): string;
  builtins?: Builtins<T>;
}): HTMLElement & { refresh: () => void } {
  const { sanitizeConfig, importConfig, exportConfig, builtins } = schema;
  /** Selected built-in (by name), or '' when a saved config (or nothing) is selected. */
  let builtin = '';
  let selected = dev.configs[0]?.name ?? '';
  const findBuiltin = () => (builtin ? builtins?.list.find((b) => b.name === builtin) : undefined);
  const active = h('div', { class: 'dev-cactive' });
  const activeLabel = () => {
    const l = builtins && loaded.get(dev);
    if (!l) return 'Custom';
    return l.print === builtins.print(dev.config) ? `Active: ${l.name}` : 'Custom (modified)';
  };
  const markLoaded = (n: string) => builtins && loaded.set(dev, { name: n, print: builtins.print(dev.config) });
  const list = h('div', { class: 'dev-clist', role: 'listbox', 'aria-label': 'Saved configs' });
  const name = h('input', { class: 'dev-text', placeholder: 'Config name', maxlength: 24, 'aria-label': 'Config name' });
  const importBox = h('textarea', { class: 'dev-text dev-import', placeholder: 'Paste an exported config here, then press Import again', rows: 5, spellcheck: 'false' });
  importBox.hidden = true;
  const file = h('input', { type: 'file', accept: '.json,.txt,application/json,text/plain', class: 'dev-file' });
  file.hidden = true;

  const save = () => dev.saveConfigList();
  const find = (n: string) => dev.configs.find((c) => c.name === n);
  const uniqueName = (base: string) => {
    let n = cleanName(base);
    const taken = (x: string) => find(x) || builtins?.list.some((b) => cleanName(b.name) === x);
    for (let i = 2; taken(n); i++) n = `${cleanName(base).slice(0, 20)} ${i}`;
    return n;
  };
  const btn = (label: string, run: () => void, tone = '') => {
    const b = h('button', { type: 'button', class: `dev-btn ${tone}` }, label);
    b.addEventListener('click', () => {
      dev.click();
      run();
    });
    return b;
  };

  const actions = {
    create: () => {
      const n = uniqueName(name.value || 'New config');
      dev.configs.push({ name: n, config: sanitizeConfig(structuredClone(dev.config)) });
      selected = n;
      builtin = '';
      save();
      dev.notify(`Created “${n}” from the current settings`, 'good');
    },
    save: () => {
      const c = !builtin && find(selected);
      if (!c) return actions.create();
      c.config = sanitizeConfig(structuredClone(dev.config));
      save();
      dev.notify(`Saved “${c.name}”`, 'good');
    },
    load: () => {
      const b = findBuiltin();
      if (b) {
        dev.replaceConfig(sanitizeConfig(b.build(dev.config)));
        markLoaded(b.name);
        dev.menuRefresh();
        return dev.notify(`Loaded config: ${b.name}`, 'good');
      }
      const c = find(selected);
      if (!c) return dev.notify('Select a config to load', 'bad');
      dev.replaceConfig(sanitizeConfig(structuredClone(c.config)));
      markLoaded(c.name);
      dev.menuRefresh();
      dev.notify(builtins ? `Loaded config: ${c.name}` : `Loaded “${c.name}”`, 'good');
    },
    reset: () => {
      if (!builtins) return;
      dev.replaceConfig(sanitizeConfig(builtins.reset(dev.config)));
      loaded.delete(dev);
      dev.menuRefresh();
      dev.notify('Every cheat setting back to default', 'good');
    },
    rename: () => {
      if (builtin) return dev.notify('Built-in configs can’t be renamed; Save makes your own copy', 'bad');
      const c = find(selected);
      if (!c) return dev.notify('Select a config to rename', 'bad');
      if (!name.value.trim()) return dev.notify('Type the new name first', 'bad');
      const n = uniqueName(name.value);
      c.name = n;
      selected = n;
      save();
      dev.notify(`Renamed to “${n}”`, 'good');
    },
    remove: () => {
      if (builtin) return dev.notify('Built-in configs can’t be deleted', 'bad');
      const i = dev.configs.findIndex((c) => c.name === selected);
      if (i < 0) return dev.notify('Select a config to delete', 'bad');
      const [gone] = dev.configs.splice(i, 1);
      selected = dev.configs[Math.max(0, i - 1)]?.name ?? '';
      save();
      dev.notify(`Deleted “${gone!.name}”`);
    },
    exportIt: () => {
      const b = findBuiltin();
      const c = (b && { name: b.name, config: b.build(dev.config) }) || (!builtin && find(selected)) || { name: 'Current', config: dev.config };
      const text = exportConfig(c);
      void navigator.clipboard?.writeText(text).catch(() => undefined);
      if (!text.startsWith('{')) {
        // A short share code: shown in the box to copy (Import with it there adds it back).
        importBox.hidden = false;
        importBox.value = text;
        importBox.select();
        return dev.notify(`Config code for “${c.name}” copied`, 'good');
      }
      const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
      const a = h('a', { href: url, download: `${c.name.replace(/\s+/g, '-').toLowerCase()}.chikenrunhvh-dev.json` });
      a.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      dev.notify(`Exported “${c.name}” (copied and downloaded)`, 'good');
    },
    importIt: () => {
      if (importBox.hidden) {
        importBox.hidden = false;
        importBox.focus();
        return;
      }
      if (!importBox.value.trim()) return file.click();
      addImported(importBox.value);
    },
  };

  const addImported = (text: string) => {
    try {
      const { reset, ...named } = importConfig(text);
      named.name = uniqueName(named.name);
      dev.configs.push(named);
      selected = named.name;
      builtin = '';
      save();
      importBox.value = '';
      importBox.hidden = true;
      dev.notify(`Imported “${named.name}”`, 'good');
      if (reset?.length) dev.notify(`Reset to defaults by the HvH v2 migration: ${reset.join(', ')}`, 'bad');
      refresh();
    } catch (err) {
      dev.notify(err instanceof Error ? err.message : 'That is not a valid config', 'bad');
    }
  };
  file.addEventListener('change', () => {
    const f = file.files?.[0];
    if (f) void f.text().then(addImported);
    file.value = '';
  });

  const wrap = (fn: () => void) => () => {
    fn();
    refresh();
  };
  const root = Object.assign(
    h(
      'div',
      { class: 'dev-configs' },
      builtins ? h('div', { class: 'dev-cleft' }, active, list) : list,
      h(
        'div',
        { class: 'dev-cside' },
        name,
        h(
          'div',
          { class: 'dev-btns' },
          btn('Load', wrap(actions.load), 'primary'),
          btn('Save', wrap(actions.save)),
          btn('Create new', wrap(actions.create)),
          btn('Rename', wrap(actions.rename)),
          btn('Delete', wrap(actions.remove), 'danger'),
          builtins ? btn('Reset to default', wrap(actions.reset)) : null,
        ),
        h('div', { class: 'dev-btns' }, btn('Export', wrap(actions.exportIt)), btn('Import', wrap(actions.importIt))),
        importBox,
        file,
        h('small', { class: 'dev-muted' }, 'Configs hold only menu settings and are stored in this browser. Imports are checked and anything unknown is dropped.'),
      ),
    ),
    { refresh: () => {} },
  );

  const row = (on: boolean, pick: () => void, ...content: HTMLElement[]) => {
    const r = h('button', { type: 'button', class: `dev-crow${on ? ' active' : ''}`, role: 'option', 'aria-selected': String(on) }, ...content);
    r.addEventListener('click', () => {
      pick();
      dev.click();
      refresh();
    });
    r.addEventListener('dblclick', wrap(actions.load));
    return r;
  };
  const refresh = () => {
    active.textContent = activeLabel();
    const saved =
      dev.configs.length === 0
        ? [h('div', { class: 'dev-empty' }, 'No saved configs')]
        : dev.configs.map((c) =>
            row(
              !builtin && c.name === selected,
              () => {
                selected = c.name;
                builtin = '';
                name.value = c.name;
              },
              h('span', null, c.name),
            ),
          );
    if (!builtins) return list.replaceChildren(...saved);
    list.replaceChildren(
      h('div', { class: 'dev-sub' }, 'Built-in'),
      ...builtins.list.map((b) =>
        row(
          b.name === builtin,
          () => {
            builtin = b.name;
            name.value = '';
          },
          h('span', { class: 'dev-cname' }, b.name, h('i', { class: 'dev-ctag', style: `--tag:${b.color}` }, b.tag)),
          h('small', { class: 'dev-cdesc' }, b.description),
        ),
      ),
      h('div', { class: 'dev-sub' }, 'Your configs'),
      ...saved,
    );
  };
  root.refresh = () => {
    // Called often by the menu; only rebuild when the list changed.
    active.textContent = activeLabel();
    const key = dev.configs.map((c) => c.name).join('|') + `#${builtin}#${selected}`;
    if (key !== (root.dataset.key ?? '')) {
      root.dataset.key = key;
      refresh();
    }
  };
  refresh();
  return root;
}
