import * as THREE from 'three';
import { TrainingMenu } from '../ui/TrainingMenu';
import { nativeOn, nativeValue, type NativeValues } from '../dev/skeet/visualValues';
import {
  ZOMBIE_SHOP_BY_ID,
  type ZombieState,
  type WeaponId,
  BLOCK_ID_BASE,
  BLOCK_KINDS,
  BLOCK_SIZE,
  ARMS_LADDER,
  BOMB,
  BUILD_RANGE,
  INTERP_DELAY_MS,
  MODES,
  PLAYER,
  PROJECTILES,
  FLASH,
  launchVelocity,
  predictThrow,
  throwDrop,
  throwerVelocity,
  type ProjectileKind,
  type ThrowPower,
  SIM_DT,
  TEAM_NAMES,
  WEAPONS,
  blockAabb,
  cellOf,
  createCollisionWorld,
  eyeHeightOf,
  hopMaxFor,
  moveSpeedFor,
  heightOf,
  getItem,
  makeRay,
  meleeHit,
  normalize,
  pelletDirections,
  pointOnRay,
  rayChicken,
  rayHvhChicken, CommandChoker, NetworkSimulator, defaultHvhCore, fakeLagTicks,
  hvhSpread,
  type WeaponDef,
  exploitMode,
  raycastPenetrating,
  raycastWorld,
  softBoxTest,
  WALLBANG,
  shotSeed,
  spreadFor,
  unpackPlayer,
  unpackVehicle,
  wrapAngle,
  type BlockState,
  type BuyItem,
  type ChatMessage,
  type CollisionWorld,
  type DamageEvent,
  type ExplosionEvent,
  type FlagEvent,
  type InputFrame,
  type MeleeTarget,
  type JoinSuccess,
  type KillCause,
  type KillEvent,
  type LootState,
  type MatchRewardEvent,
  type MatchState,
  type ModeDef,
  type PickupEvent,
  type PlayerInfo,
  type ProjectileSpawn,
  type RayHit,
  type RoomInfo,
  type RoundState,
  type ScoresEvent,
  type ServerToClientEvents,
  type ShotEvent,
  type SmokeEvent,
  type SpawnEvent,
  type Vec3,
  type WorldSnapshot,
  levelFor,
  rankOf,
  BUGGY,
  seatPosition,
  carAimSpeed, type FlashedEvent,
  bombHoldsPlayer,
  teamName,
  teamSwitchBlocked,
  type TrainingGiveRequest,
  upgradeEffects,
  type MapZone,
  CRYSTAL_HUNT,
  POWER_UP_INFO,
  isPowerUp,
} from '@game/shared';
import type { Network } from '../net/Network';
import { CommandClock, NO_SIGHT, TickClock, commandIntent, shotReference } from '../hvh/PredictedTickbase';
import { SmoothedPitch, SmoothedYaw, SpectateTarget } from '../hvh/Spectate';
import { HVH_ROUNDS, LATE_CSGO, enemyVisible, snapshotSightTargets, type SightTarget } from '@game/shared/hvh/v2';
import { HitLog, initHvhV2Ui } from '../ui/hvh/HitLog';
import { HvhBuyMenu } from '../ui/hvh/HvhBuyMenu';
import { nextGrenade, grenadeCount, slotItems, stepSlot, weaponIndexForKey, type HeldGrenade, type SlotItem } from './weaponSlots';
import { getSettings } from '../settings';
import { BuyMenu } from '../ui/BuyMenu';
import type { Hud, ScoreLine } from '../ui/Hud';
import { showJumpscare } from '../ui/Jumpscare';
import { ZombieHud } from '../ui/ZombieHud';
import { getKeybinds, keyLabel } from '../keybinds';
import { ZombieNight } from './ZombieNight';
import { HuntView } from './HuntView';
import { emptySoundFor, reloadSoundFor } from './Audio';
import type { AudioEngine } from './Audio';
import { Blocks } from './Blocks';
import { BombView, type BombMode } from './BombView';
import { CameraRig, zoomLookScale } from './CameraRig';
import { Effects } from './Effects';
import { Flags } from './Flags';
import type { Action, Input } from './Input';
import { LocalPlayer } from './LocalPlayer';
import { LootView } from './LootView';
import { ClientProjectiles, ThrowPreview } from './Projectiles';
import { CASING_FOR, CYCLE_OF, Casings, ejectDelayMs } from './Casings';
import { RemotePlayers, type RemotePlayer } from './RemotePlayers';
import { Vehicles } from './Vehicles';
import { ViewModel } from './ViewModel';
import { WeaponController } from './WeaponController';
import type { World } from './World';

/** How strongly each snapshot nudges the server-clock estimate (lower = smoother, slower to adapt). */
const CLOCK_SMOOTHING = 0.05;
const HUD_INTERVAL = 1 / 15;
const AIM_RANGE = 250;
const PICKUP_TEXT: Record<string, string> = { medkit: '+50 Health', armor: '+50 Armor', fuel: 'Jetpack fuel!', eggs: '+2 Explosive eggs' };

export interface SessionContext {
  scene: THREE.Scene;
  /** Drawn on top of the world (the first-person gun). */
  overlay: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  world: World;
  input: Input;
  net: Network;
  audio: AudioEngine;
  hud: Hud;
  join: JoinSuccess;
  /** Match reward: the new coin and XP totals. */
  onReward: (coins: number, xp: number) => void;
  /** Something that frees the mouse (the buy menu) opened or closed. */
  onOverlay: () => void;
  /** The server closed the room. */
  onClosed: (reason: string) => void;
  /** Developer tools, if loaded. */
  dev?: DevHooks;
  /** Zombie Apocalypse Blood Moon: tints the night (0 normal to 1 crimson). */
  setBloodMoon?: (amount: number) => void;
  /** Inside a story event level: its own light (null: back to the map's). */
  setZoneLook?: (look: MapZone['look'] | null) => void;
}

/** How the developer system plugs into a match. Every hook is optional behaviour on top of normal play. */
export interface DevHooks {
  onShot?(session: GameSession, assisted?: boolean): void;
  onServerShot?(session: GameSession, shot: ShotEvent): void;
  shotIntent?(): import('@game/shared').ShotIntent | undefined;
  attach(session: GameSession): void;
  detach(session: GameSession): void;
  /** Start of every frame (aim assist, triggers). */
  beforeFrame(session: GameSession, dt: number, now: number): void;
  /** Adjust an input frame before it is predicted and sent (movement helpers, free camera). */
  modifyFrame(session: GameSession, frame: InputFrame): InputFrame;
  /** Extra trigger pull (trigger assist, auto fire). */
  wantsFire(now?: number): boolean;
  /** Replacement shot direction from the eye (aim lock), or null. */
  aimOverride(session: GameSession, eye: Vec3): Vec3 | null;
  /** Multiplier on camera recoil. */
  recoilScale(): number;
  /** No shooting while flying a free camera or spectating. */
  blocksShooting(): boolean;
  /** Free camera / spectating: return true if the camera was placed by the developer system. */
  controlCamera(session: GameSession, dt: number): boolean;
  /** End of every frame (overlays). */
  afterFrame(session: GameSession, dt: number): void;
  /** How your own chicken is drawn (spin bot), or null to face where you look. */
  bodyAngles(): { yaw: number; pitch: number } | null;
  /** Developer wallhack silhouette for a player, or null when the developer wallhack is off. */
  xrayFor(session: GameSession, player: RemotePlayer): THREE.Material | null;
}

/** HvH: everyone sees enemies through walls as a red silhouette. */
const HVH_XRAY = new THREE.MeshBasicMaterial({ color: 0xff3b4e, opacity: 0.6, depthFunc: THREE.GreaterDepth, depthWrite: false, fog: false, blending: THREE.AdditiveBlending, toneMapped: false });

/** Everything that exists only while in a room. Created on join, disposed on leave. */
export class GameSession {
  hvhVisuals: NativeValues | null = null;
  private visualKick = {yaw:0,pitch:0};
  private readonly commandChoker = new CommandChoker();
  private commandNetwork: NetworkSimulator<readonly InputFrame[]> | null = null;
  private networkKey = '';
  /** Server tick being displayed (render time), sent as each command's clientTick. */
  private readonly tickClock = new TickClock();
  /** HvH: the latest snapshot's `t` and the enemies it shows us, which v2 sight is predicted from (R56). */
  private sightView: { t: number; enemies: SightTarget[] } | null = null;
  private readonly commandClock = new CommandClock();
  /** Seq of the command that carries the latest hitscan shot (the `fire` message references it). */
  private shotCommand: number | null = null;
  readonly room: RoomInfo;
  readonly selfPid: number;
  readonly mode: ModeDef;

  private readonly ctx: SessionContext;
  // Public (read-only) for the developer tools.
  readonly infos = new Map<number, PlayerInfo>();
  readonly local: LocalPlayer;
  readonly remotes: RemotePlayers;
  readonly rig: CameraRig;
  private readonly effects: Effects;
  readonly projectiles: ClientProjectiles;
  /** Your aiming line while a grenade's pin is pulled (only on your screen). */
  private readonly throwPreview: ThrowPreview;
  readonly loot: LootView;
  readonly weapons: WeaponController;
  /** This session's own collision data (Sandbox blocks get added to it). */
  readonly collision: CollisionWorld;
  readonly vehicles: Vehicles;
  private readonly blocks: Blocks | null;
  readonly flags: Flags | null;
  /** Boxes bullets go through (wallbang), and how many per bullet in this mode. */
  private readonly isSoft: (id: number) => boolean;
  private readonly wallbangBoxes: number;
  private building = false;
  private blockIndex = 0;
  private fireWasDown = false;
  private aimWasDown = false;
  private readonly handlers: [keyof ServerToClientEvents, (...args: never[]) => void][] = [];

  private match: MatchState;
  /** ChikenBomb: the round, your money, the buy menu and the bomb in the world. */
  private round: RoundState | null;
  private money: number;
  private readonly buyMenu: BuyMenu | null;
  /** v2 HvH rounds: the main + pistol pick (open at freeze, closed at live). */
  private readonly hvhBuy: HvhBuyMenu | null;
  /** The HvH buy menu took the mouse (opened with B), so closing it takes it back. */
  private hvhBuyReleased = false;
  /** Zombie Apocalypse: the wave panel, shop and game-over screen. */
  private readonly zombieHud: ZombieHud | null;
  private night: ZombieNight | null = null;
  /** Story events (Crystal Hunt): crystals, portal, the phone. */
  private hunt: HuntView | null = null;
  private huntSpeedLevel = 0;
  /** Max health as a multiple of normal (Health upgrade); the health bar is a share of it. */
  private maxHealth = 1;
  /** Training: the weapon menu (B). */
  private readonly trainingMenu: TrainingMenu | null;
  private zombieOver = false;
  /** A sniper's scope: 0 = not scoped, 1 = scoped, 2 = zoomed in further. */
  private scopeLevel: 0 | 1 | 2 = 0;
  /** The weapon the scope belongs to (a different weapon puts the scope away). */
  private scopeWeapon: WeaponId | null = null;
  private readonly bombView: BombView | null;
  private hasKit = false;
  private nextBeep = 0;
  private readonly markerPoint = new THREE.Vector3();
  private teamScores: [number, number] = [0, 0];
  private accumulator = 0;
  private nextSeq = 1;
  private throwSeq = 0;
  /** Estimated (server clock − performance.now()), in ms. */
  private clockOffset = 0;
  private hasClock = false;
  private aimingSent = false;
  private heldGrenade: HeldGrenade | null = null;
  /** ChikenBomb: the bomb is in your hands (slot 5); holding fire plants it. */
  private bombOut = false;
  private grenadeThrowHeld = false;
  /** The grenade in hand has its pin pulled (a mouse button is held): letting go throws it. */
  private pinPulled = false;
  /** The mouse buttons last frame, for the grenade throw. */
  private throwButtons = { left: false, right: false };
  private chatOpen = false;
  /** What the server was last told is in hand. */
  private heldSent: 'gun' | HeldGrenade | 'bomb' = 'gun';
  /** When "you must be in a bomb site" may show again. */
  private plantHintAt = 0;
  /** The open chat box sends to the team only (U), not everyone (Y). */
  private chatTeamOnly = false;
  private hudTimer = 0;
  private lastJetFx = 0;
  private wasOnGround = true;
  private deathPos: THREE.Vector3 | null = null;
  private respawnAt = 0;
  /** v2 HvH rounds (R63): the living teammate a dead player watches. */
  private readonly spectate = new SpectateTarget();
  private readonly spectateYaw = new SmoothedYaw();
  private readonly spectatePitch = new SmoothedPitch();
  private spectated: RemotePlayer | null = null;
  private lastResultsKey = '';
  /** First-person gun, attached to the camera. */
  private readonly viewmodel: ViewModel;
  /** Spent cases flying out of every gun nearby. */
  private readonly casings: Casings;
  private readonly lastViewPos = new THREE.Vector3();
  private readonly tmp = new THREE.Vector3();
  private readonly camDir = new THREE.Vector3();
  hitLog: HitLog | null = null;

