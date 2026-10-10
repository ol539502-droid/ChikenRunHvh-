import { h } from '../../ui/dom';
import { cleanName, exportConfig, importConfig, sanitizeConfig } from '../config';
import type { Dev } from '../Dev';

/** Configs tab: save, load, delete, rename, create, export and import named configs. */
export function configsPanel(dev: Dev): HTMLElement & { refresh: () => void } {
  return renderConfigsPanel(dev, { sanitizeConfig, importConfig, exportConfig });
}

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
  importConfig(text: string): { name: string; config: T };
  exportConfig(named: { name: string; config: T }): string;
}): HTMLElement & { refresh: () => void } {
  const { sanitizeConfig, importConfig, exportConfig } = schema;
  let selected = dev.configs[0]?.name ?? '';
  const list = h('div', { class: 'dev-clist', role: 'listbox', 'aria-label': 'Saved configs' });
  const name = h('input', { class: 'dev-text', placeholder: 'Config name', maxlength: 24, 'aria-label': 'Config name' });
  const importBox = h('textarea', { class: 'dev-text dev-import', placeholder: 'Paste an exported config here, then press Import again', rows: 5, spellcheck: 'false' });
  importBox.hidden = true;
  const file = h('input', { type: 'file', accept: '.json,application/json', class: 'dev-file' });
  file.hidden = true;

  const save = () => dev.saveConfigList();
  const find = (n: string) => dev.configs.find((c) => c.name === n);
  const uniqueName = (base: string) => {
    let n = cleanName(base);
    for (let i = 2; find(n); i++) n = `${cleanName(base).slice(0, 20)} ${i}`;
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
      save();
      dev.notify(`Created “${n}” from the current settings`, 'good');
    },
    save: () => {
      const c = find(selected);
      if (!c) return actions.create();
      c.config = sanitizeConfig(structuredClone(dev.config));
      save();
      dev.notify(`Saved “${c.name}”`, 'good');
    },
    load: () => {
      const c = find(selected);
      if (!c) return dev.notify('Select a config to load', 'bad');
      dev.replaceConfig(sanitizeConfig(structuredClone(c.config)));
      dev.menuRefresh();
      dev.notify(`Loaded “${c.name}”`, 'good');
    },
    rename: () => {
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
      const i = dev.configs.findIndex((c) => c.name === selected);
      if (i < 0) return dev.notify('Select a config to delete', 'bad');
      const [gone] = dev.configs.splice(i, 1);
      selected = dev.configs[Math.max(0, i - 1)]?.name ?? '';
      save();
      dev.notify(`Deleted “${gone!.name}”`);
    },
    exportIt: () => {
      const c = find(selected) ?? { name: 'Current', config: dev.config };
      const text = exportConfig(c);
      void navigator.clipboard?.writeText(text).catch(() => undefined);
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
      const named = importConfig(text);
      named.name = uniqueName(named.name);
      dev.configs.push(named);
      selected = named.name;
      save();
      importBox.value = '';
      importBox.hidden = true;
      dev.notify(`Imported “${named.name}”`, 'good');
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
      list,
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
        ),
        h('div', { class: 'dev-btns' }, btn('Export', wrap(actions.exportIt)), btn('Import', wrap(actions.importIt))),
        importBox,
        file,
        h('small', { class: 'dev-muted' }, 'Configs hold only menu settings and are stored in this browser. Imports are checked and anything unknown is dropped.'),
      ),
    ),
    { refresh: () => {} },
  );

  const refresh = () => {
    list.replaceChildren(
      ...(dev.configs.length === 0
        ? [h('div', { class: 'dev-empty' }, 'No saved configs')]
        : dev.configs.map((c) => {
            const row = h('button', { type: 'button', class: `dev-crow${c.name === selected ? ' active' : ''}`, role: 'option', 'aria-selected': String(c.name === selected) }, h('span', null, c.name));
            row.addEventListener('click', () => {
              selected = c.name;
              name.value = c.name;
              dev.click();
              refresh();
            });
            row.addEventListener('dblclick', wrap(actions.load));
            return row;
          })),
    );
  };
  root.refresh = () => {
    // Called often by the menu; only rebuild when the list changed.
    const key = dev.configs.map((c) => c.name).join('|') + `#${selected}`;
    if (key !== (root.dataset.key ?? '')) {
      root.dataset.key = key;
      refresh();
    }
  };
  refresh();
  return root;
}
