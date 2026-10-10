import { MAPS, MODES, MODE_IDS, REPORT_REASONS, rankOf, type CreateRoomRequest, type LeaderboardRow, type MapId, type ModeId, type Profile, type ReportReason, type RoomSummary } from '@game/shared';
import { BINDS, getKeybinds, keyLabel, resetKeybinds, setKeybind, watchKeybinds, type BindId } from '../keybinds';
import type { AudioEngine } from '../game/Audio';
import { getCameraMode, setCameraMode, type CameraMode } from '../game/CameraRig';
import { exitPlayFullscreen, keyboardLockSupported } from '../fullscreen';
import { ApiError, type Api } from '../net/Api';
import { CROSSHAIR_COLORS, CROSSHAIR_STYLES, LIMITS, defaultCrosshair, defaultSettings, getSettings, updateSettings, type CrosshairSettings, type Quality } from '../settings';
import { CrosshairView } from './Crosshair';
import { clear, h } from './dom';
import { openModal } from './Modal';

const PHASE_LABEL: Record<RoomSummary['phase'], string> = { waiting: 'Waiting', countdown: 'Starting', playing: 'In game', ended: 'Results' };

/** List of public rooms with join buttons. */
export function openServerBrowser(listRooms: () => Promise<RoomSummary[]>, join: (roomId: string) => void): void {
  const list = h('div', { class: 'room-list' }, 'Loading…');
  const refresh = async () => {
    clear(list);
    list.append('Loading…');
    try {
      const rooms = await listRooms();
      clear(list);
      if (rooms.length === 0) {
        list.append(h('p', { class: 'muted' }, 'No public rooms right now. Use Quick Play or create one!'));
        return;
      }
      const table = h('table', { class: 'rooms' }, h('tr', null, h('th', null, 'Room'), h('th', null, 'Mode'), h('th', null, 'Map'), h('th', null, 'Players'), h('th', null, 'Status'), h('th')));
      for (const r of rooms.sort((a, b) => b.players - a.players)) {
        const full = r.players >= r.maxPlayers;
        table.append(
          h(
            'tr',
            null,
            h('td', null, r.name),
            h('td', null, MODES[r.mode].name),
            h('td', null, MAPS[r.map].name),
            h('td', null, `${r.players}/${r.maxPlayers}`),
            h('td', null, PHASE_LABEL[r.phase]),
            h('td', null, h('button', { type: 'button', disabled: full, onclick: () => (modal.close(), join(r.id)) }, full ? 'Full' : 'Join')),
          ),
        );
      }
      list.append(table);
    } catch {
      clear(list);
      list.append(h('p', { class: 'error' }, 'Could not load rooms.'));
    }
  };
  const content = h('div', null, h('div', { class: 'row-right' }, h('button', { class: 'secondary', type: 'button', onclick: () => void refresh() }, '↻ Refresh')), list);
  const modal = openModal('Server browser', content, { wide: true });
  void refresh();
}

/** Pick mode, map, privacy and bots for a new room. */
export function openCreateRoom(create: (req: CreateRoomRequest) => void): void {
  // Ranked (FaceChiken) is matchmaking only.
  const mode = h('select', { id: 'create-mode' }, ...MODE_IDS.filter((id) => !MODES[id].ranked && !MODES[id].training).map((id) => h('option', { value: id }, MODES[id].name)));
  const map = h('select', { id: 'create-map' });
  const fillMaps = () => {
    clear(map);
    for (const id of MODES[mode.value as ModeId].maps) map.append(h('option', { value: id }, MAPS[id].name));
  };
  mode.addEventListener('change', fillMaps);
  fillMaps();
  const isPrivate = h('input', { type: 'checkbox', id: 'create-private', checked: true });
  const bots = h('input', { type: 'number', id: 'create-bots', min: 0, max: 8, value: 0 });
  const form = h(
    'form',
    { class: 'form' },
    h('label', { for: 'create-mode' }, 'Mode'),
    mode,
    h('label', { for: 'create-map' }, 'Map'),
    map,
    h('label', { class: 'check' }, isPrivate, ' Private (friends join with a code)'),
    h('label', { for: 'create-bots' }, 'AI bots'),
    bots,
    h('button', { type: 'submit' }, 'Create room'),
  );
  const modal = openModal('Create room', form);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    modal.close();
    create({ mode: mode.value as ModeId, map: map.value as MapId, private: isPrivate.checked, bots: Math.max(0, Math.min(8, Number(bots.value) || 0)) });
  });
}

