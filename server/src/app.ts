import { existsSync } from 'node:fs';
import { TrainingRoom } from './rooms/TrainingRoom';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { Server } from 'socket.io';
import { DEFAULT_MODS, MODES, PLAYER, HVH_PANEL_IDS, defaultHvhLoadout, sanitizeHvhLoadout, isDefaultMods, isMapId, isModeId, parseDevAction, sanitizeMods, type DevStatus, type MapId, type ModeId } from '@game/shared';
import { createApiRouter } from './api';
import { Social } from './social/Social';
import { SESSION_COOKIE, hashToken, readCookie } from './auth';
import { GameDatabase } from './db/Database';
import { DevAccess } from './dev/DevAccess';
import { runDevAction } from './dev/devActions';
import type { GameRoom } from './rooms/GameRoom';
import { RoomManager } from './rooms/RoomManager';
import type { ServerPlayer } from './rooms/ServerPlayer';
import { jsonErrors, originAllowed, securityHeaders } from './security';
import type { GameServer, GameSocket } from './types';
import { TokenBucket, isRecord } from './util';

export interface GameServerOptions {
  port: number;
  /** SQLite file, or ':memory:' for tests. */
  dbPath: string;
  /** Built client to serve (production). Omit in dev, where Vite serves the client. */
  clientDist?: string;
  /** Sign-up / login attempts allowed per IP per minute (tests raise this). */
  authPerMinute?: number;
  /** Passkey that unlocks the developer menu. Omit to turn developer tools off entirely. */
  devPasskey?: string;
  /** Allow developer tools in public rooms (a local dev server). Otherwise: private rooms only. */
  devInPublicRooms?: boolean;
  /** Equal, balanced HvH panels for every player in HvH matches, no passkey; on by default (false turns it off). */
  publicHvhPanel?: boolean;
  /** FaceChiken anti-cheat: remove cheaters (default), only log them, or off. */
  antiCheat?: 'enforce' | 'log' | 'off';
  /** Only developer accounts (`npm run developer`) may use the passkey. On for public servers. */
  devAccountsOnly?: boolean;
  /** Guest accounts each IP may create per hour (tests raise this). */
  guestsPerHour?: number;
  /** How many reverse proxies (nginx, a load balancer) sit in front of the server, for real client IPs. */
  trustProxyHops?: number;
  /** Other origins allowed to use the API and sockets (when the page is hosted elsewhere). */
  allowedOrigins?: readonly string[];
  /** Simultaneous sockets allowed per IP address. */
  maxSocketsPerIp?: number;
  log?: (message: string) => void;
}

/** How often expired sessions and long-unused guest accounts are swept away. */
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

export interface RunningServer {
  http: HttpServer;
  io: GameServer;
  db: GameDatabase;
  rooms: RoomManager;
  port: number;
  close(): Promise<void>;
}

