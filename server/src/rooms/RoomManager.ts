import { MODES, levelFor, type JoinResponse, type MapId, type ModeId, type RoomSummary, type Team } from '@game/shared';
import { REPORT_REASONS } from '@game/shared';
import type { GameDatabase } from '../db/Database';
import type { GameServer, GameSocket } from '../types';
import { randomRoomCode, randomString } from '../util';
import type { AntiCheatMode } from './AntiCheat';
import { GameRoom, type PlayerProfile, type RoomHooks } from './GameRoom';
import { createRoom } from './modes';

export const MAX_ROOMS = 200;

/** Creates, finds and cleans up rooms, and remembers which room each socket is in. */
/** The same person can report the same player once in this long. */
const REPORT_COOLDOWN_MS = 10 * 60_000;

export class RoomManager {
  private readonly io: GameServer;
  private readonly db: GameDatabase;
  private readonly rooms = new Map<string, GameRoom>();
  private readonly socketRooms = new Map<string, GameRoom>();
  private readonly hooks: RoomHooks;
  private publicCounter = 1;
  /** Someone went into or out of a room (friends see what you're playing). */
  onActivity: ((userId: number) => void) | null = null;

  private readonly antiCheat: AntiCheatMode;

  constructor(io: GameServer, db: GameDatabase, options: { antiCheat?: AntiCheatMode } = {}) {
    this.io = io;
    this.db = db;
    this.antiCheat = options.antiCheat ?? 'enforce';
    this.hooks = {
      onMatchEnd: (room, results) => this.db.recordMatch(results, room.mode.id),
      onEmpty: (room) => this.close(room),
      onCheat: (room, player, reason, details, remove) => {
        if (!remove) return;
        if (player.userId !== null) this.db.addStrike(player.userId, reason, { ...details, room: room.info.id, map: room.info.map });
        const socket = player.socket;
        if (!socket) return room.removePlayer(player);
        socket.emit('roomClosed', `Removed by the FaceChiken anti-cheat (${reason}). That counts as a loss, and a strike: strikes ban you from FaceChiken for a while.`);
        void socket.leave(room.channel);
        this.leave(socket);
      },
    };
  }

  get count(): number {
    return this.rooms.size;
  }

  get playerCount(): number {
    let n = 0;
    for (const room of this.rooms.values()) n += room.humanCount;
    return n;
  }

  list(): RoomSummary[] {
    return [...this.rooms.values()].filter((r) => !r.info.private).map((r) => r.summary());
  }

  get(id: string): GameRoom | undefined {
    return this.rooms.get(id);
  }

  byCode(code: string): GameRoom | undefined {
    const wanted = code.trim().toUpperCase();
    for (const room of this.rooms.values()) if (room.info.code === wanted) return room;
    return undefined;
  }

  roomOf(socketId: string): GameRoom | undefined {
    return this.socketRooms.get(socketId);
  }

  /** The busiest public room of this mode that still has space, or a brand new one. */
  /** The busiest open public room for a mode (and map, if one is asked for), or a new one. */
  quickPlay(mode: ModeId, map?: MapId, partySize = 1, withoutBots = false): GameRoom | null {
    // Modes that never have bots (ranked, Squad Up) are always "without bots".
    const noBots = withoutBots || MODES[mode].noBots === true || MODES[mode].ranked === true;
    // Training is always your own private room.
    if (MODES[mode].training) {
      const maps = MODES[mode].maps;
      return this.create(mode, map ?? maps[Math.floor(Math.random() * maps.length)]!, true, undefined, 0, false, true);
    }
    let best: GameRoom | null = null;
    for (const room of this.rooms.values()) {
      if (room.info.private || room.info.mode !== mode || room.isFull || (map && room.info.map !== map)) continue;
      // "With bots" and "Without bots" players are kept in separate rooms.
      if ((room.info.noBots === true) !== noBots) continue;
      // A party only goes where all of them fit (on one team).
      if (partySize > 1 && room.teamForParty(partySize) === null) continue;
      if (!best || room.humanCount > best.humanCount) best = room;
    }
    if (best) return best;
    const maps = MODES[mode].maps;
    return this.create(mode, map ?? maps[Math.floor(Math.random() * maps.length)]!, false, undefined, 0, !noBots, noBots);
  }

