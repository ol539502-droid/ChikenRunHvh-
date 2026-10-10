import {
  PLAYER,
  SIM_RATE,
  WEAPONS,
  createMoveState,
  magazineSize,
  defaultHvhLoadout,
  CommandBuffer, ExploitResource, createAnimation, ResolverSystem,
  type DevMods,
  type InputFrame,
  type MoveState,
  type PlayerInfo,
  type PlayerState,
  type WeaponId,
  DEFAULT_MELEE,
} from '@game/shared';
import type { GameSocket } from '../types';
import { TokenBucket } from '../util';
import { History } from './History';

/** Clients may send inputs slightly faster than SIM_RATE to absorb timer jitter... */
const INPUT_RATE_TOLERANCE = 1.1;
/** ...and catch up after a short stall (e.g. a GC pause or a dropped frame burst). */
const INPUT_BURST = SIM_RATE / 4;

/** Everything the server tracks about one player in a room. */
export class ServerPlayer {
  readonly info: PlayerInfo;
  /** Null for bots. */
  readonly socket: GameSocket | null;
  /** Database user id, null for bots. */
  readonly userId: number | null;
  readonly history = new History();
  readonly chatLimiter = new TokenBucket(3, 1.5);
  readonly buildLimiter = new TokenBucket(8, 6);
  private readonly inputLimiter = new TokenBucket(INPUT_BURST, SIM_RATE * INPUT_RATE_TOLERANCE);

  state: MoveState = createMoveState(0, 0, 0);
  yaw = 0;
  lookYaw = 0;
  fakeYaw = 0;
  fakePitch = 0;
  hvhCoverSide = 0;
  hvhTargetYaw: number | undefined;
  hvhCoverAt = -Infinity;
  hvh = defaultHvhLoadout();
  hvhEnabled = false;
  hvhPanel: import('@game/shared').HvhPanelId = 'manual';
  hvhPreparing = false;
  readonly commands = new CommandBuffer();
  readonly resource = new ExploitResource();
  animation = createAnimation();
  readonly resolver = new ResolverSystem();
  readonly fireQueue: Readonly<import('@game/shared').FireRequest>[] = [];
  hvhMode = false;
  simulationTime = 0;
  antiBruteSide = 1;
  lastThreatTick = -100;
  weaponHeat = 0;
  revealUntil = 0;
  concealUntil = 0;
  pitch = 0;
  lastInput: InputFrame | null = null;
  lastSeq = 0;

  alive = false;
  hp = 0;
  armor = 0;
  respawnAt = 0;
  shieldUntil = 0;

  weaponSlot = 0;
  readonly mags = new Map<WeaponId, number>();
  reloadUntil = 0;
  lastFireAt = -Infinity;
  /** Burst weapons: when the current burst began and how many of its shots went out. */
  burstStart = -Infinity;
  burstShots = 0;
  switchReadyAt = 0;
  /** When this player may switch team (M) again. */
  teamSwitchAt = 0;
  lastShotSeq = 0;
  aiming = false;

  eggs = 0;
  smokes = 0;
  flashes = 0;
  /** Kills this match that were headshots (for the match history). */
  headshotKills = 0;
  /** Flashbanged until then (performance.now ms): bots can't see, kills count as "blind". */
  blindUntil = 0;
  lastThrowSeq = 0;
  nextThrowAt = 0;

  /** Vehicle id being driven (0 = on foot). */
  vehicle = 0;
  carryingFlag: 0 | 1 | 2 = 0;

  /** Developer testing modifiers; null for everyone without developer access (and bots). */
  mods: DevMods | null = null;
  /** The anti-cheat caught them; they're on their way out. */
  removedForCheating = false;
  /** The melee weapon picked in the shop (knife skins replace the Knife in knife and bomb modes). */
  melee: WeaponId = DEFAULT_MELEE;
  /** Held in place by a developer (or ChikenBomb buy time): inputs are acknowledged but ignored. */
  frozen = false;
  /** Use (E) held in the latest input. */
  useHeld = false;
  /** ChikenBomb money, and whether a chikenCT bought a defuse kit. */
  money = 0;
  hasKit = false;