export async function startGameServer(options: GameServerOptions): Promise<RunningServer> {
  const log = options.log ?? (() => {});
  const db = new GameDatabase(options.dbPath);
  const app = express();
  app.disable('x-powered-by');
  const hops = options.trustProxyHops ?? 0;
  if (hops > 0) app.set('trust proxy', hops);
  const allowedOrigins = options.allowedOrigins ?? [];
  const http = createServer(app);
  const io: GameServer = new Server(http, { serveClient: false, maxHttpBufferSize: 64 * 1024 });
  const rooms = new RoomManager(io, db, { antiCheat: options.antiCheat });
  const social = new Social(db, rooms);
  const dev = options.devPasskey
    ? new DevAccess({
        passkey: options.devPasskey,
        allowPublicRooms: options.devInPublicRooms === true,
        isDeveloper: options.devAccountsOnly ? (userId) => db.isDeveloper(userId) : undefined,
      })
    : null;

  /** Drops an account's live sockets (after "log out everywhere", a password change or deletion). */
  const signOutSockets = (userId: number) => {
    for (const socket of io.sockets.sockets.values()) if (socket.data.userId === userId) socket.disconnect(true);
  };

  app.use(securityHeaders);
  app.use(
    '/api',
    createApiRouter(db, rooms, { authPerMinute: options.authPerMinute, guestsPerHour: options.guestsPerHour, allowedOrigins, onSignedOut: signOutSockets }),
  );
  if (options.clientDist && existsSync(options.clientDist)) app.use(express.static(options.clientDist, { dotfiles: 'deny', index: 'index.html' }));
  app.use(jsonErrors);

  // Socket connections: same-site only (no cross-site WebSocket hijacking), a few per IP, and
  // every socket belongs to an account (its session cookie, or a token from non-browser clients).
  const socketsPerIp = new Map<string, number>();
  const maxSockets = options.maxSocketsPerIp ?? 32;
  io.use((socket, next) => {
    const headers = socket.handshake.headers;
    const forwardedHost = hops > 0 && typeof headers['x-forwarded-host'] === 'string' ? headers['x-forwarded-host'] : undefined;
    if (!originAllowed(headers.origin, [headers.host, forwardedHost], allowedOrigins)) return next(new Error('forbidden origin'));
    const ip = clientIp(socket, hops);
    if ((socketsPerIp.get(ip) ?? 0) >= maxSockets) return next(new Error('too many connections'));
    const authToken = isRecord(socket.handshake.auth) ? socket.handshake.auth.token : undefined;
    const token = typeof authToken === 'string' ? authToken : readCookie(headers.cookie, SESSION_COOKIE);
    const userId = token ? db.userIdForSession(hashToken(token)) : undefined;
    if (userId === undefined) return next(new Error('unauthorized'));
    socket.data.userId = userId;
    socket.data.ip = ip;
    socketsPerIp.set(ip, (socketsPerIp.get(ip) ?? 0) + 1);
    socket.on('disconnect', () => {
      const n = (socketsPerIp.get(ip) ?? 1) - 1;
      if (n <= 0) socketsPerIp.delete(ip);
      else socketsPerIp.set(ip, n);
    });
    next();
  });

  io.on('connection', (socket) => {
    social.attach(socket);
    attachHandlers(socket, rooms, social, dev, options.publicHvhPanel !== false);
  });

  const cleanup = () => {
    const removed = db.cleanup();
    if (removed.sessions || removed.guests) log(`[server] cleanup: ${removed.sessions} expired sessions, ${removed.guests} old guest accounts`);
  };
  cleanup();
  const cleanupTimer = setInterval(cleanup, CLEANUP_INTERVAL_MS);
  cleanupTimer.unref();

  await new Promise<void>((resolve) => http.listen(options.port, resolve));
  const port = (http.address() as AddressInfo).port;
  log(`[server] game server listening on port ${port}`);

  return {
    http,
    io,
    db,
    rooms,
    port,
    close: async () => {
      clearInterval(cleanupTimer);
      rooms.closeAll();
      await new Promise<void>((resolve) => io.close(() => resolve()));
      db.close();
    },
  };
}