export function openJoinCode(join: (code: string) => void): void {
  const input = h('input', { maxlength: 5, placeholder: 'ABCDE', class: 'code-input', autocomplete: 'off', spellcheck: 'false' });
  const form = h('form', { class: 'form' }, h('p', { class: 'muted' }, 'Ask the host for the 5-letter room code.'), input, h('button', { type: 'submit' }, 'Join'));
  const modal = openModal('Join with code', form);
  input.focus();
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const code = input.value.trim().toUpperCase();
    if (code.length !== 5) return;
    modal.close();
    join(code);
  });
}

/** Register to keep progress, log in on another device, or log out. */
/** "2h ago", "3d ago" for the match history. */
function ago(at: number, now = Date.now()): string {
  const minutes = Math.max(0, Math.round((now - at) / 60_000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 60 * 24) return `${Math.floor(minutes / 60)}h ago`;
  return `${Math.floor(minutes / 1440)}d ago`;
}

/** Account > Last 10 matches: result, mode, K/D and headshot share of the kills. */
function historyBox(api: Api): HTMLElement {
  const box = h('div', { class: 'history' }, h('h3', null, 'Last 10 matches'), h('p', { class: 'muted' }, 'Loading…'));
  api
    .history()
    .then((rows) => {
      clear(box);
      box.append(h('h3', null, 'Last 10 matches'));
      if (rows.length === 0) {
        box.append(h('p', { class: 'muted' }, 'No matches yet. Finish one and it shows up here.'));
        return;
      }
      const table = h('div', { class: 'history-table', role: 'table' });
      table.append(h('div', { class: 'history-row head', role: 'row' }, h('span', null, ''), h('span', null, 'Mode'), h('span', null, 'K / D'), h('span', null, 'HS %'), h('span', null, 'When')));
      for (const r of rows) {
        const hs = r.kills > 0 ? `${Math.round((r.headshots / r.kills) * 100)}%` : '–';
        table.append(
          h(
            'div',
            { class: `history-row ${r.won ? 'won' : 'lost'}`, role: 'row' },
            h('b', null, r.won ? 'WIN' : 'LOSS'),
            h('span', null, MODES[r.mode]?.name ?? r.mode),
            h('span', null, `${r.kills} / ${r.deaths}`),
            h('span', null, hs),
            h('span', { class: 'muted' }, ago(r.at)),
          ),
        );
      }
      box.append(table);
    })
    .catch(() => {
      clear(box);
      box.append(h('h3', null, 'Last 10 matches'), h('p', { class: 'muted' }, 'Could not load your matches.'));
    });
  return box;
}

export function openAccount(api: Api, onChanged: () => void): void {
  const content = h('div');
  const modal = openModal('Account', content);
  const render = () => {
    clear(content);
    const p = api.profile!;
    const stats = h(
      'div',
      { class: 'stats-grid' },
      ...(
        [
          ['Kills', p.stats.kills],
          ['Deaths', p.stats.deaths],
          ['Wins', p.stats.wins],
          ['Matches', p.stats.matches],
        ] as const
      ).map(([label, value]) => h('div', null, h('b', null, value), h('span', null, label))),
    );
    if (p.username) {
      content.append(
        h('p', null, 'Signed in as ', h('b', null, p.username)),
        stats,
        historyBox(api),
        h(
          'button',
          {
            class: 'secondary',
            type: 'button',
            onclick: async () => {
              await api.logout();
              onChanged();
              modal.close();
            },
          },
          'Log out',
        ),
        passwordForm(),
        h(
          'div',
          { class: 'form compact' },
          h('h3', null, 'Security'),
          h('p', { class: 'muted' }, 'Lost a device, or logged in somewhere you shouldn’t have? Sign out everywhere.'),
          h(
            'button',
            {
              class: 'secondary',
              type: 'button',
              onclick: async () => {
                await api.logoutEverywhere();
                onChanged();
                modal.close();
              },
            },
            'Log out on all devices',
          ),
        ),
        deleteForm(true),
      );
      return;
    }
    content.append(h('p', { class: 'muted' }, 'You are playing as a guest. Register to keep your coins and items, and to log in on other devices.'), stats, historyBox(api));
    content.append(credentialsForm('Register (keeps your progress)', 'Register', (u, pw) => api.register(u, pw)));
    content.append(credentialsForm('Already have an account?', 'Log in', (u, pw) => api.login(u, pw)));
    content.append(deleteForm(false));
  };
  const passwordForm = () => {
    const current = h('input', { type: 'password', placeholder: 'Current password', autocomplete: 'current-password', maxlength: 128 });
    const next = h('input', { type: 'password', placeholder: 'New password (8+ characters)', autocomplete: 'new-password', maxlength: 128 });
    const status = h('p', { class: 'muted' });
    const form = h('form', { class: 'form compact' }, h('h3', null, 'Change password'), current, next, h('button', { type: 'submit' }, 'Change password'), status);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      status.className = 'muted';
      status.textContent = '';
      try {
        await api.changePassword(current.value, next.value);
        current.value = next.value = '';
        status.textContent = 'Password changed. Your other devices were signed out.';
        onChanged();
      } catch (err) {
        status.className = 'error';
        status.textContent = err instanceof ApiError ? err.message : 'Something went wrong.';
      }
    });
    return form;
  };
  /** Permanent deletion; registered accounts confirm with their password. */
  const deleteForm = (registered: boolean) => {
    const password = h('input', { type: 'password', placeholder: 'Password', autocomplete: 'current-password', maxlength: 128 });
    const status = h('p', { class: 'error' });
    const form = h(
      'form',
      { class: 'form compact' },
      h('h3', null, registered ? 'Delete account' : 'Delete guest data'),
      h('p', { class: 'muted' }, 'Removes your account, coins, items and stats from the server for good.'),
      registered ? password : null,
      h('button', { type: 'submit', class: 'secondary' }, registered ? 'Delete my account' : 'Delete my data'),
      status,
    );
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!window.confirm('Delete everything for good? This cannot be undone.')) return;
      status.textContent = '';
      try {
        await api.deleteAccount(registered ? password.value : undefined);
        onChanged();
        modal.close();
      } catch (err) {
        status.textContent = err instanceof ApiError ? err.message : 'Something went wrong.';
      }
    });
    return form;
  };
  const credentialsForm = (title: string, label: string, submit: (u: string, p: string) => Promise<Profile>) => {
    const user = h('input', { placeholder: 'Username', autocomplete: 'username', maxlength: 16 });
    const pass = h('input', { type: 'password', placeholder: label === 'Register' ? 'Password (8+ characters)' : 'Password', autocomplete: label === 'Register' ? 'new-password' : 'current-password', maxlength: 128 });
    const error = h('p', { class: 'error' });
    const form = h('form', { class: 'form compact' }, h('h3', null, title), user, pass, h('button', { type: 'submit' }, label), error);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      error.textContent = '';
      try {
        await submit(user.value.trim(), pass.value);
        onChanged();
        render();
      } catch (err) {
        error.textContent = err instanceof ApiError ? err.message : 'Something went wrong.';
      }
    });
    return form;
  };
  render();
}

