import { WEAPONS, WEAPON_SWITCH_MS, defaultHvhLoadout, fireIntervalFor, magazineSize, shotUsesAmmo, takeShot, type FireTiming, type DevMods, type PlayerState, type WeaponDef, type WeaponId, type ShotEvent } from '@game/shared';
import { ExploitResource, defaultHvhCore, hvhWeapon, trainingMods } from '@game/shared';

/** After firing, trust our own ammo count over (older) snapshots for this long. */
const AMMO_TRUST_MS = 400;

/**
 * Client-side weapon state: which gun is out, predicted ammo, reload and fire-rate timers.
 * The server enforces the same rules; this just keeps the game responsive.
 */
export class WeaponController {
  tactical = false;
  heat = 0;
  lastShotBurst = 1;
  private readonly resource = new ExploitResource();
  private wallTick = 0;
  private resourceTime = performance.now();
  loadout: WeaponId[];
  slot = 0;
  shotSeq = 0;
  private readonly mags = new Map<WeaponId, number>();
  private reloadEndsAt = 0;
  private reloadStartedAt = 0;
  private switchReadyAt = 0;
  private confirmedReadyAt = -Infinity;
  /** When we last fired, and burst progress (the same rule the server checks). */
  private readonly timing: FireTiming = { lastFireAt: -Infinity, burstStart: -Infinity, burstShots: 0 };
  private triggerWasDown = false;
  private assistedBurst = false;
  /** Developer modifiers confirmed by the server (null = normal rules). */
  /** Training: infinite ammo and instant reload, on top of any developer modifiers. */
  training = false;
  private devMods: DevMods | null = null;
  get mods(): DevMods | null {
    return this.training ? trainingMods(this.devMods) : this.devMods;
  }
  set mods(value: DevMods | null) {
    this.devMods = value;
  }
  /** Developer option: semi-automatic weapons keep firing while the trigger is held. */
  forceAutomatic = false;
  hvh = defaultHvhLoadout();

  constructor(loadout: WeaponId[]) {
    this.loadout = loadout.length > 0 ? loadout : ['pistol'];
    this.refill();
  }

  get weapon(): WeaponId {
    return this.loadout[this.slot] ?? this.loadout[0]!;
  }

  get def(): WeaponDef {
    return this.tactical ? hvhWeapon(WEAPONS[this.weapon]) : WEAPONS[this.weapon];
  }

  get mag(): number {
    return this.mags.get(this.weapon) ?? 0;
  }

  magazineSize(id: WeaponId = this.weapon): number {
    return magazineSize(WEAPONS[id].magazine, this.mods);
  }

  /** Time between shots, including developer modifiers (fire rate, no rocket cooldown). */
  get fireInterval(): number {
    return fireIntervalFor(this.def, this.mods);
  }

  get reloading(): boolean {
    return this.reloadEndsAt > 0;
  }

  /** 0..1 progress of the current reload. */
  reloadProgress(now: number): number {
    if (!this.reloading) return 0;
    return Math.min(1, (now - this.reloadStartedAt) / (this.reloadEndsAt - this.reloadStartedAt));
  }

  refill(): void {
    this.timing.lastFireAt = this.timing.burstStart = -Infinity;
    this.timing.burstShots = 0;
    this.triggerWasDown = false;
    this.resource.reset(); this.resourceTime = performance.now();
    this.heat = 0;
    for (const id of this.loadout) this.mags.set(id, this.magazineSize(id));
    this.reloadEndsAt = 0;
    this.switchReadyAt = 0;
    this.confirmedReadyAt = -Infinity;
  }

  /** Returns true if the slot changed (the caller tells the server). */
  switchTo(slot: number, now: number): boolean {
    if (slot < 0 || slot >= this.loadout.length || slot === this.slot) return false;
    this.slot = slot;
    this.reloadEndsAt = 0;
    this.switchReadyAt = now + WEAPON_SWITCH_MS;
    this.timing.burstShots = 0;
    return true;
  }

  cycle(direction: 1 | -1, now: number): boolean {
    const n = this.loadout.length;
    return this.switchTo((this.slot + direction + n) % n, now);
  }

  /** Returns true if a reload started (the caller tells the server). */
  reload(now: number): boolean {
    if (this.reloading || this.mag >= this.magazineSize()) return false;
    this.reloadStartedAt = now;
    this.reloadEndsAt = now + (this.mods?.instantReload ? 1 : this.def.reloadTime);
    return true;
  }

  update(now: number, choked = (this.hvh.core?.fakeLag ?? 0) > 0): void {
    const count = Math.min(8, Math.floor((now - this.resourceTime) / (1000 / 64)));
    for (let i = 0; i < count; i++) {
      this.resource.step(++this.wallTick, now - this.timing.lastFireAt < 250, choked);
      this.resourceTime += 1000 / 64;
      this.heat = Math.max(0, this.heat - 1.5 / 64);
    }
    if (this.reloading && now >= this.reloadEndsAt) {
      this.mags.set(this.weapon, this.magazineSize());
      this.reloadEndsAt = 0;
    }
  }

