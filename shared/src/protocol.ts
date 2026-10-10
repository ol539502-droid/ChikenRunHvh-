import type { RoundState } from './bomb';
import type { FriendsState, PartyInvite, PartyState, SocialResult } from './social';
import type { DevAction, DevMods, DevResult, DevStatus, JumpscareStyle } from './dev';
import type { HvhLoadout } from './hvh';
import type { Appearance } from './items';
import type { MapId, Team } from './maps/types';
import { round } from './math';
import type { ModeId } from './modes';
import type { InputFrame, MoveState } from './physics';
import type { LootPhase, PickupKind } from './pickups';
import type { ProjectileKind } from './projectiles';
import { weaponAt, weaponIndex, type WeaponId } from './weapons';
import type { ZombieGear, ZombieJoin, ZombieKind, ZombieState } from './zombies';

// ---------------------------------------------------------------------------
// Players
// ---------------------------------------------------------------------------

/** Mostly-static facts about a player in a room. Sent on join; updated with `playerUpdated`. */
export interface PlayerInfo {
  /** Small per-room number used everywhere in the protocol instead of the socket id. */
  pid: number;
  name: string;
  team: Team;
  appearance: Appearance;
  loadout: WeaponId[];
  bot: boolean;
  kills: number;
  deaths: number;
  score: number;
  /** A developer account (set on the server only): the name glows rainbow. */
  dev?: boolean;
  /** Arms Race: the step of the weapon ladder this player is on (0 = first). */
  level?: number;
  /** Account rank, 1–10 (from XP earned in matches). */
  rank?: number;
  /** Zombie Apocalypse: this chicken is a zombie of that kind. */
  undead?: ZombieKind;
}

/** The fast-changing state of a player, as carried in every snapshot. */
export interface PlayerState extends MoveState {
  /** Public animation observations. The authoritative body yaw is never serialized in HvH. */
  simulationTime?: number;
  lowerBodyYaw?: number;
  turnWeight?: number;
  hvhDefensive?: boolean;
  weaponHeat?: number;
  fakeYaw?: number;
  /** Physical head pitch (anti-aim in HvH, look pitch elsewhere), shared with hit detection. */
  fakePitch?: number;
  hvhCharge?: number;
  hvhBurst?: boolean;
  hvhConcealed?: boolean;
  hvhPreparing?: boolean;
  pid: number;
  yaw: number;
  pitch: number;
  alive: boolean;
  reloading: boolean;
  /** Spawn protection (can't be damaged). */
  shielded: boolean;
  aiming: boolean;
  carryingFlag: boolean;
  hp: number;
  armor: number;
  weapon: WeaponId;
  mag: number;
  eggs: number;
  smokes: number;
  /** Flashbangs left (Z). */
  flashes?: number;
  /** Last input `seq` the server applied (for client reconciliation). */
  ack: number;
  /** Vehicle being driven, 0 when on foot. */
  vehicle: number;
  /** Held in place by a developer (inputs are ignored). */
  frozen: boolean;
}

const F_GROUND = 1;
const F_ALIVE = 2;
const F_RELOADING = 4;
const F_JETTING = 8;
const F_JUMP_HELD = 16;
const F_SHIELDED = 32;
const F_AIMING = 64;
const F_FLAG = 128;
const F_GLIDING = 256;
const F_FROZEN = 512;
const F_CROUCH = 1024;

export type PackedPlayer = number[];