/** Modes with their own leaderboard (everything but Sandbox). */
const BOARD_MODES = MODE_IDS.filter((id) => !MODES[id].building && !MODES[id].zombies && !MODES[id].training);

/** The best players overall (by rank) or in one mode (by wins), one tab each. */
/** "3h 20m" / "12m" until the daily challenges reset. */
function untilReset(ms: number): string {
  const minutes = Math.max(1, Math.ceil(ms / 60_000));
  return minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${minutes}m`;
}

/** Main menu > Daily challenges: three goals a day, each pays coins once when you reach it. */
export async function openDaily(api: Api): Promise<void> {
  const body = h('div', { class: 'daily' }, h('p', { class: 'muted' }, 'Loading…'));
  openModal('📅 Daily challenges', body);
  try {
    const status = await api.daily();
    clear(body);
    body.append(h('p', { class: 'muted daily-note' }, `Progress counts every match you finish today, in any mode. New challenges in ${untilReset(status.resetsInMs)}.`));
    for (const c of status.challenges) {
      body.append(
        h(
          'div',
          { class: `daily-row${c.done ? ' done' : ''}` },
          h('div', { class: 'daily-top' }, h('b', null, c.done ? `✅ ${c.label}` : c.label), h('span', { class: 'daily-reward' }, `🪙 ${c.reward}`)),
          h('div', { class: 'daily-bar', role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': c.goal, 'aria-valuenow': c.progress }, h('i', { style: `width:${Math.round((c.progress / c.goal) * 100)}%` })),
          h('small', { class: 'muted' }, `${c.progress} / ${c.goal}`),
        ),
      );
    }
    if (status.challenges.every((c) => c.done)) body.append(h('p', { class: 'daily-note' }, 'All done for today. Come back tomorrow!'));
  } catch {
    clear(body);
    body.append(h('p', { class: 'muted' }, 'Could not load the challenges. Try again in a moment.'));
  }
}

export async function openLeaderboard(api: Api, initial?: ModeId): Promise<void> {
  const tabs = h('div', { class: 'tabs board-tabs', role: 'tablist' });
  const content = h('div', { class: 'board' });
  let request = 0;
  const show = async (mode: ModeId | null) => {
    for (const b of tabs.children) b.classList.toggle('active', (b as HTMLElement).dataset.tab === (mode ?? 'all'));
    const mine = ++request;
    content.replaceChildren(h('p', { class: 'muted' }, 'Loading…'));
    try {
      const rows: LeaderboardRow[] = await api.leaderboard(mode ?? undefined);
      if (mine !== request) return;
      clear(content);
      content.append(h('p', { class: 'muted board-note' }, mode ? `Best in ${MODES[mode].name}, by ${MODES[mode].ranked ? 'rank points' : 'wins then kills'}.` : 'Best chickens in every mode, by wins then kills. Levels move in FaceChiken.'));
      if (rows.length === 0) {
        content.append(h('p', { class: 'muted' }, mode ? `No finished ${MODES[mode].name} matches yet. Be the first!` : 'No finished matches yet. Be the first!'));
        return;
      }
      const table = h('table', { class: 'rooms board-table' }, h('tr', null, h('th', null, '#'), h('th', null, 'Chicken'), h('th', null, 'Rank'), h('th', null, 'Wins'), h('th', null, 'Kills'), h('th', null, 'Deaths'), h('th', null, 'Matches')));
      rows.forEach((r, i) => {
        const rank = rankOf(r.level);
        table.append(
          h(
            'tr',
            { class: i < 3 ? `top top${i + 1}` : '' },
            h('td', null, i < 3 ? ['🥇', '🥈', '🥉'][i]! : i + 1),
            h('td', null, r.dev ? h('span', { class: 'rainbow' }, r.name) : r.name),
            h('td', { class: 'board-rank', title: rank.name }, `${rank.icon} ${rank.level}`),
            h('td', null, r.wins),
            h('td', null, r.kills),
            h('td', null, r.deaths),
            h('td', null, r.matches),
          ),
        );
      });
      content.append(table);
    } catch {
      if (mine !== request) return;
      clear(content);
      content.append(h('p', { class: 'error' }, 'Could not load the leaderboard.'));
    }
  };
  const tab = (id: string, label: string, mode: ModeId | null) => h('button', { type: 'button', class: 'tab', role: 'tab', 'data-tab': id, onclick: () => void show(mode) }, label);
  tabs.append(tab('all', 'All modes', null), ...BOARD_MODES.map((id) => tab(id, MODES[id].name, id)));
  openModal('Leaderboard', h('div', { class: 'board-wrap' }, tabs, content), { wide: true });
  const start = initial && BOARD_MODES.includes(initial) ? initial : null;
  tabs.querySelector<HTMLElement>(`[data-tab="${start ?? 'all'}"]`)?.scrollIntoView({ block: 'nearest', inline: 'center' });
  await show(start);
}

type SettingsTab = 'controls' | 'keys' | 'crosshair' | 'graphics' | 'sound';
const SETTINGS_TABS: { id: SettingsTab; label: string }[] = [
  { id: 'controls', label: 'Controls' },
  { id: 'keys', label: 'Keys' },
  { id: 'crosshair', label: 'Crosshair' },
  { id: 'graphics', label: 'Graphics' },
  { id: 'sound', label: 'Sound' },
];
let lastSettingsTab: SettingsTab = 'controls';

const QUALITY_INFO: Record<Quality, string> = {
  low: 'Fastest. No shadows or grass, lower resolution. For older phones and laptops.',
  medium: 'Shadows, some grass and decorations. Good for phones and integrated graphics.',
  high: 'Sharp shadows, thick grass, glow on flashes and explosions. Needs a decent graphics card.',
};

/** A labelled slider with an editable number next to it. */
function slider(id: string, label: string, limits: { min: number; max: number; step: number }, value: number, digits: number, onChange: (v: number) => void, hint?: string): HTMLElement {
  const range = h('input', { type: 'range', id, min: limits.min, max: limits.max, step: limits.step, value });
  const box = h('input', { type: 'number', class: 'num', min: limits.min, max: limits.max, step: limits.step, value: value.toFixed(digits), 'aria-label': label });
  range.addEventListener('input', () => {
    box.value = Number(range.value).toFixed(digits);
    onChange(Number(range.value));
  });
  box.addEventListener('change', () => {
    const v = Math.min(limits.max, Math.max(limits.min, Number(box.value) || limits.min));
    box.value = v.toFixed(digits);
    range.value = String(v);
    onChange(v);
  });
  return h('div', { class: 'setting' }, h('label', { for: id }, label), h('div', { class: 'slider-row' }, range, box), hint ? h('small', { class: 'muted' }, hint) : null);
}

function checkbox(id: string, label: string, checked: boolean, onChange: (v: boolean) => void): HTMLElement {
  const input = h('input', { type: 'checkbox', id, checked });
  input.addEventListener('change', () => onChange(input.checked));
  return h('label', { class: 'check' }, input, ` ${label}`);
}

/** A row of toggle buttons where exactly one is active. */
function segmented<T extends string>(options: { id: T; label: string }[], value: T, onChange: (v: T) => void, cls = ''): HTMLElement {
  const row = h('div', { class: `segmented ${cls}`, role: 'radiogroup' });
  for (const o of options) {
    const b = h('button', { type: 'button', class: `seg${o.id === value ? ' active' : ''}`, role: 'radio', 'aria-checked': String(o.id === value), 'data-value': o.id }, o.label);
    b.addEventListener('click', () => {
      for (const other of row.children) {
        other.classList.toggle('active', other === b);
        other.setAttribute('aria-checked', String(other === b));
      }
      onChange(o.id);
    });
    row.append(b);
  }
  return row;
}

export function openSettings(audio: AudioEngine, initialTab?: SettingsTab): void {
  const body = h('div', { class: 'settings' });
  const tabs = h('div', { class: 'tabs' });
  let stopPreview: (() => void) | null = null;

  const show = (tab: SettingsTab) => {
    lastSettingsTab = tab;
    stopPreview?.();
    stopPreview = null;
    for (const b of tabs.children) b.classList.toggle('active', (b as HTMLElement).dataset.tab === tab);
    clear(body);
    if (tab === 'controls') body.append(controlsTab(() => show('controls')));
    if (tab === 'keys') body.append(keysTab());
    if (tab === 'crosshair') {
      const { el, stop } = crosshairTab(() => show('crosshair'));
      stopPreview = stop;
      body.append(el);
    }
    if (tab === 'graphics') body.append(graphicsTab(() => show('graphics')));
    if (tab === 'sound') body.append(soundTab(audio));
  };
  for (const t of SETTINGS_TABS) tabs.append(h('button', { type: 'button', class: 'tab', 'data-tab': t.id, onclick: () => show(t.id) }, t.label));
  openModal('Settings', h('div', { class: 'settings-wrap' }, tabs, body), { onClose: () => stopPreview?.() });
  show(initialTab ?? lastSettingsTab);
}

/** Settings > Keys: click a key, press the new one (Esc cancels). A key another action uses swaps places. */
function keysTab(): HTMLElement {
  const root = h('div', { class: 'keys-tab' });
  const note = h('p', { class: 'muted keys-note' }, 'Click a key, then press the new one. Esc cancels. Arrow keys also move you. 1-9 pick weapons, Tab shows the scores, Enter opens chat.');
  let listening: { id: BindId; stop: () => void } | null = null;

  const draw = () => {
    clear(root);
    root.append(note);
    const keys = getKeybinds();
    for (const group of ['Movement', 'Combat', 'Grenades', 'Other'] as const) {
      root.append(h('h4', { class: 'keys-group' }, group));
      for (const b of BINDS.filter((x) => x.group === group)) {
        const active = listening?.id === b.id;
        const button = h('button', { type: 'button', class: `key-cap${active ? ' listening' : ''}${keys[b.id] !== b.code ? ' changed' : ''}`, 'aria-label': `${b.label}: ${keyLabel(keys[b.id])}. Click to change.` }, active ? 'Press a key…' : keyLabel(keys[b.id]));
        button.addEventListener('click', () => (active ? stopListening() : listen(b.id)));
        root.append(h('div', { class: 'key-row' }, h('span', null, b.label), button));
      }
    }
    root.append(
      h(
        'button',
        {
          type: 'button',
          class: 'secondary',
          onclick: () => {
            stopListening();
            resetKeybinds();
          },
        },
        'Reset all keys',
      ),
    );
  };

  const stopListening = () => {
    listening?.stop();
    listening = null;
    draw();
  };

  const listen = (id: BindId) => {
    listening?.stop();
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.code === 'Escape') return stopListening();
      if (!setKeybind(id, e.code)) {
        note.textContent = `${keyLabel(e.code)} can't be used (menus, weapon slots and the dev menus keep their keys). Pick another.`;
        return;
      }
      note.textContent = 'Saved.';
      stopListening();
    };
    window.addEventListener('keydown', onKey, true);
    listening = { id, stop: () => window.removeEventListener('keydown', onKey, true) };
    draw();
  };

  const unwatch = watchKeybinds(() => {
    if (root.isConnected || !listening) draw();
  });
  // The tab is rebuilt when it is shown again; stop listening when the dialog goes away.
  new MutationObserver(() => {
    if (!root.isConnected) {
      listening?.stop();
      unwatch();
    }
  }).observe(document.body, { childList: true, subtree: true });
  draw();
  return root;
}

