import { MODES, type CreateRoomRequest, type JoinResponse, type JoinSuccess, type ModeId } from '@game/shared';
import { toggleGuide } from '../ui/Guide';
import { Dev as ClassicDev } from '../dev/classic/Dev';
import { combineDevHooks } from '../dev/combine';
import { Dev } from '../dev/Dev';
import { Friends } from '../ui/Friends';
import { exitPlayFullscreen } from '../fullscreen';
import { Game } from '../game/Game';
import { Api } from '../net/Api';
import { Network } from '../net/Network';
import { openAccount, openCreateRoom, openJoinCode, openLeaderboard, openServerBrowser, openSettings, openReportDialog, openDaily } from '../ui/Dialogs';
import { byId, h } from '../ui/dom';
import { HvhSetup } from '../ui/HvhSetup';
import { MainMenu } from '../ui/MainMenu';
import { CookieNotice, openPrivacy } from '../ui/Privacy';
import { anyModalOpen, setModalLayer } from '../ui/Modal';
import { ShopScreen } from '../ui/Shop';
import { TouchControls, isTouchDevice } from '../ui/TouchControls';

type Screen = 'boot' | 'menu' | 'shop' | 'game';

/** Top-level controller: boot, menus, joining rooms, pause and reconnects. */
export class App {
  private readonly api = new Api();
  private readonly net = new Network();
  private readonly game: Game;
  private readonly dev: Dev;
  /** Pause menu: the HvH panels, only shown in HvH matches. */
  private readonly reportButton = h('button', { type: 'button', class: 'secondary', onclick: () => this.openReport() }, 'Report a player');
  /** 'Leave match', or 'Back to lobby' in Training. */
  private readonly leaveButton = h('button', { type: 'button', class: 'secondary', onclick: () => this.leave() }, 'Leave match');
  private readonly hvhPanelsButton = h('button', { type: 'button', class: 'secondary', onclick: () => this.openHvhSetup() }, 'HvH panels');
  private readonly friends: Friends;
  /** The old mega?dev menu, on L (the HvH Lab above is on Insert). */
  private readonly classicDev: ClassicDev;
  private readonly menu: MainMenu;
  private readonly shop: ShopScreen;
  private readonly touch: TouchControls | null;
  private readonly pause: HTMLElement;
  private readonly loading: HTMLElement;
  private readonly pauseButton: HTMLButtonElement;
  private readonly cookieNotice: CookieNotice;
  private screen: Screen = 'boot';
  private joining = false;
  private hvhSetup: HvhSetup | null = null;
  private setupVersion = 0;
  private touchPaused = false;
  /** The room to get back into after a dropped connection. */
  private lastRoom: { id: string; mode: ModeId } | null = null;
  private rejoinOnConnect = false;