  constructor(info: PlayerInfo, socket: GameSocket | null, userId: number | null) {
    this.info = info;
    this.socket = socket;
    this.userId = userId;
  }

  get pid(): number {
    return this.info.pid;
  }

  get weapon(): WeaponId {
    return this.info.loadout[this.weaponSlot] ?? this.info.loadout[0] ?? 'pistol';
  }

  get mag(): number {
    return this.mags.get(this.weapon) ?? 0;
  }

  /** Full magazine for a weapon, including any developer magazine multiplier. */
  magazineSize(id: WeaponId): number {
    return magazineSize(WEAPONS[id].magazine, this.mods);
  }

  /** Token bucket that stops a client from sending inputs faster than real time (speed hacking). */
  takeInputToken(now: number): boolean {
    return this.inputLimiter.take(1, now);
  }

  /** Fresh life at a spawn point: full health, full magazines, starting grenades. */
  respawn(x: number, z: number, yaw: number, now: number, protectMs: number = PLAYER.spawnProtectionMs): void {
    this.state = createMoveState(x, 0, z);
    this.yaw = yaw;
    this.lookYaw = this.fakeYaw = yaw;
    this.fakePitch = 0;
    this.hvhCoverAt = -Infinity; this.hvhCoverSide = 0; this.hvhTargetYaw = undefined;
    this.commands.clear(); this.fireQueue.length = 0; this.resource.reset(); this.animation = createAnimation(yaw);
    this.simulationTime = now; this.lastThreatTick = -100; this.antiBruteSide = 1;
    this.weaponHeat = 0;
    this.revealUntil = this.concealUntil = 0;
    this.pitch = 0;
    this.alive = true;
    this.hp = PLAYER.maxHealth;
    this.armor = 0;
    this.shieldUntil = now + protectMs;
    this.reloadUntil = 0;
    this.lastFireAt = this.burstStart = -Infinity;
    this.burstShots = 0;
    this.switchReadyAt = 0;
    this.aiming = false;
    this.eggs = PLAYER.startEggs;
    this.smokes = PLAYER.startSmokes;
    this.flashes = PLAYER.startFlashes;
    this.blindUntil = 0;
    this.vehicle = 0;
    for (const id of this.info.loadout) this.mags.set(id, this.magazineSize(id));
    this.history.clear();
    if (this.hvhMode) this.history.push({ t: now, x, y: 0, z, yaw, alive: true, scale: 1 });
  }

  toState(): PlayerState {
    return {
      ...this.state,
      pid: this.pid,
      yaw: this.hvhMode ? this.animation.eyeYaw : this.yaw,
      pitch: this.pitch,
      alive: this.alive,
      reloading: this.reloadUntil > 0,
      shielded: this.shieldUntil > performance.now(),
      aiming: this.aiming,
      carryingFlag: this.carryingFlag !== 0,
      hp: Math.max(0, this.hp),
      armor: this.armor,
      weapon: this.weapon,
      mag: this.mag,
      eggs: this.eggs,
      smokes: this.smokes,
      flashes: this.flashes,
      ack: this.lastSeq,
      vehicle: this.vehicle,
      frozen: this.frozen,
      fakeYaw: this.hvhMode ? this.fakeYaw : this.yaw,
      fakePitch: this.hvhEnabled ? this.fakePitch : this.pitch,
      hvhCharge: this.hvhMode ? this.resource.charge : 0,
      hvhBurst: false,
      simulationTime: this.simulationTime,
      lowerBodyYaw: this.hvhMode ? this.animation.lowerBodyYaw : this.yaw,
      turnWeight: this.animation.turnWeight,
      weaponHeat: this.weaponHeat,
      hvhDefensive: this.hvhMode && performance.now() < this.concealUntil && this.hvh.core?.defensive === true,
      hvhPreparing: this.hvhPreparing,
      hvhConcealed: this.hvhEnabled && performance.now() < this.concealUntil,
    };
  }
}