function attachHandlers(socket: GameSocket, rooms: RoomManager, social: Social, dev: DevAccess | null, publicHvh: boolean): void {
  // Joining is cheap to spam and expensive to serve, so it gets its own budget.
  const joinLimiter = new TokenBucket(5, 0.5);
  const tooFast = { ok: false as const, error: 'Slow down a little.' };

  /** Runs `fn` only if the socket is in a room as a player. */
  const inRoom =
    <A extends unknown[]>(fn: (room: GameRoom, player: ServerPlayer, ...args: A) => void) =>
    (...args: A) => {
      const room = rooms.roomOf(socket.id);
      const player = room?.playerFor(socket.id);
      if (room && player) fn(room, player, ...args);
    };

  socket.on('listRooms', (ack) => {
    if (typeof ack === 'function') ack(rooms.list());
  });

  socket.on('quickPlay', (req, ack) => {
    if (typeof ack !== 'function') return;
    if (!joinLimiter.take()) return ack(tooFast);
    const mode = isRecord(req) && isModeId(req.mode) ? req.mode : 'ffa';
    const map = isRecord(req) && isMapId(req.map) && MODES[mode].maps.includes(req.map) ? req.map : undefined;
    // With a party, the leader brings everyone (to a room with space for all of them).
    const withoutBots = isRecord(req) && req.noBots === true;
    ack(social.joinWithParty(socket, (size) => rooms.quickPlay(mode, map, size, withoutBots)));
  });

  socket.on('createRoom', (req, ack) => {
    if (typeof ack !== 'function') return;
    if (!joinLimiter.take()) return ack(tooFast);
    if (!isRecord(req) || !isModeId(req.mode) || !isMapId(req.map) || !MODES[req.mode].maps.includes(req.map)) {
      return ack({ ok: false, error: 'That mode and map combination is not available.' });
    }
    if (MODES[req.mode].ranked) return ack({ ok: false, error: `${MODES[req.mode].name} is matchmaking only: use Play on the menu.` });
    const bots = Number.isInteger(req.bots) ? Math.max(0, Math.min(8, req.bots as number)) : 0;
    const host = rooms.roomOf(socket.id)?.playerFor(socket.id)?.info.name;
    ack(social.joinWithParty(socket, () => rooms.create(req.mode as ModeId, req.map as MapId, req.private === true, host ?? 'Player', bots)));
  });

  socket.on('joinRoom', (req, ack) => {
    if (typeof ack !== 'function') return;
    if (!joinLimiter.take()) return ack(tooFast);
    const room = !isRecord(req)
      ? undefined
      : typeof req.roomId === 'string'
        ? rooms.get(req.roomId)
        : typeof req.code === 'string'
          ? rooms.byCode(req.code)
          : undefined;
    if (!room) return ack({ ok: false, error: 'Room not found. Check the code.' });
    ack(social.joinWithParty(socket, () => room));
  });

  socket.on('leaveRoom', () => rooms.leave(socket));

  socket.on('input', inRoom((room, player, frame: unknown) => room.handleInput(player, frame)));
  socket.on('fire', inRoom((room, player, req: unknown) => room.handleFire(player, req)));
  socket.on('reload', inRoom((room, player) => room.handleReload(player)));
  socket.on('switchWeapon', inRoom((room, player, slot: unknown) => room.handleSwitch(player, slot)));
  socket.on('trainingGive', (req, ack) => {
    if (typeof ack !== 'function') return;
    const room = rooms.roomOf(socket.id);
    const player = room?.playerFor(socket.id);
    if (!(room instanceof TrainingRoom) || !player) return ack({ ok: false, error: 'Only in Training.' });
    const error = room.give(player, req);
    ack(error ? { ok: false, error } : { ok: true });
  });
  socket.on('switchTeam', (ack) => {
    if (typeof ack !== 'function') return;
    const room = rooms.roomOf(socket.id);
    const player = room?.playerFor(socket.id);
    if (!room || !player) return ack({ ok: false, error: 'You are not in a match.' });
    const error = room.switchTeam(player, performance.now());
    ack(error ? { ok: false, error } : { ok: true });
  });
  socket.on('throw', inRoom((room, player, req: unknown) => room.handleThrow(player, req)));
  socket.on('aim', inRoom((room, player, aiming: unknown) => room.handleAim(player, aiming)));
  socket.on('chat', inRoom((room, player, text: unknown, teamOnly?: unknown) => room.handleChat(player, text, teamOnly === true)));
  const reportLimiter = new TokenBucket(5, 0.05);
  socket.on('report', (req, ack) => {
    if (typeof ack !== 'function') return;
    if (!reportLimiter.take()) return ack({ ok: false, error: 'Slow down a little.' });
    ack(isRecord(req) ? rooms.report(socket, req.pid, req.reason) : { ok: false, error: 'Invalid report.' });
  });
  socket.on('useVehicle', inRoom((room, player) => room.handleUseVehicle(player)));
  socket.on('zombieBuild', inRoom((room, player) => room.handleZombieBuild(player)));
  socket.on('zombieRestart', inRoom((room, player) => room.handleZombieRestart(player)));
  socket.on('buy', (itemId, ack) => {
    if (typeof ack !== 'function') return;
    const room = rooms.roomOf(socket.id);
    const player = room?.playerFor(socket.id);
    ack(room && player ? room.handleBuy(player, itemId) : { ok: false, error: 'Join a match first.', money: 0 });
  });
  socket.on('build', inRoom((room, player, req: unknown) => room.handleBuild(player, req)));
  socket.on('unbuild', inRoom((room, player, id: unknown) => room.handleUnbuild(player, id)));

  attachDevHandlers(socket, rooms, dev, publicHvh);

  socket.on('latency', (ack) => {
    if (typeof ack === 'function') ack(performance.now());
  });

  socket.on('disconnect', () => rooms.leave(socket));
}

/**
 * Developer tools. Every request is checked here: the account must have unlocked access with
 * the passkey (checked server-side), and the room must allow developer tools.
 */