  constructor(ctx: SessionContext) {
    this.ctx = ctx;
    const { join } = ctx;
    this.room = join.room;
    this.selfPid = join.selfPid;
    this.mode = MODES[join.room.mode];
    this.match = join.match;
    this.teamScores = join.match.teamScores;
    this.round = join.round;
    this.money = join.money;
    for (const p of join.players) this.infos.set(p.pid, p);

    const mePacked = join.snapshot.p.find((p) => p[0] === join.selfPid);
    const meInfo = this.infos.get(join.selfPid);
    if (!mePacked || !meInfo) throw new Error('Join response did not include the local player');
    const me = unpackPlayer(mePacked);

    this.collision = createCollisionWorld(ctx.world.map);
    this.effects = new Effects(ctx.scene);
    this.vehicles = new Vehicles(ctx.scene, this.effects);
    this.blocks = this.mode.building || this.mode.zombies ? new Blocks(ctx.scene, this.collision) : null;
    for (const b of join.blocks) this.blocks?.add(b);
    this.flags = this.mode.id === 'ctf' ? new Flags(ctx.scene, ctx.world.map, join.flags) : null;
    this.isSoft = softBoxTest(ctx.world.map, (id) => this.blocks?.kindOf(id));
    this.wallbangBoxes = this.mode.wallbang ? WALLBANG.maxBoxes : 0;
    this.local = new LocalPlayer(ctx.scene, meInfo, me);
    this.local.tactical = this.mode.id === 'hvh';
    this.remotes = new RemotePlayers(ctx.scene);
    this.rig = new CameraRig(ctx.camera, this.collision);
    this.projectiles = new ClientProjectiles(ctx.scene, this.collision, this.effects);
    this.throwPreview = new ThrowPreview(ctx.scene);
    this.loot = new LootView(ctx.scene, ctx.world.map, this.effects);
    this.loot.setAll(join.loot);
    for (const d of join.drops) this.loot.addDrop(d, false);
    this.loot.onBreak = (at) => ctx.audio.play('boxBreak', at);
    this.weapons = new WeaponController(meInfo.loadout);
    this.weapons.tactical = this.mode.id === 'hvh';
    this.weapons.training = this.mode.training === true;
    // Chicken upgrades: only when the server says they count here (PvE).
    const upgrades = join.upgrades ? upgradeEffects(join.upgrades) : null;
    this.local.upgrades = upgrades;
    this.weapons.reloadScale = upgrades?.reload ?? 1;
    this.maxHealth = upgrades?.maxHealth ?? 1;
    this.viewmodel = new ViewModel(ctx.overlay);
    this.casings = new Casings(ctx.scene, this.collision, getSettings().quality, (kind, at, loud) =>
      ctx.audio.play(kind === 'nova' || kind === 'xm1014' || kind === 'mag7' ? 'shellThud' : 'shellClink', at, 0.5 * loud));
    // First person: the case leaves the view model's ejection port when the action opens.
    this.viewmodel.onEject = (at, dir) => {
      const kind = CASING_FOR[this.weapons.weapon];
      if (!kind) return;
      const s = this.local.state, speed = 2.2 + Math.random() * 0.9;
      this.casings.eject(kind, at, { x: dir.x * speed + s.vx, y: dir.y * speed + Math.max(0, s.vy), z: dir.z * speed + s.vz });
    };
    this.viewmodel.skin = meInfo.appearance.gun ?? 'none';
    this.viewmodel.onInspectCue = (cue) => ctx.audio.play(cue === 'in' ? 'reload' : 'click', undefined, 0.55);
    this.bombView = this.mode.bomb ? new BombView(ctx.scene) : null;
    this.buyMenu = this.mode.bomb ? new BuyMenu(ctx.hud.root, meInfo.appearance, this.mode.csOnly) : null;
    if (this.buyMenu) {
      this.buyMenu.onBuy = (item) => this.buy(item);
      this.buyMenu.onClose = () => this.closeBuyMenu();
    }
    // Only v2 HvH rooms with rounds send a round on join.
    this.hvhBuy = this.mode.id === 'hvh' && join.round ? new HvhBuyMenu(ctx.hud.root) : null;
    if (this.hvhBuy) {
      this.hvhBuy.onPick = (id) => this.hvhPick(id);
      this.hvhBuy.onClose = () => this.setHvhBuyOpen(false);
      this.sendHvhPicks();
    }
    this.trainingMenu = this.mode.training ? new TrainingMenu(ctx.hud.root) : null;
    if (this.trainingMenu) {
      this.trainingMenu.onClose = () => this.toggleTrainingMenu(false);
      this.trainingMenu.onPick = (id) => this.trainingPick(id);
      // Free and unlimited, like the guns: picking one puts it in your hand.
      this.trainingMenu.onGrenade = (grenade) => this.trainingRequest({ grenade }, 'In hand · unlimited', () => this.takeOutGrenade(grenade));
    }
    this.zombieHud = this.mode.zombies ? new ZombieHud(ctx.hud.root) : null;
    if (this.zombieHud) this.zombieHud.huntOnly = this.mode.huntOnly !== undefined;
    if (this.zombieHud) {
      ctx.input.zombieMode = true;
      this.zombieHud.onBuy = (item) => this.zombieBuy(item.id);
      this.zombieHud.onShopClose = () => this.closeZombieShop();
      this.zombieHud.onRestart = () => {
        ctx.net.socket.emit('zombieRestart');
        void ctx.input.requestLock();
        ctx.onOverlay();
      };
      if (join.zombie) {
        this.zombieHud.setState(join.zombie.state);
        this.zombieHud.setGear(join.zombie.gear);
      }
      ctx.hud.toast(`🧟 Survive! B opens the shop between waves, C builds a wall that lasts 10 seconds. Ctrl crouches. ${keyLabel(getKeybinds().flashlight)} switches your flashlight.`, 'info');
      // A darker HUD for the night, the flashlight and the sounds of the dark.
      ctx.hud.root.classList.add('hud-zombie');
      this.night = new ZombieNight(ctx.scene, ctx.camera, ctx.audio, ctx.setBloodMoon, ctx.world.map.zones ?? [], ctx.setZoneLook);
      this.hunt = new HuntView(ctx.scene, ctx.hud.root, ctx.audio, this.effects, ctx.world.map, (a) => this.rig.addShake(a));
      if (join.zombie?.hunt) this.hunt.setState(join.zombie.hunt);
      if (join.zombie) this.night.setBloodMoon(join.zombie.state.bloodMoon);
    }
    ctx.input.yaw = me.yaw;
    ctx.input.pitch = -0.15;

    for (const info of join.players) if (info.pid !== this.selfPid) this.remotes.add(info, this.isFriendly(info));
    this.onSnapshot(join.snapshot);
    for (const p of join.projectiles) this.projectiles.spawn(p, this.selfPid, 0);
    for (const s of join.smokes) this.onSmoke(s);

    ctx.hud.setRoom(join.room);
    // Only v2 HvH rooms with rounds send a round on join.
    if (this.mode.id === 'hvh' && join.round) ctx.hud.setRoundsRule(HVH_ROUNDS);
    ctx.hud.setVisible(true);
    if (this.mode.wallhack) ctx.hud.toast('HvH: everyone sees enemies through walls', 'bad');
    if (this.mode.bomb) ctx.hud.toast(this.self.team === 1 ? 'You are chikenT: plant the bomb on A or B' : 'You are chikenCT: stop the bomb, defuse it with E', 'info');
    this.refreshScores();
    this.bindNetwork();
    this.bindChat();
    ctx.dev?.attach(this);
  }

  get camera(): THREE.PerspectiveCamera {
    return this.ctx.camera;
  }
  get firstPerson(): boolean { return this.rig.firstPerson; }

  get map() {
    return this.ctx.world.map;
  }

  get playerCount(): number {
    return this.infos.size;
  }

  get self(): PlayerInfo {
    return this.infos.get(this.selfPid)!;
  }

  serverNow(): number {
    return performance.now() + this.clockOffset;
  }

  isFriendly(info: PlayerInfo): boolean {
    return this.mode.teams && info.team !== 0 && info.team === this.self?.team;
  }

  // ---------------------------------------------------------------------------
  // Frame
  // ---------------------------------------------------------------------------

  update(dt: number, fps: number): void {
    const { input, net, audio, hud } = this.ctx;
    const now = performance.now();

    for (const action of input.consumeActions()) this.handleAction(action, now);
    const dev = this.ctx.dev;
    dev?.beforeFrame(this, dt, now);

    // Fixed-timestep simulation: the same tick size the server uses, independent of frame rate.
    this.accumulator += dt;
    while (this.accumulator >= SIM_DT) {
      this.accumulator -= SIM_DT;
      if (!this.local.alive) { this.commandClock.reset(); continue; }
      // v2 clock correction: the server is holding a backlog of our commands; send this tick's later.
      // Never delay a command that carries a shot.
      if (this.local.hvhV2 && this.shotCommand !== this.nextSeq && this.commandClock.skip(this.nextSeq)) continue;
      let frame = input.sample(this.nextSeq++);
      if (dev) frame = dev.modifyFrame(this, frame);
      if (this.mode.id !== 'hvh') frame = { ...frame, autoHop: false, subtickStrafe: false };
      // With the bomb out, holding fire plants it (the same as holding E).
      if (this.bombOut && input.firing) frame = { ...frame, use: true };
      if (this.bombHolds(frame)) frame = { ...frame, forward: 0, right: 0, jump: false, crouch: true };
      // Melee and projectile weapons never fire a hitscan shot (the server rejects them as 'wrong weapon').
      const def = this.weapons.def;
      const hitscan = !def.melee && !def.projectile;
      const exploit = exploitMode(this.weapons.hvh.exploit, def, this.weapons.mag);
      // v2: the tickbase action decides the movement (the charging stop, the burst), with the enemy
      // sight from the eye before this command's step. The choke bit is decided after the step.
      let sight = NO_SIGHT;
      const plan = this.mode.id === 'hvh' && this.local.hvhV2
        ? { intent: commandIntent({ seq: frame.seq, shotSeq: this.shotCommand, hitscan, held: false, exploit }), ctx: sight }
        : undefined;
      // R62: in freeze (buy time) the server charges regardless of sight.
      if (plan && !this.buyTime && this.local.tickbase.needsSight(frame.seq, plan.intent)) plan.ctx = sight = { enemyVisible: this.enemyInSight() };
      this.local.predict(frame, this.collision, hopMaxFor(this.weapons.weapon), moveSpeedFor(this.weapons.weapon), plan);
      if (this.mode.id === 'hvh') {
        const core = this.weapons.hvh.core ?? defaultHvhCore();
        const key = `${core.latencyMs}/${core.jitterMs}/${core.packetLoss}`;
        if (key !== this.networkKey) { this.networkKey = key; this.commandNetwork = new NetworkSimulator({ latencyMs: core.latencyMs, jitterMs: core.jitterMs, loss: core.packetLoss }, this.selfPid); }
        const speed = this.horizontalSpeed();
        const shooting = input.firing || dev?.wantsFire(now) === true;
        // v2 rooms allow the era's choke limit (LATE_CSGO.maxChoke); legacy rooms keep the 12 cap.
        const maxChoke = this.local.hvhV2 ? LATE_CSGO.maxChoke : undefined;
        const choke = fakeLagTicks(core,frame.seq,speed,shooting,maxChoke);
        // Flush rule is unchanged from before v2: a shot flushes only via fakeLagBreakOnShot.
        const flush = !input.active || (core.fakeLagBreakOnShot && shooting);
        const intent = commandIntent({
          seq: frame.seq, shotSeq: this.shotCommand, hitscan,
          held: this.commandChoker.wouldHold(choke, flush, maxChoke), exploit, trigger: shooting,
        });
        if (this.local.hvhV2) this.weapons.commandBuilt(frame.seq, intent.trigger === true);
        const cmd = this.local.command(frame, intent, this.tickClock.viewedTick(this.serverNow() - INTERP_DELAY_MS), sight);
        // R56: the server traces this command's sight against the snapshot we predicted it from.
        if (this.sightView) cmd.sightT = this.sightView.t;
        const batch = this.commandChoker.push(cmd, choke, flush, maxChoke);
        if (batch.length) this.commandNetwork!.send(batch, now);
      } else net.socket.emit('input', frame);
    }
    if (this.mode.id === 'hvh') for (const batch of this.commandNetwork?.receive(now) ?? []) for (const frame of batch) net.socket.emit('input', this.local.emitted(frame));

    const state = this.local.state;
    if (this.local.alive) {
      if (this.wasOnGround && !state.onGround && state.vy > 1) audio.play('jump', undefined, 0.6);
      if (state.jetting && now - this.lastJetFx > 90) {
        this.lastJetFx = now;
        audio.play('jet', undefined, 0.5);
      }
    }
    this.wasOnGround = state.onGround;
    if (state.jetting) for (const side of [-0.1, 0.1]) this.effects.exhaust(this.jetNozzle(this.local.position, this.ctx.input.yaw, side));

    // Render everything.
    const renderTime = this.serverNow() - INTERP_DELAY_MS;
    this.vehicles.render(renderTime, dt, this.local.car ? { id: this.local.vehicleId, car: this.local.car, input: this.local.alive ? input.sample(0) : null } : null);
    // In the seat the chicken turns to face where you aim (that's where its gun points).
    const carSeat = this.local.car ? this.vehicles.seatOf(this.local.vehicleId, new THREE.Vector3()) : null;
    const seat = carSeat ? { position: carSeat.position, yaw: input.yaw } : null;
    this.updateEngine();
    const body = dev?.bodyAngles() ?? null;
    this.local.render(this.accumulator / SIM_DT, dt, body?.yaw ?? input.yaw, body?.pitch ?? input.pitch, seat);
    this.remotes.render(renderTime, dt);
    this.night?.update(dt, this.remotes);
    if (this.hunt?.active) {
      const players = [...this.remotes.players.values()];
      const mates = players.filter((r) => !r.info.undead && r.alive).map((r) => r.position);
      const now = this.serverNow();
      // A red crystal: every monkey through walls (and on the phone).
      const reveal = this.hunt.revealing(now);
      const monkeys = players.filter((r) => r.info.undead === 'monkey' && r.alive);
      for (const m of monkeys) m.chicken.setMonkeyXray(reveal);
      this.ctx.world.blackout = this.hunt.update(dt, this.local.position, this.ctx.input.yaw, mates, monkeys.map((m) => m.position), now);
    } else if (this.hunt) {
      this.hunt.update(dt, this.local.position, 0, [], [], 0);
      this.ctx.world.blackout = false;
      if (this.local.eventSpeed !== 1) this.local.eventSpeed = 1;
    }
    for (const r of this.remotes.players.values()) {
      const v = r.latest?.vehicle;
      const remoteSeat = v ? this.vehicles.seatOf(v, new THREE.Vector3()) : null;
      if (remoteSeat && r.alive) r.sitAt(remoteSeat.position, r.yaw);
    }
    this.flags?.update(dt, (pid) => this.drawnAt(pid));
    this.updateBombView();
    this.updateBombMarkers();
    for (const r of this.remotes.players.values()) {
      if (r.latest?.jetting && r.alive) this.effects.exhaust(this.jetNozzle(r.position, r.yaw, Math.random() > 0.5 ? 0.1 : -0.1));
    }
    this.updateXray();
    this.projectiles.update(dt);
    this.casings.update(dt);
    this.loot.update(dt);
    this.effects.update(dt);

    const def = this.weapons.def;
    const canAim = input.active && this.local.alive && !this.local.car && !this.building && !this.weapons.reloading && !this.heldGrenade && !this.grenadeThrowHeld;
    // Snipers (Sniper, Scout): the scope button is a click, not a hold (see stepScope).
    if (def.scope) this.stepScope(canAim && this.scopeWeapon === def.id, input.aiming && !this.aimWasDown);
    else this.scopeLevel = 0;
    this.scopeWeapon = def.id;
    const aiming = def.scope ? this.scopeLevel > 0 : input.aiming && canAim;
    const scoped = aiming && def.scope;
    const zoom = !aiming ? 1 : this.scopeLevel === 2 && def.zoom2 ? def.zoom2 : def.zoom;
    input.zoomScale = zoom > 1 ? zoomLookScale(zoom) * getSettings().zoomSensitivity : 1;
    if (dev?.controlCamera(this, dt)) {
      this.local.chicken.setBodyVisible(true);
      this.updateViewmodel(dt, false);
    } else if (this.local.alive) {
      const noRecoil=nativeValue(this.hvhVisuals,'Visuals.Effects.visualRecoilAdjustment')===2;
      this.rig.follow(seat?.position ?? this.local.position, input.yaw-(noRecoil?this.visualKick.yaw:0), input.pitch-(noRecoil?this.visualKick.pitch:0), zoom, dt, scoped, this.local.car !== null, this.local.eyeScale);
      this.local.chicken.setBodyVisible(!(this.rig.firstPerson || (scoped && !this.rig.hvhThirdPerson)));
      this.updateViewmodel(dt, this.rig.firstPerson && !scoped, aiming);
    } else if (this.spectateTeammate(dt)) {
      this.updateViewmodel(dt, false);
    } else if (this.deathPos) {
      this.updateViewmodel(dt, false);
      this.rig.orbit(this.deathPos, dt);
      this.local.chicken.setBodyVisible(true);
    } else {
      // (At night the camera can't see far: circle the middle of the map, close in.)
      this.rig.overview(dt, this.ctx.world.map.mesh ? 70 : this.ctx.world.map.id === 'night' ? 22 : this.ctx.world.map.halfSize);
    }
    const cam = this.ctx.camera;
    audio.setListener(cam.position.x, cam.position.y, cam.position.z, input.yaw);
    this.visualKick.yaw*=Math.exp(-dt*8);this.visualKick.pitch*=Math.exp(-dt*8);

    // Weapons.
    this.weapons.update(now, this.mode.id === 'hvh'
      && fakeLagTicks(this.weapons.hvh.core ?? defaultHvhCore(), this.nextSeq - 1, this.horizontalSpeed(), false, this.local.hvhV2 ? LATE_CSGO.maxChoke : undefined) > 0);
    // In a buggy you can shoot (and throw) but not swing a melee weapon.
    if (!input.firing && !input.aiming) this.grenadeThrowHeld = false;
    // Tell the server what's in hand (it checks we have it); planting needs the bomb out on a site.
    const held = this.bombOut ? 'bomb' : this.heldGrenade ?? 'gun';
    if (held !== this.heldSent && this.local.alive) {
      this.heldSent = held;
      net.socket.emit('hold', held);
    }
    if (this.bombOut && input.active && input.firing && !this.fireWasDown && !this.onBombSite() && now >= this.plantHintAt) {
      this.plantHintAt = now + 1500;
      hud.toast('You must be in a bomb site to plant', 'bad');
    }
    this.stepGrenade(input.active && input.firing, input.active && input.aiming, input.active);
    if (this.bombOut && !this.carryingBomb()) this.bombOut = false;
    const canShoot = input.active && this.local.alive && !(this.local.car && this.weapons.def.melee) && !this.building && !this.buyTime && !this.heldGrenade && !this.bombOut && !this.grenadeThrowHeld && !dev?.blocksShooting();
    if (aiming !== this.aimingSent) {
      this.aimingSent = aiming;
      net.socket.emit('aim', aiming);
    }
    if (canShoot && this.match.phase !== 'ended') {
      const assisted = dev?.wantsFire(now) ?? false;
      const result = this.weapons.trigger(input.firing || assisted, now, assisted);
      if (result === 'fire') this.fire(aiming, assisted);
      else if (result === 'empty') {
        audio.play(emptySoundFor(this.weapons.weapon));
        this.startReload(now);
      }
      if (this.weapons.mag === 0 && !this.weapons.reloading) this.startReload(now);
    } else this.weapons.suspend();

    if (this.building) this.updateBuilding(input.firing, input.aiming);
    this.fireWasDown = input.firing;
    this.aimWasDown = input.aiming;

    // HUD.
    hud.update();
    this.hudTimer += dt;
    if (this.hudTimer >= HUD_INTERVAL) {
      this.hudTimer = 0;
      this.updateHud(now, fps, aiming, scoped);
    }
    this.buyMenu?.update(dt);
    this.updateHvhBuy();
    this.blocks?.tick(now);
    dev?.afterFrame(this, dt);
  }