const REPORT_LABELS: Record<ReportReason, string> = { cheating: 'Cheating / hacking', abuse: 'Abusive chat or name', griefing: 'Griefing (blocking, team damage)', other: 'Something else' };

/** Pause menu > Report a player: pick who and why; `send` reports them (the server saves it). */
export function openReportDialog(players: { pid: number; name: string }[], send: (pid: number, reason: ReportReason) => Promise<{ ok: boolean; error?: string }>): void {
  if (players.length === 0) {
    openModal('Report a player', h('p', { class: 'muted' }, 'There is nobody else in this match to report.'));
    return;
  }
  const who = h('select', { 'aria-label': 'Player' }, ...players.map((p) => h('option', { value: String(p.pid) }, p.name)));
  const why = h('select', { 'aria-label': 'Reason' }, ...REPORT_REASONS.map((r) => h('option', { value: r }, REPORT_LABELS[r])));
  const status = h('p', { class: 'status', role: 'status', 'aria-live': 'polite' });
  const submit = h('button', { type: 'button', class: 'play' }, 'Send report');
  submit.addEventListener('click', () => {
    submit.disabled = true;
    status.textContent = 'Sending…';
    send(Number(who.value), why.value as ReportReason)
      .then((res) => {
        status.textContent = res.ok ? 'Thanks, the report was saved.' : (res.error ?? 'Could not send the report.');
        if (!res.ok) submit.disabled = false;
      })
      .catch(() => {
        status.textContent = 'Could not send the report.';
        submit.disabled = false;
      });
  });
  openModal('Report a player', h('div', { class: 'form' }, h('label', null, 'Player', who), h('label', null, 'Reason', why), submit, status));
}