  constructor() {
    const ui = byId('ui-layer');
    setModalLayer(byId('modal-layer'));
    this.game = new Game(byId<HTMLCanvasElement>('game'), byId('hud-layer'));

    this.menu = new MainMenu(ui, {
      quickPlay: (mode, map, noBots) => this.enter(() => this.net.quickPlay(mode, map, noBots)),
      browse: () => openServerBrowser(() => this.net.listRooms(), (roomId) => this.enter(() => this.net.joinRoom({ roomId }), true)),
      createRoom: () => openCreateRoom((req: CreateRoomRequest) => this.enter(() => this.net.createRoom(req), true)),
      joinCode: () => openJoinCode((code) => this.enter(() => this.net.joinRoom({ code }), true)),
      customize: () => this.showShop(),
      friends: () => this.friends.open(),
      leaderboard: (mode) => void openLeaderboard(this.api, mode),
      daily: () => void openDaily(this.api),
      account: () => openAccount(this.api, () => this.net.reconnect()),
      settings: () => openSettings(this.game.audio),
      privacy: () => openPrivacy(),
      guide: () => this.openGuide(),
      dailyStatus: () => this.api.daily(),
      online: () => this.api.online(),
      sound: (kind) => {
        // A button press is a user gesture: the moment the browser lets sound start.
        if (kind === 'press') this.game.audio.unlock();
        this.game.audio.play('click', undefined, kind === 'press' ? 0.8 : 0.22);
      },
    });
    // Friends and parties: the leader's Play brings the whole party along (the server moves them).
    this.friends = new Friends(this.net.socket, ui, {
      notice: (text) => (this.screen === 'game' ? this.game.hud.toast(text) : this.menu.setStatus(text)),
      joined: (join) => {
        if (this.screen === 'game') return;
        this.startGame(join);
        this.game.hud.toast(`👥 Your party leader started ${MODES[join.room.mode].name}: click to play`);
      },
      register: () => openAccount(this.api, () => this.net.reconnect()),
    });
    this.friends.onChange(() => {
      const p = this.friends.party;
      const names = p?.members.map((m) => m.name) ?? [];
      const leader = p?.members.find((m) => m.userId === p.leader)?.name ?? '';
      this.menu.setFriends(this.friends.waiting, p ? { names, leader, isLeader: this.friends.isLeader } : null);
    });
    this.cookieNotice = new CookieNotice(ui);
    // Developer menu: the menu key (Insert by default), or tap the logo five times on touch screens.
    this.dev = new Dev({
      socket: this.net.socket,
      input: this.game.input,
      hud: this.game.hud,
      audio: this.game.audio,
      fps: () => this.game.fps,
      ping: () => this.net.ping,
      openCrosshairSettings: () => openSettings(this.game.audio, 'crosshair'),
      inGame: () => this.screen === 'game' && !this.hvhSetup,
      onMenuChange: () => this.refreshOverlays(),
      applyWorldLook: (look) => this.game.setLook(look),
    });
    this.classicDev = new ClassicDev({
      socket: this.net.socket,
      input: this.game.input,
      hud: this.game.hud,
      audio: this.game.audio,
      fps: () => this.game.fps,
      ping: () => this.net.ping,
      openCrosshairSettings: () => openSettings(this.game.audio, 'crosshair'),
      inGame: () => this.screen === 'game' && !this.hvhSetup,
      onMenuChange: () => this.refreshOverlays(),
      applyWorldLook: (look) => this.game.setLook(look),
    });
    this.game.dev = combineDevHooks(this.dev.runtime, this.classicDev.runtime);
    this.bindSecretTaps();
    // F1: the how-to-play guide, anywhere (and not the browser's own help page).
    window.addEventListener('keydown', (e) => {
      if (e.code !== 'F1') return;
      e.preventDefault();
      e.stopPropagation();
      this.openGuide();
    }, true);
    for (const ev of ['pointerdown', 'keydown'] as const) window.addEventListener(ev, () => this.game.audio.unlock(), { once: true });
    // Ctrl is crouch, and windowed (or outside Chrome / Edge) Ctrl+W can't be blocked: ask before leaving a match.
    window.addEventListener('beforeunload', (e) => {
      if (this.screen !== 'game') return;
      e.preventDefault();
      e.returnValue = '';
    });
    this.shop = new ShopScreen(ui, this.api, (appearance, weapon) => this.game.setPreview(appearance, weapon), () => this.showMenu());

    this.loading = h('div', { class: 'loading' }, h('div', { class: 'egg-spinner' }, '🥚'), h('p', null, 'Hatching…'));
    ui.append(this.loading);

    const resume = h('button', { type: 'button' }, this.isTouch ? 'Resume' : 'Click to resume');
    resume.addEventListener('click', () => {
      this.touchPaused = false;
      this.game.audio.unlock();
      void this.game.input.requestLock();
      this.refreshOverlays();
    });
    this.pause = h(
      'div',
      { class: 'overlay pause' },
      h(
        'div',
        { class: 'panel card' },
        h('h2', null, 'Paused'),
        resume,
        this.hvhPanelsButton,
        this.reportButton,
        h('button', { type: 'button', class: 'secondary', onclick: () => this.openGuide() }, 'How to play (F1)'),
        h('button', { type: 'button', class: 'secondary', onclick: () => openSettings(this.game.audio) }, 'Settings'),
        this.leaveButton,
      ),
    );
    this.pause.hidden = true;
    ui.append(this.pause);

    this.pauseButton = h('button', { class: 'touch-pause icon-btn', type: 'button', 'aria-label': 'Pause' }, '❚❚');
    this.pauseButton.hidden = true;
    this.pauseButton.addEventListener('click', () => {
      this.touchPaused = true;
      this.refreshOverlays();
    });
    ui.append(this.pauseButton);

    this.touch = this.isTouch ? new TouchControls(byId('hud-layer'), this.game.input) : null;
    this.game.input.touchMode = this.isTouch;
    this.game.input.onLockChange = () => this.refreshOverlays();
    this.api.onProfile((p) => {
      this.game.setMenuChicken(p.appearance);
      this.menu.setProfile(p);
      this.friends.selfId = p.id;
    });
    this.bindConnection();
    this.menu.setVisible(false);
  }

