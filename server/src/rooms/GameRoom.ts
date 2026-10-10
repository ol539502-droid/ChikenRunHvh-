import {
  CHAT_MAX_LENGTH,
  COINS,
  MAPS,
  MATCH,
  MAX_REWIND_MS,
  MODES,
  PLAYER,
  SIM_DT,
  SIM_RATE,
  SNAPSHOT_RATE,
  WEAPONS,
  WEAPON_SWITCH_MS,
  bodyScale,
  clamp,
  createCollisionWorld,
  damageAt,
  eyeHeightOf,
  fireIntervalFor,
  hopMaxFor,
  hvhPose,
  hvhPitch,
  chickenHeadCenter,
  defaultHvhLoadout,
  HVH,
  moveSpeedFor,
  openSpots,
  isWeaponId,
  makeRay,
  meleeHit,
  packPlayer,
  pelletDirections,
  pointOnRay,
  rayChicken,
  raycastPenetrating,
  raycastWorld,
  round,
  softBoxTest,
  wallbangScale,
  WALLBANG,
  shotSeed,
  shotUsesAmmo,
  takeShot,
  spreadFor,
  stepPlayer,
  wrapAngle,
  type Appearance,
  type BlockKind,
  type BuyResult,
  type BlockState,
  type CollisionWorld,
  type FireRequest,
  type FlagState,
  type InputFrame,
  type JoinResponse,
  type KillCause,
  type MapDef,
  type MapId,
  type MatchPhase,
  type MatchState,
  type ModeDef,
  type ModeId,
  type PlayerInfo,
  type RoomInfo,
  type RoomSummary,
  type ScoreRow,
  type SpawnPoint,
  type Team,
  type ThrowRequest,
  type MeleeTarget,
  type RoundState,
  type ZombieJoin,
  type Vec3,
  type WeaponDef,
  type WeaponId,
  type WorldSnapshot,
  DEFAULT_MELEE,
  MIN_LEVEL,
  RANKED,
  isKnifeSkin,
  isMelee,
  levelFor,
  rankedPoints,
  carAimSpeed,
  stepAnimation, defaultHvhCore, fakeLagTicks, rayHvhChicken, buildHvhMatrix, traceHvhCover,
  hvhHitDamage, auditShot, type ShotAudit,
  hvhWeapon, hvhSpread, unpackPlayer, hvhStance,
  KILL_FLAGS,
  teamName,
  teamSwitchBlocked,
} from '@game/shared';
import type { GameServer, GameSocket } from '../types';
import { isFiniteNumber, isRecord, sanitizeText } from '../util';
import { AntiCheat, type AntiCheatMode } from './AntiCheat';
import { BotSystem } from './BotSystem';
import { LootSystem } from './LootSystem';
import { ProjectileSystem } from './ProjectileSystem';
import { ServerPlayer } from './ServerPlayer';
import { VehicleSystem } from './VehicleSystem';

export interface RoomOptions {
  id: string;
  code: string;
  name: string;
  mode: ModeId;
  map: MapId;
  private: boolean;
  /** AI players to keep in the room. */
  bots?: number;
  /** Public quick-play rooms top themselves up with bots while few humans are around. */
  fillBots?: boolean;
  /** "Without bots": no bots at all; the match waits for enough real players. */
  noBots?: boolean;
  /** Ranked rooms: what the anti-cheat does about cheaters (default: removes them). */
  antiCheat?: AntiCheatMode;
}

/** What the room needs to know about a player joining (loaded from their account). */
/** Where a bot should go for the mode, and whether to hold use (E) once there. */
export interface BotGoal {
  x: number;
  z: number;
  /** Hold use here (plant / defuse) instead of walking. */
  use?: boolean;
}

export interface PlayerProfile {
  userId: number | null;
  name: string;
  appearance: Appearance;
  loadout: WeaponId[];
  bot?: boolean;
  /** Developer account: the name glows rainbow for everyone. */
  dev?: boolean;
  /** Rank level, 1–10. */
  rank?: number;
  /** Team modes: put them on this team (their party is on it). */
  team?: Team;
}

export interface MatchResult {
  userId: number;
  pid: number;
  kills: number;
  /** Kills that were headshots. */
  headshots?: number;
  deaths: number;
  won: boolean;
  coins: number;
  xp: number;
}

export interface RoomHooks {
  /** Persist rewards; returns each user's new coin and rank-point totals. */
  onMatchEnd?(room: GameRoom, results: MatchResult[]): Map<number, { coins: number; xp: number; levelCoins: number; dailyCoins?: number }>;
  /** Called when the last human leaves. */
  onEmpty?(room: GameRoom): void;
  /** The anti-cheat caught someone: record it and (when `remove`) take them out of the room. */
  onCheat?(room: GameRoom, player: ServerPlayer, reason: string, details: Record<string, unknown>, remove: boolean): void;
}

const THROW_COOLDOWN_MS = 600;
/** Fire-rate checks allow a little jitter: packets bunch up on the way to the server. */
const FIRE_RATE_TOLERANCE = 0.8;
const KILL_SCORE = 100;
/** A shot through this close to a smoke cloud's middle counts as "through smoke". */
const SMOKE_SIGHT_RADIUS = 3.4;
/** Spread spawns: further than this from every enemy counts as safe. */
const SPREAD_SAFE = 28;
const HEADSHOT_BONUS = 25;
const SUICIDE_PENALTY = 50;
/** How long after switching team (M) before you can switch again. */
const TEAM_SWITCH_COOLDOWN_MS = 5000;

export class GameRoom {
  readonly info: RoomInfo;
  readonly mode: ModeDef;
  readonly map: MapDef;
  readonly world: CollisionWorld;
  /** Socket.IO room name for broadcasts. */
  readonly channel: string;
  readonly io: GameServer;
  readonly players = new Map<number, ServerPlayer>();
  readonly projectiles: ProjectileSystem;
  readonly loot: LootSystem;
  readonly vehicles: VehicleSystem | null;
  /** FaceChiken only: fog of war and cheat detection. */
  readonly antiCheat: AntiCheat | null;
  readonly bots: BotSystem;

  private readonly hooks: RoomHooks;
  /** Whether a collision id is a box bullets go through (wallbang). */
  protected readonly isSoft: (id: number) => boolean;
  private readonly botTarget: number | null;
  private readonly fillBots: boolean;
  /** Never any bots here (ranked, Squad Up, or a room opened "without bots"). */
  private readonly noBots: boolean;
  private nextBotCheck = 0;
  private readonly bySocket = new Map<string, ServerPlayer>();
  private nextPid = 1;
  private match: MatchState;
  private readonly tickTimer: NodeJS.Timeout;
  private readonly snapshotTimer: NodeJS.Timeout;
  private lastTick = performance.now();
  private accumulator = 0;
  private closed = false;
  hvhTick = 0;
  private readonly publicStates = new Map<number, { until: number; shot: number; state: import('@game/shared').PlayerState }>();

  constructor(io: GameServer, options: RoomOptions, hooks: RoomHooks = {}) {
    this.io = io;
    this.hooks = hooks;
    this.mode = MODES[options.mode];
    this.map = MAPS[options.map];
    this.world = createCollisionWorld(this.map);
    this.isSoft = softBoxTest(this.map, (id) => this.blockKind(id));
    this.channel = `room:${options.id}`;
    this.info = {
      id: options.id,
      code: options.code,
      name: options.name,
      mode: options.mode,
      map: options.map,
      maxPlayers: this.mode.maxPlayers,
      private: options.private,
      ...(options.noBots === true || this.mode.noBots === true || this.mode.ranked === true ? { noBots: true } : {}),
    };
    this.projectiles = new ProjectileSystem(this);
    this.loot = new LootSystem(this);
    this.vehicles = this.mode.vehicles && this.map.vehicles.length > 0 ? new VehicleSystem(this) : null;
    this.bots = new BotSystem(this);
    this.botTarget = options.bots && options.bots > 0 ? Math.min(options.bots, this.mode.maxPlayers - 1) : null;
    this.fillBots = options.fillBots === true;
    this.noBots = options.noBots === true || this.mode.noBots === true || this.mode.ranked === true;
    this.antiCheat = this.mode.ranked && options.antiCheat !== 'off' ? new AntiCheat(this, options.antiCheat ?? 'enforce') : null;
    this.match = {
      phase: this.mode.building ? 'playing' : 'waiting',
      endsAt: null,
      teamScores: [0, 0],
      winnerTeam: 0,
      winnerPid: 0,
      mvpPid: 0,
    };
    this.tickTimer = setInterval(() => this.tick(), 1000 / SIM_RATE);
    this.snapshotTimer = setInterval(() => this.broadcastSnapshot(), 1000 / SNAPSHOT_RATE);
  }

  get playerCount(): number {
    return this.players.size;
  }

  get humanCount(): number {
    let n = 0;
    for (const p of this.players.values()) if (!p.info.bot) n++;
    return n;
  }

  /** Bots step aside for humans, so only humans count towards full. */
  get isFull(): boolean {
    return this.humanCount >= (this.mode.maxHumans ?? this.mode.maxPlayers);
  }

  get phase(): MatchPhase {
    return this.match.phase;
  }

  summary(): RoomSummary {
    return {
      id: this.info.id,
      name: this.info.name,
      mode: this.info.mode,
      map: this.info.map,
      players: this.players.size,
      maxPlayers: this.mode.maxPlayers,
      phase: this.match.phase,
    };
  }

