import { MAPS, MODES, MODE_IDS, isMapId, rankProgress, type DailyStatus, type MapId, type ModeDef, type ModeId, type Profile } from '@game/shared';
import { clear, h, storage } from './dom';
import { anyModalOpen } from './Modal';
import { MODE_ICON, icon, type IconName } from './icons';

export interface MenuActions {
  /** `map` undefined: any map. `noBots`: the "Without bots" choice (wait for real players). */
  quickPlay(mode: ModeId, map?: MapId, noBots?: boolean): void;
  browse(): void;
  createRoom(): void;
  joinCode(): void;
  customize(): void;
  friends(): void;
  /** Opens on that mode's tab, or overall. */
  leaderboard(mode?: ModeId): void;
  daily(): void;
  account(): void;
  settings(): void;
  privacy(): void;
  /** The how-to-play guide (also F1). */
  guide(): void;
  /** Today's challenges, for the card on the title screen. */
  dailyStatus(): Promise<DailyStatus>;
  /** How many people are playing right now. */
  online(): Promise<number>;
  /** Menu sounds: hovering a button, pressing one. */
  sound(kind: 'hover' | 'press'): void;
}

/** Mode tabs. Any mode not listed lands in the last one. */
const CATEGORIES: { id: string; label: string; modes: ModeId[] }[] = [
  { id: 'casual', label: 'Casual', modes: ['ffa', 'tdm', 'squad', 'duel', 'training'] },
  { id: 'competitive', label: 'Competitive', modes: ['face', 'bomb', 'hvh'] },
  { id: 'fun', label: 'Fun', modes: ['zombie', 'arms', 'knife', 'ctf', 'sandbox'] },
];
for (const id of MODE_IDS) if (!CATEGORIES.some((c) => c.modes.includes(id))) CATEGORIES.at(-1)!.modes.push(id);

/** "What's new" on the title screen: newest first. Edit freely. */
const WHATS_NEW: readonly { title: string; text: string }[] = [
  { title: 'Team switch', text: 'Press M to change teams. Not in FaceChiken, where ranked teams are fixed.' },
  { title: 'Sniper scope', text: 'Right-click to scope, again to zoom in. Sniper and Scout.' },
  { title: 'Zombie Apocalypse', text: 'Co-op waves with bosses and a shop between rounds.' },
];


const TAB_KEY = 'chikengun:menu-tab';
const BOTS_KEY = 'chikengun:menu-no-bots';
const MODE_KEY = 'chikengun:menu-mode';
const mapKey = (mode: ModeId) => `chikengun:map:${mode}`;
/** How often the "playing now" count is refreshed while the title screen is up. */
const ONLINE_EVERY_MS = 20_000;

/** "5 vs 5", "1 vs 1", "Free for all · 12"… */
function playersLine(m: ModeDef): string {
  if (m.training) return 'Solo · practice';
  if (m.building) return `Build together · up to ${m.maxPlayers}`;
  if (m.zombies) return `Co-op survival · up to ${m.maxHumans ?? m.maxPlayers}`;
  if (m.ranked) return `Ranked ${m.maxPlayers / 2} vs ${m.maxPlayers / 2} · real players`;
  if (m.teams) return `${m.maxPlayers / 2} vs ${m.maxPlayers / 2}`;
  if (m.maxPlayers === 2) return '1 vs 1';
  return `Free for all · up to ${m.maxPlayers}`;
}

/**
 * The title screen, laid out like a game lobby: a big PLAY for your mode and a column of menu
 * buttons on the left (your chicken runs on the right), your level and coins up top, today's
 * challenges and what's new below, and how many people are playing. "Change mode" opens the
 * mode select: every mode by tab, the bots choice, the server browser and private rooms.
 */