/** Compact array form of a PlayerState. Positions are rounded to millimetres. */
export function packPlayer(p: PlayerState): PackedPlayer {
  const flags =
    (p.onGround ? F_GROUND : 0) |
    (p.alive ? F_ALIVE : 0) |
    (p.reloading ? F_RELOADING : 0) |
    (p.jetting ? F_JETTING : 0) |
    (p.jumpHeld ? F_JUMP_HELD : 0) |
    (p.shielded ? F_SHIELDED : 0) |
    (p.aiming ? F_AIMING : 0) |
    (p.carryingFlag ? F_FLAG : 0) |
    (p.gliding ? F_GLIDING : 0) |
    (p.frozen ? F_FROZEN : 0) |
    (p.crouching ? F_CROUCH : 0);
  return [
    p.pid,
    round(p.x, 3),
    round(p.y, 3),
    round(p.z, 3),
    round(p.vx, 3),
    round(p.vy, 3),
    round(p.vz, 3),
    round(p.yaw, 3),
    round(p.pitch, 3),
    flags,
    Math.ceil(p.hp),
    Math.ceil(p.armor),
    weaponIndex(p.weapon),
    p.mag,
    round(p.fuel, 3),
    p.eggs,
    p.smokes,
    p.ack,
    p.vehicle,
    round(p.hop, 3),
    p.groundTicks,
    round(p.fakeYaw ?? p.yaw, 3),
    Math.floor((p.hvhCharge ?? 0) * 1000) / 1000,
    p.hvhBurst ? 1 : 0,
    p.hvhConcealed ? 1 : 0,
    round(p.horizontalSpeed, 3),
    p.hvhPreparing ? 1 : 0,
    round(p.fakePitch ?? p.pitch, 3),
    p.flashes ?? 0,
    round(p.walkVx ?? 0, 3), round(p.walkVz ?? 0, 3), p.simulationTime ?? 0,
    round(p.lowerBodyYaw ?? p.yaw, 3), p.turnWeight ?? 0, p.hvhDefensive ? 1 : 0,
    round(p.weaponHeat ?? 0, 3),
    p.crouchAmount === undefined ? -1 : round(p.crouchAmount, 3),
  ];
}

export function unpackPlayer(a: PackedPlayer): PlayerState {
  const flags = a[9] ?? 0;
  return {
    pid: a[0] ?? 0,
    x: a[1] ?? 0,
    y: a[2] ?? 0,
    z: a[3] ?? 0,
    vx: a[4] ?? 0,
    vy: a[5] ?? 0,
    vz: a[6] ?? 0,
    yaw: a[7] ?? 0,
    pitch: a[8] ?? 0,
    onGround: (flags & F_GROUND) !== 0,
    alive: (flags & F_ALIVE) !== 0,
    reloading: (flags & F_RELOADING) !== 0,
    jetting: (flags & F_JETTING) !== 0,
    jumpHeld: (flags & F_JUMP_HELD) !== 0,
    shielded: (flags & F_SHIELDED) !== 0,
    aiming: (flags & F_AIMING) !== 0,
    carryingFlag: (flags & F_FLAG) !== 0,
    gliding: (flags & F_GLIDING) !== 0,
    frozen: (flags & F_FROZEN) !== 0,
    crouching: (flags & F_CROUCH) !== 0,
    hp: a[10] ?? 0,
    armor: a[11] ?? 0,
    weapon: weaponAt(a[12] ?? 0),
    mag: a[13] ?? 0,
    fuel: a[14] ?? 0,
    eggs: a[15] ?? 0,
    smokes: a[16] ?? 0,
    ack: a[17] ?? 0,
    vehicle: a[18] ?? 0,
    hop: a[19] ?? 0,
    groundTicks: a[20] ?? 255,
    fakeYaw: a[21] ?? a[7] ?? 0,
    hvhCharge: a[22] ?? 0,
    hvhBurst: a[23] === 1,
    hvhConcealed: a[24] === 1,
    horizontalSpeed: a[25] ?? 0,
    hvhPreparing: a[26] === 1,
    fakePitch: a[27] ?? a[8] ?? 0,
    flashes: a[28] ?? 0,
    walkVx: a[29] ?? 0, walkVz: a[30] ?? 0, simulationTime: a[31] ?? 0,
    lowerBodyYaw: a[32] ?? a[7] ?? 0, turnWeight: a[33] ?? 0, hvhDefensive: a[34] === 1,
    weaponHeat: a[35] ?? 0,
    crouchAmount: (a[36] ?? -1) < 0 ? undefined : a[36],
  };
}

// ---------------------------------------------------------------------------
// Vehicles, blocks, flags (packed the same way)
// ---------------------------------------------------------------------------