  /** The buy menu is open (it has the mouse). The HvH menu auto-opened at freeze leaves look and keys to the game. */
  get buyMenuOpen(): boolean {
    return (this.buyMenu?.open ?? false) || (this.hvhBuyReleased && (this.hvhBuy?.open ?? false)) || (this.zombieHud?.shopOpen ?? false) || this.zombieOver || (this.trainingMenu?.open ?? false);
  }
  setWeaponTint(color: string | null, style = 0, alpha = 1): void { this.viewmodel.setTint(color,style,alpha); }

  setSkeetVisuals(values: NativeValues | null): void {
    const v=this.mode.id==='hvh'?values:null;if(v===this.hvhVisuals)return;this.hvhVisuals=v;
    this.rig.hvhThirdPerson=nativeOn(v,'Visuals.Effects.forceThirdPerson');
    this.rig.hvhFov=nativeValue(v,'Misc.overrideFov');
    this.rig.hvhNoShake=nativeValue(v,'Visuals.Effects.visualRecoilAdjustment')>0;
    this.viewmodel.suppressRecoil=nativeValue(v,'Visuals.Effects.visualRecoilAdjustment')===2;
    this.effects.hideSmoke=nativeOn(v,'Visuals.Effects.removeSmokeGrenades');
    this.effects.showImpacts=!v||nativeOn(v,'Visuals.Effects.bulletImpacts');
    this.ctx.hud.showScope=!nativeOn(v,'Visuals.Effects.removeScopeOverlay');
    this.ctx.hud.showFlash=!nativeOn(v,'Visuals.Effects.removeFlashbangEffects');
    this.ctx.hud.persistentKillfeed=nativeOn(v,'Misc.persistentKillfeed');
    const brightness=nativeOn(v,'Visuals.Effects.brightnessAdjustment_1')?2:nativeOn(v,'Visuals.Effects.brightnessAdjustment_0')?1:0;
    this.ctx.world.setHvhEffects(nativeOn(v,'Visuals.Effects.removeFog'),nativeOn(v,'Visuals.Effects.removeGrass'),nativeValue(v,'Visuals.Effects.transparentWalls'),nativeValue(v,'Visuals.Effects.transparentProps'),brightness);
    const sky=this.ctx.scene.getObjectByName('sky');if(sky)sky.visible=!nativeOn(v,'Visuals.Effects.removeSkybox');
  }
  inspectWeapon(): void { this.viewmodel.inspect(); }

  /** Silhouettes through walls: the developer wallhack wins, otherwise HvH shows enemies. */
  private updateXray(): void {
    const dev = this.ctx.dev;
    for (const r of this.remotes.players.values()) {
      const hvh = this.mode.wallhack && r.alive && !this.isFriendly(r.info) ? HVH_XRAY : null;
      r.chicken.setXray(dev?.xrayFor(this, r) ?? hvh);
    }
  }

  private updateViewmodel(dt: number, visible: boolean, aiming = false): void {
    const w = this.weapons;
    const now = performance.now();
    this.viewmodel.update({
      dt,
      camera: this.ctx.camera,
      weapon: w.weapon,
      grenade: this.heldGrenade,
      grenadePin: this.pinPulled,
      bomb: this.bombOut,
      visible,
      aiming,
      speed: this.local.alive ? Math.hypot(this.local.position.x - this.lastViewPos.x, this.local.position.z - this.lastViewPos.z) / Math.max(dt, 1e-3) : 0,
      onGround: this.local.onGround,
      reload: w.reloading ? w.reloadProgress(now) : null,
      yaw: this.ctx.input.yaw,
      pitch: this.ctx.input.pitch,
    });
    this.lastViewPos.copy(this.local.position);
  }


  private updateHud(now: number, fps: number, aiming: boolean, scoped: boolean): void {
    const { hud, input, net } = this.ctx;
    const server = this.local.server;
    if (this.heldGrenade && grenadeCount(this.heldGrenade, server) <= 0) this.heldGrenade = null;
    const w = this.weapons;
    hud.setStats(net.ping, fps, this.infos.size);
    hud.setPersonalScore(this.self.kills, this.self.deaths);
    hud.setVitals(this.local.alive ? server.hp : 0, server.armor, this.local.state.fuel, this.maxHealth);
    hud.setNitro(this.local.alive && this.local.car ? this.local.car.boost : null);
    hud.setWeapon(w.weapon, w.mag, w.reloading, w.reloadProgress(now), w.loadout, w.slot, this.heldGrenade, server, this.carryingBomb() ? (this.bombOut ? 'out' : 'carried') : null);
    hud.setGrenades(server.eggs, server.smokes, server.flashes ?? 0);
    hud.setHop(this.local.alive && !this.local.car ? this.local.state.hop : 0, hopMaxFor(w.weapon));
    const spread = spreadFor(w.def, this.horizontalSpeed(), !this.local.onGround, aiming) * (w.mods?.spread ?? 1);
    const pixels = (spread / ((this.ctx.camera.fov * Math.PI) / 360)) * (window.innerHeight / 2);
    hud.setCrosshair(this.local.alive && input.active, pixels, scoped);
    hud.setMatch(this.match, this.serverNow(), this.infos.size);
    const players = [...this.infos.values()].filter((info) => !info.undead).map((info) => ({ info, alive: info.pid === this.selfPid ? this.local.alive : this.remotes.get(info.pid)?.latest?.alive ?? false }));
    hud.setRoster(players, this.selfPid);
    hud.radar.update(this.local.position, input.yaw, players.flatMap(({info,alive}) => {
      const p = this.remotes.get(info.pid);
      return info.pid !== this.selfPid && this.isFriendly(info) && alive && p && !p.culled ? [p.position] : [];
    }));
    if (this.round && this.match.phase === 'playing') this.updateRoundHud();
    if (this.mode.armsRace) {
      const level = this.self.level ?? 0;
      const next = ARMS_LADDER[level + 1];
      hud.setArmsLevel(level, ARMS_LADDER.length, WEAPONS[ARMS_LADDER[level]!].name, next ? WEAPONS[next].name : null);
    }
    else hud.setBombProgress(null, 0);
    hud.setMoney(this.round || this.mode.zombies ? this.money : null);
    this.updateZombieHud();
    if (!this.local.alive && this.mode.zombies && this.match.phase === 'playing') hud.setDeathWaiting(this.mode.huntOnly ? 'Down. Your team can still get out' : 'You’re back when the next wave starts');
    else if (!this.local.alive && this.round && this.match.phase === 'playing' && this.round.phase !== 'warmup') hud.setDeathWaiting('You’re back when the next round starts');
    else if (!this.local.alive) hud.setDeathTimer(this.respawnAt - now);
    hud.setHint(this.hintText());
    hud.setScoreboardVisible(input.scoreboardHeld && this.match.phase !== 'ended');
    if (input.scoreboardHeld) hud.renderScoreboard(this.scoreLines(), this.teamScores, net.ping);
    if (this.match.phase === 'ended' && this.match.endsAt !== null) hud.setResultsCountdown(this.match.endsAt - this.serverNow());
    if (this.local.hvhV2) this.hitLog?.update();
  }

  /** How fast you are going, for weapon spread (a moving buggy shakes your aim like walking). */
  horizontalSpeed(): number {
    if (this.local.car) return carAimSpeed(Math.hypot(this.local.car.speed, this.local.car.slip));
    return this.local.state.horizontalSpeed;
  }

  /** Your engine growls with your speed while you drive. */
  private updateEngine(): void {
    const car = this.local.alive ? this.local.car : null;
    if (!car) return this.ctx.audio.setEngine(null);
    const f = this.ctx.input.sample(0);
    this.ctx.audio.setEngine(Math.abs(car.speed) / BUGGY.maxSpeed, f.boost === true && f.forward > 0 && car.boost > 0.02);
  }

  private jetNozzle(pos: THREE.Vector3, yaw: number, side: number): Vec3 {
    const bx = Math.sin(yaw) * 0.42;
    const bz = Math.cos(yaw) * 0.42;
    return { x: pos.x + bx + Math.cos(yaw) * side, y: pos.y + 0.6, z: pos.z + bz - Math.sin(yaw) * side };
  }

  // ---------------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------------

  private handleAction(action: Action, now: number): void {
    const { net } = this.ctx;
    // With a pin pulled the grenade stays in hand until it's thrown.
    if (this.pinPulled && (action.startsWith('slot') || action === 'nextWeapon' || action === 'prevWeapon' || action === 'egg' || action === 'smoke' || action === 'flash')) return;
    switch (action) {
      case 'reload':
        if (!this.heldGrenade) this.startReload(now);
        break;
      case 'flashlight':
        this.night?.toggleFlashlight();
        break;
      case 'phone':
        this.hunt?.togglePhone();
        break;
      case 'phoneZoomIn':
        this.hunt?.zoom(1);
        break;
      case 'phoneZoomOut':
        this.hunt?.zoom(-1);
        break;
      case 'slot1':
      case 'slot2':
      case 'slot3':
      case 'slot4':
      case 'slot5':
      case 'slot6':
      case 'slot7':
      case 'slot8':
      case 'slot9': {
        // Counter-Strike's slots: 1 primary, 2 pistol, 3 knife, 4 grenades (again: the next kind), 5 the bomb.
        const n = Number(action.slice(4));
        if (this.buyMenu?.open) break;
        if (n === 5) {
          if (this.carryingBomb()) this.selectItem({ kind: 'bomb' }, now);
          break;
        }
        if (n === 4) {
          const next = nextGrenade(this.heldGrenade, this.local.server);
          if (next) this.selectItem({ kind: 'grenade', grenade: next }, now);
          break;
        }
        const index = n <= 3 ? weaponIndexForKey(this.weapons.loadout, n) : -1;
        if (index >= 0) this.selectItem({ kind: 'weapon', index }, now);
        break;
      }
      case 'nextWeapon':
      case 'prevWeapon': {
        // The scroll wheel: through everything you have, in slot order, round and round. Not
        // while a menu or chat has the mouse, or scoped in with a sniper.
        if (this.buyMenuOpen || this.chatOpen || this.scopeLevel > 0) break;
        const dir = (action === 'nextWeapon') !== getSettings().invertScroll ? 1 : -1;
        const next = stepSlot(slotItems(this.weapons.loadout, this.local.server, this.carryingBomb()), this.currentItem(), dir);
        if (next) this.selectItem(next, now);
        break;
      }
      case 'egg':
        // G with the bomb in hand drops it for a teammate (as in Counter-Strike); otherwise it's the egg.
        if (this.bombOut) {
          net.socket.emit('dropBomb');
          this.bombOut = false;
          this.ctx.hud.toast('Bomb dropped');
          break;
        }
        this.takeOutGrenade(action);
        break;
      case 'smoke':
      case 'flash':
        this.takeOutGrenade(action);
        break;
      case 'camera':
        this.ctx.hud.toast(this.rig.toggle() === 'first' ? (this.local.car ? 'First-person view (V) once you get out' : 'First-person view (V)') : 'Third-person view (V)');
        break;
      case 'chat':
        this.openChat(false);
        break;
      case 'teamChat':
        this.openChat(true);
        break;
      case 'team':
        this.requestTeamSwitch();
        break;
      case 'use':
        net.socket.emit('useVehicle');
        break;
      case 'zombieBuild':
        if (this.zombieHud && this.local.alive && !this.zombieOver) {
          net.socket.emit('zombieBuild');
          this.ctx.audio.play('click');
        }
        break;
      case 'build':
        if (this.trainingMenu) {
          this.toggleTrainingMenu(!this.trainingMenu.open);
          break;
        }
        if (this.zombieHud) {
          this.toggleZombieShop();
          break;
        }
        if (this.buyMenu) {
          this.toggleBuyMenu();
          break;
        }
        if (this.hvhBuy) {
          this.toggleHvhBuy();
          break;
        }
        if (this.mode.building && this.local.alive) {
          this.building = !this.building;
          if (!this.building) this.blocks?.showGhost(null, false);
          this.ctx.audio.play('switch');
        }
        break;
      case 'inspect':
        if (this.local.alive && !this.weapons.reloading) {
          this.viewmodel.inspect();
          this.local.chicken.inspect();
        }
        break;
      case 'nextBlock':
        if (this.building) {
          this.blockIndex = (this.blockIndex + 1) % BLOCK_KINDS.length;
          this.ctx.audio.play('click');
        }
        break;
    }
  }