function attachDevHandlers(socket: GameSocket, rooms: RoomManager, dev: DevAccess | null, publicHvh: boolean): void {
  const limiter = new TokenBucket(30, 15);
  const denied = { ok: false as const, error: 'Developer tools are not available.' };

  const context = () => {
    const room = rooms.roomOf(socket.id);
    const player = room?.playerFor(socket.id);
    const passkeyGrant = dev !== null && dev.isGranted(socket.data.userId);
    const hvh = room?.mode.id === 'hvh';
    const granted = passkeyGrant || (publicHvh && hvh);
    const allowed = granted && room !== undefined && (hvh || dev?.allowedIn(room) === true);
    const profile: DevStatus['profile'] = allowed ? hvh ? 'hvh' : 'admin' : 'off';
    if (room && player) room.enforceHvhRules(player);
    if (hvh && player && !granted) { player.hvhEnabled = false; player.hvh = defaultHvhLoadout(); }
    return { room, player, granted, allowed, profile };
  };
  const status = (): DevStatus => {
    const { player, granted, allowed, profile } = context();
    return { granted, allowedHere: allowed, profile, publicHvh, hvh: profile === 'hvh' && player ? player.hvh : defaultHvhLoadout(), mods: profile === 'admin' && player?.mods ? player.mods : { ...DEFAULT_MODS } };
  };

  socket.on('devAuth', (passkey, ack) => {
    if (typeof ack !== 'function') return;
    if (!dev) return ack(denied);
    const result = dev.tryUnlock(socket.data.userId, socket.data.ip, passkey);
    if (result === 'ok') ack({ ok: true });
    else if (result === 'denied') ack(denied);
    else ack({ ok: false, error: result === 'limited' ? 'Too many attempts. Wait a minute and try again.' : 'Wrong code.' });
  });

  socket.on('devStatus', (ack) => {
    if (typeof ack === 'function') ack(status());
  });

  socket.on('devMods', (raw, ack) => {
    if (typeof ack !== 'function' || !limiter.take()) return;
    const { player, allowed, profile } = context();
    if (player && allowed && profile === 'admin') {
      const mods = sanitizeMods(raw, player.mods ?? DEFAULT_MODS);
      player.mods = isDefaultMods(mods) ? null : mods;
      // Magazines can't hold more than the (possibly smaller) new size.
      for (const [id, n] of player.mags) player.mags.set(id, Math.min(n, player.magazineSize(id)));
      if (player.mods?.infiniteFlashes) player.flashes = PLAYER.maxFlashes;
    }
    ack(status());
  });

  socket.on('devAction', (raw, ack) => {
    if (typeof ack !== 'function') return;
    if (!limiter.take()) return ack({ ok: false, error: 'Slow down a little.' });
    const { room, player, granted, allowed } = context();
    if (!granted) return ack(denied);
    if (!room || !player) return ack({ ok: false, error: 'Join a match first.' });
    if (room.mode.id === 'hvh') return ack({ ok: false, error: 'HvH keeps equal stats; player administration is unavailable.' });
    if (MODES[room.info.mode].ranked) return ack({ ok: false, error: 'Developer tools are off in ranked matches.' });
    const action = parseDevAction(raw);
    if (!action) return ack({ ok: false, error: 'Invalid request.' });
    if (!room.info.private && action.kind !== 'jumpscare') return ack({ ok: false, error: 'Player administration only works in private test rooms.' });
    if (!allowed) return ack({ ok: false, error: 'Developer tools only work in private rooms on this server.' });
    ack(runDevAction(room, player, action));
  });

  socket.on('hvhReady', (panel, ack) => {
    if (typeof ack !== 'function') return;
    if (!limiter.take()) return ack({ ok: false, error: 'Slow down a little.' });
    const { room, player, allowed, profile } = context();
    if (!HVH_PANEL_IDS.includes(panel)) return ack({ ok: false, error: 'Unknown HvH panel.' });
    if (!room || !player || room.mode.id !== 'hvh') return ack({ ok: false, error: 'Join an HvH match first.' });
    if (panel !== 'manual' && (!allowed || profile !== 'hvh')) return ack({ ok: false, error: 'Unlock panel access or choose Manual play.' });
    ack(room.finishHvhSetup(player, panel) ? { ok: true } : { ok: false, error: 'This match has ended.' });
  });

  socket.on('devHvh', (raw, ack) => {
    if (typeof ack !== 'function') return;
    if (!limiter.take()) return ack(status());
    const { room, player, profile } = context();
    if (room && player && profile === 'hvh' && (player.hvhPreparing || player.hvhPanel !== 'manual')) {
      player.hvh = sanitizeHvhLoadout(raw);
      player.hvhEnabled = true;
      room.updateHvhPose(player, performance.now());
    }
    ack(status());
  });
}

/** The client's IP: the socket's address, or the proxy-reported one when we sit behind `hops` proxies. */
function clientIp(socket: GameSocket, hops: number): string {
  const forwarded = socket.handshake.headers['x-forwarded-for'];
  if (hops > 0 && typeof forwarded === 'string') {
    const chain = forwarded.split(',').map((x) => x.trim()).filter(Boolean);
    // The last `hops` entries were added by our own proxies; the one before them is the client.
    const ip = chain[chain.length - hops];
    if (ip) return ip;
  }
  return socket.handshake.address;
}