  create(mode: ModeId, map: MapId, isPrivate: boolean, hostName?: string, bots = 0, fillBots = false, noBots = false): GameRoom | null {
    if (this.rooms.size >= MAX_ROOMS) return null;
    let id = randomString(8);
    while (this.rooms.has(id)) id = randomString(8);
    let code = randomRoomCode();
    while (this.byCode(code)) code = randomRoomCode();
    const name = isPrivate && hostName ? `${hostName}'s room` : `${MODES[mode].name} #${this.publicCounter++}`;
    const room = createRoom(this.io, { id, code, name, mode, map, private: isPrivate, bots, fillBots, noBots, antiCheat: this.antiCheat }, this.hooks);
    this.rooms.set(id, room);
    return room;
  }

  /** Moves a socket into a room (leaving any previous one) using its account profile. */
  /** A player reports someone in their room: saved for the owner (npm run reports) and logged. */
  report(socket: GameSocket, pid: unknown, reason: unknown): { ok: boolean; error?: string } {
    const room = this.roomOf(socket.id);
    const me = room?.playerFor(socket.id);
    if (!room || !me || me.userId === null) return { ok: false, error: 'Join a match first.' };
    if (!Number.isSafeInteger(pid) || !(REPORT_REASONS as readonly unknown[]).includes(reason)) return { ok: false, error: 'Invalid report.' };
    const target = room.players.get(pid as number);
    if (!target || target.info.bot || target.userId === null) return { ok: false, error: 'That player is no longer here.' };
    if (target === me) return { ok: false, error: 'You can’t report yourself.' };
    const now = Date.now();
    if (this.db.hasRecentReport(me.userId, target.userId, now - REPORT_COOLDOWN_MS)) return { ok: true };
    this.db.addReport(me.userId, target.userId, target.info.name, reason as string, room.mode.id, now);
    console.log(`[report] ${me.info.name} reported ${target.info.name} (${reason as string}) in ${room.info.id} (${room.mode.id})`);
    return { ok: true };
  }

  /** Why this account can't play this mode (ranked rules), or null. */
  blockedFrom(userId: number, mode: ModeId): string | null {
    if (!MODES[mode].ranked) return null;
    const profile = this.db.profile(userId);
    if (!profile) return 'Account not found. Reload the page.';
    // Ranked is for real, registered players.
    if (!profile.username) return 'FaceChiken is for registered players: tap “Save progress” to register (it’s free).';
    const ban = this.db.rankedBan(profile.id);
    if (!ban) return null;
    const until = Number.isFinite(ban.until) ? `until ${new Date(ban.until).toUTCString()}` : 'for good';
    return `You're banned from FaceChiken ${until} (anti-cheat: ${ban.reason}). Other modes are open.`;
  }

  /** Moves a socket into a room (leaving any previous one) using its account profile. `team`: their party's team. */
  join(socket: GameSocket, room: GameRoom | null, team?: Team): JoinResponse {
    if (!room) return { ok: false, error: 'The server is busy, try again soon.' };
    const profile = this.db.profile(socket.data.userId);
    if (!profile) return { ok: false, error: 'Account not found. Reload the page.' };
    if (this.socketRooms.get(socket.id) === room) return { ok: false, error: 'Already in this room.' };
    const blocked = this.blockedFrom(profile.id, room.info.mode);
    if (blocked) {
      if (room.humanCount === 0) this.close(room);
      return { ok: false, error: blocked };
    }

    this.leave(socket);
    const playerProfile: PlayerProfile = {
      userId: profile.id,
      name: profile.name,
      appearance: profile.appearance,
      loadout: profile.loadout,
      dev: profile.developer,
      rank: levelFor(profile.xp),
      ...(team ? { team } : {}),
    };
    const res = room.join(socket, playerProfile);
    if (res.ok) {
      this.socketRooms.set(socket.id, room);
      this.onActivity?.(socket.data.userId);
    } else if (room.humanCount === 0) this.close(room);
    return res;
  }

  leave(socket: GameSocket): void {
    const room = this.socketRooms.get(socket.id);
    if (!room) return;
    this.socketRooms.delete(socket.id);
    room.leave(socket.id);
    this.onActivity?.(socket.data.userId);
  }

  close(room: GameRoom): void {
    if (!this.rooms.delete(room.info.id)) return;
    const left: number[] = [];
    for (const [socketId, r] of this.socketRooms) {
      if (r !== room) continue;
      this.socketRooms.delete(socketId);
      const userId = room.playerFor(socketId)?.userId;
      if (userId) left.push(userId);
    }
    room.close();
    for (const userId of left) this.onActivity?.(userId);
  }

  closeAll(): void {
    for (const room of [...this.rooms.values()]) this.close(room);
  }
}
