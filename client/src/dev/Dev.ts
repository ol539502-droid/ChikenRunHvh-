import { DEFAULT_MODS, type DevResult, type DevStatus, type HvhPanelId } from '@game/shared';
import type { AudioEngine } from '../game/Audio';
import type { Input } from '../game/Input';
import type { GameSocket } from '../net/Network';
import type { Hud } from '../ui/Hud';
import { defaultConfig, getPath, loadConfigs, loadCurrent, sanitizeConfig, saveConfigs, saveCurrent, setPath, type DevConfig, type NamedConfig } from './config';
import { HVH_PANELS } from './panels';
import { DevMenu } from './DevMenu';
import { NativeMenu } from './skeet/NativeMenu';
import { DevRuntime } from './DevRuntime';
import { showPasskeyPrompt } from './passkey';
import './dev.css';

const REQUEST_TIMEOUT_MS = 5000;
/** Config changes are sent to the server at most this often (sliders fire many events). */
const MODS_SYNC_MS = 150;

export interface DevContext {
  socket: GameSocket;
  input: Input;
  hud: Hud;
  audio: AudioEngine;
  /** Current fps / ping, for the Misc readouts. */
  fps: () => number;
  ping: () => number | null;
  /** Opens the game's own Settings at the crosshair editor. */
  openCrosshairSettings: () => void;
  /** Whether a match is running (the pointer gets re-locked when the menu closes). */
  inGame: () => boolean;
  /** Called whenever the menu opens or closes. */
  onMenuChange: () => void;
  /** Applies the World tab (level colours, sky, light) to the renderer. */
  applyWorldLook: (look: DevConfig['world']) => void;
}

/**
 * The developer system: config, the connection to the server's developer API, the menu, and
 * the in-match runtime. The server decides what's allowed; this only asks.
 */
export class Dev {
  config: DevConfig = loadCurrent();
  panelId: HvhPanelId = 'lab';
  private configPanel: 'lab' | 'skeet' = 'lab';
  configs: NamedConfig[] = loadConfigs();
  status: DevStatus = { granted: false, allowedHere: false, profile: 'off', publicHvh: false, mods: { ...DEFAULT_MODS } };
  readonly runtime: DevRuntime;
  readonly input: Input;
  readonly hud: Hud;
  readonly audio: AudioEngine;

  private readonly ctx: DevContext;
  private readonly socket: GameSocket;
  private menu: DevMenu | NativeMenu | null = null;
  private prompting = false;
  private readonly listeners = new Set<() => void>();
  private syncTimer: number | undefined;
  private sessionVersion = 0;
  private toasts: HTMLElement | null = null;

  constructor(ctx: DevContext) {
    this.ctx = ctx;
    this.socket = ctx.socket;
    this.input = ctx.input;
    this.hud = ctx.hud;
    this.audio = ctx.audio;
    this.runtime = new DevRuntime(this);
    saveConfigs(this.configs);
    ctx.applyWorldLook(this.config.world);
    window.addEventListener('keydown', this.onKey, true);
    // Grants live on the server; after a reconnect (e.g. server restart) ask again.
    this.socket.on('connect', () => void this.refreshStatus());
    this.socket.on('disconnect', () => {
      this.sessionVersion++;
      this.setStatus({ ...this.status, granted: false, allowedHere: false, profile: 'off', mods: { ...DEFAULT_MODS } });
    });
  }

  /** Developer features are on: access granted and allowed in the current room. */
  /** In an HvH match: the only place the HvH panels work. */
  get inHvh(): boolean {
    return this.runtime.currentSession?.mode.id === 'hvh';
  }

  get active(): boolean {
    return this.inHvh && this.status.profile === 'hvh'
      && this.status.granted && this.status.allowedHere && HVH_PANELS[this.panelId].assisted;
  }

  get menuOpen(): boolean {
    return this.menu !== null || this.prompting;
  }

  fps(): number {
    return this.ctx.fps();
  }

  ping(): number | null {
    return this.ctx.ping();
  }

  // ---------------------------------------------------------------------------
  // Config
  // ---------------------------------------------------------------------------

  get(path: string): unknown {
    return getPath(this.config, path);
  }

  set(path: string, value: unknown): void {
    setPath(this.config, path, value);
    this.changed();
  }

  replaceConfig(config: DevConfig): void {
    this.config = config;
    this.changed();
  }

  selectPanel(id: HvhPanelId): void {
    const changedPanel = id !== this.panelId;
    if (id !== 'manual' && id !== this.configPanel) {
      saveCurrent(this.config, this.configPanel); saveConfigs(this.configs, this.configPanel);
      this.configPanel = id; this.config = loadCurrent(id); this.configs = loadConfigs(id);
      this.ctx.applyWorldLook(this.config.world);
    }
    this.panelId = id;
    if (changedPanel) this.runtime.panelChanged();
    this.runtime.applyServerMods();
    for (const fn of this.listeners) fn();
    this.syncNow();
  }

  resetAll(): void {
    this.config = defaultConfig(this.configPanel);
    this.changed();
  }