export interface VehicleState {
  id: number;
  x: number;
  z: number;
  yaw: number;
  speed: number;
  /** pid of the driver, 0 when empty. */
  driver: number;
  hp: number;
  /** Sideways slide (drifting), m/s. */
  slip: number;
  /** Nitro left, 0–1. */
  boost: number;
}

export type PackedVehicle = number[];

export function packVehicle(v: VehicleState): PackedVehicle {
  return [v.id, round(v.x, 3), round(v.z, 3), round(v.yaw, 4), round(v.speed, 3), v.driver, Math.ceil(v.hp), round(v.slip, 3), round(v.boost, 3)];
}

export function unpackVehicle(a: PackedVehicle): VehicleState {
  return { id: a[0] ?? 0, x: a[1] ?? 0, z: a[2] ?? 0, yaw: a[3] ?? 0, speed: a[4] ?? 0, driver: a[5] ?? 0, hp: a[6] ?? 0, slip: a[7] ?? 0, boost: a[8] ?? 1 };
}

export type BlockKind = 'crate' | 'stone' | 'brick' | 'wood' | 'hay' | 'metal' | 'concrete';
export const BLOCK_KINDS: readonly BlockKind[] = ['crate', 'wood', 'stone', 'brick', 'hay', 'metal', 'concrete'];

/** A Sandbox block on the building grid: occupies cell (cx, cy, cz) of size BLOCK_SIZE. */
export interface BlockState {
  id: number;
  cx: number;
  cy: number;
  cz: number;
  kind: BlockKind;
  /** Zombie Apocalypse builds: milliseconds until it disappears (counted from when you receive it). */
  ttl?: number;
}

export interface FlagState {
  team: 1 | 2;
  x: number;
  y: number;
  z: number;
  /** pid carrying it, 0 if none. */
  carrier: number;
  atBase: boolean;
}

// ---------------------------------------------------------------------------
// Rooms and matches
// ---------------------------------------------------------------------------

export type MatchPhase = 'waiting' | 'countdown' | 'playing' | 'ended';

export interface MatchState {
  phase: MatchPhase;
  /** Server time (ms) when the current phase ends, or null if open-ended. */
  endsAt: number | null;
  /** Kills (or captures) per team: [red, blue]. */
  teamScores: [number, number];
  winnerTeam: Team;
  /** pid of the winner in free-for-all modes, 0 otherwise. */
  winnerPid: number;
  mvpPid: number;
}

export interface RoomInfo {
  id: string;
  /** Share this to let friends join a private room. */
  code: string;
  name: string;
  mode: ModeId;
  map: MapId;
  maxPlayers: number;
  private: boolean;
  /** Real players only: the match waits for enough people instead of adding bots. */
  noBots?: boolean;
}

export interface RoomSummary {
  id: string;
  name: string;
  mode: ModeId;
  map: MapId;
  players: number;
  maxPlayers: number;
  phase: MatchPhase;
}

export interface LootState {
  id: number;
  phase: LootPhase;
  pickup: PickupKind | null;
}

/** A bonus pickup dropped by a kill. `y` is the ground it lies on. */
export interface DropState {
  id: number;
  kind: PickupKind;
  x: number;
  y: number;
  z: number;
}

export interface ProjectileSpawn {
  id: number;
  kind: ProjectileKind;
  owner: number;
  /** The thrower's own counter, so it can match the server's projectile to its predicted one. */
  ownerSeq: number;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
}

export interface WorldSnapshot {
  /** Server clock in ms (monotonic, not wall-clock). */
  t: number;
  p: PackedPlayer[];
  v: PackedVehicle[];
}

export type JoinResponse =
  | {
      ok: true;
      selfPid: number;
      room: RoomInfo;
      players: PlayerInfo[];
      snapshot: WorldSnapshot;
      match: MatchState;
      loot: LootState[];
      drops: DropState[];
      projectiles: ProjectileSpawn[];
      smokes: SmokeEvent[];
      blocks: BlockState[];
      flags: FlagState[];
      /** ChikenBomb rooms: the round, and your money. */
      round: RoundState | null;
      money: number;
      /** Zombie Apocalypse: the waves so far and your gun upgrades. */
      zombie?: ZombieJoin;
    }
  | { ok: false; error: string };