  /** Five quick taps on the title open the developer menu (there is no Insert key on phones). */
  private bindSecretTaps(): void {
    const logo = document.querySelector('.main-menu .logo');
    let taps: number[] = [];
    logo?.addEventListener('click', () => {
      const now = performance.now();
      taps = [...taps.filter((t) => now - t < 3000), now];
      if (taps.length >= 5) {
        taps = [];
        // The logo is on the menu (not in an HvH match): that's mega?dev.
        void this.classicDev.openMenu();
      }
    });
  }

  private get isTouch(): boolean {
    return isTouchDevice();
  }

  async start(): Promise<void> {
    try {
      await this.api.ensureSession();
    } catch {
      this.showServerDown();
      return;
    }
    this.net.connect();
    this.loading.hidden = true;
    this.showMenu();
  }

  private showServerDown(): void {
    const retry = h('button', { type: 'button' }, 'Retry');
    retry.addEventListener('click', () => {
      this.loading.replaceChildren(h('div', { class: 'egg-spinner' }, '🥚'), h('p', null, 'Hatching…'));
      void this.start();
    });
    this.loading.replaceChildren(
      h(
        'div',
        { class: 'panel card server-down' },
        h('h2', null, "Can't reach the game server"),
        h('p', null, 'The page loaded, but the game server is not answering.'),
        h('p', { class: 'muted' }, 'Developing locally? Start everything from the project folder with ', h('code', null, 'npm run dev'), ', then press Retry.'),
        retry,
      ),
    );
  }

  // ---------------------------------------------------------------------------
  // Screens
  // ---------------------------------------------------------------------------

  private showMenu(status = '', error = false): void {
    this.clearHvhSetup();
    this.screen = 'menu';
    this.game.audio.setMusic(true);
    this.friends.setInGame(false);
    this.shop.close();
    this.game.setPreview(null);
    this.menu.setVisible(true);
    this.menu.setStatus(status, error);
    this.game.input.releaseLock();
    exitPlayFullscreen();
    this.refreshOverlays();
  }

  private showShop(): void {
    this.screen = 'shop';
    this.game.audio.setMusic(true);
    this.menu.setVisible(false);
    this.shop.open();
    void this.api.refresh().catch(() => undefined);
    this.refreshOverlays();
  }

  /** The F1 guide; in a match it frees the mouse, and the pause screen is there when it closes. */
  private openGuide(): void {
    if (this.screen === 'game') this.game.input.releaseLock();
    toggleGuide(() => this.refreshOverlays());
    this.refreshOverlays();
  }

  private refreshOverlays(): void {
    const inGame = this.screen === 'game';
    const locked = this.game.input.isLocked;
    const paused = inGame && (this.isTouch ? this.touchPaused : !locked);
    const devMenu = this.dev.menuOpen || this.classicDev.menuOpen;
    const buyMenu = this.game.activeSession?.buyMenuOpen ?? false;
    const overlay = devMenu || buyMenu;
    this.game.input.suspended = Boolean(this.hvhSetup) || overlay || paused;
    if (this.hvhSetup) this.hvhSetup.root.hidden = devMenu;
    this.pause.hidden = !paused || anyModalOpen() || overlay || Boolean(this.hvhSetup);
    this.hvhPanelsButton.hidden = this.game.activeSession?.mode.id !== 'hvh';
    const training = this.game.activeSession?.mode.training === true;
    this.leaveButton.textContent = training ? 'Back to lobby' : 'Leave match';
    this.reportButton.hidden = training;
    this.pauseButton.hidden = !inGame || !this.isTouch || paused || overlay || Boolean(this.hvhSetup);
    this.touch?.setVisible(inGame && !paused && !overlay && !this.hvhSetup);
    this.cookieNotice.setVisible(this.screen === 'menu' || this.screen === 'shop');
  }