function controlsTab(rerender: () => void): HTMLElement {
  const s = getSettings();
  const L = LIMITS;
  const camera = h('select', { id: 'set-camera' }, h('option', { value: 'third' }, 'Third person'), h('option', { value: 'first' }, 'First person'));
  camera.value = getCameraMode();
  camera.addEventListener('change', () => setCameraMode(camera.value as CameraMode));
  return h(
    'div',
    { class: 'form' },
    slider('set-sens', 'Mouse sensitivity', L.sensitivity, s.mouseSensitivity, 2, (v) => updateSettings({ mouseSensitivity: v }), 'Default is 1.00. Takes effect immediately, even mid-match.'),
    slider('set-zoom-sens', 'Zoom / scope sensitivity', L.zoomSensitivity, s.zoomSensitivity, 2, (v) => updateSettings({ zoomSensitivity: v }), 'Aiming already slows down with the zoom level; this scales it further.'),
    slider('set-touch-sens', 'Touch look sensitivity (phones & tablets)', L.sensitivity, s.touchSensitivity, 2, (v) => updateSettings({ touchSensitivity: v })),
    checkbox('set-invert', 'Invert vertical look', s.invertY, (v) => updateSettings({ invertY: v })),
    checkbox('set-jumpscares', 'Jumpscares (developer pranks)', s.jumpscares, (v) => updateSettings({ jumpscares: v })),
    h(
      'div',
      { class: 'setting' },
      checkbox('set-fullscreen', 'Full screen while playing', s.fullscreen, (v) => {
        updateSettings({ fullscreen: v });
        if (!v) exitPlayFullscreen();
      }),
      h(
        'small',
        { class: 'muted' },
        keyboardLockSupported()
          ? 'Lets you crouch with Ctrl while walking: windowed, Ctrl+W closes the tab.'
          : 'In this browser Ctrl+W always closes the tab: crouch with C while walking.',
      ),
    ),
    h('div', { class: 'setting' }, h('label', { for: 'set-camera' }, 'Camera view (switch any time with V)'), camera),
    h(
      'button',
      {
        type: 'button',
        class: 'secondary',
        onclick: () => {
          const d = defaultSettings();
          updateSettings({ mouseSensitivity: d.mouseSensitivity, zoomSensitivity: d.zoomSensitivity, touchSensitivity: d.touchSensitivity, invertY: d.invertY, fullscreen: d.fullscreen });
          rerender();
        },
      },
      'Reset controls',
    ),
  );
}