export interface BuyResult {
  ok: boolean;
  error?: string;
  money: number;
}

export type JoinSuccess = Extract<JoinResponse, { ok: true }>;

export interface CreateRoomRequest {
  mode: ModeId;
  map: MapId;
  private: boolean;
  bots?: number;
}

export interface JoinRoomRequest {
  roomId?: string;
  code?: string;
}

// ---------------------------------------------------------------------------
// Combat and gameplay events
// ---------------------------------------------------------------------------

export interface FireRequest {
  command?: number;
  intent?: import('./hvh/rage').ShotIntent;
  /** Strictly increasing per player; also seeds the pellet pattern. */
  shot: number;
  weapon: WeaponId;
  /** Aim direction (normalized) from the eye. */
  dx: number;
  dy: number;
  dz: number;
  /** Server time the shooter was seeing other players at (for lag compensation). */
  t: number;
  aiming: boolean;
}

export interface ShotEvent {
  /** Owner-only authoritative firing acknowledgement, in server simulation time. */
  readyAt?: number;
  mag?: number;
  charge?: number;
  audit?: import('./hvh/rage').ShotAudit;
  burst?: number;
  /** Accepted client sequence, for matching assistance telemetry without guessed misses. */
  shot?: number;
  pid: number;
  weapon: WeaponId;
  /** Muzzle-ish origin (eye position). */
  ox: number;
  oy: number;
  oz: number;
  /** End point of every pellet, flattened [x, y, z, x, y, z, ...]. */
  ends: number[];
  /** Per pellet: 0 = missed / hit the level, 1 = hit a chicken, 2 = headshot. */
  hits: number[];
}

export interface DamageEvent {
  victim: number;
  attacker: number;
  amount: number;
  hp: number;
  armor: number;
  headshot: boolean;
  /** Where the damage came from (for the direction indicator). */
  fromX: number;
  fromZ: number;
}

export type KillCause = WeaponId | 'egg' | 'car' | 'world' | 'bomb';

export interface KillEvent {
  killer: number;
  victim: number;
  cause: KillCause;
  headshot: boolean;
  /** How it was done (KILL_FLAGS): no scope, through a wall, through smoke, in mid-air, while blind. */
  flags?: number;
}

/** Kill tags, as bits of KillEvent.flags. */
export const KILL_FLAGS = { noscope: 1, wallbang: 2, smoke: 4, air: 8, blind: 16 } as const;

/** You were caught by a flashbang: white for about `ms`, from `x, y, z`. */
export interface FlashedEvent {
  ms: number;
  x: number;
  y: number;
  z: number;
}

export interface SpawnEvent {
  pid: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
}

export interface ThrowRequest {
  kind: 'egg' | 'smoke' | 'flash';
  seq: number;
  dx: number;
  dy: number;
  dz: number;
}

export interface ExplosionEvent {
  id: number;
  kind: ProjectileKind;
  x: number;
  y: number;
  z: number;
}

export interface SmokeEvent {
  x: number;
  y: number;
  z: number;
  /** Server time it fades out. */
  until: number;
}

export interface PickupEvent {
  /** Loot box id, or -1 for a kill bonus. */
  lootId: number;
  pid: number;
  pickup: PickupKind;
}

/** [pid, kills, deaths, score] */
export type ScoreRow = [number, number, number, number];

export interface ScoresEvent {
  rows: ScoreRow[];
  teamScores: [number, number];
}

/** Why a player can be reported (the owner reads the reports on the server). */
export const REPORT_REASONS = ['cheating', 'abuse', 'griefing', 'other'] as const;
export type ReportReason = (typeof REPORT_REASONS)[number];

export interface ChatMessage {
  /** 0 for system messages. */
  pid: number;
  name: string;
  text: string;
  team: Team;
  /** Sent by a developer account. */
  dev?: boolean;
  /** Team chat: only sent to the sender's team. */
  teamOnly?: boolean;
}