export class MainMenu {
  readonly root: HTMLElement;
  private readonly name = h('span', { class: 'profile-name' });
  private readonly coins = h('span', { class: 'coins' });
  private readonly record = h('span', { class: 'record' });
  private readonly rank = h('span', { class: 'rank-chip' });
  private readonly xpFill = h('i');
  private readonly xpBar = h('span', { class: 'xp-bar small' }, this.xpFill);
  private readonly accountBtn = h('button', { class: 'chip-btn', type: 'button' });
  private readonly status = h('p', { class: 'status', role: 'status', 'aria-live': 'polite' });
  private readonly buttons: HTMLButtonElement[] = [];
  private readonly tabs = h('div', { class: 'tabs menu-tabs', role: 'tablist' });
  private readonly cards = new Map<ModeId, HTMLElement>();
  private readonly playButtons: HTMLButtonElement[] = [];
  private readonly friendsBadge = h('span', { class: 'badge', hidden: true });
  private readonly partyStrip = h('div', { class: 'party-strip', hidden: true });
  /** The lobby choice: play with bots (default) or wait for real players. */
  private withoutBots = storage.get(BOTS_KEY) === '1';
  private readonly botsNote = h('p', { class: 'bots-note' });
  private readonly botsButtons = new Map<boolean, HTMLButtonElement>();

  // The lobby itself.
  private selected: ModeId = this.savedMode();
  private readonly playLabel = h('span', { class: 'lobby-play-label' }, 'Play');
  private readonly playMode = h('span', { class: 'lobby-play-mode' });
  private readonly playButton: HTMLButtonElement;
  private readonly modePanel: HTMLElement;
  private readonly online = h('span', { class: 'lobby-online' }, h('i'), 'Connecting…');
  private readonly daily = h('div', { class: 'lobby-card lobby-daily' });
  private onlineTimer = 0;

  get noBots(): boolean {
    return this.withoutBots;
  }