  saveConfigList(): void {
    saveConfigs(this.configs, this.configPanel);
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private changed(): void {
    this.config = sanitizeConfig(this.config);
    saveCurrent(this.config, this.configPanel);
    this.ctx.applyWorldLook(this.config.world);
    for (const fn of this.listeners) fn();
    this.scheduleSync();
  }

  // ---------------------------------------------------------------------------
  // Server
  // ---------------------------------------------------------------------------

  async refreshStatus(): Promise<DevStatus> {
    const version = this.sessionVersion;
    try {
      const status = await this.socket.timeout(REQUEST_TIMEOUT_MS).emitWithAck('devStatus');
      if (version === this.sessionVersion) this.setStatus(status);
    } catch {
      // Offline: keep what we had.
    }
    return this.status;
  }

  async unlock(passkey: string): Promise<DevResult> {
    if (!this.socket.connected) return { ok: false, error: 'Not connected to the game server.' };
    try {
      const res = await this.socket.timeout(REQUEST_TIMEOUT_MS).emitWithAck('devAuth', passkey);
      if (res.ok) {
        await this.refreshStatus();
        this.syncNow();
      }
      return res;
    } catch {
      return { ok: false, error: 'The server did not answer.' };
    }
  }

  private scheduleSync(): void {
    window.clearTimeout(this.syncTimer);
    this.syncTimer = window.setTimeout(() => this.syncNow(), MODS_SYNC_MS);
  }

  /** Sends the gameplay modifiers to the server; prediction uses whatever it confirms. */
  syncNow(): void {
    window.clearTimeout(this.syncTimer);
    if (!this.status.granted || !this.runtime.currentSession) return;
    // Outside HvH the modifiers belong to classic mega?dev (L); this one only sends defaults.
    if (this.status.profile !== 'hvh') return;
    const version = this.sessionVersion;
    this.socket
      .timeout(REQUEST_TIMEOUT_MS)
      .emitWithAck('devHvh', this.runtime.extensions.antiAim(HVH_PANELS[this.panelId].loadout(this.config)))
      .then((s) => { if (version === this.sessionVersion) this.setStatus(s); })
      .catch(() => undefined);
  }

  private setStatus(s: DevStatus): void {
    const old = `${this.active}:${this.status.profile}:${this.status.publicHvh}`;
    this.status = s;
    this.runtime.applyServerMods();
    if (old !== `${this.active}:${s.profile}:${s.publicHvh}`) for (const fn of this.listeners) fn();
  }

  sessionStarted(): void {
    this.sessionVersion++;
    if (!this.inHvh) this.closeMenu();
    // New room, new permissions: check them, then send our modifiers.
    void this.refreshStatus().then(() => this.syncNow());
  }

  sessionEnded(): void {
    this.sessionVersion++;
    this.closeMenu();
    this.status = { ...this.status, allowedHere: false, profile: 'off', mods: { ...DEFAULT_MODS } };
    for (const fn of this.listeners) fn();
  }

  // ---------------------------------------------------------------------------
  // Menu
  // ---------------------------------------------------------------------------

  async toggleMenu(): Promise<void> {
    if (this.menu) this.closeMenu();
    else await this.openMenu();
  }

  /** Opens the menu, asking for the passkey first if this account hasn't unlocked it yet. */
  async openMenu(): Promise<void> {
    if (this.menuOpen) return;
    if (!this.inHvh) {
      this.notify('HvH panels only open in HvH matches · press L for mega?dev', 'bad');
      return;
    }
    this.prompting = true;
    this.input.releaseLock();
    this.ctx.onMenuChange();
    const status = await this.refreshStatus();
    if (!status.granted && !(status.publicHvh && this.runtime.currentSession?.mode.id === 'hvh')) {
      const unlocked = await showPasskeyPrompt((key) => this.unlock(key), this.config.settings);
      if (!unlocked) {
        this.prompting = false;
        this.ctx.onMenuChange();
        return;
      }
    }
    this.prompting = false;
    this.menu = this.panelId === 'skeet' ? new NativeMenu(this, () => this.closeMenu()) : new DevMenu(this, () => this.closeMenu());
    this.ctx.onMenuChange();
    this.click();
  }

  closeMenu(): void {
    if (!this.menu) return;
    this.menu.dispose();
    this.menu = null;
    this.ctx.onMenuChange();
    if (this.ctx.inGame()) void this.input.requestLock();
  }

  /** Re-reads every control in the open menu (after a config load or reset). */
  menuRefresh(): void {
    this.menu?.refreshAll();
  }

  openCrosshairSettings(): void {
    this.ctx.openCrosshairSettings();
  }

  // ---------------------------------------------------------------------------
  // Feedback
  // ---------------------------------------------------------------------------

  click(): void {
    if (this.config.settings.sounds) this.audio.play('click', undefined, 0.5);
  }

  notify(text: string, kind: 'info' | 'good' | 'bad' = 'info'): void {
    if (!this.config.settings.notifications && kind !== 'bad') return;
    if (!this.toasts) {
      this.toasts = document.createElement('div');
      this.toasts.className = 'dev-toasts';
      document.body.append(this.toasts);
    }
    const el = document.createElement('div');
    el.className = `dev-toast ${kind}`;
    el.textContent = text;
    this.toasts.append(el);
    window.setTimeout(() => el.remove(), 2800);
  }

  private onKey = (e: KeyboardEvent): void => {
    if (e.code !== this.config.settings.menuKey || e.repeat) return;
    const t = e.target as HTMLElement | null;
    // Don't steal the key from text fields or the keybind picker.
    if (t && (isTextField(t) || t.closest('.dev-capturing'))) return;
    e.preventDefault();
    e.stopPropagation();
    void this.toggleMenu();
  };
}

/** Inputs you type into (where the menu key should type, not toggle the menu). */
function isTextField(el: HTMLElement): boolean {
  if (el.tagName === 'TEXTAREA' || el.isContentEditable) return true;
  if (el.tagName !== 'INPUT') return false;
  return !['checkbox', 'radio', 'range', 'color', 'button', 'submit'].includes((el as HTMLInputElement).type);
}