export interface MatchRewardEvent {
  coins: number;
  total: number;
  kills: number;
  won: boolean;
  /** Rank points from this match (FaceChiken only; 0 elsewhere), and the new total. */
  xp: number;
  xpTotal: number;
  /** Coins for reaching a new level (included in `coins`). */
  levelCoins: number;
  /** Coins from daily challenges this match completed (already in `coins`). */
  dailyCoins?: number;
  ranked: boolean;
}

export type FlagEventKind = 'taken' | 'dropped' | 'returned' | 'captured';

export interface FlagEvent {
  kind: FlagEventKind;
  team: 1 | 2;
  pid: number;
  flags: FlagState[];
}

export interface BuildRequest {
  cx: number;
  cy: number;
  cz: number;
  kind: BlockKind;
  /** Zombie Apocalypse builds: milliseconds until it disappears (counted from when you receive it). */
  ttl?: number;
}

// ---------------------------------------------------------------------------
// Socket.IO event maps
// ---------------------------------------------------------------------------

export interface ClientToServerEvents {
  listRooms: (ack: (rooms: RoomSummary[]) => void) => void;
  /** `map` picks a map (one the mode plays on); otherwise any. */
  /** `noBots`: join (or open) a room with no bots, which waits for real players. */
  quickPlay: (req: { mode: ModeId; map?: MapId; noBots?: boolean }, ack: (res: JoinResponse) => void) => void;
  createRoom: (req: CreateRoomRequest, ack: (res: JoinResponse) => void) => void;
  joinRoom: (req: JoinRoomRequest, ack: (res: JoinResponse) => void) => void;
  leaveRoom: () => void;
  /** Zombie Apocalypse: build a wall in front of you (it lasts 10 seconds). */
  zombieBuild: () => void;
  /** Zombie Apocalypse: play again after game over. */
  zombieRestart: () => void;

  input: (frame: InputFrame) => void;
  fire: (req: FireRequest) => void;
  reload: () => void;
  switchWeapon: (slot: number) => void;
  /** M: move to the other team. The server checks the mode, balance and a cooldown. */
  switchTeam: (ack: (res: { ok: boolean; error?: string }) => void) => void;
  /** Training only: take a gun or knife from the B menu, or refill grenades. The server checks it. */
  trainingGive: (req: import('./training').TrainingGiveRequest, ack: (res: { ok: boolean; error?: string }) => void) => void;
  throw: (req: ThrowRequest) => void;
  aim: (aiming: boolean) => void;
  /** `teamOnly`: only your team hears it (in modes without teams it goes to everyone). */
  chat: (text: string, teamOnly?: boolean) => void;
  /** Report someone in your room. Saved on the server; one report per player per 10 minutes. */
  report: (req: { pid: number; reason: ReportReason }, ack: (res: { ok: boolean; error?: string }) => void) => void;
  useVehicle: () => void;
  /** ChikenBomb buy menu. */
  buy: (itemId: string, ack: (res: BuyResult) => void) => void;
  build: (req: BuildRequest) => void;
  unbuild: (blockId: number) => void;
  /** Unlock developer tools for this account. The passkey is checked on the server only. */
  devAuth: (passkey: string, ack: (res: DevResult) => void) => void;
  devStatus: (ack: (status: DevStatus) => void) => void;
  /** Replace your own developer modifiers (ignored unless allowed). */
  devMods: (mods: Partial<DevMods>, ack: (status: DevStatus) => void) => void;
  hvhReady: (panel: import('./hvh').HvhPanelId, ack: (result: DevResult) => void) => void;
  devHvh: (loadout: HvhLoadout, ack: (status: DevStatus) => void) => void;
  devAction: (action: DevAction, ack: (res: DevResult) => void) => void;
  /** Round-trip probe; the server just calls `ack` with its clock. */
  latency: (ack: (serverTime: number) => void) => void;