  constructor(container: HTMLElement, private readonly actions: MenuActions) {
    const button = (label: string, onClick: () => void, cls = '') => {
      const b = h('button', { class: cls, type: 'button', onclick: () => { actions.sound('press'); onClick(); } }, label);
      b.addEventListener('pointerenter', () => actions.sound('hover'));
      this.buttons.push(b);
      return b;
    };
    this.accountBtn.addEventListener('click', actions.account);
    const withIcon = (b: HTMLButtonElement, name: IconName, label: string) => (b.append(icon(name), h('span', null, label)), b);

    // ---- Mode select (opened by "Change mode").
    const modes = h('div', { class: 'mode-grid' });
    for (const id of MODE_IDS) {
      const m = MODES[id];
      const picker = h('select', { class: 'map-pick', 'aria-label': `${m.name} map` }, h('option', { value: '' }, 'Any map'), ...m.maps.map((map) => h('option', { value: map }, MAPS[map].name)));
      const saved = storage.get(mapKey(id));
      picker.value = saved && m.maps.includes(saved as MapId) ? saved : '';
      picker.addEventListener('change', () => {
        storage.set(mapKey(id), picker.value);
        this.refreshPlay();
      });
      const card = h(
        'div',
        { class: `mode-card mode-${id}${m.ranked ? ' ranked' : ''}` },
        h(
          'div',
          { class: 'mode-top' },
          h('div', { class: 'mode-icon' }, icon(MODE_ICON[id])),
          h('span', { class: 'mode-players' }, playersLine(m)),
          m.building || m.zombies || m.training ? null : h('button', { type: 'button', class: 'mode-board', title: `${m.name} leaderboard`, 'aria-label': `${m.name} leaderboard`, onclick: () => actions.leaderboard(id) }, icon('trophy')),
        ),
        h('h3', null, m.name),
        h('p', null, m.description),
        m.maps.length > 1 ? picker : h('div', { class: 'map-pick single' }, MAPS[m.maps[0]!].name),
        this.addPlayButton(button('Play', () => this.play(id), 'play')),
      );
      // Cards sit in their tab's order (FaceChiken first among the competitive ones).
      card.style.order = String(CATEGORIES.find((c) => c.modes.includes(id))?.modes.indexOf(id) ?? 0);
      this.cards.set(id, card);
      modes.append(card);
    }
    for (const c of CATEGORIES) {
      this.tabs.append(h('button', { type: 'button', class: 'tab', role: 'tab', 'data-tab': c.id, onclick: () => this.showTab(c.id) }, c.label));
    }
    const closeModes = h('button', { type: 'button', class: 'icon-btn mode-select-close', 'aria-label': 'Close' }, icon('close'));
    closeModes.addEventListener('click', () => this.openModes(false));
    this.modePanel = h(
      'div',
      { class: 'mode-select', hidden: true, role: 'dialog', 'aria-label': 'Choose a mode' },
      h(
        'div',
        { class: 'mode-select-window' },
        h('header', { class: 'mode-select-head' }, h('h2', null, 'Choose a mode'), closeModes),
        h(
          'div',
          { class: 'bots-choice' },
          h('div', { class: 'bots-toggle', role: 'radiogroup', 'aria-label': 'Bots' }, this.botsOption(false, 'bot', 'With bots'), this.botsOption(true, 'person', 'No bots')),
          this.botsNote,
        ),
        this.tabs,
        modes,
        h(
          'div',
          { class: 'mode-select-rooms' },
          withIcon(button('', actions.browse, 'secondary'), 'globe', 'Server browser'),
          withIcon(button('', actions.createRoom, 'secondary'), 'plus', 'Create room'),
          withIcon(button('', actions.joinCode, 'secondary'), 'key', 'Join with code'),
        ),
      ),
    );
    this.modePanel.addEventListener('click', (e) => {
      if (e.target === this.modePanel) this.openModes(false);
    });

    // ---- The lobby.
    this.playButton = this.addPlayButton(button('', () => this.play(this.selected), 'lobby-play'));
    this.playButton.append(h('span', { class: 'lobby-play-arrow' }, icon('play')), h('span', { class: 'lobby-play-text' }, this.playLabel, this.playMode));
    const changeMode = button('Change mode', () => this.openModes(true), 'lobby-change');
    const navButton = (name: IconName, label: string, run: () => void) => {
      const b = button('', run, 'lobby-btn');
      b.append(icon(name, 'lobby-btn-icon'), h('span', { class: 'lobby-btn-label' }, label));
      return b;
    };
    const friends = navButton('team', 'Friends', actions.friends);
    friends.append(this.friendsBadge);
    const news = h('div', { class: 'lobby-card lobby-news' }, h('h3', null, "What's new"), ...WHATS_NEW.map((n) => h('div', { class: 'lobby-news-item' }, h('b', null, n.title), h('span', null, n.text))));
    const controls = withIcon(button('', actions.guide, 'lobby-link'), 'help', 'How to play · F1');

    this.root = h(
      'div',
      { class: 'screen main-menu lobby' },
      h(
        'header',
        { class: 'menu-header' },
        h('h1', { class: 'logo' }, 'ChikenRun', h('span', { class: 'accent' }, 'Hvh')),
        h('div', { class: 'profile-chip' }, this.rank, h('span', { class: 'who' }, this.name, this.record, this.xpBar), this.coins, this.accountBtn),
      ),
      this.partyStrip,
      h(
        'div',
        { class: 'lobby-body' },
        h(
          'nav',
          { class: 'lobby-nav', 'aria-label': 'Main menu' },
          this.playButton,
          changeMode,
          navButton('basket', 'Shop', actions.customize),
          friends,
          navButton('calendar', 'Daily', actions.daily),
          navButton('trophy', 'Leaderboard', () => actions.leaderboard()),
          navButton('gear', 'Settings', actions.settings),
          this.status,
        ),
        h('div', { class: 'lobby-cards' }, this.daily, news),
      ),
      h(
        'footer',
        { class: 'lobby-bottom' },
        this.online,
        controls,
        h('button', { type: 'button', class: 'link', onclick: actions.privacy }, 'Cookies & privacy'),
      ),
      h('button', { type: 'button', class: 'scene-toggle', title: 'Hide the menu to see the scene', 'aria-label': 'Hide or show the menu', onclick: () => this.root.classList.toggle('scene-only') }, icon('hide')),
      this.modePanel,
    );
    container.append(this.root);
    this.refreshBots();
    this.refreshPlay();
    const saved = storage.get(TAB_KEY);
    this.showTab(CATEGORIES.some((c) => c.id === saved) ? saved! : CATEGORIES[0]!.id);
    this.renderDaily(null);

    // Enter plays, Esc closes the mode select (when nothing else has the keyboard).
    document.addEventListener('keydown', (e) => {
      if (this.root.hidden || anyModalOpen() || e.repeat) return;
      const typing = e.target instanceof HTMLElement && /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName);
      if (e.key === 'Escape' && !this.modePanel.hidden) this.openModes(false);
      else if (e.key === 'Enter' && !typing && this.modePanel.hidden && !this.playButton.disabled) {
        e.preventDefault();
        this.playButton.click();
      }
    });
  }

  private savedMode(): ModeId {
    const saved = storage.get(MODE_KEY);
    return saved && saved in MODES ? (saved as ModeId) : 'ffa';
  }

  /** Plays a mode (it becomes the one PLAY starts next time). */
  private play(mode: ModeId): void {
    this.selected = mode;
    storage.set(MODE_KEY, mode);
    this.refreshPlay();
    this.openModes(false);
    const map = storage.get(mapKey(mode));
    this.actions.quickPlay(mode, isMapId(map) && MODES[mode].maps.includes(map) ? map : undefined, this.withoutBots);
  }

  private openModes(open: boolean): void {
    this.modePanel.hidden = !open;
    if (open) this.showMode(this.selected);
  }

  /** What the big PLAY says under it: your mode, its map, and bots or not. */
  private refreshPlay(): void {
    const m = MODES[this.selected];
    const map = storage.get(mapKey(this.selected));
    const mapName = isMapId(map) && m.maps.includes(map) ? MAPS[map].name : m.maps.length > 1 ? 'Any map' : MAPS[m.maps[0]!].name;
    const bots = m.noBots || m.ranked ? 'Real players' : this.withoutBots ? 'Without bots' : 'With bots';
    this.playMode.textContent = `${m.name} · ${mapName} · ${bots}`;
  }

  private renderDaily(status: DailyStatus | null): void {
    clear(this.daily);
    const open = h('button', { type: 'button', class: 'link' }, 'Open');
    open.addEventListener('click', () => this.actions.daily());
    this.daily.append(h('h3', null, 'Today', open));
    if (!status) {
      this.daily.append(h('p', { class: 'muted' }, 'Loading your challenges…'));
      return;
    }
    for (const c of status.challenges) {
      this.daily.append(
        h(
          'div',
          { class: `lobby-daily-row${c.done ? ' done' : ''}` },
          h('span', { class: c.done ? 'done' : '' }, c.label),
          h('span', { class: 'lobby-daily-reward' }, icon('coin'), String(c.reward)),
          h('span', { class: 'daily-bar' }, h('i', { style: `width:${Math.round((c.progress / c.goal) * 100)}%` })),
        ),
      );
    }
  }

  private refreshLive(): void {
    this.actions
      .dailyStatus()
      .then((s) => this.renderDaily(s))
      .catch(() => this.renderDaily(null));
    this.actions
      .online()
      .then((n) => {
        // People in matches right now (you on this screen aren't counted yet). Hidden when there are none.
        this.online.hidden = n === 0;
        this.online.lastChild!.textContent = `${n} ${n === 1 ? 'player' : 'players'} in matches`;
        this.online.classList.add('live');
      })
      .catch(() => {
        this.online.hidden = false;
        this.online.lastChild!.textContent = 'Offline';
        this.online.classList.remove('live');
      });
  }

  private botsOption(withoutBots: boolean, name: IconName, label: string): HTMLButtonElement {
    const b = h('button', { type: 'button', class: 'bots-opt', role: 'radio', onclick: () => this.setBots(withoutBots) }, icon(name), label);
    this.botsButtons.set(withoutBots, b);
    return b;
  }

  private setBots(withoutBots: boolean): void {
    this.withoutBots = withoutBots;
    storage.set(BOTS_KEY, withoutBots ? '1' : '0');
    this.refreshBots();
    this.refreshPlay();
  }

  private refreshBots(): void {
    for (const [value, b] of this.botsButtons) {
      b.classList.toggle('active', value === this.withoutBots);
      b.setAttribute('aria-checked', String(value === this.withoutBots));
    }
    this.botsNote.textContent = this.withoutBots
      ? 'Real players only: the match starts when enough people join (2 for most modes, 4 for Squad Up and FaceChiken).'
      : 'Bots fill the empty spots, so a match starts right away.';
  }

  private addPlayButton(b: HTMLButtonElement): HTMLButtonElement {
    this.playButtons.push(b);
    return b;
  }

  /**
   * Friends and party: the badge (requests and invites waiting), who's in your party, and what
   * Play does (the leader brings everyone; members wait for the leader).
   */
  setFriends(waiting: number, party: { names: string[]; leader: string; isLeader: boolean } | null): void {
    this.friendsBadge.hidden = waiting === 0;
    this.friendsBadge.textContent = String(waiting);
    this.partyStrip.hidden = party === null;
    if (party) {
      clear(this.partyStrip);
      this.partyStrip.append(
        h('span', { class: 'party-title' }, `Party · ${party.names.length}`),
        ...party.names.map((n) => h('span', { class: 'party-chip' }, n === party.leader ? `${n} (lead)` : n)),
        h('span', { class: 'muted' }, party.isLeader ? 'You pick the mode: everyone plays with you.' : `${party.leader} picks the mode.`),
      );
    }
    const label = !party ? 'Play' : party.isLeader ? `Play with party (${party.names.length})` : 'Leader picks';
    for (const b of this.playButtons) {
      if (b === this.playButton) this.playLabel.textContent = label;
      else b.textContent = label;
    }
  }

  /** Shows one tab's modes. */
  showTab(id: string): void {
    const cat = CATEGORIES.find((c) => c.id === id) ?? CATEGORIES[0]!;
    storage.set(TAB_KEY, cat.id);
    for (const b of this.tabs.children) {
      const on = (b as HTMLElement).dataset.tab === cat.id;
      b.classList.toggle('active', on);
      b.setAttribute('aria-selected', String(on));
    }
    for (const [mode, card] of this.cards) {
      card.hidden = !cat.modes.includes(mode);
      card.classList.toggle('selected', mode === this.selected);
    }
  }

  /** Shows the tab with this mode (for tests and links). */
  showMode(mode: ModeId): void {
    const cat = CATEGORIES.find((c) => c.modes.includes(mode));
    if (cat) this.showTab(cat.id);
  }

  setProfile(p: Profile): void {
    this.name.textContent = p.name;
    this.name.classList.toggle('rainbow', p.developer);
    const { rank, next, progress } = rankProgress(p.xp);
    this.rank.textContent = String(rank.level);
    this.rank.dataset.level = String(rank.level);
    this.rank.title = (next ? `Level ${rank.level} · ${rank.name}: ${next.xp - p.xp} rank points to ${next.name}` : `Level ${rank.level} · ${rank.name} (top rank)`) + '. Levels move in FaceChiken.';
    this.record.textContent = `Lv ${rank.level} ${rank.name} · ${p.xp} pts` + (p.stats.matches > 0 ? ` · ${p.stats.wins} wins` : '');
    this.xpFill.style.width = `${Math.round(progress * 100)}%`;
    this.coins.replaceChildren(icon('coin'), p.coins.toLocaleString());
    this.accountBtn.textContent = p.username ? 'Account' : 'Save progress';
  }

  setStatus(text: string, error = false): void {
    this.status.textContent = text;
    this.status.classList.toggle('error', error);
  }

  setBusy(busy: boolean): void {
    for (const b of this.buttons) b.disabled = busy;
  }

  setVisible(visible: boolean): void {
    this.root.hidden = !visible;
    window.clearInterval(this.onlineTimer);
    if (!visible) {
      this.openModes(false);
      return;
    }
    // While the title screen is up: today's challenges and the player count, kept fresh.
    this.refreshLive();
    this.onlineTimer = window.setInterval(() => this.refreshLive(), ONLINE_EVERY_MS);
  }
}