  playerFor(socketId: string): ServerPlayer | undefined {
    return this.bySocket.get(socketId);
  }

  areTeammates(a: ServerPlayer, b: ServerPlayer): boolean {
    return this.mode.teams && a !== b && a.info.team !== 0 && a.info.team === b.info.team;
  }

  /** Defense at the rules layer, even when an internal caller bypasses socket authorization. */
  enforceHvhRules(p: ServerPlayer): void {
    if (this.mode.id !== 'hvh') return;
    p.mods = null;
    p.frozen = false;
    for (const [id, mag] of p.mags) p.mags.set(id, Math.min(mag, WEAPONS[id].magazine));
  }

  updateHvhPose(p: ServerPlayer, now: number): void {
    if (this.mode.id !== 'hvh') return;
    if (!p.hvhEnabled) { p.yaw = p.fakeYaw = p.lookYaw; p.animation.eyeYaw = p.animation.bodyYaw = p.animation.lowerBodyYaw = p.lookYaw; p.fakePitch = p.pitch; return; }
    const settings = p.hvh.skeet;
    if (settings?.enabled && (settings.atTargets || settings.freestanding) && now - p.hvhCoverAt >= 100) {
      p.hvhCoverAt = now; p.hvhCoverSide = 0; p.hvhTargetYaw = undefined;
      let nearest: import('@game/shared').PlayerState | undefined, distance = 80;
      for (const packed of this.snapshot(now, p.pid).p) {
        const enemy = unpackPlayer(packed);
        if (enemy.pid === p.pid || !enemy.alive || enemy.vehicle || this.areTeammates(p, this.players.get(enemy.pid)!)) continue;
        const d = Math.hypot(enemy.x - p.state.x, enemy.z - p.state.z);
        if (d < distance) { nearest = enemy; distance = d; }
      }
      if (nearest && distance > 0.1) {
        p.hvhTargetYaw = Math.atan2(-(nearest.x - p.state.x), -(nearest.z - p.state.z));
        if (settings.freestanding) {
          const from = { x: nearest.x, y: nearest.y + eyeHeightOf(nearest), z: nearest.z };
          const pose = hvhPose(p.lookYaw, p.hvh, now, false, false, { targetYaw: p.hvhTargetYaw });
          const requested = settings.states[hvhStance({ speed: p.state.horizontalSpeed, crouching: p.state.crouching, onGround: p.state.onGround })].desync * Math.PI / 180;
          const risk = (side: number) => {
            const matrix = buildHvhMatrix(p.state, pose.real + requested * side, bodyScale(p.state), hvhPitch(p.pitch, p.hvh));
            let total = 0;
            for (const box of matrix.boxes.filter(b => b.group === 'head' || b.group === 'chest')) {
              const dx = box.center.x - from.x, dy = box.center.y - from.y, dz = box.center.z - from.z, range = Math.hypot(dx, dy, dz);
              const ray = makeRay(from, { x: dx / range, y: dy / range, z: dz / range });
              const cover = traceHvhCover(ray, this.world, range, this.isSoft), hit = rayHvhChicken(ray, p.state.x, p.state.y, p.state.z, matrix.yaw, cover.wallDistance, matrix.scale, matrix.pitch);
              if (hit) total += hvhHitDamage(hvhWeapon(WEAPONS[nearest!.weapon]), hit, cover) * (box.group === 'head' ? 2 : 1);
            }
            return total;
          };
          const left = risk(-1), right = risk(1);
          p.hvhCoverSide = Math.abs(left - right) < 0.1 ? 0 : left < right ? -1 : 1;
        }
      }
    }
    const revealed = !p.alive || p.vehicle !== 0 || (now >= p.concealUntil && now < p.revealUntil);
    const pose = hvhPose(p.lookYaw, p.hvh, now, p.lastInput?.invert === true, revealed,
      { speed: p.state.horizontalSpeed, onGround: p.state.onGround, crouching: p.state.crouching,
        targetYaw: p.hvhTargetYaw, coverSide: p.hvhCoverSide, seed: p.pid });
    p.animation.eyeYaw = pose.real;
    p.fakeYaw = pose.real;
    p.fakePitch = hvhPitch(p.pitch, p.hvh, revealed);
  }

  // ---------------------------------------------------------------------------
  // Membership
  // ---------------------------------------------------------------------------

  join(socket: GameSocket | null, profile: PlayerProfile): JoinResponse {
    if (this.closed) return { ok: false, error: 'That room has closed.' };
    if (this.isFull) return { ok: false, error: 'That room is full.' };
    // A human takes a bot's seat (on their own team, when they come with one).
    const wantTeam = this.mode.teams && profile.team ? profile.team : 0;
    if (wantTeam && this.teamSize(wantTeam) >= this.mode.maxPlayers / 2) this.bots.removeOne(wantTeam);
    if (this.players.size >= this.mode.maxPlayers && !this.bots.removeOne()) return { ok: false, error: 'That room is full.' };
    if (socket && this.bySocket.has(socket.id)) return { ok: false, error: 'Already in this room.' };

    const melee = profile.loadout.find((w) => isMelee(w)) ?? DEFAULT_MELEE;
    const info: PlayerInfo = {
      pid: this.nextPid++,
      name: profile.name,
      team: this.mode.teams ? (wantTeam || this.pickTeam()) : 0,
      appearance: profile.appearance,
      // Knife-only and bomb modes still let you bring your own knife skin.
      loadout: this.mode.weapons ? this.mode.weapons.map((w) => (w === 'knife' && isKnifeSkin(melee) ? melee : w)) : profile.loadout.length > 0 ? profile.loadout : ['pistol'],
      bot: profile.bot ?? false,
      kills: 0,
      deaths: 0,
      score: 0,
      rank: profile.rank ?? MIN_LEVEL,
      ...(profile.dev ? { dev: true } : {}),
    };
    const player = new ServerPlayer(info, socket, profile.userId);
    player.hvhMode = this.mode.id === 'hvh';
    player.melee = melee;
    const now = performance.now();
    if (this.mode.id === 'hvh' && socket) player.hvhPreparing = true;
    else this.spawn(player, now, false);
    this.players.set(info.pid, player);
    if (socket) {
      this.bySocket.set(socket.id, player);
      void socket.join(this.channel);
      socket.to(this.channel).emit('playerJoined', info);
    } else {
      this.io.to(this.channel).emit('playerJoined', info);
    }
    // Zombies come and go by the dozen: no chat line for each.
    if (!(this.mode.zombies && info.bot)) this.systemMessage(`${info.name} joined`);
    this.onPlayerJoin(player, now);
    this.updateMatch(now);

    const { projectiles, smokes } = this.projectiles.joinState(now);
    return {
      ok: true,
      selfPid: info.pid,
      room: this.info,
      players: [...this.players.values()].map((p) => p.info),
      snapshot: this.snapshotFor(player, now),
      match: this.match,
      loot: this.loot.states(),
      drops: this.loot.dropStates(),
      projectiles,
      smokes,
      blocks: [],
      flags: [],
      round: null,
      money: 0,
      ...this.joinExtras(player),
    };
  }

  /** Kind of a Sandbox block by id (only the Sandbox room has blocks). */
  protected blockKind(_blockId: number): BlockKind | undefined {
    return undefined;
  }

  /** Mode-specific state for players joining mid-match (blocks, flags, the bomb round). */
  protected joinExtras(_player: ServerPlayer): Partial<{ blocks: BlockState[]; flags: FlagState[]; round: RoundState | null; money: number; zombie: ZombieJoin }> {
    return {};
  }

  /** Hook for mode rules about a player who just joined (ChikenBomb: wait for the next round). */
  protected onPlayerJoin(_player: ServerPlayer, _now: number): void {}

  /** What a bot should go and do for the mode (ChikenBomb: plant / defuse), or null to just roam and fight. */
  botGoal(_p: ServerPlayer): BotGoal | null {
    return null;
  }

  /** ChikenBomb buy menu; nothing to buy anywhere else. */
  handleBuy(p: ServerPlayer, _itemId: unknown): BuyResult {
    return { ok: false, error: 'There is no buy menu in this mode.', money: p.money };
  }

  /** Shooting and throwing are off (ChikenBomb buy time). */
  /** Modes can hold a player still (planting a bomb). */
  protected movementLocked(_p: ServerPlayer): boolean {
    return false;
  }

  protected actionsBlocked(): boolean {
    return false;
  }

  leave(socketId: string): void {
    const player = this.bySocket.get(socketId);
    if (!player) return;
    this.bySocket.delete(socketId);
    void player.socket?.leave(this.channel);
    this.removePlayer(player);
  }

  removePlayer(player: ServerPlayer): void {
    if (!this.players.has(player.pid)) return;
    this.vehicles?.eject(player);
    this.onPlayerLeave(player);
    this.players.delete(player.pid);
    this.publicStates.delete(player.pid);
    this.bots.forget(player.pid);
    this.antiCheat?.forget(player);
    this.io.to(this.channel).emit('playerLeft', player.pid);
    if (this.mode.zombies && player.info.bot) return;
    this.systemMessage(`${player.info.name} left`);
    this.emitScores();
    this.updateMatch(performance.now());
    if (this.humanCount === 0) this.hooks.onEmpty?.(this);
  }