function crosshairTab(rerender: () => void): { el: HTMLElement; stop: () => void } {
  const c = getSettings().crosshair;
  const L = LIMITS;
  const preview = new CrosshairView();
  const set = (patch: Partial<CrosshairSettings>) => preview.apply(updateSettings({ crosshair: patch }).crosshair);
  preview.apply(c);

  // Breathe the spread in and out so you can see how a dynamic crosshair reacts.
  let raf = 0;
  const animate = (time: number) => {
    preview.setSpread((Math.sin(time / 450) * 0.5 + 0.5) * 16);
    raf = requestAnimationFrame(animate);
  };
  raf = requestAnimationFrame(animate);

  const custom = h('input', { type: 'color', class: 'color-pick', value: c.color, 'aria-label': 'Custom colour' });
  const swatches = h('div', { class: 'swatches' });
  const markColor = (value: string) => {
    for (const el of swatches.querySelectorAll<HTMLElement>('.swatch-btn')) el.classList.toggle('active', el.dataset.color === value);
  };
  for (const color of CROSSHAIR_COLORS) {
    swatches.append(
      h('button', {
        type: 'button',
        class: 'swatch-btn',
        style: `background:${color}`,
        'data-color': color,
        'aria-label': `Colour ${color}`,
        onclick: () => {
          set({ color });
          custom.value = color;
          markColor(color);
        },
      }),
    );
  }
  swatches.append(custom);
  custom.addEventListener('input', () => {
    set({ color: custom.value });
    markColor(custom.value.toLowerCase());
  });
  markColor(c.color);

  const el = h(
    'div',
    { class: 'form' },
    h('div', { class: 'crosshair-preview' }, preview.root),
    h('div', { class: 'setting' }, h('label', null, 'Style'), segmented(CROSSHAIR_STYLES, c.style, (style) => set({ style }), 'wrap')),
    h('div', { class: 'setting' }, h('label', null, 'Colour'), swatches),
    slider('ch-size', 'Size', L.size, c.size, 0, (size) => set({ size })),
    slider('ch-thick', 'Thickness', L.thickness, c.thickness, 0, (thickness) => set({ thickness })),
    slider('ch-gap', 'Gap', L.gap, c.gap, 0, (gap) => set({ gap })),
    slider('ch-opacity', 'Opacity', L.opacity, c.opacity, 2, (opacity) => set({ opacity })),
    checkbox('ch-outline', 'Dark outline (easier to see on bright backgrounds)', c.outline, (outline) => set({ outline })),
    checkbox('ch-dynamic', 'Dynamic: opens up while moving, jumping and shooting', c.dynamic, (dynamic) => set({ dynamic })),
    h(
      'button',
      {
        type: 'button',
        class: 'secondary',
        onclick: () => {
          updateSettings({ crosshair: defaultCrosshair() });
          rerender();
        },
      },
      'Reset crosshair',
    ),
  );
  return { el, stop: () => cancelAnimationFrame(raf) };
}