  /**
   * Decides whether the trigger produces a shot this frame (semi-auto needs a fresh press,
   * automatic weapons repeat at their fire rate). Returns 'fire', 'empty' (click) or null.
   */
  trigger(down: boolean, now: number, assisted = false): 'fire' | 'empty' | null {
    const fresh = down && !this.triggerWasDown;
    this.triggerWasDown = down;
    const w = this.def;
    if (this.assistedBurst && !down && !assisted && w.burst) this.timing.burstShots = w.burst.count;
    // A burst keeps going after the trigger pull that started it.
    const midBurst = w.burst !== undefined && this.timing.burstShots > 0 && this.timing.burstShots < w.burst.count && now - this.timing.burstStart < this.fireInterval;
    if (!midBurst && (!down || (!w.automatic && !this.forceAutomatic && !assisted && !fresh))) return null;
    if (now < this.switchReadyAt || this.reloading || (this.tactical && now < this.confirmedReadyAt)) return null;
    if (this.mag <= 0) {
      this.timing.burstShots = 0;
      return fresh ? 'empty' : null;
    }
    const interval = fireIntervalFor(w, this.mods);
    const core = this.hvh.core ?? defaultHvhCore();
    const mode = (core.era === 'tickbase' || core.era === 'defensive') && !w.melee && !w.projectile && !w.burst
      && (this.hvh.exploit !== 'doubleTap' || this.mag >= 2) ? this.hvh.exploit : 'off';
    const permission = this.tactical && !w.burst ? this.resource.fire(interval, mode, this.wallTick) : { shots: 1, hidden: false };
    if (!permission.shots || ((!this.tactical || w.burst) && !takeShot(w, interval, this.timing, now))) return null;
    if (this.tactical) this.timing.lastFireAt = now;
    if (this.tactical) this.heat = Math.min(3, this.heat + permission.shots * 0.25);
    this.lastShotBurst = permission.shots;
    if (w.burst && this.timing.burstShots === 1) this.assistedBurst = assisted;
    if (shotUsesAmmo(this.def, this.mods)) this.mags.set(this.weapon, Math.max(0, this.mag - permission.shots));
    this.shotSeq++;
    return 'fire';
  }

  /** Readiness for assists. It never consumes ammunition or advances a timer. */
  shotState(now: number): 'Ready' | 'Reloading' | 'Switching weapon' | 'Empty' | 'Cooldown' {
    if (this.reloading) return 'Reloading';
    if (now < this.switchReadyAt) return 'Switching weapon';
    if (this.mag <= 0) return 'Empty';
    if (this.tactical && now < this.confirmedReadyAt) return 'Cooldown';
    if (this.tactical && !this.def.burst) return this.resource.playerTick >= this.resource.nextAttackTick ? 'Ready' : 'Cooldown';
    const interval = fireIntervalFor(this.def, this.mods);
    return takeShot(this.def, interval, { ...this.timing }, now) ? 'Ready' : 'Cooldown';
  }

  suspend(): void {
    this.triggerWasDown = false;
    if (this.def.burst) this.timing.burstShots = this.def.burst.count;
  }

  /** Reconcile the latest request immediately; delayed snapshots need not correct rejected ammo. */
  confirmShot(shot: ShotEvent, now: number, serverNow: number): void {
    if (!this.tactical || shot.weapon !== this.weapon || shot.shot !== this.shotSeq) return;
    if (shot.readyAt !== undefined) this.confirmedReadyAt = now + Math.max(0, shot.readyAt - serverNow);
    if (shot.mag !== undefined) this.mags.set(this.weapon, Math.max(0, Math.min(this.magazineSize(), shot.mag)));
    if (shot.charge !== undefined) this.resource.ticks = Math.max(0, Math.min(1, shot.charge)) * this.resource.capacity;
  }

  /** The server changed our loadout (developer tools): keep the same gun out if we still have it. */
  setLoadout(loadout: WeaponId[]): void {
    if (loadout.length === 0 || loadout.join() === this.loadout.join()) return;
    const current = this.weapon;
    this.loadout = [...loadout];
    const slot = this.loadout.indexOf(current);
    this.slot = slot >= 0 ? slot : 0;
    for (const id of this.loadout) if (!this.mags.has(id)) this.mags.set(id, this.magazineSize(id));
  }

  /** Adopt the server's numbers when we haven't just changed them ourselves. */
  sync(server: PlayerState, now: number): void {
    if (this.tactical && now - this.timing.lastFireAt > AMMO_TRUST_MS && server.hvhCharge !== undefined) this.resource.ticks = server.hvhCharge * this.resource.capacity;
    if (this.tactical && now - this.timing.lastFireAt > AMMO_TRUST_MS) this.heat = server.weaponHeat ?? 0;
    if (server.weapon !== this.weapon) {
      const slot = this.loadout.indexOf(server.weapon);
      if (slot >= 0 && now > this.switchReadyAt + 500) this.slot = slot;
    }
    if (server.weapon === this.weapon && !this.reloading && !server.reloading && now - this.timing.lastFireAt > AMMO_TRUST_MS) {
      this.mags.set(this.weapon, server.mag);
    }
  }
}