  close(reason = 'Room closed'): void {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.tickTimer);
    clearInterval(this.snapshotTimer);
    this.io.to(this.channel).emit('roomClosed', reason);
    for (const p of this.players.values()) void p.socket?.leave(this.channel);
    this.players.clear();
    this.publicStates.clear();
    this.bySocket.clear();
  }

/** Everyone on a team, bots included. */
  private teamSize(team: Team): number {
    let n = 0;
    for (const p of this.players.values()) if (p.info.team === team) n++;
    return n;
  }

  /**
   * Where a party of `size` would go: the team with the most room for humans (bots give up
   * their seats), 0 in free-for-all modes, or null if they don't fit together.
   */
  teamForParty(size: number): Team | null {
    if (this.closed || this.humanCount + size > this.mode.maxPlayers) return null;
    if (!this.mode.teams) return 0;
    const humans: [number, number] = [0, 0];
    for (const p of this.players.values()) if (!p.info.bot && (p.info.team === 1 || p.info.team === 2)) humans[p.info.team - 1]++;
    const free = (t: 1 | 2) => this.mode.maxPlayers / 2 - humans[t - 1];
    const best: 1 | 2 = free(1) === free(2) ? this.pickTeam() : free(1) > free(2) ? 1 : 2;
    return free(best) >= size ? best : null;
  }

  private pickTeam(): 1 | 2 {
    let red = 0;
    let blue = 0;
    for (const p of this.players.values()) {
      if (p.info.team === 1) red++;
      else if (p.info.team === 2) blue++;
    }
    if (red !== blue) return red < blue ? 1 : 2;
    const [rs, bs] = this.match.teamScores;
    if (rs !== bs) return rs < bs ? 1 : 2;
    return Math.random() < 0.5 ? 1 : 2;
  }

  // ---------------------------------------------------------------------------
  // Client messages
  // ---------------------------------------------------------------------------

  handleInput(p: ServerPlayer, raw: unknown): void {
    this.enforceHvhRules(p);
    let frame = parseInput(raw);
    if (!frame || p.removedForCheating || frame.seq <= p.lastSeq) return;
    if (!p.takeInputToken(performance.now())) return; // over budget: the client's reconciliation corrects it
    const assisted = this.mode.id === 'hvh' && p.hvhEnabled && !p.hvhPreparing;
    frame.autoHop = assisted && frame.autoHop === true;
    frame.subtickStrafe = assisted && frame.subtickStrafe === true;
    // Ranked shot validation remembers accepted view commands immediately; movement still waits for its tick.
    if (p.commands.enqueue(frame)) this.antiCheat?.onInput(p, frame.yaw, frame.pitch);
  }

  private applyInput(p: ServerPlayer, frame: Readonly<InputFrame>): void {
    if (p.removedForCheating) return;
    if ((frame.autoHop || frame.subtickStrafe) && (this.mode.id !== 'hvh' || !p.hvhEnabled || p.hvhPreparing)) {
      frame = { ...frame, autoHop: false, subtickStrafe: false };
    }
    p.lastSeq = frame.seq;
    p.useHeld = frame.use === true;
    // Planting / defusing (bomb modes): held still, crouched, whatever keys are down.
    if (this.movementLocked(p)) frame = { ...frame, forward: 0, right: 0, jump: false, crouch: true };
    p.yaw = frame.yaw;
    p.lookYaw = frame.yaw;
    p.pitch = frame.pitch;
    p.lastInput = frame;
    this.updateHvhPose(p, performance.now());
    // Dead chickens don't move, but we still acknowledge the input so the client can drop it.
    if (!p.alive || p.frozen) { p.state.horizontalSpeed = 0; return; }
    if (p.vehicle && this.vehicles) {
      this.vehicles.drive(p, frame);
      return;
    }
    stepPlayer(p.state, frame, SIM_DT, this.world, p.mods, hopMaxFor(p.weapon), moveSpeedFor(p.weapon), this.mode.id === 'hvh');
  }

  handleFire(p: ServerPlayer, raw: unknown): void {
    this.enforceHvhRules(p);
    const req = parseFire(raw);
    if (!req || !p.alive || p.removedForCheating || this.match.phase === 'ended' || this.actionsBlocked()) return;
    // A shot waits for the movement it was fired after (`command`): the client aims from where it
    // stands after that input, so firing from an older server position (moving, airborne) shifts
    // every bullet away from where the crosshair was, even with no spread at all.
    const late = req.command !== undefined && req.command > p.lastSeq;
    if (this.mode.id === 'hvh' || late || p.fireQueue.length > 0) {
      if (p.fireQueue.length < 4 && req.shot > p.lastShotSeq && !p.fireQueue.some(r => r.shot === req.shot)) p.fireQueue.push(Object.freeze({ ...req, intent: req.intent ? Object.freeze({ ...req.intent }) : undefined }));
      return;
    }
    this.executeFire(p, req, performance.now());
  }

  private executeFire(p: ServerPlayer, req: FireRequest, now: number): void {
    if (!p.alive || p.removedForCheating || this.match.phase === 'ended' || this.actionsBlocked()) return;
    if (req.shot <= p.lastShotSeq) return;
    if (req.weapon !== p.weapon) { this.rejectHvhShot(p, req, 'SERVER_REJECTED'); return; }
    const w = this.mode.id === 'hvh' ? hvhWeapon(WEAPONS[req.weapon]) : WEAPONS[req.weapon];
    // From the car: guns and launchers, but no knifing out of the driver's seat.
    if (p.vehicle && w.melee) return;
    const mods = p.mods;
    if (now < p.switchReadyAt || p.reloadUntil > 0 || p.mag <= 0) { this.rejectHvhShot(p, req, 'SERVER_REJECTED'); return; }
    const tactical = this.mode.id === 'hvh';
    if (tactical && (req.t < now - MAX_REWIND_MS || req.t > now + 16)) {
      this.rejectHvhShot(p, req, 'RECORD_INVALID'); return;
    }
    const core = p.hvh.core ?? defaultHvhCore();
    const mode = p.hvhEnabled && (core.era === 'tickbase' || core.era === 'defensive') && !w.projectile && !w.melee && !w.burst
      && (p.hvh.exploit !== 'doubleTap' || p.mag >= 2) ? p.hvh.exploit : 'off';
    const permission = tactical && !w.burst ? p.resource.fire(w.fireInterval, mode, this.hvhTick) : { shots: 1, hidden: false };
    if (!permission.shots) { this.rejectHvhShot(p, req, 'SERVER_REJECTED'); return; }
    const shotCount = Math.min(permission.shots, p.mag);
    const interval = fireIntervalFor(w, mods);
    // Fire rate (and burst timing), with a little slack for network jitter.
    const timing = { lastFireAt: p.lastFireAt, burstStart: p.burstStart, burstShots: p.burstShots };
    if ((!tactical || w.burst) && !takeShot(w, interval, timing, now, tactical ? 1 : FIRE_RATE_TOLERANCE)) {
      this.rejectHvhShot(p, req, 'SERVER_REJECTED'); return;
    }
    p.burstStart = timing.burstStart;
    p.burstShots = timing.burstShots;

    p.lastShotSeq = req.shot;
    p.lastFireAt = now;
    if (shotUsesAmmo(w, mods)) p.mags.set(req.weapon, p.mag - shotCount);
    p.shieldUntil = 0;
    p.aiming = req.aiming;
    if (this.mode.id === 'hvh' && p.hvhEnabled) {
      const hidden = permission.hidden;
      p.concealUntil = hidden ? now + HVH.hideMs : 0;
      p.revealUntil = now + HVH.revealMs + (hidden ? HVH.hideMs : 0);
      if (!hidden) {
        p.animation.eyeYaw = Math.atan2(-req.dx, -req.dz);
        p.animation.bodyYaw = p.animation.eyeYaw;
        p.yaw = p.animation.bodyYaw; p.fakeYaw = p.animation.eyeYaw;
        p.fakePitch = Math.asin(clamp(req.dy / Math.hypot(req.dx, req.dy, req.dz), -1, 1));
      }
    }

    const eye = this.eyeOf(p);
    const len = Math.hypot(req.dx, req.dy, req.dz);
    const aim = { x: req.dx / len, y: req.dy / len, z: req.dz / len };
    // Ranked: a shot nowhere near where you were looking is thrown away (silent aim).
    if (this.antiCheat && !w.melee && !this.antiCheat.allowShot(p, aim)) return;

    if (w.projectile) {
      this.projectiles.launch(w.projectile, p, this.safeLaunchPoint(eye, aim), aim, req.shot, now, (mods?.projectileSpeed ?? 1) * (w.projectileSpeed ?? 1), w.id);
      this.io.to(this.channel).emit('shot', { pid: p.pid, weapon: req.weapon, ox: eye.x, oy: eye.y, oz: eye.z, ends: [], hits: [] });
      return;
    }
    const rewindTo = clamp(req.t, now - MAX_REWIND_MS, now);
    if (w.melee) {
      this.swing(p, w, eye, aim, rewindTo, now);
      return;
    }

    // A moving car shakes your aim like walking does.
    const seat = this.vehicles?.seatOf(p);
    const spread = (tactical ? hvhSpread(w, p.state.horizontalSpeed, !p.state.onGround, req.aiming, p.weaponHeat)
      : spreadFor(w, seat ? carAimSpeed(seat.speed) : p.state.horizontalSpeed, !p.state.onGround, req.aiming)) * (mods?.spread ?? 1);
    if (tactical) p.weaponHeat = Math.min(3, p.weaponHeat + 0.25 * shotCount);
    const dirs = pelletDirections(w, aim, spread, shotSeed(p.pid, req.shot));
    if (shotCount === 2) dirs.push(...pelletDirections(w, aim, spread, shotSeed(p.pid, req.shot) ^ 0x51ed270b));
    const targets = this.targetsAt(p, rewindTo, now);
    const target = req.intent ? targets.find(t => t.key.pid === req.intent!.target) : undefined;
    let intentBlocked = false;
    if (tactical && req.intent && target) {
      const ray = makeRay(eye, aim);
      const predicted = rayHvhChicken(ray, target.x, target.y, target.z, req.intent.yaw, w.range, target.scale, target.pitch);
      const actual = rayHvhChicken(ray, target.x, target.y, target.z, target.yaw, w.range, target.scale, target.pitch);
      const distance = predicted && actual ? Math.min(predicted.t, actual.t) : predicted?.t ?? actual?.t;
      // Observe obstruction before pellets can smash a loot box.
      if (distance !== undefined) intentBlocked = targets.some(t => t !== target
        && !!rayHvhChicken(ray, t.x, t.y, t.z, t.yaw, distance, t.scale, t.pitch))
        || !!this.loot.raycast(ray, distance) || !!this.vehicles?.raycast(ray, distance, p);
    }

    const ends: number[] = [];
    const hits: number[] = [];
    const damageByVictim = new Map<ServerPlayer, { amount: number; headshot: boolean; flags: number }>();
    // Kill tags that hold for the whole shot.
    const shotFlags = (w.scope && !req.aiming ? KILL_FLAGS.noscope : 0) | this.shooterFlags(p, now);
    for (const d of dirs) {
      const ray = makeRay(eye, d);
      // Wallbang: crates, hay and wood don't stop bullets, they just weaken them.
      const { soft, wall } = raycastPenetrating(ray, this.world, w.range, this.isSoft, this.mode.wallbang ? WALLBANG.maxBoxes : 0);
      const cover = tactical ? traceHvhCover(ray, this.world, w.range, this.mode.wallbang ? this.isSoft : undefined) : null;
      let maxT = cover ? cover.wallDistance : wall ? wall.t : w.range;
      let kind = 0;
      let victim: ServerPlayer | null = null;
      let victimAt: MeleeTarget<ServerPlayer> | null = null;
      let headshot = false;

      for (const t of targets) {
        const hit = (tactical ? rayHvhChicken : rayChicken)(ray, t.x, t.y, t.z, t.yaw, maxT, t.scale, t.pitch);
        if (hit) {
          maxT = hit.t;
          victim = t.key;
          victimAt = t;
          headshot = hit.headshot;
          kind = hit.headshot ? 2 : 1;
        }
      }
      const box = this.loot.raycast(ray, maxT);
      if (box) {
        maxT = box.t;
        victim = null;
        kind = 0;
        this.loot.smash(box.id, now);
      }
      const car = this.vehicles?.raycast(ray, maxT, p);
      if (car) {
        maxT = car.t;
        victim = null;
        kind = 0;
        this.vehicles!.damage(car.id, damageAt(w, car.t) * wallbangScale(soft, car.t), p, now);
      }

      // Ranked: how close to the middle of the head / body single bullets land (aim lock).
      if (victim && victimAt && w.pellets === 1) this.antiCheat?.onHit(p, eye, aim, victimAt, headshot);
      if (victim) {
        const entry = damageByVictim.get(victim) ?? { amount: 0, headshot: false, flags: shotFlags };
        if (soft.some((s) => s.t < maxT)) entry.flags |= KILL_FLAGS.wallbang;
        if (this.throughSmoke(eye, pointOnRay(ray, maxT), now)) entry.flags |= KILL_FLAGS.smoke;
        const trueHit = tactical && victimAt ? rayHvhChicken(ray, victimAt.x, victimAt.y,
          victimAt.z, victimAt.yaw, maxT + 0.001, victimAt.scale, victimAt.pitch) : null;
        entry.amount += trueHit && cover ? hvhHitDamage(w, trueHit, cover) : damageAt(w, maxT) * (headshot ? w.headshotMultiplier : 1) * wallbangScale(soft, maxT);
        entry.headshot ||= headshot;
        damageByVictim.set(victim, entry);
      }
      const end = pointOnRay(ray, maxT);
      ends.push(round(end.x, 2), round(end.y, 2), round(end.z, 2));
      hits.push(kind);
    }

    let audit: ShotAudit | undefined;
    if (tactical && req.intent) {
      const intendedPlayer = this.players.get(req.intent.target);
      const valid = Math.abs(req.t - req.intent.recordT) < 1 && now - req.t <= MAX_REWIND_MS
        && (!intendedPlayer?.alive || !!target);
      let reason = auditShot(req.intent, eye, aim, dirs, target ? buildHvhMatrix(target, target.yaw, target.scale, target.pitch) : null,
        valid, this.world, w, this.mode.wallbang ? this.isSoft : undefined);
      const rawDamage = target ? damageByVictim.get(target.key)?.amount ?? 0 : 0;
      const damage = target && now >= target.key.shieldUntil
        ? Math.min(target.key.hp, rawDamage - Math.min(target.key.armor, rawDamage * PLAYER.armorAbsorb)) : 0;
      if (intentBlocked && (reason === 'RESOLVER' || reason === 'SPREAD')) reason = 'OCCLUSION';
      if (reason === 'HIT' && rawDamage === 0) reason = 'OCCLUSION';
      else if (reason === 'HIT' && damage === 0) reason = 'SERVER_REJECTED';
      audit = { target: req.intent.target, source: req.intent.source, recordT: req.intent.recordT, reason, damage,
        headshot: !!target && damageByVictim.get(target.key)?.headshot === true };
    }
    const event: import('@game/shared').ShotEvent = {
      shot: req.shot,
      pid: p.pid,
      weapon: req.weapon,
      ox: round(eye.x, 2),
      oy: round(eye.y, 2),
      oz: round(eye.z, 2),
      ends,
      hits,
      burst: shotCount,
    };
    if (p.socket && tactical) {
      p.socket.to(this.channel).emit('shot', event);
      p.socket.emit('shot', { ...event, audit, mag: p.mag, charge: p.resource.charge,
        readyAt: now + Math.max(0, p.resource.nextAttackTick - p.resource.playerTick) * SIM_DT * 1000 });
    } else this.io.to(this.channel).emit('shot', event);
    if (audit) p.resolver.feedback(audit.target, audit.source, audit.reason, now, audit.headshot === true);
    if (tactical) for (const enemy of this.players.values()) {
      if (enemy === p || !enemy.alive || !enemy.hvhEnabled || this.areTeammates(p, enemy)) continue;
      const { x: hx, y: hy, z: hz } = chickenHeadCenter(enemy.state, enemy.yaw, bodyScale(enemy.state), enemy.fakePitch);
      const threatened = dirs.some((d, i) => {
        const along = (hx - eye.x) * d.x + (hy - eye.y) * d.y + (hz - eye.z) * d.z;
        const near = Math.hypot(hx - eye.x - along * d.x, hy - eye.y - along * d.y, hz - eye.z - along * d.z);
        const endDistance = Math.hypot(ends[i * 3]! - eye.x, ends[i * 3 + 1]! - eye.y, ends[i * 3 + 2]! - eye.z);
        return along > 0 && along <= endDistance + 0.3 && near < 0.7;
      });
      if (threatened && this.hvhTick - enemy.lastThreatTick >= 12) {
        enemy.lastThreatTick = this.hvhTick;
        if (enemy.hvh.core?.antiBruteforce) enemy.antiBruteSide *= -1;
        if (enemy.hvh.core?.defensive && enemy.hvh.core.era === 'defensive' && enemy.resource.defend(this.hvhTick)) enemy.concealUntil = now + 125;
      }
    }
    for (const [victim, { amount, headshot, flags }] of damageByVictim) this.damage(victim, p, amount, headshot, req.weapon, eye, now, flags);
  }

  /** Kill tags about the shooter: in mid-air, blinded by a flashbang. */
  private shooterFlags(p: ServerPlayer, now: number): number {
    return (!p.state.onGround && !p.vehicle ? KILL_FLAGS.air : 0) | (now < p.blindUntil ? KILL_FLAGS.blind : 0);
  }

  /** Does the line from `a` to `b` pass through a smoke cloud? */
  private throughSmoke(a: Vec3, b: Vec3, now: number): boolean {
    for (const s of this.projectiles.activeSmokes(now)) {
      const c = { x: s.x, y: Math.max(0.4, s.y) + 1.2, z: s.z };
      const d = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z };
      const len2 = d.x * d.x + d.y * d.y + d.z * d.z || 1;
      const t = Math.max(0, Math.min(1, ((c.x - a.x) * d.x + (c.y - a.y) * d.y + (c.z - a.z) * d.z) / len2));
      if (Math.hypot(a.x + d.x * t - c.x, a.y + d.y * t - c.y, a.z + d.z * t - c.z) < SMOKE_SIGHT_RADIUS) return true;
    }
    return false;
  }

  private rejectHvhShot(p: ServerPlayer, req: FireRequest, reason: import('@game/shared').ShotReason): void {
    if (this.mode.id === 'hvh') p.socket?.emit('shot', { pid: p.pid, shot: req.shot, weapon: req.weapon, ox: p.state.x, oy: p.state.y, oz: p.state.z,
      ends: [], hits: [], mag: p.mag, charge: p.resource.charge,
      readyAt: p.simulationTime + Math.max(0, p.resource.nextAttackTick - p.resource.playerTick) * SIM_DT * 1000,
      audit: req.intent ? { target: req.intent.target, source: req.intent.source, reason, recordT: req.intent.recordT, damage: 0 } : undefined });
  }

  /** Where `p` shoots and throws from: their eyes, or the driver's seat in a car. */
  eyeOf(p: ServerPlayer): Vec3 {
    const seat = this.vehicles?.seatOf(p);
    if (seat) return { x: seat.x, y: seat.y + PLAYER.eyeHeight, z: seat.z };
    return { x: p.state.x, y: p.state.y + eyeHeightOf(p.state), z: p.state.z };
  }

  /**
   * Every enemy `p` could hit, where they were at `rewindTo` (lag compensation). Drivers sit
   * in their seat: the car's body takes the bullets that hit it, but a head above it can be shot.
   */
  private targetsAt(p: ServerPlayer, rewindTo: number, now = performance.now()): MeleeTarget<ServerPlayer>[] {
    const targets: MeleeTarget<ServerPlayer>[] = [];
    for (const t of this.players.values()) {
      if (t === p || !t.alive || this.areTeammates(p, t)) continue;
      const past = this.mode.id === 'hvh' ? t.history.atValid(rewindTo, now) : t.history.at(rewindTo);
      if (this.mode.id === 'hvh' && !past) continue;
      if (past && !past.alive) continue;
      const seat = this.vehicles?.seatOf(t);
      if (seat) {
        // The car's offset from where it was then (the seat moves with it).
        const dx = (past?.x ?? t.state.x) - t.state.x;
        const dz = (past?.z ?? t.state.z) - t.state.z;
        targets.push({ key: t, x: seat.x + dx, y: seat.y, z: seat.z + dz, yaw: past?.yaw ?? t.yaw, scale: 1, pitch: past?.pitch ?? t.pitch });
        continue;
      }
      targets.push({ key: t, x: past?.x ?? t.state.x, y: past?.y ?? t.state.y, z: past?.z ?? t.state.z, yaw: past?.yaw ?? t.yaw,
        scale: past?.scale ?? bodyScale(t.state), pitch: past?.pitch ?? (this.mode.id === 'hvh' ? t.fakePitch : t.pitch) });
    }
    return targets;
  }

  /** A melee swing: hits the chicken in front (see meleeHit), or smashes a loot box in reach. */
  private swing(p: ServerPlayer, w: WeaponDef, eye: Vec3, aim: Vec3, rewindTo: number, now: number): void {
    const hit = meleeHit(eye, aim, w, this.targetsAt(p, rewindTo, now), this.world);
    if (!hit) {
      const box = this.loot.raycast(makeRay(eye, aim), w.range);
      if (box) this.loot.smash(box.id, now);
    }
    this.io.to(this.channel).emit('shot', {
      pid: p.pid,
      weapon: w.id,
      ox: round(eye.x, 2),
      oy: round(eye.y, 2),
      oz: round(eye.z, 2),
      ends: hit ? [round(hit.point.x, 2), round(hit.point.y, 2), round(hit.point.z, 2)] : [],
      hits: hit ? [hit.headshot ? 2 : 1] : [],
    });
    if (hit) this.damage(hit.key, p, w.damage * (hit.headshot ? w.headshotMultiplier : 1), hit.headshot, w.id, eye, now, this.shooterFlags(p, now));
  }

  handleReload(p: ServerPlayer): void {
    this.enforceHvhRules(p);
    const w = WEAPONS[p.weapon];
    if (!p.alive || p.reloadUntil > 0 || p.mag >= p.magazineSize(w.id)) return;
    p.reloadUntil = performance.now() + (p.mods?.instantReload ? 0.001 : w.reloadTime);
    p.aiming = false;
  }

  handleSwitch(p: ServerPlayer, slot: unknown): void {
    if (!Number.isInteger(slot) || (slot as number) < 0 || (slot as number) >= p.info.loadout.length) return;
    if (slot === p.weaponSlot) return;
    p.weaponSlot = slot as number;
    p.reloadUntil = 0;
    p.aiming = false;
    p.switchReadyAt = performance.now() + WEAPON_SWITCH_MS;
    p.burstShots = 0;
  }

  handleAim(p: ServerPlayer, aiming: unknown): void {
    if (typeof aiming === 'boolean') p.aiming = aiming && p.alive;
  }

  handleThrow(p: ServerPlayer, raw: unknown): void {
    const req = parseThrow(raw);
    const now = performance.now();
    if (!req || !p.alive || this.match.phase === 'ended' || this.actionsBlocked() || req.seq <= p.lastThrowSeq || now < p.nextThrowAt) return;
    // Developer "infinite flashbangs": the stack is refilled, so it never runs out.
    if (req.kind === 'flash' && p.mods?.infiniteFlashes) p.flashes = PLAYER.maxFlashes;
    if ((req.kind === 'egg' ? p.eggs : req.kind === 'smoke' ? p.smokes : p.flashes) <= 0) return;
    if (req.kind === 'egg') p.eggs--;
    else if (req.kind === 'smoke') p.smokes--;
    else if (p.mods?.infiniteFlashes) p.flashes = PLAYER.maxFlashes;
    else p.flashes--;
    p.lastThrowSeq = req.seq;
    p.nextThrowAt = now + THROW_COOLDOWN_MS;
    p.shieldUntil = 0;
    const eye = this.eyeOf(p);
    const dir = { x: req.dx, y: req.dy, z: req.dz };
    this.projectiles.launch(req.kind, p, this.safeLaunchPoint(eye, dir), dir, req.seq, now);
  }

  /** Zombie Apocalypse (C, and the Restart button); nothing in other modes. */
  handleZombieBuild(_p: ServerPlayer): void {}
  handleZombieRestart(_p: ServerPlayer): void {}

  /** Enter or leave the nearest vehicle (rooms with vehicles override this). */
  handleUseVehicle(p: ServerPlayer): void {
    this.vehicles?.use(p);
  }

  /** Sandbox building (the Sandbox room overrides these). */
  handleBuild(_p: ServerPlayer, _raw: unknown): void {}
  handleUnbuild(_p: ServerPlayer, _raw: unknown): void {}

  handleChat(p: ServerPlayer, raw: unknown, teamOnly = false): void {
    const text = sanitizeText(raw, CHAT_MAX_LENGTH);
    if (!text || !p.chatLimiter.take()) return;
    const message = { pid: p.pid, name: p.info.name, text, team: p.info.team, ...(p.info.dev ? { dev: true } : {}) };
    // Team chat: only the sender's team hears it (modes without teams: everyone).
    if (teamOnly && p.info.team > 0) {
      for (const q of this.players.values()) if (q.info.team === p.info.team) q.socket?.emit('chat', { ...message, teamOnly: true });
      return;
    }
    this.io.to(this.channel).emit('chat', message);
  }

  /** Throws start half a metre in front of the eye, unless a wall is right there. */
  private safeLaunchPoint(eye: Vec3, dir: Vec3): Vec3 {
    const len = Math.hypot(dir.x, dir.y, dir.z) || 1;
    const d = { x: dir.x / len, y: dir.y / len, z: dir.z / len };
    const wall = raycastWorld(makeRay(eye, d), this.world, 0.6);
    const dist = wall ? Math.max(0, wall.t - 0.2) : 0.5;
    return { x: eye.x + d.x * dist, y: eye.y + d.y * dist, z: eye.z + d.z * dist };
  }

  // ---------------------------------------------------------------------------
  // Combat
  // ---------------------------------------------------------------------------

  /** Applies damage (armor first), reports it to both sides, and kills when health runs out. */
  /** `flags`: how it was done (KILL_FLAGS), reported if it kills. */
  damage(victim: ServerPlayer, attacker: ServerPlayer | null, amount: number, headshot: boolean, cause: KillCause, from: Vec3, now: number, flags = 0): void {
    this.enforceHvhRules(victim);
    if (attacker) this.enforceHvhRules(attacker);
    if (!victim.alive || amount <= 0 || this.match.phase === 'ended') return;
    if (now < victim.shieldUntil) return;
    if (attacker && this.areTeammates(attacker, victim)) return;
    if (cause === 'rocket' && victim.mods?.noRocketDamage) return;
    // Developer damage multiplier (bullets, rockets, eggs, buggies alike).
    if (attacker?.mods) amount *= attacker.mods.damage;
    if (amount <= 0) return;

    let remaining = amount;
    if (victim.armor > 0) {
      const absorbed = Math.min(victim.armor, remaining * PLAYER.armorAbsorb);
      victim.armor -= absorbed;
      remaining -= absorbed;
    }
    victim.hp -= remaining;

    const event = {
      victim: victim.pid,
      attacker: attacker?.pid ?? 0,
      amount: Math.round(amount),
      hp: Math.max(0, Math.ceil(victim.hp)),
      armor: Math.ceil(victim.armor),
      headshot,
      fromX: round(from.x, 1),
      fromZ: round(from.z, 1),
    };
    victim.socket?.emit('damage', event);
    if (attacker && attacker !== victim) attacker.socket?.emit('damage', event);

    if (victim.hp <= 0) this.kill(victim, attacker, cause, headshot, now, flags);
  }

  /** `counted`: false for a death that isn't a kill or a suicide (switching team). */
  protected kill(victim: ServerPlayer, attacker: ServerPlayer | null, cause: KillCause, headshot: boolean, now: number, flags = 0, counted = true): void {
    victim.alive = false;
    victim.hp = 0;
    victim.reloadUntil = 0;
    victim.aiming = false;
    victim.respawnAt = now + this.mode.respawnMs;
    this.onPlayerDeath(victim, now);
    this.onKill(victim, attacker, cause, now);

    const scoring = counted && this.match.phase === 'playing' && !this.mode.building;
    if (scoring) {
      victim.info.deaths++;
      if (attacker && attacker !== victim) {
        attacker.info.kills++;
        if (headshot) attacker.headshotKills++;
        attacker.info.score += KILL_SCORE + (headshot ? HEADSHOT_BONUS : 0);
        if (this.mode.teams && this.mode.teamKills && attacker.info.team !== 0) this.match.teamScores[attacker.info.team - 1]++;
      } else {
        victim.info.score = Math.max(0, victim.info.score - SUICIDE_PENALTY);
      }
    }

    this.io.to(this.channel).emit('kill', { killer: attacker?.pid ?? 0, victim: victim.pid, cause, headshot, ...(flags && attacker && attacker !== victim ? { flags } : {}) });
    // Every kill leaves a random bonus where the victim fell (not in buy-menu modes).
    if (!this.mode.noDrops) this.loot.dropBonus({ x: victim.state.x, y: victim.state.y, z: victim.state.z }, now);
    if (scoring) {
      this.emitScores();
      this.checkScoreLimit(now);
    }
  }

  /** Hook for systems that care about deaths (dropping a carried flag, leaving a vehicle). */
  protected onPlayerDeath(victim: ServerPlayer, _now: number): void {
    this.vehicles?.eject(victim);
  }

  /** Hook for kill rewards (ChikenBomb money). Runs after onPlayerDeath. */
  protected onKill(_victim: ServerPlayer, _attacker: ServerPlayer | null, _cause: KillCause, _now: number): void {}

  /** Hook for systems that care about a player leaving the room (CTF drops the flag). */
  protected onPlayerLeave(_player: ServerPlayer): void {}

  /** Hook for systems hit by explosions other than players and loot (vehicles). */
  onBlast(centre: Vec3, radius: number, damage: number, owner: ServerPlayer | null, now: number): void {
    this.vehicles?.blast(centre, radius, damage, owner, now);
  }

  finishHvhSetup(p: ServerPlayer, panel: import('@game/shared').HvhPanelId): boolean {
    if (this.mode.id !== 'hvh' || this.match.phase === 'ended') return false;
    p.hvhPanel = panel;
    if (panel === 'manual') { p.hvh = defaultHvhLoadout(); p.hvhEnabled = false; }
    if (p.hvhPreparing) {
      p.hvhPreparing = false;
      this.spawn(p, performance.now(), true);
    }
    this.updateHvhPose(p, performance.now());
    return true;
  }

  /**
   * M: move `p` to the other team, decided here. Not where teams are fixed (teamSwitchBlocked).
   * Teams can't end up more than two real players apart, and a bot gives up its seat on a full
   * team (the bot system then refills the other one). Switching while alive costs that life,
   * as in Counter-Strike (not counted as a death), so it can't escape a fight or revive you.
   * Returns why not, or null when done.
   */
  switchTeam(p: ServerPlayer, now: number): string | null {
    const blocked = teamSwitchBlocked(this.mode);
    if (blocked) return blocked;
    if (p.info.bot || (p.info.team !== 1 && p.info.team !== 2)) return 'You are not on a team.';
    if (this.closed || this.match.phase === 'ended') return 'The match is over.';
    if (now < p.teamSwitchAt) return 'Wait a few seconds before switching again.';
    const from = p.info.team;
    const to: 1 | 2 = from === 1 ? 2 : 1;
    let humansFrom = 0;
    let humansTo = 0;
    for (const q of this.players.values()) {
      if (q.info.bot) continue;
      if (q.info.team === from) humansFrom++;
      else if (q.info.team === to) humansTo++;
    }
    if (humansTo + 1 - (humansFrom - 1) > 2) return `${teamName(this.mode, to)} already has more players.`;
    if (this.teamSize(to) >= this.mode.maxPlayers / 2 && !this.bots.removeOne(to)) return `${teamName(this.mode, to)} is full.`;
    p.teamSwitchAt = now + TEAM_SWITCH_COOLDOWN_MS;
    if (p.alive) this.kill(p, null, 'world', false, now, 0, false);
    p.info.team = to;
    // Bots even it out: one leaves the bigger side and the bot top-up refills the smaller one.
    if (this.teamSize(to) - this.teamSize(from) >= 2) this.bots.removeOne(to);
    this.announcePlayer(p);
    this.systemMessage(`${p.info.name} joined ${teamName(this.mode, to)}`);
    this.onTeamSwitched(p, now);
    return null;
  }

  /** Hook after a team switch (ChikenBomb puts you back in during buy time). */
  protected onTeamSwitched(_p: ServerPlayer, _now: number): void {}

  /** Puts a player back at a spawn point right away (developer tools). */
  respawnPlayer(p: ServerPlayer, now: number): void {
    this.vehicles?.eject(p);
    this.spawn(p, now, true);
  }

  /** Tells everyone a player's info changed (e.g. their loadout). */
  announcePlayer(p: ServerPlayer): void {
    this.io.to(this.channel).emit('playerUpdated', p.info);
  }

  protected spawn(p: ServerPlayer, now: number, announce: boolean): void {
    this.enforceHvhRules(p);
    this.publicStates.delete(p.pid);
    const point = this.pickSpawn(p);
    p.respawn(point.x, point.z, Math.atan2(point.x, point.z), now, this.mode.spawnProtectionMs ?? PLAYER.spawnProtectionMs);
    // Weapon-restricted modes (Knife Fight) have no grenades either.
    if (this.mode.weapons) p.eggs = p.smokes = p.flashes = 0;
    if (announce) this.io.to(this.channel).emit('spawn', { pid: p.pid, x: point.x, y: 0, z: point.z, yaw: p.yaw });
  }

  /** Open spots all over the map (spread-spawn modes), worked out once per room. */
  private spread: SpawnPoint[] | null = null;

  /** Where free-for-all chickens spawn and bots wander. */
  roamSpots(): readonly { x: number; z: number }[] {
    if (!this.mode.spreadSpawns || this.mode.building) return [...this.map.spawns, ...this.map.loot, ...this.map.flags];
    this.spread ??= [...this.map.spawns.map((s) => ({ x: s.x, z: s.z })), ...openSpots(this.map.spawns, this.world, this.map.halfSize)];
    return this.spread;
  }

  /**
   * Spread-spawn modes: anywhere open, as far as possible from living enemies and never in their
   * sight, so nobody is shot the moment they appear.
   */
  private pickSpreadSpawn(p: ServerPlayer): SpawnPoint {
    const enemies = [...this.players.values()].filter((o) => o !== p && o.alive && !this.areTeammates(p, o));
    const scored = this.roamSpots().map((spot) => {
      // Beyond SPREAD_SAFE metres every spot is as good as any other, so spawns vary.
      let nearest = SPREAD_SAFE;
      for (const e of enemies) nearest = Math.min(nearest, Math.hypot(e.state.x - spot.x, e.state.z - spot.z));
      return { spot, score: nearest + Math.random() * 6 };
    });
    scored.sort((a, b) => b.score - a.score);
    // Of the furthest few, the first that no enemy can see.
    const shortlist = scored.slice(0, 16);
    const hidden = shortlist.find(({ spot }) => !enemies.some((e) => this.canSeeSpot(e, spot)));
    return (hidden ?? shortlist[0])?.spot ?? this.map.spawns[0]!;
  }

  /** Could `viewer` see a chicken standing at `spot`? */
  private canSeeSpot(viewer: ServerPlayer, spot: { x: number; z: number }): boolean {
    const eye = { x: viewer.state.x, y: viewer.state.y + eyeHeightOf(viewer.state), z: viewer.state.z };
    const dx = spot.x - eye.x;
    const dy = 0.9 - eye.y;
    const dz = spot.z - eye.z;
    const dist = Math.hypot(dx, dy, dz);
    if (dist > 70) return false;
    return !raycastWorld(makeRay(eye, { x: dx / dist, y: dy / dist, z: dz / dist }), this.world, dist);
  }

  /** Team spawns in team modes; otherwise the free spot furthest from living enemies. */
  protected pickSpawn(p: ServerPlayer): SpawnPoint {
    if (this.mode.spreadSpawns && !this.mode.teams && !this.mode.building) return this.pickSpreadSpawn(p);
    const all = this.map.spawns;
    const team = p.info.team;
    const pool = this.mode.teams && team !== 0 ? all.filter((s) => s.team === team) : all;
    let best = pool[0] ?? all[0]!;
    let bestScore = -Infinity;
    for (const spawn of pool) {
      let nearest = 1000;
      for (const other of this.players.values()) {
        if (other === p || !other.alive || this.areTeammates(p, other)) continue;
        nearest = Math.min(nearest, Math.hypot(other.state.x - spawn.x, other.state.z - spawn.z));
      }
      // Never on top of someone already standing there (a whole team spawns at once in rounds).
      let taken = false;
      for (const other of this.players.values()) {
        if (other !== p && other.alive && Math.hypot(other.state.x - spawn.x, other.state.z - spawn.z) < PLAYER.radius * 3) taken = true;
      }
      const score = nearest + Math.random() * 4 - (taken ? 1000 : 0);
      if (score > bestScore) {
        bestScore = score;
        best = spawn;
      }
    }
    return best;
  }

  // ---------------------------------------------------------------------------
  // Match flow
  // ---------------------------------------------------------------------------

  private updateMatch(now: number): void {
    if (this.mode.building || this.closed) return;
    const m = this.match;
    const enough = this.players.size >= this.mode.minPlayers;
    switch (m.phase) {
      case 'waiting':
        if (enough) this.setPhase('countdown', now + MATCH.countdownMs);
        break;
      case 'countdown':
        if (!enough) this.setPhase('waiting', null);
        else if (now >= (m.endsAt ?? 0)) this.startMatch(now);
        break;
      case 'playing':
        // Needing a full lobby to start is not a reason to end a match when one person leaves.
        if (this.players.size < (this.mode.noBots ? Math.min(2, this.mode.minPlayers) : this.mode.minPlayers)) this.setPhase('waiting', null);
        else if (m.endsAt !== null && now >= m.endsAt) this.endMatch(now);
        break;
      case 'ended':
        if (now >= (m.endsAt ?? 0)) {
          if (enough) this.startMatch(now);
          else this.setPhase('waiting', null);
        }
        break;
    }
  }

  /** Skips waiting/countdown (private-room hosts, tests). */
  startNow(): void {
    if (!this.mode.building) this.startMatch(performance.now());
  }

  private setPhase(phase: MatchPhase, endsAt: number | null): void {
    this.match = { ...this.match, phase, endsAt };
    this.io.to(this.channel).emit('match', this.match);
  }

  private startMatch(now: number): void {
    if (this.antiCheat) {
      this.antiCheat.reset();
      this.systemMessage('🛡️ FaceChiken anti-cheat is on: fair play only.');
    }
    for (const p of this.players.values()) {
      p.info.kills = 0;
      p.headshotKills = 0;
      p.info.deaths = 0;
      p.info.score = 0;
      this.spawn(p, now, true);
    }
    this.projectiles.clear();
    this.vehicles?.reset();
    this.loot.reset();
    for (const state of this.loot.states()) this.io.to(this.channel).emit('loot', state);
    this.onMatchStart(now);
    this.match = {
      phase: 'playing',
      endsAt: this.mode.timeLimitMs > 0 ? now + this.mode.timeLimitMs : null,
      teamScores: [0, 0],
      winnerTeam: 0,
      winnerPid: 0,
      mvpPid: 0,
    };
    this.io.to(this.channel).emit('match', this.match);
    this.emitScores();
  }

  /** Hook for mode systems to reset their state at the start of a match. */
  protected onMatchStart(_now: number): void {}

  protected checkScoreLimit(now: number): void {
    const limit = this.mode.scoreLimit;
    if (limit <= 0 || this.match.phase !== 'playing') return;
    const reached = this.mode.teams
      ? this.match.teamScores.some((s) => s >= limit)
      : [...this.players.values()].some((p) => p.info.kills >= limit);
    if (reached) this.endMatch(now);
  }

  protected addTeamScore(team: Team, amount: number): void {
    if (team === 0) return;
    this.match.teamScores[team - 1] += amount;
    this.emitScores();
  }

  /** Ends the match. `winner` names the winner for modes that decide it themselves (Arms Race). */
  protected endMatch(now: number, winner?: ServerPlayer): void {
    const players = [...this.players.values()];
    const byScore = [...players].sort((a, b) => b.info.score - a.info.score || b.info.kills - a.info.kills);
    let winnerTeam: Team = 0;
    let winnerPid = 0;
    if (winner) {
      winnerPid = winner.pid;
    } else if (this.mode.teams) {
      const [red, blue] = this.match.teamScores;
      winnerTeam = red === blue ? 0 : red > blue ? 1 : 2;
    } else {
      const byKills = [...players].sort((a, b) => b.info.kills - a.info.kills || b.info.score - a.info.score);
      const top = byKills[0];
      if (top && top.info.kills > 0 && top.info.kills !== byKills[1]?.info.kills) winnerPid = top.pid;
    }
    this.match = {
      phase: 'ended',
      endsAt: now + MATCH.resultsMs,
      teamScores: this.match.teamScores,
      winnerTeam,
      winnerPid,
      mvpPid: byScore[0] && byScore[0].info.score > 0 ? byScore[0].pid : 0,
    };
    this.projectiles.clear();
    this.io.to(this.channel).emit('match', this.match);
    this.awardCoins(players);
  }

  private awardCoins(players: ServerPlayer[]): void {
    const results: MatchResult[] = [];
    for (const p of players) {
      if (p.userId === null) continue;
      const won = this.mode.teams ? p.info.team === this.match.winnerTeam && p.info.team !== 0 : p.pid === this.match.winnerPid;
      const coins = Math.min(COINS.max, COINS.perMatch + COINS.perKill * p.info.kills + (won ? COINS.win : 0));
      results.push({ userId: p.userId, pid: p.pid, kills: p.info.kills, headshots: p.headshotKills, deaths: p.info.deaths, won, coins, xp: this.mode.ranked ? rankedPoints(p.info.kills, won) : 0 });
    }
    if (results.length === 0 || !this.hooks.onMatchEnd) return;
    const totals = this.hooks.onMatchEnd(this, results);
    for (const r of results) {
      const total = totals.get(r.userId);
      const p = this.players.get(r.pid);
      if (total === undefined || !p) continue;
      p.socket?.emit('reward', { coins: r.coins + total.levelCoins + (total.dailyCoins ?? 0), total: total.coins, kills: r.kills, won: r.won, xp: r.xp, xpTotal: total.xp, levelCoins: total.levelCoins, dailyCoins: total.dailyCoins ?? 0, ranked: this.mode.ranked === true });
      // Ranked up: everyone's scoreboard shows the new badge.
      const rank = levelFor(total.xp);
      if (rank !== p.info.rank) {
        p.info.rank = rank;
        this.announcePlayer(p);
      }
    }
  }

  /**
   * Ranked: someone left a match that's underway. It counts as a lost match for them (saved
   * right away, since they won't be here at the end).
   */
  protected recordLeaver(p: ServerPlayer): void {
    if (!this.mode.ranked || p.userId === null || !this.hooks.onMatchEnd) return;
    this.hooks.onMatchEnd(this, [{ userId: p.userId, pid: p.pid, kills: p.info.kills, headshots: p.headshotKills, deaths: p.info.deaths, won: false, coins: 0, xp: RANKED.leave }]);
  }

  emitScores(): void {
    const rows: ScoreRow[] = [...this.players.values()].map((p) => [p.pid, p.info.kills, p.info.deaths, p.info.score]);
    this.io.to(this.channel).emit('scores', { rows, teamScores: this.match.teamScores });
  }

  systemMessage(text: string): void {
    this.io.to(this.channel).emit('chat', { pid: 0, name: '', text, team: 0 });
  }

  // ---------------------------------------------------------------------------
  // Loop
  // ---------------------------------------------------------------------------

  private tick(): void {
    const now = performance.now();
    this.accumulator += now - this.lastTick;
    this.lastTick = now;
    let steps = 0;
    while (this.accumulator >= SIM_DT * 1000 && steps < 4) {
      this.fixedUpdate(now - this.accumulator + SIM_DT * 1000);
      this.accumulator -= SIM_DT * 1000;
      steps++;
    }
    // Way behind (e.g. the process was suspended): drop the backlog instead of fast-forwarding.
    if (steps === 4) this.accumulator = 0;
  }

  protected fixedUpdate(now: number): void {
    this.hvhTick++;
    for (const p of this.players.values()) {
      this.enforceHvhRules(p);
      const command = p.commands.next();
      if (command) this.applyInput(p, command);
      // Missing commands cannot invent presses or run assistance without new input.
      else if (p.alive && !p.frozen && !p.vehicle && p.lastInput) {
        // A held key is remembered, but a missing command never makes the chicken hop on landing.
        const held = p.state.jumpHeld;
        stepPlayer(p.state,
          { ...p.lastInput, forward: 0, right: 0, jump: held && !p.state.onGround, autoHop: false, subtickStrafe: false }, SIM_DT,
          this.world, p.mods, hopMaxFor(p.weapon), moveSpeedFor(p.weapon), this.mode.id === 'hvh');
        p.state.jumpHeld = held;
      }
      p.simulationTime = now;
      if (this.mode.id === 'hvh') {
        p.weaponHeat = Math.max(0, p.weaponHeat - SIM_DT * 1.5);
        p.resource.step(this.hvhTick, p.fireQueue.length > 0 || now - p.lastFireAt < 250,
          p.hvhEnabled && fakeLagTicks(p.hvh.core ?? defaultHvhCore(), p.lastSeq, p.state.horizontalSpeed) > 0);
      } else p.resource.playerTick++;
      this.updateHvhPose(p, now);
      if (this.mode.id === 'hvh') {
        const pose = hvhPose(p.lookYaw, p.hvh, now, (p.lastInput?.invert === true) !== (p.antiBruteSide < 0), !p.hvhEnabled || !p.alive || (now >= p.concealUntil && now < p.revealUntil),
          { speed: p.state.horizontalSpeed, onGround: p.state.onGround, crouching: p.state.crouching, seed: p.pid, targetYaw: p.hvhTargetYaw, coverSide: p.hvhCoverSide });
        stepAnimation(p.animation, { eyeYaw: pose.real, desiredDelta: wrapAngle(pose.fake - pose.real), speed: p.state.horizontalSpeed,
          crouch: p.state.crouchAmount ?? (p.state.crouching ? 1 : 0), grounded: p.state.onGround, active: p.hvhEnabled && p.hvh.antiAim.enabled, weaponSpeed: moveSpeedFor(p.weapon) }, this.hvhTick);
        p.yaw = p.animation.bodyYaw; p.fakeYaw = p.animation.eyeYaw; p.simulationTime = now;
      }
      p.history.push({ t: now, x: p.state.x, y: p.state.y, z: p.state.z, yaw: p.yaw, alive: p.alive, scale: bodyScale(p.state),
        pitch: this.mode.id === 'hvh' ? p.fakePitch : p.pitch });
      if (p.reloadUntil > 0 && now >= p.reloadUntil) {
        p.reloadUntil = 0;
        p.mags.set(p.weapon, p.magazineSize(p.weapon));
      }
      if (!p.hvhPreparing && !p.alive && now >= p.respawnAt && this.match.phase !== 'ended') this.spawn(p, now, true);
    }
    for (const p of this.players.values()) {
      const req = p.fireQueue[0];
      if (req && (req.command === undefined || req.command <= p.lastSeq || now - req.t > MAX_REWIND_MS)) { p.fireQueue.shift(); this.executeFire(p, req, now); }
    }
    this.maintainBots(now);
    this.bots.update(now);
    this.vehicles?.update(now);
    this.projectiles.update(now);
    this.loot.update(now);
    this.updateMatch(now);
  }

  /** Keeps the bot count on target: fixed for practice rooms, filling empty seats in public ones. */
  private maintainBots(now: number): void {
    if (now < this.nextBotCheck || this.closed || this.humanCount === 0) return;
    this.nextBotCheck = now + 1000;
    let wanted = 0;
    // Ranked, real-players-only modes and "without bots" rooms: no bots at all.
    if (this.noBots) wanted = 0;
    else if (this.botTarget !== null) wanted = this.botTarget;
    else if (this.fillBots && !this.mode.building) wanted = Math.max(0, (this.mode.fillBots ?? (this.mode.maxPlayers === 2 ? 2 : 4)) - this.humanCount);
    wanted = Math.min(wanted, this.mode.maxPlayers - this.humanCount);
    // Fill all empty seats at once; leave one at a time so a match doesn't empty out suddenly.
    while (this.bots.count < wanted && this.bots.add());
    if (this.bots.count > wanted) this.bots.removeOne();
  }

  /**
   * The anti-cheat caught `p`. Logged here; the room manager records the strike and (when
   * `remove`) takes them out, after the current message is handled.
   */
  caughtCheating(p: ServerPlayer, reason: string, details: Record<string, unknown>, remove: boolean): void {
    console.warn(`[anticheat] ${remove ? 'removed' : 'flagged (watch only)'} "${p.info.name}" (user ${p.userId ?? 'guest'}) in ${this.info.id}: ${reason} ${JSON.stringify(details)}`);
    if (remove) {
      p.removedForCheating = true;
      this.systemMessage(`🛡️ Anti-cheat removed ${p.info.name} from the match.`);
    }
    queueMicrotask(() => this.hooks.onCheat?.(this, p, reason, details, remove));
  }

  /** What `viewer` is told: in ranked rooms, only the enemies they could see (fog of war). */
  snapshotFor(viewer: ServerPlayer, now = performance.now()): WorldSnapshot {
    const ac = this.antiCheat;
    if (!ac) return this.snapshot(now, viewer.pid);
    const players = [...this.players.values()].filter((t) => t === viewer || this.areTeammates(viewer, t) || ac.visible(viewer, t, now));
    return { t: now, p: players.map((p) => packPlayer(p.toState())), v: this.vehicles?.packed() ?? [] };
  }

  snapshot(now = performance.now(), viewer = 0): WorldSnapshot {
    return { t: now, p: [...this.players.values()].map((p) => {
      if (this.mode.id !== 'hvh' || p.pid === viewer) return packPlayer(p.toState());
      const core = p.hvh.core ?? defaultHvhCore();
      const choke = p.hvhEnabled ? fakeLagTicks(core,p.lastSeq,p.state.horizontalSpeed) : 0;
      const cached = this.publicStates.get(p.pid);
      if (choke > 0 && cached && now < cached.until && cached.state.alive === p.alive
        && (!(core.fakeLagBreakOnShot || core.fakeLagMode === 'peek') || cached.shot === p.lastShotSeq)) return packPlayer(cached.state);
      const state = p.toState();
      if (core.era === 'legacy' && p.hvhEnabled) state.yaw = state.fakeYaw = wrapAngle(state.yaw + Math.PI / 2);
      this.publicStates.set(p.pid, { state, shot: p.lastShotSeq, until: now + ((choke + 1) * SIM_DT * 1000) });
      return packPlayer(state);
    }), v: this.vehicles?.packed() ?? [] };
  }

  private broadcastSnapshot(): void {
    if (this.players.size === 0) return;
    if (!this.antiCheat && this.mode.id !== 'hvh') {
      this.io.to(this.channel).volatile.emit('snapshot', this.snapshot());
      return;
    }
    // Ranked fog of war and HvH owner acknowledgements each need a viewer-specific snapshot.
    const now = performance.now();
    for (const viewer of this.players.values()) viewer.socket?.volatile.emit('snapshot', this.snapshotFor(viewer, now));
  }
}

