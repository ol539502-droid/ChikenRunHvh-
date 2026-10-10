import { storage } from './ui/dom';

/** Everything the player can rebind. `code` values are KeyboardEvent.code ("KeyW", "Space", "ShiftLeft"). */
export interface BindDef {
  id: BindId;
  label: string;
  group: 'Movement' | 'Combat' | 'Grenades' | 'Other';
  code: string;
}

export type BindId =
  | 'forward'
  | 'back'
  | 'left'
  | 'right'
  | 'jump'
  | 'crouch'
  | 'slowWalk'
  | 'reload'
  | 'inspect'
  | 'egg'
  | 'smoke'
  | 'flash'
  | 'use'
  | 'camera'
  | 'chat'
  | 'teamChat'
  | 'team'
  | 'build'
  | 'nextBlock'
  | 'flashlight';

export const BINDS: readonly BindDef[] = [
  { id: 'forward', label: 'Move forward', group: 'Movement', code: 'KeyW' },
  { id: 'back', label: 'Move back', group: 'Movement', code: 'KeyS' },
  { id: 'left', label: 'Move left', group: 'Movement', code: 'KeyA' },
  { id: 'right', label: 'Move right', group: 'Movement', code: 'KeyD' },
  { id: 'jump', label: 'Jump / bunny hop', group: 'Movement', code: 'Space' },
  { id: 'crouch', label: 'Crouch', group: 'Movement', code: 'KeyC' },
  { id: 'slowWalk', label: 'Slow walk', group: 'Movement', code: 'ShiftLeft' },
  { id: 'reload', label: 'Reload', group: 'Combat', code: 'KeyR' },
  { id: 'inspect', label: 'Inspect weapon', group: 'Combat', code: 'KeyF' },
  { id: 'egg', label: 'Throw egg', group: 'Grenades', code: 'KeyG' },
  { id: 'smoke', label: 'Throw smoke', group: 'Grenades', code: 'KeyQ' },
  { id: 'flash', label: 'Throw flashbang', group: 'Grenades', code: 'KeyZ' },
  { id: 'use', label: 'Use / plant / defuse / car', group: 'Other', code: 'KeyE' },
  { id: 'camera', label: 'First / third person', group: 'Other', code: 'KeyV' },
  { id: 'chat', label: 'Chat (everyone)', group: 'Other', code: 'KeyY' },
  { id: 'teamChat', label: 'Team chat', group: 'Other', code: 'KeyU' },
  { id: 'team', label: 'Switch team', group: 'Other', code: 'KeyM' },
  { id: 'build', label: 'Build mode (Sandbox)', group: 'Other', code: 'KeyB' },
  { id: 'nextBlock', label: 'Next block (Sandbox)', group: 'Other', code: 'KeyX' },
  { id: 'flashlight', label: 'Flashlight (Zombies)', group: 'Other', code: 'KeyT' },
];

export type Keybinds = Record<BindId, string>;

const KEY = 'chikengun:keybinds';
/** Keys that always keep their meaning: menus, scoreboard, weapon slots, the dev menus. */
const RESERVED = new Set(['Escape', 'Tab', 'Enter', 'Insert', 'KeyL', 'Backspace', 'Delete', 'MetaLeft', 'MetaRight', 'ContextMenu', ...Array.from({ length: 9 }, (_, i) => `Digit${i + 1}`)]);

export function defaultKeybinds(): Keybinds {
  return Object.fromEntries(BINDS.map((b) => [b.id, b.code])) as Keybinds;
}

/** A key we accept for a binding: a plain KeyboardEvent.code that isn't reserved. */
export function isBindable(code: unknown): code is string {
  return typeof code === 'string' && /^[A-Za-z0-9]{1,20}$/.test(code) && !RESERVED.has(code);
}

function sanitize(raw: unknown): Keybinds {
  const out = defaultKeybinds();
  if (!raw || typeof raw !== 'object') return out;
  const r = raw as Record<string, unknown>;
  for (const b of BINDS) if (isBindable(r[b.id])) out[b.id] = r[b.id] as string;
  // Keep unique saved keys before assigning unused defaults to conflicting actions.
  const seen = new Set<string>();
  for (const b of BINDS) {
    if (seen.has(out[b.id])) { out[b.id] = ''; continue; }
    seen.add(out[b.id]);
  }
  for (const b of BINDS) {
    if (out[b.id]) continue;
    out[b.id] = !seen.has(b.code) ? b.code : BINDS.find(def => !seen.has(def.code))!.code;
    seen.add(out[b.id]);
  }
  return out;
}

function load(): Keybinds {
  try {
    return sanitize(JSON.parse(storage.get(KEY) ?? 'null'));
  } catch {
    return defaultKeybinds();
  }
}

let current = load();
const listeners = new Set<(k: Keybinds) => void>();

export function getKeybinds(): Readonly<Keybinds> {
  return current;
}

/** Which other action already uses `code`, if any. */
export function bindOwner(code: string, except?: BindId): BindId | null {
  return BINDS.find((b) => b.id !== except && current[b.id] === code)?.id ?? null;
}

/** Binds `id` to `code`. A key that another action has swaps places with it. Returns false if the key isn't allowed. */
export function setKeybind(id: BindId, code: string): boolean {
  if (!isBindable(code)) return false;
  const next = { ...current };
  const owner = bindOwner(code, id);
  if (owner) next[owner] = current[id];
  next[id] = code;
  commit(next);
  return true;
}

export function resetKeybinds(): void {
  commit(defaultKeybinds());
}

function commit(next: Keybinds): void {
  current = next;
  storage.set(KEY, JSON.stringify(next));
  for (const fn of listeners) fn(current);
}

export function watchKeybinds(fn: (k: Keybinds) => void): () => void {
  listeners.add(fn);
  fn(current);
  return () => listeners.delete(fn);
}

/** "KeyW" → "W", "ShiftLeft" → "Left Shift", "Space" → "Space". */
export function keyLabel(code: string): string {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit\d$/.test(code)) return code.slice(5);
  if (/^(Shift|Control|Alt)(Left|Right)$/.test(code)) return `${code.endsWith('Left') ? 'Left' : 'Right'} ${code.replace(/(Left|Right)$/, '')}`;
  if (code.startsWith('Arrow')) return `${code.slice(5)} arrow`;
  return code.replace(/([a-z])([A-Z])/g, '$1 $2');
}