  /** Pause menu > Report a player: the other people in this match (not bots). */
  private openReport(): void {
    const session = this.game.activeSession;
    const players = session ? [...session.infos.values()].filter((i) => !i.bot && i.pid !== session.selfPid).map((i) => ({ pid: i.pid, name: i.name })) : [];
    openReportDialog(players, (pid, reason) => this.net.report(pid, reason));
  }

  // ---------------------------------------------------------------------------
  // Joining and leaving
  // ---------------------------------------------------------------------------

  /** Must be called from a click: pointer lock and audio need a user gesture. */
  private enter(request: () => Promise<JoinResponse>, explicitRoom = false): void {
    if (this.joining) return;
    this.joining = true;
    this.game.audio.unlock();
    void this.game.input.requestLock();
    this.menu.setBusy(true);
    this.menu.setStatus(explicitRoom ? 'Joining room…' : 'Finding a match…');
    void request()
      .then((res) => {
        if (!res.ok) {
          this.showMenu(res.error, true);
          return;
        }
        this.startGame(res);
      })
      .catch(() => this.showMenu('Could not reach the game server.', true))
      .finally(() => {
        this.joining = false;
        this.menu.setBusy(false);
      });
  }

  private startGame(join: JoinSuccess): void {
    this.game.audio.setMusic(false);
    this.clearHvhSetup();
    this.lastRoom = { id: join.room.id, mode: join.room.mode };
    this.touch?.setBombMode(MODES[join.room.mode].bomb === true);
    this.screen = 'game';
    this.friends.setInGame(true);
    this.touchPaused = false;
    this.menu.setVisible(false);
    this.shop.close();
    this.game.startSession(this.net, join, {
      onReward: (coins, xp) => this.api.setRewards(coins, xp),
      onOverlay: () => this.refreshOverlays(),
      onClosed: (reason) => {
        this.lastRoom = null;
        this.game.endSession();
        this.showMenu(reason, true);
      },
    });
    if (join.room.mode === 'hvh') this.openHvhSetup();
    this.refreshOverlays();
  }

  private clearHvhSetup(): void {
    this.setupVersion++;
    this.hvhSetup?.dispose();
    this.hvhSetup = null;
  }

  private openHvhSetup(): void {
    this.clearHvhSetup();
    this.game.input.releaseLock();
    const version = this.setupVersion;
    this.hvhSetup = new HvhSetup(this.dev, async panel => {
      const res = await this.net.socket.timeout(5000).emitWithAck('hvhReady', panel);
      if (version !== this.setupVersion || this.screen !== 'game') return null;
      if (!res.ok) return res.error ?? 'Could not enter combat.';
      this.dev.selectPanel(panel);
      this.clearHvhSetup();
      this.touchPaused = false;
      this.refreshOverlays();
      this.game.audio.unlock();
      void this.game.input.requestLock();
      return null;
    }, () => this.leave());
    byId('ui-layer').append(this.hvhSetup.root);
    this.refreshOverlays();
  }

  private leave(): void {
    this.lastRoom = null;
    this.net.leaveRoom();
    this.game.endSession();
    this.showMenu();
    void this.api.refresh().catch(() => undefined);
  }

  private bindConnection(): void {
    const socket = this.net.socket;
    socket.on('disconnect', (reason) => {
      if (this.screen === 'game') {
        this.game.endSession();
        this.rejoinOnConnect = this.lastRoom !== null;
        this.showMenu('Connection lost. Reconnecting…', true);
      }
      // Socket.IO reconnects by itself unless the server closed the connection on purpose.
      if (reason === 'io server disconnect') socket.connect();
    });
    socket.on('connect', () => {
      if (!this.rejoinOnConnect || !this.lastRoom || this.screen !== 'menu') return;
      this.rejoinOnConnect = false;
      const { id, mode } = this.lastRoom;
      this.menu.setStatus('Reconnected, rejoining…');
      void this.net
        .joinRoom({ roomId: id })
        .then((res) => (res.ok ? res : this.net.quickPlay(mode, undefined, this.menu.noBots)))
        .then((res) => (res.ok ? this.startGame(res) : this.showMenu(res.error, true)))
        .catch(() => this.showMenu('Could not rejoin.', true));
    });
    socket.on('connect_error', (err) => {
      // Our session expired (e.g. the database was reset): start over as a guest.
      if (err.message !== 'unauthorized') return;
      void this.api.startGuest().then(() => this.net.reconnect());
    });
  }
}