function graphicsTab(rerender: () => void): HTMLElement {
  const s = getSettings();
  const info = h('small', { class: 'muted' }, QUALITY_INFO[s.quality]);
  const qualities: { id: Quality; label: string }[] = [
    { id: 'low', label: 'Low' },
    { id: 'medium', label: 'Medium' },
    { id: 'high', label: 'High' },
  ];
  return h(
    'div',
    { class: 'form' },
    h(
      'div',
      { class: 'setting' },
      h('label', null, 'Graphics quality'),
      segmented(qualities, s.quality, (quality) => {
        updateSettings({ quality });
        info.textContent = QUALITY_INFO[quality];
      }),
      info,
    ),
    slider('set-fov', 'Field of view', LIMITS.fov, s.fov, 0, (fov) => updateSettings({ fov }), 'Degrees, vertical. Higher shows more around you; 70 is the default.'),
    h(
      'button',
      {
        type: 'button',
        class: 'secondary',
        onclick: () => {
          const d = defaultSettings();
          updateSettings({ quality: d.quality, fov: d.fov });
          rerender();
        },
      },
      'Reset graphics',
    ),
  );
}

function soundTab(audio: AudioEngine): HTMLElement {
  return h(
    'div',
    { class: 'form' },
    slider('set-volume', 'Volume', { min: 0, max: 1, step: 0.05 }, audio.volume, 2, (v) => {
      audio.volume = v;
      audio.play('click');
    }),
    slider('set-music', 'Lobby music', { min: 0, max: 1, step: 0.05 }, audio.musicVolume, 2, (v) => (audio.musicVolume = v), 'The song on the title screen. 0 turns it off.'),
  );
}