// ---------------------------------------------------------------------------
// Validation of untrusted client messages
// ---------------------------------------------------------------------------

function parseInput(raw: unknown): InputFrame | null {
  if (!isRecord(raw)) return null;
  const { seq, forward, right, jump, yaw, pitch } = raw;
  if (!Number.isSafeInteger(seq) || !isFiniteNumber(forward) || !isFiniteNumber(right) || !isFiniteNumber(yaw)) return null;
  if (typeof jump !== 'boolean') return null;
  return {
    seq: seq as number,
    forward: clamp(forward, -1, 1),
    right: clamp(right, -1, 1),
    jump,
    autoHop: raw.autoHop === true,
    subtickStrafe: raw.subtickStrafe === true,
    yaw: wrapAngle(yaw),
    pitch: isFiniteNumber(pitch) ? clamp(pitch, -1.5, 1.5) : 0,
    crouch: raw.crouch === true,
    slowWalk: raw.slowWalk === true,
    use: raw.use === true,
    invert: raw.invert === true,
    boost: raw.boost === true,
  };
}

function parseFire(raw: unknown): FireRequest | null {
  if (!isRecord(raw)) return null;
  const { shot, weapon, dx, dy, dz, t, aiming } = raw;
  if (!Number.isSafeInteger(shot) || !isWeaponId(weapon)) return null;
  if (!isFiniteNumber(dx) || !isFiniteNumber(dy) || !isFiniteNumber(dz) || !isFiniteNumber(t)) return null;
  const len = Math.hypot(dx, dy, dz);
  if (len < 0.5 || len > 1.5) return null;
  const intentRaw = isRecord(raw.intent) ? raw.intent : null;
  const intent = intentRaw && Number.isSafeInteger(intentRaw.target) && isFiniteNumber(intentRaw.recordT) && isFiniteNumber(intentRaw.yaw)
    && ['CENTER','LEFT','RIGHT','LEFT_LOW','RIGHT_LOW','LAST_MOVING','BODY_UPDATE'].includes(String(intentRaw.source))
    ? { target: intentRaw.target as number, recordT: intentRaw.recordT, yaw: wrapAngle(intentRaw.yaw), source: intentRaw.source as import('@game/shared').HypothesisSource } : undefined;
  return { shot: shot as number, weapon, dx, dy, dz, t, aiming: aiming === true, command: Number.isSafeInteger(raw.command) ? raw.command as number : undefined, intent };
}

function parseThrow(raw: unknown): ThrowRequest | null {
  if (!isRecord(raw)) return null;
  const { kind, seq, dx, dy, dz } = raw;
  if ((kind !== 'egg' && kind !== 'smoke' && kind !== 'flash') || !Number.isSafeInteger(seq)) return null;
  if (!isFiniteNumber(dx) || !isFiniteNumber(dy) || !isFiniteNumber(dz)) return null;
  const len = Math.hypot(dx, dy, dz);
  if (len < 0.5 || len > 1.5) return null;
  return { kind, seq: seq as number, dx: dx / len, dy: dy / len, dz: dz / len };
}