  /** M: ask the server for the other team. It checks the rules (and may say no); we only explain. */
  private requestTeamSwitch(): void {
    const { hud, net } = this.ctx;
    const blocked = teamSwitchBlocked(this.mode);
    if (blocked) {
      hud.toast(blocked, 'bad');
      return;
    }
    net.socket
      .timeout(5000)
      .emitWithAck('switchTeam')
      .then((res) => { if (!res.ok) hud.toast(res.error ?? 'Could not switch team.', 'bad'); })
      .catch(() => hud.toast('Could not switch team.', 'bad'));
  }

  private switchWeapon(change: () => boolean): void {
    if (!this.local.alive || !change()) return;
    this.ctx.net.socket.emit('switchWeapon', this.weapons.slot);
    this.ctx.audio.play('equip');
  }

  private startReload(now: number): void {
    if (!this.local.alive || !this.weapons.reload(now)) return;
    this.ctx.net.socket.emit('reload');
    this.ctx.audio.play(reloadSoundFor(this.weapons.weapon));
  }

  // ---------------------------------------------------------------------------
  // Shooting
  // ---------------------------------------------------------------------------

  /** Where the crosshair points: first thing the camera ray hits (beyond the player). */
  /** Actual camera-to-eye shot direction, including third-person parallax. */
  aimDirection(eye: Vec3): Vec3 {
    const cam = this.ctx.camera;
    cam.getWorldDirection(this.camDir);
    const dir = { x: this.camDir.x, y: this.camDir.y, z: this.camDir.z };
    // Skip whatever is between a third-person camera and the chicken.
    const skip = Math.max(0, (eye.x - cam.position.x) * dir.x + (eye.y - cam.position.y) * dir.y + (eye.z - cam.position.z) * dir.z);
    const origin = { x: cam.position.x + dir.x * skip, y: cam.position.y + dir.y * skip, z: cam.position.z + dir.z * skip };
    const ray = makeRay(origin, dir);
    // Follow the same valid soft-cover path as the bullet, including in third person.
    const penetrate = this.mode.wallbang === true && !this.weapons.def.projectile && !this.weapons.def.melee;
    let t = this.raycastScene(ray, AIM_RANGE, penetrate).t;
    if (t < 1.5) t = 1.5;
    const target = pointOnRay(ray, t);
    return normalize({ x: target.x - eye.x, y: target.y - eye.y, z: target.z - eye.z });
  }

  /**
   * Nearest hit among the level, visible enemy chickens and loot boxes. With `penetrate` (bullets),
   * crates/hay/wood don't stop the ray; the boxes passed through come back in `soft`.
   */
  raycastScene(ray: ReturnType<typeof makeRay>, range: number, penetrate = false): { t: number; pid: number; headshot: boolean; world: boolean; normal: Vec3; soft: RayHit[] } {
    const pen = raycastPenetrating(ray, this.collision, range, this.isSoft, penetrate ? this.wallbangBoxes : 0);
    const wall = pen.wall;
    const soft = pen.soft;
    const normal = wall ? { x: wall.nx, y: wall.ny, z: wall.nz } : { x: 0, y: 1, z: 0 };
    let best = { t: wall ? wall.t : range, pid: 0, headshot: false, world: !!wall, normal, soft };
    for (const [pid, r] of this.remotes.players) {
      // Drivers count too: they sit in their seat (see sitAt), head above the car.
      if (!r.alive || r.culled || r.latest?.alive === false || this.isFriendly(r.info)) continue;
      const hit = (this.mode.id === 'hvh' ? rayHvhChicken : rayChicken)(ray, r.position.x, r.position.y, r.position.z, r.yaw, best.t, r.scale, r.pitch);
      if (hit) best = { t: hit.t, pid, headshot: hit.headshot, world: false, normal, soft };
    }
    const box = this.loot.raycast(ray, best.t);
    if (box >= 0) best = { t: box, pid: 0, headshot: false, world: false, normal, soft };
    // Your own buggy never gets in the way of your aim (the server skips it too).
    const car = this.vehicles.raycast(ray, best.t, this.local.car ? this.local.vehicleId : 0);
    if (car >= 0) best = { t:car, pid:0, headshot:false, world:false, normal, soft };
    return best;
  }

  eye(): Vec3 {
    // Driving: your eyes are in the seat (where the server shoots from too).
    if (this.local.car) {
      const seat = seatPosition(this.local.car);
      return { x: seat.x, y: seat.y + PLAYER.eyeHeight, z: seat.z };
    }
    const s = this.local.state;
    return { x: s.x, y: s.y + eyeHeightOf(s), z: s.z };
  }

  /**
   * v2 tickbase sight, as the server's (HvhRoom.enemyInSight, R56): a living enemy in actual line
   * of sight from our eye, among the enemies of the latest snapshot. The command names that
   * snapshot (`sightT`) and the server traces the same list, so the two agree.
   */
  private enemyInSight(): boolean {
    return enemyVisible(this.eye(), this.sightView?.enemies ?? [], this.collision);
  }

  /** v2: the next command carries this shot (intent.fire). Legacy HvH and non-hitscan weapons keep the acked seq. */
  private markShot(w: WeaponDef): number {
    const ref = shotReference(this.local.hvhV2 && !w.melee && !w.projectile, this.nextSeq, this.local.server.ack);
    this.shotCommand = ref.shotSeq;
    if (ref.shotSeq !== null) this.local.tickbase.shot(ref.shotSeq);
    return ref.command;
  }

  private fire(aiming: boolean, assisted = false): void {
    const { net, audio, input } = this.ctx;
    const w = this.weapons.def;
    const eye = this.eye();
    const silentAim = this.ctx.dev?.aimOverride(this, eye) ?? null;
    assisted ||= this.mode.id === 'hvh' && silentAim !== null;
    this.ctx.dev?.onShot?.(this, assisted);
    const aim = silentAim ?? this.aimDirection(eye);
    net.socket.emit('fire', {
      shot: this.weapons.shotSeq,
      weapon: w.id,
      dx: aim.x,
      dy: aim.y,
      dz: aim.z,
      t: (assisted ? this.ctx.dev?.shotIntent?.()?.recordT : undefined) ?? this.serverNow() - INTERP_DELAY_MS,
      // Weapon requests execute from authoritative movement already acknowledged by the server.
      // Referencing a future choked command kept every shot waiting until its target record expired.
      command: this.mode.id === 'hvh' ? this.markShot(w) : this.nextSeq - 1,
      intent: assisted ? this.ctx.dev?.shotIntent?.() : undefined,
      aiming,
    });
    if (w.melee) {
      this.swing(eye, aim);
      return;
    }

    this.local.chicken.kick();
    this.viewmodel.fire();
    const recoil = w.recoil * (this.ctx.dev?.recoilScale() ?? 1) * this.weapons.lastShotBurst;
    const beforeYaw=input.yaw,beforePitch=input.pitch;
    input.kick(recoil * (aiming ? 0.6 : 1), (Math.random() - 0.5) * recoil * 0.4);
    this.visualKick.yaw+=input.yaw-beforeYaw;this.visualKick.pitch+=input.pitch-beforePitch;
    const muzzle = this.viewmodel.muzzleWorld(this.tmp) ?? this.local.chicken.muzzleWorldPosition(this.tmp);
    const muzzlePos = { x: muzzle.x, y: muzzle.y, z: muzzle.z };
    this.effects.muzzleFlash(muzzlePos, w.pellets > 1 || w.id === 'sniper');
    audio.play(w.sound);
    if (w.projectile) return;
    // Third person: the case comes out of the chicken's gun (in first person the view model throws it).
    if (!this.viewmodel.visible) this.thirdPersonCase(w.id, muzzlePos, aim, input.yaw, this.local.state);

    // Draw our own tracers immediately, with the same pellet pattern the server will use.
    const spread = (this.mode.id === 'hvh' ? hvhSpread(w, this.horizontalSpeed(), !this.local.onGround, aiming, Math.max(0, this.weapons.heat - this.weapons.lastShotBurst * 0.25))
      : spreadFor(w, this.horizontalSpeed(), !this.local.onGround, aiming)) * (this.weapons.mods?.spread ?? 1);
    const directions = pelletDirections(w, aim, spread, shotSeed(this.selfPid, this.weapons.shotSeq));
    if (this.mode.id === 'hvh' && this.weapons.lastShotBurst === 2) directions.push(...pelletDirections(w, aim, spread, shotSeed(this.selfPid, this.weapons.shotSeq) ^ 0x51ed270b));
    for (const d of directions) {
      const ray = makeRay(eye, d);
      const hit = this.raycastScene(ray, w.range, true);
      const end = pointOnRay(ray, hit.t);
      this.effects.tracer(muzzlePos, end);
      // Holes in the boxes the bullet went through on the way.
      for (const s of hit.soft) {
        if (s.t >= hit.t) break;
        const at = pointOnRay(ray, s.t);
        this.effects.impact(at, 0xc28a4e);
        this.effects.bulletHole(at, { x: s.nx, y: s.ny, z: s.nz });
      }
      if (hit.pid) this.effects.feathers(end, this.skinColor(hit.pid), 4);
      else if (hit.world) {
        this.effects.impact(end);
        this.effects.bulletHole(end, hit.normal);
      }
    }
  }

  /** Our own melee swing: animate and give instant feedback. The server decides the damage. */
  private swing(eye: Vec3, aim: Vec3): void {
    const { audio } = this.ctx;
    const w = this.weapons.def;
    this.local.chicken.swing();
    this.viewmodel.fire();
    // (A knife, pan or katana swing doesn't kick the camera.)
    audio.play(w.sound);
    const targets: MeleeTarget<number>[] = [];
    for (const [pid, r] of this.remotes.players) {
      if (!r.alive || this.isFriendly(r.info)) continue;
      targets.push({ key: pid, x: r.position.x, y: r.position.y, z: r.position.z, yaw: r.yaw, scale: r.scale, pitch:r.pitch });
    }
    const hit = meleeHit(eye, aim, w, targets, this.collision);
    if (!hit) return;
    this.effects.feathers(hit.point, this.skinColor(hit.key), 6);
    audio.play(w.id === 'pan' ? 'bonk' : 'meleeHit', hit.point);
  }

  /** ChikenBomb buy time (v2 HvH freeze time): the server refuses every shot and throw, so we don't pretend to fire either. */
  private get buyTime(): boolean {
    return (this.mode.bomb === true || this.mode.id === 'hvh') && this.round?.phase === 'buy';
  }

  /** What's in hand now, as a slot item. */
  private currentItem(): SlotItem {
    if (this.bombOut) return { kind: 'bomb' };
    if (this.heldGrenade) return { kind: 'grenade', grenade: this.heldGrenade };
    return { kind: 'weapon', index: this.weapons.slot };
  }

  /** Takes `item` in hand (a gun by its loadout slot, a grenade, or the bomb). */
  private selectItem(item: SlotItem, now: number): void {
    if (item.kind === 'grenade') return this.takeOutGrenade(item.grenade);
    this.heldGrenade = null;
    this.scopeLevel = 0;
    if (item.kind === 'bomb') {
      this.bombOut = true;
      this.weapons.suspend();
      this.ctx.audio.play('equip');
      return;
    }
    this.bombOut = false;
    if (item.index !== this.weapons.slot) this.switchWeapon(() => this.weapons.switchTo(item.index, now));
  }

  /** G, Q or the flashbang key: the grenade comes out; a mouse button then pulls the pin. */
  private takeOutGrenade(kind: HeldGrenade): void {
    const { audio, hud } = this.ctx;
    if (!this.local.alive || this.heldGrenade === kind) return;
    if (grenadeCount(kind, this.local.server) <= 0) {
      hud.toast(kind === 'egg' ? 'No eggs left' : kind === 'smoke' ? 'No smoke grenades left' : 'No flashbangs left', 'bad');
      audio.play('empty');
      return;
    }
    this.heldGrenade = kind;
    this.bombOut = false;
    this.scopeLevel = 0;
    this.weapons.suspend();
    audio.play('equip');
  }

  /**
   * Holding a grenade: left click (far), right click (a soft underhand toss) or both (medium)
   * pulls the pin; letting go of a button throws with what was held just before. The aiming
   * line shows meanwhile. Losing the mouse (a menu opening) puts the pin back instead.
   */
  private stepGrenade(left: boolean, right: boolean, active: boolean): void {
    const was = this.throwButtons;
    this.throwButtons = { left, right };
    const kind = this.heldGrenade;
    if (!kind || !this.local.alive || !active) {
      this.setPin(false);
      this.throwPreview.hide();
      return;
    }
    if (!this.pinPulled) {
      if ((left || right) && !was.left && !was.right && !this.grenadeThrowHeld) {
        if (this.buyTime) {
          this.ctx.hud.toast('Buy time: no throwing yet', 'bad');
          this.grenadeThrowHeld = true;
        } else this.setPin(true);
      }
    } else if ((was.left && !left) || (was.right && !right)) {
      const power: ThrowPower = was.left && was.right ? 0.5 : was.left ? 1 : 0;
      this.setPin(false, false);
      this.throwGrenade(kind, power);
      this.grenadeThrowHeld = true;
      if (grenadeCount(kind, this.local.server) <= 0) this.heldGrenade = null;
    }
    if (!this.pinPulled) {
      this.throwPreview.hide();
      return;
    }
    const aim = this.throwAim(kind, left && right ? 0.5 : left ? 1 : 0);
    const { path, end } = predictThrow(PROJECTILES[aim.projectile], aim.origin, aim.velocity, this.collision);
    this.throwPreview.show(path, end);
  }