  // Friends and parties (registered accounts).
  friendsList: (ack: (state: FriendsState) => void) => void;
  friendRequest: (username: string, ack: (res: SocialResult) => void) => void;
  /** Answer a friend request from `userId`. */
  friendRespond: (req: { userId: number; accept: boolean }, ack: (res: SocialResult) => void) => void;
  /** Unfriend, or take back a request you sent. */
  friendRemove: (userId: number, ack: (res: SocialResult) => void) => void;
  partyState: (ack: (party: PartyState | null) => void) => void;
  /** Invite a friend to your party (making one if you're not in one). */
  partyInvite: (userId: number, ack: (res: SocialResult) => void) => void;
  partyAnswer: (req: { partyId: string; accept: boolean }, ack: (res: SocialResult) => void) => void;
  partyLeave: (ack: (res: SocialResult) => void) => void;
  /** Leader only. */
  partyKick: (userId: number, ack: (res: SocialResult) => void) => void;
}

export interface ServerToClientEvents {
  snapshot: (snapshot: WorldSnapshot) => void;
  playerJoined: (player: PlayerInfo) => void;
  playerLeft: (pid: number) => void;
  playerUpdated: (player: PlayerInfo) => void;

  shot: (e: ShotEvent) => void;
  damage: (e: DamageEvent) => void;
  kill: (e: KillEvent) => void;
  spawn: (e: SpawnEvent) => void;
  projectile: (e: ProjectileSpawn) => void;
  explode: (e: ExplosionEvent) => void;
  smoke: (e: SmokeEvent) => void;
  /** A flashbang blinded you. */
  flashed: (e: FlashedEvent) => void;
  /** A developer jumpscared you (mega?dev prank). */
  jumpscare: (e: { style: JumpscareStyle }) => void;
  loot: (e: LootState) => void;
  pickup: (e: PickupEvent) => void;
  drop: (d: DropState) => void;
  /** A bonus was picked up (`pid`) or expired (pid 0). */
  dropGone: (e: { id: number; pid: number }) => void;
  scores: (e: ScoresEvent) => void;
  match: (e: MatchState) => void;
  chat: (msg: ChatMessage) => void;
  reward: (e: MatchRewardEvent) => void;
  flag: (e: FlagEvent) => void;
  /** ChikenBomb: the round and the bomb changed. */
  round: (e: RoundState) => void;
  /** ChikenBomb: your money. */
  money: (e: { money: number }) => void;
  /** Zombie Apocalypse: the wave, the countdown, the boss. */
  zombie: (s: ZombieState) => void;
  /** Zombie Apocalypse: your gun upgrades changed. */
  zombieGear: (g: ZombieGear) => void;
  blockPlaced: (block: BlockState) => void;
  blockRemoved: (blockId: number) => void;
  /** The server removed you from the room (e.g. kicked); go back to the lobby. */
  roomClosed: (reason: string) => void;

  /** Your friends list changed (a request, someone came online, started playing...). */
  friends: (state: FriendsState) => void;
  /** Your party changed (null: you're not in one any more). */
  party: (party: PartyState | null) => void;
  partyInvited: (invite: PartyInvite) => void;
  /** Your party leader started a match: you're in it too. */
  partyJoined: (join: JoinSuccess) => void;
  /** Something to tell you ("Bob accepted your friend request"). */
  notice: (text: string) => void;
}

// ---------------------------------------------------------------------------
// REST API (accounts, shop)
// ---------------------------------------------------------------------------

export interface Profile {
  id: number;
  name: string;
  /** Null for guest accounts that haven't registered yet. */
  username: string | null;
  coins: number;
  appearance: Appearance;
  loadout: WeaponId[];
  owned: string[];
  stats: { kills: number; deaths: number; wins: number; matches: number };
  /** Experience from finished matches; sets the rank (see ranks.ts). */
  xp: number;
  /** Developer account: only the server can grant it (`npm run developer`). */
  developer: boolean;
}

/** One finished match in a player's history (Account > Last 10 matches). */
export interface MatchHistoryRow {
  mode: ModeId;
  kills: number;
  deaths: number;
  /** Kills that were headshots. */
  headshots: number;
  won: boolean;
  /** When the match ended (ms since 1970). */
  at: number;
}

export interface LeaderboardRow {
  name: string;
  kills: number;
  deaths: number;
  wins: number;
  matches: number;
  /** Rank level, 1–10. */
  level: number;
  dev?: boolean;
}