  private setPin(on: boolean, tell = true): void {
    if (on === this.pinPulled) return;
    this.pinPulled = on;
    if (on) {
      this.ctx.net.socket.emit('pin', this.heldGrenade);
      this.ctx.audio.play('pin');
    } else if (tell) this.ctx.net.socket.emit('pin', null);
  }

  /** Where a throw leaves your hand and how fast, worked out exactly as the server does. */
  private throwAim(kind: HeldGrenade, power: ThrowPower): { projectile: ProjectileKind; dir: Vec3; origin: Vec3; velocity: Vec3 } {
    const projectile: ProjectileKind = kind === 'egg' ? 'he' : kind;
    const eye = this.eye();
    const dir = this.aimDirection(eye);
    eye.y -= throwDrop(power);
    const wall = raycastWorld(makeRay(eye, dir), this.collision, 0.6);
    const dist = wall ? Math.max(0, wall.t - 0.2) : 0.5;
    const origin = { x: eye.x + dir.x * dist, y: eye.y + dir.y * dist, z: eye.z + dir.z * dist };
    return { projectile, dir, origin, velocity: launchVelocity(PROJECTILES[projectile], dir, power, throwerVelocity(this.local.state)) };
  }

  private throwGrenade(kind: HeldGrenade, power: ThrowPower): void {
    const { net, audio } = this.ctx;
    if (!this.local.alive || this.buyTime) return;
    const count = grenadeCount(kind, this.local.server);
    if (count <= 0) return;
    const aim = this.throwAim(kind, power);
    this.throwSeq++;
    net.socket.emit('throw', { kind, seq: this.throwSeq, dx: aim.dir.x, dy: aim.dir.y, dz: aim.dir.z, power });
    this.projectiles.predict(aim.projectile, this.selfPid, this.throwSeq, aim.origin, aim.velocity);
    // Predict the count so a quick double tap doesn't show a stale number (Training's never run out).
    if (!this.mode.training) this.local.server = { ...this.local.server, [kind === 'egg' ? 'eggs' : kind === 'smoke' ? 'smokes' : 'flashes']: count - 1 };
    this.viewmodel.throwGrenade();
    this.local.chicken.swing();
    audio.play('throw');
  }

  /** A case out of a chicken's gun: a little behind the muzzle, thrown out to the right (after the pump or bolt is worked). */
  private thirdPersonCase(weapon: WeaponId, muzzle: Vec3, aim: Vec3, yaw: number, mover: { vx: number; vy: number; vz: number }): void {
    const kind = CASING_FOR[weapon];
    if (!kind) return;
    const back = weapon === 'sniper' || weapon === 'scout' || weapon === 'ssg08' || weapon === 'scar20' ? 0.45 : 0.28;
    const at = { x: muzzle.x - aim.x * back, y: muzzle.y - aim.y * back + 0.02, z: muzzle.z - aim.z * back };
    const speed = 2.2 + Math.random() * 0.9;
    const rx = Math.cos(yaw), rz = -Math.sin(yaw);
    this.casings.eject(kind, at, { x: rx * speed + mover.vx, y: 1.6 + Math.max(0, mover.vy), z: rz * speed + mover.vz }, ejectDelayMs(CYCLE_OF[weapon]));
  }

  private skinColor(pid: number): number {
    const info = this.infos.get(pid);
    return (info && getItem('skin', info.appearance.skin)?.color) ?? 0xffffff;
  }

  // ---------------------------------------------------------------------------
  // Vehicles, building, flags
  // ---------------------------------------------------------------------------

  /** Where a player is drawn right now (flags ride on carriers). */
  private drawnAt(pid: number): { position: THREE.Vector3; yaw: number } | null {
    if (pid === this.selfPid) return this.local.alive ? { position: this.local.chicken.root.position, yaw: this.local.chicken.root.rotation.y } : null;
    const r = this.remotes.get(pid);
    return r && r.alive ? { position: r.chicken.root.position, yaw: r.chicken.root.rotation.y } : null;
  }

  /**
   * A sniper's scope, like Counter-Strike: click the scope button once to look through it (it
   * stays when you let go), again to zoom in further, a third time to put it away. Switching
   * weapons, reloading, getting in a car or dying puts it away too.
   */
  private stepScope(allowed: boolean, clicked: boolean): void {
    if (!allowed) {
      this.scopeLevel = 0;
      return;
    }
    if (!clicked) return;
    const levels = this.weapons.def.zoom2 ? 2 : 1;
    this.scopeLevel = this.scopeLevel >= levels ? 0 : ((this.scopeLevel + 1) as 1 | 2);
    if (this.scopeLevel > 0) this.ctx.audio.play('sniperZoom');
  }

  private hintText(): string | null {
    if (this.bombOut && this.local.alive) return 'Hold left-click on A or B · Plant · G · Drop the bomb · Wheel · Switch';
    if (this.heldGrenade && this.local.alive) return 'Hold left-click · Throw far · Right-click · Toss · Both · Medium · 4 · Next grenade · Wheel · Switch';
    const def = this.weapons.def;
    if (def.scope && this.local.alive && this.scopeLevel > 0) {
      const zoom = this.scopeLevel === 2 && def.zoom2 ? def.zoom2 : def.zoom;
      const next = this.scopeLevel === 1 && def.zoom2 ? `zoom to ${def.zoom2}×` : 'put the scope away';
      return `Scope ${zoom}× · Right-click to ${next}`;
    }
    if (!this.local.alive) return this.round && this.match.phase === 'playing' && this.round.phase !== 'warmup' ? 'You’re back when the next round starts' : null;
    const bomb = this.bombHint();
    if (bomb) return bomb;
    if (this.local.car) return 'Driving · Shoot with the mouse · Space drift · Shift nitro · E to get out';
    if (this.trainingMenu) return this.trainingMenu.open ? null : 'B · Weapons · Esc · Back to lobby';
    if (this.zombieHud && this.zombieState?.phase === 'event') return `${keyLabel(getKeybinds().phone)} · Bigger phone map · ${keyLabel(getKeybinds().flashlight)} · Flashlight · find the purple crystals`;
    if (this.zombieHud) return this.zombieHud.shopOpen ? null : this.zombieState?.phase === 'prep' ? 'B · Shop (open now!) · C · Build a wall' : 'C · Build a wall (gone in 10 s) · Ctrl · Crouch';
    if (this.building) {
      const kind = BLOCK_KINDS[this.blockIndex]!;
      return `Build mode · ${kind[0]!.toUpperCase()}${kind.slice(1)} (X to change) · Click place · Right-click remove · B to exit`;
    }
    if (this.flags && this.flags.carrierOf(this.self.team === 1 ? 2 : 1) === this.selfPid) return '🚩 You have the enemy flag! Bring it to your base';
    const s = this.local.state;
    if (s.y < 1.5 && this.vehicles.nearestFree(s.x, s.z)) return 'E · Drive the buggy';
    if (this.mode.building) return 'B · Build mode';
    return null;
  }

  // ---------------------------------------------------------------------------
  // ChikenBomb
  // ---------------------------------------------------------------------------

  private onRound(r: RoundState): void {
    const prev = this.round;
    this.round = r;
    const { hud, audio } = this.ctx;
    const mine = this.self.team;
    if (r.phase === 'buy' && prev?.phase !== 'buy') {
      if (prev?.phase === 'warmup') hud.resetCombatFeedback();
      this.hasKit = false;
      // v2 HvH rounds: the buy phase is the freeze time.
      hud.toast(this.mode.bomb ? `Round ${r.round} · buy time: press B` : `Round ${r.round} · freeze time`);
      if (r.bomb.carrier === this.selfPid) hud.toast('💣 You carry the bomb: plant it on A or B', 'good');
    }
    if (r.phase === 'planted' && prev?.phase !== 'planted') {
      hud.announce('💣 BOMB PLANTED', `Site ${r.bomb.site} · ${mine === 2 ? 'defuse it!' : 'defend it!'}`, mine === 2 ? 'bad' : 'good');
      audio.play('bombPlanted');
    }
    if (r.phase === 'over' && prev?.phase !== 'over' && r.reason === 'defused') {
      hud.announce('✂️ BOMB DEFUSED', mine === 2 ? 'Nice work!' : 'They got it in time', mine === 2 ? 'good' : 'bad');
      audio.play('defused');
    }
    if (r.phase === 'live' && prev?.bomb.carrier !== this.selfPid && r.bomb.carrier === this.selfPid && prev?.phase === 'live') hud.toast('💣 You picked up the bomb', 'good');
    if (r.phase === 'over' && prev?.phase !== 'over') {
      const won = r.winner === mine;
      // Only v2 HvH rounds can be drawn (winner 0).
      if (r.winner === 0) hud.toast('Round drawn', 'info');
      else hud.toast(won ? 'Round won! 🎉' : 'Round lost', won ? 'good' : 'bad');
      audio.play(won ? 'reward' : 'empty');
    }
    if (this.hvhBuy) this.onHvhRound(r, prev);
    const buying = r.phase === 'warmup' || ((r.phase === 'buy' || r.phase === 'live') && r.buyEndsAt !== null && this.serverNow() < r.buyEndsAt);
    if (!buying && this.buyMenu?.open) this.buyMenu.say('Buy time is over: press B or Esc to play', true);
  }

  /** Round line, buy menu contents and your own plant / defuse progress. */
  private updateRoundHud(): void {
    const r = this.round!;
    const { hud } = this.ctx;
    const now = this.serverNow();
    hud.setRound(r, now, this.self.team);
    const buying = r.phase === 'warmup' || ((r.phase === 'buy' || r.phase === 'live') && r.buyEndsAt !== null && now < r.buyEndsAt);
    hud.buyButton.textContent = buying ? 'B · Buy' : 'Buy time over';
    hud.buyButton.disabled = !buying || !this.local.alive;
    const action = r.bomb.action;
    if (action && action.pid === this.selfPid) {
      hud.setBombProgress(action.kind === 'plant' ? '💣 Planting…' : '✂️ Defusing…', (now - action.startedAt) / (action.endsAt - action.startedAt));
    } else hud.setBombProgress(null, 0);
    if (this.buyMenu?.open) {
      const s = this.local.server;
      const loadout = this.weapons.loadout;
      const buying = r.phase === 'warmup' || ((r.phase === 'buy' || r.phase === 'live') && r.buyEndsAt !== null && now < r.buyEndsAt);
      const inBuyZone = r.phase === 'warmup' || (this.ctx.world.map.buyZones ?? []).some((z) => z.team === this.self.team && Math.hypot(s.x - z.x, s.z - z.z) <= z.radius);
      this.buyMenu.render({
        money: this.money,
        team: this.self.team,
        secondsLeft: r.phase === 'warmup' ? null : buying ? Math.max(1, Math.ceil(((r.buyEndsAt ?? now) - now) / 1000)) : 0,
        loadout,
        armor: s.armor,
        eggs: s.eggs,
        smokes: s.smokes,
        flashes: s.flashes ?? 0,
        hasKit: this.hasKit,
        blocked: (item) =>
          !buying ? 'Buy time is over'
          : !inBuyZone ? 'Spawn only'
          : item.kind === 'weapon' && loadout.includes(item.weapon!) ? 'Owned'
          : item.kind === 'armor' && s.armor >= PLAYER.maxArmor ? 'Full'
          : item.kind === 'eggs' && s.eggs >= PLAYER.maxEggs ? 'MAX'
          : item.kind === 'smoke' && s.smokes >= PLAYER.maxSmokes ? 'MAX'
          : item.kind === 'flash' && (s.flashes ?? 0) >= PLAYER.maxFlashes ? 'MAX'
          : item.kind === 'kit' && this.hasKit ? 'Owned'
          : null,
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Zombie Apocalypse
  // ---------------------------------------------------------------------------

  private zombieState: ZombieState | null = null;

  private onZombieState(s: ZombieState): void {
    const previous = this.zombieState;
    this.zombieState = s;
    this.zombieHud?.setState(s);
    this.night?.setBloodMoon(s.bloodMoon);
    if (s.phase === 'over' && previous?.phase !== 'over') {
      this.zombieOver = true;
      this.ctx.audio.play('death');
      // The mouse is yours for the Restart button.
      this.ctx.input.releaseLock();
      this.ctx.onOverlay();
    }
    if (s.phase !== 'over' && this.zombieOver) {
      this.zombieOver = false;
      this.ctx.onOverlay();
    }
    if (previous && previous.phase !== 'wave' && s.phase === 'wave') {
      this.ctx.audio.play(s.boss ? 'bigBoom' : 'countdown');
      if (s.bloodMoon) this.ctx.hud.announce('BLOOD MOON', `Wave ${s.wave}: faster zombies, double coins`, 'bad');
      else this.ctx.hud.announce(s.boss ? '☠️ BOSS WAVE' : `Wave ${s.wave}`, s.boss ? 'Kill it before it kills you' : 'Here they come!', 'bad');
    }
    if (previous && previous.phase === 'wave' && s.phase === 'prep') {
      this.ctx.audio.play('reward');
      this.ctx.hud.announce('Wave cleared', 'The shop is open: press B', 'good');
    }
  }

  private updateZombieHud(): void {
    const hud = this.zombieHud;
    if (!hud) return;
    const boss = this.zombieState?.boss;
    const health = boss ? (this.remotes.get(boss.pid)?.latest?.hp ?? null) : null;
    hud.update(this.serverNow(), { money: this.money, weapon: this.weapons.weapon, loadout: this.weapons.loadout }, health === null ? null : health / 100);
  }

  /** Training's weapon menu: it takes the mouse while open. */
  private toggleTrainingMenu(open: boolean): void {
    const menu = this.trainingMenu;
    if (!menu || menu.open === open) return;
    menu.setOpen(open, this.weapons.loadout);
    if (open) this.ctx.input.releaseLock();
    else void this.ctx.input.requestLock();
    this.ctx.onOverlay();
    this.ctx.audio.play('click');
  }

  /** Ask the server (it checks this is Training), then take the new weapon out. */
  private trainingPick(id: WeaponId): void {
    this.trainingRequest({ weapon: id }, `${WEAPONS[id].name} in hand`, () => {
      const slot = this.weapons.loadout.indexOf(id);
      if (slot >= 0) this.switchWeapon(() => this.weapons.switchTo(slot, performance.now()));
    });
  }

  private trainingRequest(req: TrainingGiveRequest, done: string, then?: () => void): void {
    this.ctx.net.socket
      .timeout(5000)
      .emitWithAck('trainingGive', req)
      .then((res) => {
        if (res.ok) then?.();
        this.trainingMenu?.update(this.weapons.loadout, res.ok ? done : res.error ?? 'Not available', !res.ok);
      })
      .catch(() => this.trainingMenu?.update(this.weapons.loadout, 'The server did not answer', true));
  }

  private toggleZombieShop(): void {
    const hud = this.zombieHud!;
    if (hud.shopOpen) return this.closeZombieShop();
    if (!this.local.alive) return this.ctx.hud.toast('You can shop once you are back', 'bad');
    if (this.zombieState?.phase !== 'prep') return this.ctx.hud.toast('The shop is only open between waves', 'bad');
    hud.setShopOpen(true);
    this.ctx.input.releaseLock();
    this.ctx.onOverlay();
    this.ctx.audio.play('click');
    this.updateZombieHud();
  }

  private closeZombieShop(): void {
    const hud = this.zombieHud;
    if (!hud?.shopOpen) return;
    hud.setShopOpen(false);
    void this.ctx.input.requestLock();
    this.ctx.onOverlay();
  }

  private zombieBuy(id: string): void {
    this.ctx.net.socket.emit('buy', id, (res) => {
      this.money = res.money;
      if (!res.ok) {
        this.zombieHud?.say(res.error ?? 'You can’t buy that.', true);
        this.ctx.audio.play('empty');
        return;
      }
      this.zombieHud?.say('Bought!');
      this.ctx.audio.play('pickup');
      // A new gun: take it out (the server already put it in the slot).
      const item = ZOMBIE_SHOP_BY_ID.get(id);
      if (item?.weapon) {
        const slot = this.weapons.loadout.indexOf(item.weapon);
        if (slot >= 0) this.switchWeapon(() => this.weapons.switchTo(slot, performance.now()));
      }
    });
  }

  toggleBuyMenu(): void {
    const menu = this.buyMenu;
    if (!menu) return;
    if (menu.open) return this.closeBuyMenu();
    const r = this.round;
    const now = this.serverNow();
    const buying = r?.phase === 'warmup' || !!r && (r.phase === 'buy' || r.phase === 'live') && r.buyEndsAt !== null && now < r.buyEndsAt;
    if (!this.local.alive) return this.ctx.hud.toast('You can buy when you’re back next round', 'bad');
    if (!buying) return this.ctx.hud.toast('Buy time is over: you can buy at the start of the next round', 'bad');
    menu.setAppearance(this.self.appearance, this.self.team);
    menu.setOpen(true);
    // The mouse is yours while shopping.
    this.ctx.input.releaseLock();
    this.ctx.onOverlay();
    this.updateRoundHud();
    this.ctx.audio.play('click');
  }

  /** Called from a key press or click, so the game can take the mouse back. */
  private closeBuyMenu(): void {
    const menu = this.buyMenu;
    if (!menu?.open) return;
    menu.setOpen(false);
    void this.ctx.input.requestLock();
    this.ctx.onOverlay();
  }

  private buy(item: BuyItem): void {
    this.ctx.net.socket.emit('buy', item.id, (res) => {
      this.money = res.money;
      if (!res.ok) {
        this.buyMenu?.say(res.error ?? 'You can’t buy that.', true);
        this.ctx.audio.play('empty');
        return;
      }
      this.buyMenu?.say(`Bought ${item.name}`);
      this.ctx.audio.play('pickup');
      if (item.kind === 'kit') this.hasKit = true;
      // A new gun: take it out (the server already put it in slot 1).
      if (item.weapon) {
        this.heldGrenade = null;
        const slot = this.weapons.loadout.indexOf(item.weapon);
        if (slot >= 0) this.switchWeapon(() => this.weapons.switchTo(slot, performance.now()));
      }
    });
  }

  // ---------------------------------------------------------------------------
  // v2 HvH buy menu
  // ---------------------------------------------------------------------------

  /** Whenever a buy window opens, the server gets the remembered pick (a same pick is a no-op). */
  private onHvhRound(r: RoundState, prev: RoundState | null): void {
    const window_ = r.phase === 'warmup' || r.phase === 'buy';
    if (window_ && prev?.phase !== r.phase) this.sendHvhPicks();
    // Freeze time opens the menu without taking the mouse: 1–4 stay the weapon keys, and B opens it to pick.
    if (r.phase === 'buy' && prev?.phase !== 'buy') this.setHvhBuyOpen(true);
    if (!window_) this.setHvhBuyOpen(false);
  }

  private sendHvhPicks(): void {
    const { main, pistol } = this.hvhBuy!.model.selected;
    // A refusal (window closed, picking too fast) leaves the loadout as it was: the menu shows that.
    for (const id of [main, pistol]) this.ctx.net.socket.emit('buy', id, (res) => {
      if (!res.ok) this.hvhBuy?.sync(this.weapons.loadout);
    });
  }

  private hvhPick(id: WeaponId): void {
    this.ctx.net.socket.emit('buy', id, (res) => {
      if (!res.ok) {
        this.hvhBuy?.sync(this.weapons.loadout);
        this.hvhBuy?.say(res.error ?? 'You can’t pick that.', true);
        this.ctx.audio.play('empty');
        return;
      }
      this.hvhBuy?.say(`${WEAPONS[id].name} picked`);
      this.ctx.audio.play('pickup');
      // Take the new gun out (playerUpdated already brought the new loadout).
      const slot = this.weapons.loadout.indexOf(id);
      if (slot >= 0) this.switchWeapon(() => this.weapons.switchTo(slot, performance.now()));
    });
  }

  /** B: open (taking the mouse) during warmup and freeze, or close. */
  private toggleHvhBuy(): void {
    if (this.hvhBuy?.open && this.hvhBuyReleased) return this.setHvhBuyOpen(false);
    // The passive freeze menu reopens with the mouse.
    if (this.hvhBuy?.open) this.setHvhBuyOpen(false);
    const phase = this.round?.phase;
    if (phase !== 'warmup' && phase !== 'buy') return this.ctx.hud.toast('Buying is closed: you can pick at the next freeze time', 'bad');
    this.setHvhBuyOpen(true, true);
    this.ctx.audio.play('click');
  }

  private setHvhBuyOpen(open: boolean, takeMouse = false): void {
    const menu = this.hvhBuy;
    if (!menu || menu.open === open) return;
    menu.setOpen(open, !takeMouse);
    if (open && takeMouse) {
      this.hvhBuyReleased = true;
      this.ctx.input.releaseLock();
    } else if (!open && this.hvhBuyReleased) {
      this.hvhBuyReleased = false;
      void this.ctx.input.requestLock();
    }
    this.ctx.onOverlay();
  }

  private updateHvhBuy(): void {
    const menu = this.hvhBuy;
    if (!menu?.open || !this.round) return;
    menu.setSecondsLeft(this.round.phase === 'warmup' ? null : Math.max(0, Math.ceil(((this.round.endsAt ?? 0) - this.serverNow()) / 1000)));
    menu.update();
  }

  /** What to do about the bomb, for the hint bar. */
  private bombHint(): string | null {
    const r = this.round;
    if (!r || this.match.phase !== 'playing') return null;
    const me = this.local.state;
    if (r.phase === 'buy') return 'Buy time · B to open the buy menu';
    if (r.phase === 'live' && r.bomb.carrier === this.selfPid) {
      if (r.bomb.action?.kind === 'plant') return 'Planting… keep holding E';
      const site = this.map.bombSites?.find((s) => Math.hypot(me.x - s.x, me.z - s.z) <= s.radius && Math.abs(me.y - (s.y ?? 0)) < 1.5);
      return site ? `Site ${site.id} · hold E (or 5, then hold fire) to plant the bomb (3 s)` : "💣 You have the bomb (5) · follow the A / B markers and plant it";
    }
    if (r.phase === 'live' && this.self.team === 1) {
      const carrier = r.bomb.carrier ? this.infos.get(r.bomb.carrier) : undefined;
      if (!r.bomb.carrier) return '💣 The bomb is on the floor · pick it up (follow the marker)';
      if (carrier?.bot) return `🤖 ${carrier.name} has the bomb · stand next to it and hold E to take it`;
      if (carrier) return `${carrier.name} has the bomb · cover them`;
    }
    if (r.phase === 'planted' && this.self.team === 2) {
      const near = Math.hypot(me.x - r.bomb.x, me.z - r.bomb.z) <= BOMB.defuseRange;
      if (r.bomb.action?.kind === 'defuse' && r.bomb.action.pid === this.selfPid) return 'Defusing… keep holding E';
      return near ? `Hold E to defuse${this.hasKit ? ' (kit: 5 s)' : ' (10 s)'}` : `💣 Find the bomb on site ${r.bomb.site} and defuse it`;
    }
    if (r.phase === 'planted' && this.self.team === 1) return `💣 Defend the bomb on site ${r.bomb.site}`;
    return null;
  }

  /**
   * The bomb: on the carrier's back, on the floor in front of whoever is planting it (the code
   * goes in digit by digit), dropped, or planted and counting down (beeping faster and faster),
   * with key clicks while planting and wire clicks while defusing.
   */
  private updateBombView(): void {
    const r = this.round;
    if (!r || !this.bombView) return;
    const b = r.bomb;
    const now = this.serverNow();
    const exploded = r.phase === 'over' && r.reason === 'exploded';
    const action = b.action;
    const progress = action ? Math.min(1, Math.max(0, (now - action.startedAt) / (action.endsAt - action.startedAt))) : 0;
    let at: THREE.Vector3 | null = null;
    let yaw = 0;
    let mode: BombMode = 'dropped';
    let blink = 0.5;
    if (action?.kind === 'plant' && b.carrier) {
      // On the floor just in front of the planter.
      const d = this.drawnAt(b.carrier);
      if (d) {
        yaw = d.yaw;
        at = this.tmp.set(d.position.x - Math.sin(yaw) * 0.55, d.position.y + 0.02, d.position.z - Math.cos(yaw) * 0.55);
        mode = 'planting';
      }
      if (now >= this.nextBeep) {
        this.nextBeep = now + 380;
        this.ctx.audio.play('keypad', at ?? undefined, 0.7);
      }
    } else if (b.carrier) {
      const d = this.drawnAt(b.carrier);
      if (d && !(b.carrier === this.selfPid && this.rig.firstPerson)) {
        yaw = d.yaw;
        at = this.tmp.set(d.position.x + Math.sin(yaw) * 0.42, d.position.y + 0.7, d.position.z + Math.cos(yaw) * 0.42);
        mode = 'carried';
      }
    } else if ((r.phase === 'live' || r.phase === 'planted' || r.phase === 'over') && !exploded) {
      at = this.tmp.set(b.x, b.y, b.z);
      mode = r.phase === 'planted' ? (action?.kind === 'defuse' ? 'defusing' : 'planted') : r.phase === 'over' && r.reason === 'defused' ? 'defused' : 'dropped';
    }
    const left = b.explodeAt !== null ? Math.max(0, b.explodeAt - now) : 0;
    if (r.phase === 'planted' && b.explodeAt !== null) {
      // Beeps speed up from once a second to frantic as the fuse runs out.
      const interval = 120 + 880 * (left / BOMB.fuseMs);
      blink = 1000 / interval;
      if (now >= this.nextBeep) {
        this.nextBeep = now + interval;
        this.ctx.audio.play('beep', { x: b.x, y: b.y, z: b.z });
        if (action?.kind === 'defuse') this.ctx.audio.play('defuseTick', { x: b.x, y: b.y, z: b.z }, 0.8);
      }
    } else if (mode === 'defused' || mode === 'carried') blink = 0;
    this.bombView.update(at, yaw, mode, progress, left / 1000, blink, now / 1000);
  }

  /** Planting / defusing holds you still, crouched (the server does the same). */
  private bombHolds(frame: InputFrame): boolean {
    if (!this.round || !this.local.alive || this.match.phase !== 'playing') return false;
    const s = this.local.state;
    return bombHoldsPlayer(this.round, { pid: this.selfPid, team: this.self.team, x: s.x, y: s.y, z: s.z, onGround: s.onGround, useHeld: frame.use === true }, this.map.bombSites ?? []);
  }

  /** You have the bomb in a live ChikenBomb round. */
  /** Standing on a bomb site (the server's rule: within its circle, at about its height). */
  private onBombSite(): boolean {
    const s = this.local.state;
    return (this.ctx.world.map.bombSites ?? []).some((site) => Math.hypot(s.x - site.x, s.z - site.z) <= site.radius && Math.abs(s.y - (site.y ?? 0)) < 1.5);
  }

  private carryingBomb(): boolean {
    return this.local.alive && this.round?.phase === 'live' && this.round.bomb.carrier === this.selfPid;
  }

  /** On-screen markers: the sites, the planted bomb with its timer, and (for chikenT) the bomb or its carrier. */
  private updateBombMarkers(): void {
    const r = this.round;
    const hud = this.ctx.hud;
    if (!r || this.match.phase !== 'playing' || !(r.phase === 'live' || r.phase === 'planted' || r.phase === 'buy')) return hud.setMarkers([]);
    const cam = this.ctx.camera;
    const w = window.innerWidth;
    const hgt = window.innerHeight;
    const out: { x: number; y: number; label: string; sub: string; kind: string }[] = [];
    const add = (x: number, y: number, z: number, label: string, kind: string) => {
      const p = this.markerPoint.set(x, y, z);
      const dist = cam.position.distanceTo(p);
      p.project(cam);
      if (p.z > 1 || p.z < -1) return;
      out.push({ x: ((p.x + 1) / 2) * w, y: ((1 - p.y) / 2) * hgt, label, sub: `${Math.round(dist)} m`, kind });
    };
    const b = r.bomb;
    for (const s of this.map.bombSites ?? []) {
      if (r.phase === 'planted' && b.site === s.id) continue;
      add(s.x, (s.y ?? 0) + 2.2, s.z, s.id, b.carrier === this.selfPid ? 'site go' : 'site');
    }
    if (r.phase === 'planted') {
      const left = b.explodeAt !== null ? Math.max(0, b.explodeAt - this.serverNow()) / 1000 : 0;
      add(b.x, b.y + 1.2, b.z, `💣 ${b.site ?? ''} · ${Math.ceil(left)}s`, 'bomb');
    } else if (this.self.team === 1 && r.phase === 'live') {
      if (!b.carrier) add(b.x, b.y + 0.9, b.z, '💣 Bomb', 'dropped');
      else if (b.carrier !== this.selfPid) {
        const d = this.drawnAt(b.carrier);
        if (d) add(d.position.x, d.position.y + 2.1, d.position.z, '💣', 'carrier');
      }
    }
    hud.setMarkers(out);
  }

  private blockCentre(b: BlockState): Vec3 {
    const box = blockAabb(b.cx, b.cy, b.cz);
    return { x: box.minX + BLOCK_SIZE / 2, y: box.minY + BLOCK_SIZE / 2, z: box.minZ + BLOCK_SIZE / 2 };
  }

  /** Aims a ghost block at the crosshair; click places, right-click removes. */
  private updateBuilding(fireDown: boolean, aimDown: boolean): void {
    const blocks = this.blocks;
    if (!blocks || !this.local.alive || this.local.car) {
      blocks?.showGhost(null, false);
      return;
    }
    const cam = this.ctx.camera;
    cam.getWorldDirection(this.camDir);
    const eye = this.eye();
    const dir = { x: this.camDir.x, y: this.camDir.y, z: this.camDir.z };
    const skip = Math.max(0, (eye.x - cam.position.x) * dir.x + (eye.y - cam.position.y) * dir.y + (eye.z - cam.position.z) * dir.z);
    const origin = { x: cam.position.x + dir.x * skip, y: cam.position.y + dir.y * skip, z: cam.position.z + dir.z * skip };
    const ray = makeRay(origin, dir);
    const hit = raycastWorld(ray, this.collision, BUILD_RANGE + 2);
    if (!hit) {
      blocks.showGhost(null, false);
      return;
    }
    // The cell just in front of the surface we're pointing at.
    const p = pointOnRay(ray, hit.t);
    const cell = cellOf(p.x + hit.nx * 0.05, p.y + hit.ny * 0.05, p.z + hit.nz * 0.05);
    const box = blockAabb(cell.cx, cell.cy, cell.cz);
    const centre = { x: box.minX + BLOCK_SIZE / 2, y: box.minY + BLOCK_SIZE / 2, z: box.minZ + BLOCK_SIZE / 2 };
    const s = this.local.state;
    const r = PLAYER.radius;
    const insideMe = box.minX < s.x + r && box.maxX > s.x - r && box.minZ < s.z + r && box.maxZ > s.z - r && box.minY < s.y + heightOf(s) && box.maxY > s.y;
    const inReach = Math.hypot(centre.x - eye.x, centre.y - eye.y, centre.z - eye.z) <= BUILD_RANGE;
    const valid = inReach && !insideMe && cell.cy >= 0;
    const blockId = hit.id !== undefined && hit.id >= BLOCK_ID_BASE ? hit.id - BLOCK_ID_BASE : null;
    blocks.showGhost(cell, valid);

    if (fireDown && !this.fireWasDown && valid) this.ctx.net.socket.emit('build', { ...cell, kind: BLOCK_KINDS[this.blockIndex]! });
    if (aimDown && !this.aimWasDown && blockId !== null) this.ctx.net.socket.emit('unbuild', blockId);
  }

  private onFlag(e: FlagEvent): void {
    this.flags?.set(e.flags);
    // Flags resetting at the start of a match isn't news.
    if (e.kind === 'returned' && e.pid === 0 && this.match.phase !== 'playing') return;
    const who = this.infos.get(e.pid)?.name ?? 'Someone';
    const flagName = `${TEAM_NAMES[e.team]} flag`;
    const ours = e.team === this.self.team;
    const text: Record<FlagEvent['kind'], string> = {
      taken: `${who} took the ${flagName}!`,
      dropped: `${who} dropped the ${flagName}`,
      returned: `The ${flagName} is back home`,
      captured: `${who} captured the ${flagName}!`,
    };
    // Good news is yellow, bad news red: losing our flag is bad, taking theirs is good.
    const bad = ours ? e.kind === 'taken' || e.kind === 'captured' : e.kind === 'returned';
    this.ctx.hud.toast(text[e.kind], bad ? 'bad' : 'good');
    this.ctx.audio.play(e.kind === 'captured' ? 'reward' : 'pickup');
  }

  // ---------------------------------------------------------------------------
  // Chat
  // ---------------------------------------------------------------------------

  private bindChat(): void {
    const input = this.ctx.hud.chatInput;
    input.onkeydown = (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        const text = input.value.trim();
        const wave = /^\/wave\s+(\d{1,2})$/i.exec(text);
        const backrooms = /^\/backrooms(?:\s+(small|full))?$/i.exec(text);
        // Developer shortcuts (Zombie Apocalypse, private room, passkey unlocked): /wave 7,
        // /backrooms small (a quick test run), /backrooms full.
        const dev = (action: { kind: 'zombieWave'; wave: number; variant?: 'small' | 'full' }, label: string) =>
          this.ctx.net.socket.emit('devAction', action, (res) => this.ctx.hud.toast(res.ok ? `${label} in 3 seconds` : (res.error ?? 'Not allowed.'), res.ok ? 'good' : 'bad'));
        if (wave) dev({ kind: 'zombieWave', wave: Number(wave[1]) }, `Wave ${wave[1]}`);
        else if (backrooms) {
          const variant = (backrooms[1]?.toLowerCase() ?? 'full') as 'small' | 'full';
          dev({ kind: 'zombieWave', wave: CRYSTAL_HUNT.events.backrooms.wave, variant }, `Backrooms (${variant})`);
        }
        else if (text) this.ctx.net.socket.emit('chat', text, this.chatTeamOnly);
        this.closeChat();
      } else if (e.key === 'Escape') {
        this.closeChat();
      }
    };
  }

  private openChat(teamOnly: boolean): void {
    if (this.chatOpen) return;
    this.chatOpen = true;
    // Only modes with teams have team chat; elsewhere U is the same as Y.
    this.chatTeamOnly = teamOnly && (this.infos.get(this.selfPid)?.team ?? 0) > 0;
    this.ctx.input.enabled = false;
    this.ctx.hud.setChatOpen(true, this.chatTeamOnly);
  }

  private closeChat(): void {
    this.chatOpen = false;
    this.ctx.input.enabled = true;
    this.ctx.hud.setChatOpen(false);
  }

  // ---------------------------------------------------------------------------
  // Network events
  // ---------------------------------------------------------------------------

  private on<E extends keyof ServerToClientEvents>(event: E, fn: ServerToClientEvents[E]): void {
    // Socket.IO's typings for on/off with generic event names are awkward; the map above keeps them paired.
    (this.ctx.net.socket.on as (e: string, f: unknown) => void)(event, fn);
    this.handlers.push([event, fn as (...args: never[]) => void]);
  }

  private bindNetwork(): void {
    this.on('snapshot', (s) => this.onSnapshot(s));
    this.on('hvhState', (e) => {
      this.tickClock.sample(e.tick, this.serverNow());
      this.commandClock.observe(e.queued ?? 0, e.lastAckSeq + (e.queued ?? 0));
      this.local.onHvhState(e);
      if (this.local.hvhV2) {
        initHvhV2Ui(
          this,
          () => new HitLog((id) => this.infos.get(Number(id))?.name ?? id, { container: this.ctx.hud.root }),
          (handler) => this.on('shotVerdict', handler),
        );
      }
    });
    this.on('playerJoined', (info) => this.onPlayerInfo(info));
    this.on('playerUpdated', (info) => this.onPlayerInfo(info));
    this.on('round', (r) => this.onRound(r));
    this.on('money', (e) => (this.money = e.money));
    this.on('zombie', (s) => this.onZombieState(s));
    this.on('zombieHit', (e) => this.remotes.get(e.pid)?.chicken.flinch(e.headshot));
    this.on('hunt', (s) => {
      const before = this.huntSpeedLevel;
      this.hunt?.setState(s);
      // Speed-ups: you run faster (predicted like the server does it)... and so do the monkeys.
      this.huntSpeedLevel = s?.speedLevel ?? 0;
      this.local.eventSpeed = 1 + CRYSTAL_HUNT.speedUp.player * this.huntSpeedLevel;
      if (s && this.huntSpeedLevel > before) {
        this.ctx.hud.announce(`SPEED LEVEL ${this.huntSpeedLevel}`, "You're faster... so are the monkeys", 'bad');
        this.ctx.audio.play('monkeyShriek', undefined, 0.7);
      }
    });
    this.on('crystal', (e) => this.hunt?.collect(e));
    // A monkey screeching to its pack: you hear where it is.
    this.on('zombieAlert', (e) => {
      const r = this.remotes.get(e.pid);
      if (r) this.ctx.audio.play('monkeyShriek', r.position, 1.1);
    });
    this.on('huntScare', (e) => this.hunt?.scare(e.kind));
    this.on('huntEnd', (e) => {
      this.ctx.hud.announce(e.success ? 'ESCAPED' : 'EVENT FAILED', e.reason, e.success ? 'good' : 'bad');
      this.ctx.audio.play(e.success ? 'reward' : 'death', undefined, 0.9);
    });
    this.on('zombieFuse', (e) => {
      const r = this.remotes.get(e.pid);
      r?.chicken.fuse();
      if (r) this.ctx.audio.play('fuse', r.position, 1);
    });
    this.on('zombiePower', (e) => {
      const info = POWER_UP_INFO[e.kind];
      const who = e.pid === this.selfPid ? 'You' : (this.infos.get(e.pid)?.name ?? 'Someone');
      this.ctx.hud.announce(info.name.toUpperCase(), `${who}: ${info.text}`, 'good');
      this.ctx.audio.play(e.kind === 'nuke' ? 'nuke' : 'powerUp', undefined, 0.9);
      if (e.kind === 'nuke') this.rig.addShake(0.6);
    });
    this.on('zombieGear', (g) => this.zombieHud?.setGear(g));
    this.on('playerLeft', (pid) => {
      this.infos.delete(pid);
      this.remotes.remove(pid);
      this.refreshScores();
    });
    this.on('shot', (e) => this.onShot(e));
    this.on('damage', (e) => this.onDamage(e));
    this.on('kill', (e) => this.onKill(e));
    this.on('spawn', (e) => this.onSpawn(e));
    this.on('projectile', (e) => this.onProjectile(e));
    this.on('explode', (e) => this.onExplode(e));
    this.on('smoke', (e) => this.onSmoke(e));
    this.on('flashed', (e) => this.onFlashed(e));
    this.on('jumpscare', (e) => {
      if (!getSettings().jumpscares) {
        this.ctx.hud.toast('👻 A developer tried to jumpscare you (jumpscares are off in Settings)');
        return;
      }
      showJumpscare(e.style, this.ctx.audio);
    });
    this.on('loot', (e) => this.onLoot(e));
    this.on('pickup', (e) => this.onPickup(e));
    this.on('drop', (d) => this.loot.addDrop(d));
    this.on('dropGone', (e) => this.loot.removeDrop(e.id));
    this.on('scores', (e) => this.onScores(e));
    this.on('match', (e) => this.onMatch(e));
    this.on('chat', (m) => this.onChat(m));
    this.on('reward', (e) => this.onReward(e));
    this.on('roomClosed', (reason) => this.ctx.onClosed(reason));
    this.on('blockPlaced', (b: BlockState) => {
      this.blocks?.add(b);
      this.ctx.audio.play('click', this.blockCentre(b), 0.7);
    });
    this.on('blockRemoved', (id: number) => this.blocks?.remove(id));
    this.on('flag', (e) => this.onFlag(e));
  }

  private onSnapshot(snapshot: WorldSnapshot): void {
    const sample = snapshot.t - performance.now();
    if (!this.hasClock) {
      this.clockOffset = sample;
      this.hasClock = true;
    } else {
      this.clockOffset += (sample - this.clockOffset) * CLOCK_SMOOTHING;
    }
    const mine = snapshot.p.find((p) => p[0] === this.selfPid);
    if (mine) {
      const state = unpackPlayer(mine);
      const wasAlive = this.local.alive;
      const car = state.vehicle ? snapshot.v.map(unpackVehicle).find((v) => v.id === state.vehicle) : undefined;
      this.local.reconcile(state, this.collision, car);
      // A respawn we haven't seen the event for yet (e.g. just joined).
      if (!wasAlive && state.alive) this.respawned();
      this.weapons.sync(state, performance.now());
    }
    this.remotes.pushSnapshot(snapshot, this.selfPid);
    this.vehicles.pushSnapshot(snapshot.t, snapshot.v);
    if (this.mode.id === 'hvh') {
      this.sightView = { t: snapshot.t, enemies: snapshotSightTargets(snapshot.p, (pid) => {
        const info = this.infos.get(pid);
        return pid !== this.selfPid && !(info && this.isFriendly(info));
      }) };
    }
  }

  private onPlayerInfo(info: PlayerInfo): void {
    const before = this.infos.get(info.pid)?.level;
    const teamBefore = this.infos.get(info.pid)?.team;
    this.infos.set(info.pid, info);
    // Our own team changed (M): everyone else is now a friend or a foe the other way round.
    if (info.pid === this.selfPid && teamBefore !== undefined && teamBefore !== info.team) {
      for (const other of this.infos.values()) if (other.pid !== this.selfPid) this.remotes.add(other, this.isFriendly(other));
      this.ctx.hud.toast(`You joined ${teamName(this.mode, info.team)}`, 'good');
    }
    // Arms Race: a new weapon (or knocked back a step).
    if (info.pid === this.selfPid && info.level !== undefined && before !== undefined && info.level !== before) {
      const weapon = WEAPONS[ARMS_LADDER[info.level]!].name;
      if (info.level > before) {
        this.ctx.hud.toast(`Level ${info.level + 1}: ${weapon}`, 'good');
        this.ctx.audio.play('reward');
      } else {
        this.ctx.hud.toast(`Knifed! Back to ${weapon}`, 'bad');
        this.ctx.audio.play('empty');
      }
    }
    if (info.pid === this.selfPid) {
      this.weapons.setLoadout(info.loadout);
      // Arms Race: take the new gun out (the server already did).
      if (info.level !== undefined && before !== undefined && info.level !== before) this.weapons.switchTo(0, performance.now());
      this.local.chicken.setAppearance(info.appearance);
      this.local.chicken.setTeam(info.team);
    } else {
      this.remotes.add(info, this.isFriendly(info));
    }
    this.refreshScores();
  }

  private onShot(e: ShotEvent): void {
    if (e.pid === this.selfPid) this.weapons.confirmShot(e, performance.now(), this.serverNow());
    this.ctx.dev?.onServerShot?.(this, e);
    if (e.pid === this.selfPid) return;
    const remote = this.remotes.get(e.pid);
    const origin = remote ? remote.chicken.muzzleWorldPosition(this.tmp) : new THREE.Vector3(e.ox, e.oy, e.oz);
    const from = { x: origin.x, y: origin.y, z: origin.z };
    const def = WEAPONS[e.weapon];
    if (def.melee) {
      remote?.chicken.swing();
      // A zombie claws (a brute or boss smashes) instead of swinging a knife.
      const undead = remote?.info.undead;
      this.ctx.audio.play(undead ? (undead === 'brute' || undead === 'boss' ? 'zsmash' : 'zclaw') : def.sound, from, 0.9);
      if (e.hits.length > 0) {
        const at = { x: e.ends[0]!, y: e.ends[1]!, z: e.ends[2]! };
        this.effects.feathers(at, 0xffffff, 5);
        this.ctx.audio.play(def.id === 'pan' ? 'bonk' : 'meleeHit', at, 0.9);
      }
      return;
    }
    remote?.chicken.kick();
    this.effects.muzzleFlash(from);
    if (remote && !def.projectile && e.ends.length >= 3 && this.ctx.camera.position.distanceTo(origin) < 25) {
      const dx = e.ends[0]! - from.x, dy = e.ends[1]! - from.y, dz = e.ends[2]! - from.z;
      const len = Math.hypot(dx, dy, dz) || 1;
      this.thirdPersonCase(def.id, from, { x: dx / len, y: dy / len, z: dz / len }, remote.yaw, { vx: 0, vy: 0, vz: 0 });
    }
    this.ctx.audio.play(remote?.latest ? WEAPONS[remote.latest.weapon].sound : 'rifle', from, 0.9);
    for (let i = 0; i < e.hits.length; i++) {
      const end = { x: e.ends[i * 3]!, y: e.ends[i * 3 + 1]!, z: e.ends[i * 3 + 2]! };
      if(!this.hvhVisuals||nativeOn(this.hvhVisuals,'Visuals.Effects.bulletTracers'))this.effects.tracer(from, end);
      if (e.hits[i]) this.effects.feathers(end, 0xffffff, 3);
      else this.effects.impact(end);
      this.markWall(from, end);
    }
  }

  /** Leaves a bullet hole if a remote player's shot from `from` stopped at a wall at `end`. */
  private markWall(from: Vec3, end: Vec3): void {
    const d = { x: end.x - from.x, y: end.y - from.y, z: end.z - from.z };
    const length = Math.hypot(d.x, d.y, d.z);
    if (length < 0.1) return;
    const ray = makeRay(from, { x: d.x / length, y: d.y / length, z: d.z / length });
    const { soft, wall } = raycastPenetrating(ray, this.collision, length + 0.2, this.isSoft, this.wallbangBoxes);
    for (const s of soft) if (s.t < length - 0.05) this.effects.bulletHole(pointOnRay(ray, s.t), { x: s.nx, y: s.ny, z: s.nz });
    // Only if the wall really is where the shot ended (it could have hit a chicken or loot box instead).
    if (wall && Math.abs(wall.t - length) < 0.25) this.effects.bulletHole(end, { x: wall.nx, y: wall.ny, z: wall.nz });
  }

  private onDamage(e: DamageEvent): void {
    const { hud, audio } = this.ctx;
    if (e.victim === this.selfPid) {
      this.local.server = { ...this.local.server, hp: e.hp, armor: e.armor };
      audio.play('hurt');
      this.rig.addShake(0.15);
      if (e.attacker !== this.selfPid) {
        const angle = Math.atan2(-(e.fromX - this.local.position.x), -(e.fromZ - this.local.position.z));
        hud.damageFrom(-wrapAngle(angle - this.ctx.input.yaw));
      }
    } else if (e.attacker === this.selfPid) {
      hud.hit(e.headshot, e.hp <= 0, e.amount);
      if(!this.hvhVisuals||nativeOn(this.hvhVisuals,'Visuals.Players.hitmarkerSound'))audio.play(e.headshot ? 'headshot' : 'hit');
    }
  }

  private onKill(e: KillEvent): void {
    const { hud, audio } = this.ctx;
    const killer = this.infos.get(e.killer);
    const victim = this.infos.get(e.victim);
    hud.kill(killer, victim, e.cause, e.headshot, this.selfPid, e.flags ?? 0);

    if (e.victim === this.selfPid) {
      this.local.onOwnDeath();
      this.died(killer, e.cause, e.flags ?? 0, e.headshot);
    } else {
      const remote = this.remotes.get(e.victim);
      if (remote) {
        remote.kill();
        remote.chicken.onVanish = (at) => this.vanished(at, e.victim);
        const at = { x: remote.position.x, y: remote.position.y + 0.8, z: remote.position.z };
        if (remote.info.undead) {
          this.effects.zombieBurst(at, new THREE.Color(this.skinColor(e.victim)).multiplyScalar(0.45).getHex());
          audio.play('zdeath', remote.position, remote.info.undead === 'boss' ? 1.2 : 0.8);
        } else {
          this.effects.feathers(at, this.skinColor(e.victim), 22);
          audio.play('death', remote.position, 0.8);
        }
      }
      if (e.killer === this.selfPid) {
        audio.play('kill');
        // A no-scope, wallbang, mid-air... kill gets a little fanfare.
        if (e.flags) audio.play('reward', undefined, 0.5);
      }
    }
  }

  private died(killer: PlayerInfo | undefined, cause: KillCause, flags = 0, headshot = false): void {
    this.local.server = { ...this.local.server, alive: false, hp: 0 };
    this.deathPos = this.local.position.clone();
    this.respawnAt = performance.now() + this.mode.respawnMs;
    this.effects.feathers({ x: this.deathPos.x, y: this.deathPos.y + 0.8, z: this.deathPos.z }, this.skinColor(this.selfPid), 22);
    this.local.chicken.onVanish = (at) => this.vanished(at, this.selfPid);
    this.ctx.audio.play('death');
    this.ctx.hud.showDeath(killer, cause, this.selfPid, flags, headshot);
    if (this.chatOpen) this.closeChat();
    // Zombie Apocalypse: a zombie got you, and it jumps at your face (off with the Jumpscares setting).
    if (this.mode.zombies && killer?.undead && getSettings().jumpscares) showJumpscare('chicken', this.ctx.audio, true);
  }

  /** The death animation ended: the body vanishes in a puff of feathers. */
  private vanished(at: THREE.Vector3, pid: number): void {
    const p = { x: at.x, y: at.y, z: at.z };
    this.effects.poof(p, this.skinColor(pid));
    this.ctx.audio.play('poof', p, 0.8);
  }

  /**
   * v2 HvH rounds (R63): dead in a round, watch a living teammate's view (their public eye angles);
   * fire cycles to the next teammate, aim back to the previous. False when nobody can be watched,
   * so the death camera stays. Spectate.ts picks the teammate; a respawn ends it.
   */
  private spectateTeammate(dt: number): boolean {
    const { input } = this.ctx;
    const phase = this.round?.phase;
    const before = this.spectated;
    let next: RemotePlayer | null = null;
    if (this.mode.id === 'hvh' && this.local.hvhV2 && !this.local.alive && (phase === 'live' || phase === 'over')) {
      const team = this.self?.team ?? 0;
      const players = [...this.remotes.players.values()].map((r) => ({ pid: r.info.pid, team: r.info.team, alive: r.alive && !r.culled }));
      const click = !input.active ? 0 : input.firing && !this.fireWasDown ? 1 : input.aiming && !this.aimWasDown ? -1 : 0;
      const pid = click === 0 ? this.spectate.update(team, players) : this.spectate.cycle(team, players, click);
      next = pid === null ? null : this.remotes.players.get(pid) ?? null;
    }
    if (before && before !== next) before.chicken.setBodyVisible(true);
    this.spectated = next;
    if (!next) return false;
    if (next !== before) {
      this.ctx.hud.toast(`Spectating ${next.info.name}`);
      this.spectateYaw.reset();
      this.spectatePitch.reset();
    }
    // First person: inside their chicken, so hide the body. HvH third person keeps the camera behind them: show it.
    next.chicken.setBodyVisible(this.rig.hvhThirdPerson);
    // Their eye yaw and pitch are anti-aimed: smoothed (the pitch kept near level), so jitter and flicks do not shake the view.
    this.rig.follow(next.position, this.spectateYaw.step(next.yaw, dt), this.spectatePitch.step(next.latest?.pitch ?? 0, dt), 1, dt, true, false, next.scale);
    return true;
  }

  private respawned(): void {
    this.spectated?.chicken.setBodyVisible(true);
    this.spectated = null;
    this.spectate.reset();
    this.heldGrenade = null;
    this.heldSent = 'gun';
    this.pinPulled = false;
    this.deathPos = null;
    this.weapons.refill();
    this.ctx.hud.hideDeath();
  }

  private onSpawn(e: SpawnEvent): void {
    if (e.pid === this.selfPid) {
      this.local.respawnAt(e.x, e.y, e.z);
      this.ctx.input.yaw = e.yaw;
      this.ctx.input.pitch = -0.15;
      this.respawned();
    } else {
      this.remotes.get(e.pid)?.teleport(this.serverNow(), e.x, e.y, e.z, e.yaw);
    }
  }

  private onProjectile(e: ProjectileSpawn): void {
    this.projectiles.spawn(e, this.selfPid, (this.ctx.net.ping ?? 60) / 2);
    // Someone else's throw: their chicken swings its arm.
    if (e.owner !== this.selfPid && e.ownerSeq > 0 && (e.kind === 'he' || e.kind === 'smoke' || e.kind === 'flash')) this.remotes.get(e.owner)?.chicken.swing();
  }

  /** A flashbang got us: white screen, ears ringing. */
  private onFlashed(e: FlashedEvent): void {
    this.ctx.hud.flash(e.ms);
    this.ctx.audio.ringFor(e.ms / 1000, Math.min(1, e.ms / FLASH.maxMs));
  }

  private onExplode(e: ExplosionEvent): void {
    this.projectiles.explode(e);
    const at = { x: e.x, y: e.y, z: e.z };
    if (e.kind === 'smoke') {
      this.ctx.audio.play('smokePop', at);
      return;
    }
    if (e.kind === 'flash') {
      // The bang everyone hears and the light everyone sees; being blinded comes separately.
      this.effects.flashPop(at);
      this.ctx.audio.play('flashbang', at);
      return;
    }
    if (e.kind === 'bolt') {
      // A crossbow bolt hitting something: a thud, no explosion.
      this.effects.impact(at);
      this.ctx.audio.play('meleeHit', at, 0.6);
      return;
    }
    const dist = this.ctx.camera.position.distanceTo(this.tmp.set(e.x, e.y, e.z));
    if (e.id === -1) {
      // The bomb (the server sends it as id -1).
      this.effects.bombExplosion(at);
      this.ctx.audio.play('bigBoom', at, 1.4);
      this.rig.addShake(Math.max(0.15, 1.8 - dist / 30));
      if (dist < 25) this.ctx.hud.flash(Math.round(1100 - dist * 40));
      return;
    }
    this.effects.explosion(at, PROJECTILES[e.kind].splashRadius * (e.scale ?? 1));
    this.ctx.audio.play('explosion', at);
    this.rig.addShake(Math.max(0, 1 - dist / 25));
  }

  private onSmoke(e: SmokeEvent): void {
    const seconds = (e.until - this.serverNow()) / 1000;
    // Thick for as long as it blocks sight, then thins out over a few more seconds.
    if (seconds > 0.5) this.effects.smokeCloud(e, seconds + 3);
  }

  private onLoot(e: LootState): void {
    this.loot.set(e);
  }

  private onPickup(e: PickupEvent): void {
    // Power-ups are announced to everyone (zombiePower).
    if (e.pid !== this.selfPid || isPowerUp(e.pickup)) return;
    const text = PICKUP_TEXT[e.pickup] ?? 'Pickup!';
    this.ctx.hud.toast(e.lootId === -1 ? `Kill bonus: ${text}` : text, 'good');
    this.ctx.audio.play('pickup');
  }

  private onScores(e: ScoresEvent): void {
    for (const [pid, kills, deaths, score] of e.rows) {
      const info = this.infos.get(pid);
      if (info) this.infos.set(pid, { ...info, kills, deaths, score });
    }
    this.teamScores = e.teamScores;
    this.refreshScores();
  }

  private onMatch(m: MatchState): void {
    const { hud, audio } = this.ctx;
    const previous = this.match.phase;
    this.match = m;
    this.teamScores = m.teamScores;
    if (m.phase === 'playing' && previous !== 'playing') {
      hud.resetCombatFeedback();
      hud.toast('Fight!', 'good');
      audio.play('reward');
    }
    if (m.phase === 'countdown') audio.play('countdown');
    if (m.phase === 'ended') {
      this.lastResultsKey = '';
      this.renderResults();
    }
    this.refreshScores();
  }

  private renderResults(): void {
    // Zombie Apocalypse has its own game-over panel.
    if (this.mode.zombies) return;
    const m = this.match;
    const key = `${m.winnerPid}|${m.winnerTeam}|${m.mvpPid}`;
    if (key === this.lastResultsKey) return;
    this.lastResultsKey = key;
    const self = this.self;
    const won = this.mode.teams ? m.winnerTeam !== 0 && m.winnerTeam === self.team : m.winnerPid === this.selfPid;
    this.ctx.hud.renderResults(m, this.scoreLines(), this.teamScores, this.infos.get(m.winnerPid), this.infos.get(m.mvpPid), won);
  }

  private onChat(m: ChatMessage): void {
    this.ctx.hud.chat(m, m.pid === this.selfPid);
  }

  private onReward(e: MatchRewardEvent): void {
    this.ctx.hud.showReward(e);
    this.ctx.hud.toast(e.ranked ? `+${e.coins} coins · ${e.xp >= 0 ? '+' : ''}${e.xp} rank points` : `+${e.coins} coins`, 'good');
    if (e.dailyCoins) this.ctx.hud.toast(`📅 Daily challenge done! +${e.dailyCoins} coins`, 'good');
    const before = levelFor(e.xpTotal - e.xp);
    const after = levelFor(e.xpTotal);
    if (after > before) {
      const rank = rankOf(after);
      this.ctx.hud.toast(`Level up! Level ${rank.level} · ${rank.name} · +${e.levelCoins} coins`, 'good');
    }
    this.ctx.audio.play('reward');
    this.ctx.onReward(e.total, e.xpTotal);
  }

  private scoreLines(): ScoreLine[] {
    return [...this.infos.values()].filter((info) => !info.undead).map((info) => ({ info, self: info.pid === this.selfPid }));
  }

  private refreshScores(): void {
    this.ctx.hud.setTeamScores(this.teamScores, this.self?.team ?? 0);
  }

  // ---------------------------------------------------------------------------

  dispose(): void {
    this.ctx.dev?.detach(this);
    const socket = this.ctx.net.socket as unknown as { off: (e: string, f: unknown) => void };
    for (const [event, fn] of this.handlers) socket.off(event, fn);
    this.handlers.length = 0;
    if (this.chatOpen) this.closeChat();
    this.ctx.hud.chatInput.onkeydown = null;
    this.ctx.input.zoomScale = 1;
    this.viewmodel.dispose();
    this.bombView?.dispose();
    this.buyMenu?.dispose();
    this.hvhBuy?.dispose();
    this.zombieHud?.dispose();
    this.night?.dispose();
    this.hunt?.dispose();
    this.ctx.world.blackout = false;
    this.ctx.hud.root.classList.remove('hud-zombie');
    this.trainingMenu?.dispose();
    this.ctx.input.zombieMode = false;
    this.local.dispose();
    this.remotes.dispose();
    this.projectiles.dispose();
    this.casings.dispose();
    this.throwPreview.dispose();
    this.loot.dispose();
    this.vehicles.dispose();
    this.ctx.audio.setEngine(null);
    this.blocks?.dispose();
    this.flags?.dispose();
    this.effects.dispose();
    this.hitLog?.dispose();
    this.hitLog = null;
    this.ctx.hud.setVisible(false);
    this.ctx.hud.hideDeath();
  }
}

