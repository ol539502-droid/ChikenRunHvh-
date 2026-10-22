import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { io as connect, type Socket } from 'socket.io-client';
import { SIM_DT, type ClientToServerEvents, type ServerToClientEvents } from '@game/shared';
import { startGameServer, type RunningServer } from '../../src/app';
import type { CommandIntent } from '@game/shared/hvh/v2';
import type { ServerPlayer } from '../../src/rooms/ServerPlayer';
import { DEBUG_MAX_RECORDS, HvhRoom, type HvhEngine } from '../../src/rooms/HvhRoom';
import { addPlayer, fakeIo, place, stepRoom } from '../helpers';

const TICK_MS = SIM_DT * 1000;
type Sent = { event: string; data: unknown };

function fakeSocket(p: ServerPlayer, sink: Sent[]): void {
  const socket = { emit(event: string, data: unknown) { sink.push({ event, data }); }, to() { return { emit() {} }; }, leave() {}, volatile: { emit(event: string, data: unknown) { sink.push({ event, data }); } } };
  Object.defineProperty(p, 'socket', { value: socket });
}

const open: HvhRoom[] = [];
after(() => { for (const r of open) r.close(); });

function setup(engine: HvhEngine, isPrivate = true) {
  const { io } = fakeIo();
  const room = new HvhRoom(io, { id: 'dbg', code: 'DBG01', name: 'Debug', mode: 'hvh', map: 'flat', private: isPrivate, hvhEngine: engine }, {});
  open.push(room);
  const dev = addPlayer(room, 'Dev');
  const normal = addPlayer(room, 'Normal');
  const target = addPlayer(room, 'Target');
  dev.info.team = 1; normal.info.team = 1; target.info.team = 2;
  room.startNow();
  place(dev, 20, 20); place(normal, 22, 20); place(target, 20, 10);
  for (const p of [dev, normal, target]) { p.shieldUntil = 0; p.hvhEnabled = true; }
  const devSent: Sent[] = [];
  const normalSent: Sent[] = [];
  fakeSocket(dev, devSent);
  fakeSocket(normal, normalSent);
  return { room, dev, normal, target, devSent, normalSent };
}

function run(room: HvhRoom, players: ServerPlayer[], ticks: number): void {
  const seqs = new Map<number, number>();
  let now = performance.now();
  for (let i = 0; i < ticks; i++) {
    now += TICK_MS;
    for (const p of players) {
      const seq = (seqs.get(p.pid) ?? 0) + 1;
      seqs.set(p.pid, seq);
      room.handleInput(p, { seq, forward: 0, right: 0, jump: false, yaw: 0, pitch: 0, intent: { fire: false, choke: false, doubleTap: false, hideShots: false } as CommandIntent });
    }
    stepRoom(room, now);
  }
}

const debugMessages = (sent: Sent[]) => sent.filter((s) => s.event === 'hvhDebug');

describe('hvhDebug feed', () => {
  it('an authorized dev socket in a private v2 room receives hvhDebug for each other player', () => {
    const { room, dev, normal, target, devSent } = setup('v2');
    room.setDebugViewer(dev, () => true);
    run(room, [dev, normal, target], 5);
    const msgs = debugMessages(devSent).map((m) => m.data as { playerId: number; realPose: unknown; records: unknown[]; resolver: { side: string; confidence: number } });
    assert.ok(msgs.length > 0);
    assert.deepEqual([...new Set(msgs.map((m) => m.playerId))].sort(), [normal.pid, target.pid].sort());
    const last = msgs.filter((m) => m.playerId === target.pid).at(-1)!;
    assert.ok(last.records.length > 0);
    assert.ok(last.realPose && typeof last.resolver.confidence === 'number' && ['left', 'right', 'center'].includes(last.resolver.side));
  });

  it('sends at most one message per other player per tick', () => {
    const { room, dev, normal, target, devSent } = setup('v2');
    room.setDebugViewer(dev, () => true);
    run(room, [dev, normal, target], 1);
    assert.equal(debugMessages(devSent).length, 2);
  });

  it('a normal player never receives hvhDebug', () => {
    const { room, dev, normal, target, normalSent } = setup('v2');
    room.setDebugViewer(dev, () => true);
    run(room, [dev, normal, target], 5);
    assert.equal(debugMessages(normalSent).length, 0);
  });

  it('a viewer whose authorization is revoked, or in a public room, receives nothing', () => {
    const revoked = setup('v2');
    let ok = true;
    revoked.room.setDebugViewer(revoked.dev, () => ok);
    run(revoked.room, [revoked.dev, revoked.normal, revoked.target], 2);
    const before = debugMessages(revoked.devSent).length;
    ok = false;
    run(revoked.room, [revoked.dev, revoked.normal, revoked.target], 3);
    assert.equal(debugMessages(revoked.devSent).length, before);
    const pub = setup('v2', false);
    pub.room.setDebugViewer(pub.dev, () => true);
    run(pub.room, [pub.dev, pub.normal, pub.target], 3);
    assert.equal(debugMessages(pub.devSent).length, 0);
  });

  it('sends at most 24 records per target, volatile, and skips dead targets', () => {
    const { room, dev, normal, target, devSent } = setup('v2');
    room.setDebugViewer(dev, () => true);
    run(room, [dev, normal, target], 40);
    const msgs = debugMessages(devSent).map((m) => m.data as { records: unknown[] });
    assert.ok(msgs.every((m) => m.records.length <= DEBUG_MAX_RECORDS));
    assert.equal(msgs.at(-1)!.records.length, Math.min(room.v2State(normal.pid)!.history.records().length, DEBUG_MAX_RECORDS));
    devSent.length = 0;
    Object.defineProperty(target, 'alive', { get: () => false, set: () => {}, configurable: true });
    run(room, [dev, normal], 2);
    assert.ok(debugMessages(devSent).every((m) => (m.data as { playerId: number }).playerId !== target.pid));
  });

  it('a legacy room sends the feed to nobody and keeps its old behaviour', () => {
    const { room, dev, devSent } = setup('legacy');
    room.setDebugViewer(dev, () => true);
    for (let i = 0; i < 3; i++) stepRoom(room, performance.now() + i * TICK_MS);
    assert.equal(debugMessages(devSent).length, 0);
    assert.ok(devSent.every((s) => s.event !== 'hvhState'));
  });

  it('building the feed leaves resolver memory unchanged (peekResolve, not resolve)', () => {
    const { room, dev, normal, target } = setup('v2');
    run(room, [dev, normal, target], 4);
    const before = structuredClone(room.v2State(dev.pid)!.resolver);
    room.setDebugViewer(dev, () => true);
    run(room, [dev, normal, target], 4);
    assert.deepEqual(room.v2State(dev.pid)!.resolver, before);
  });
});

describe('devHvhDebug socket gate', () => {
  type Client = Socket<ServerToClientEvents, ClientToServerEvents>;
  const clients: Client[] = [];
  const servers: RunningServer[] = [];
  const savedEngine = process.env.HVH_ENGINE;
  after(async () => {
    for (const c of clients) c.disconnect();
    for (const s of servers) await s.close();
    if (savedEngine === undefined) delete process.env.HVH_ENGINE; else process.env.HVH_ENGINE = savedEngine;
  });

  async function boot(engine: 'v2' | 'legacy', extra: Partial<Parameters<typeof startGameServer>[0]> = {}) {
    process.env.HVH_ENGINE = engine;
    const server = await startGameServer({ port: 0, dbPath: ':memory:', authPerMinute: 1000, guestsPerHour: 100_000, devPasskey: '2010', devInPublicRooms: false, ...extra });
    servers.push(server);
    const base = `http://localhost:${server.port}`;
    const join = async () => {
      const { token } = (await (await fetch(`${base}/api/auth/guest`, { method: 'POST', headers: { 'x-session-transport': 'token' } })).json()) as { token: string };
      const c: Client = connect(base, { transports: ['websocket'], auth: { token }, reconnection: false });
      clients.push(c);
      await new Promise<void>((resolve, reject) => { c.once('connect', () => resolve()); c.once('connect_error', reject); });
      return c;
    };
    return { server, join };
  }
  const createHvh = async (c: Client, isPrivate: boolean, join?: () => Promise<Client>) => {
    const res = await c.timeout(3000).emitWithAck('createRoom', { mode: 'hvh', map: 'mirage', private: isPrivate, bots: 2 });
    assert.ok(res.ok);
    if (res.ok && join) {
      // A second human, so there is another player to report on (bots are off in HvH rooms).
      const other = await join();
      assert.ok((await other.timeout(3000).emitWithAck('joinRoom', { code: res.room.code })).ok);
      assert.ok((await other.timeout(3000).emitWithAck('hvhReady', 'manual')).ok); // spawns them
    }
    return res;
  };
  const enable = (c: Client) => c.timeout(3000).emitWithAck('devHvhDebug', true);
  const until = async (cond: () => boolean, ms = 4000) => { for (let t = 0; t < ms && !cond(); t += 25) await wait(25); };
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it('denies without a passkey, even with the public HvH panel', async () => {
    const { join } = await boot('v2', { publicHvhPanel: true });
    const c = await join();
    await createHvh(c, true);
    let got = 0;
    c.on('hvhDebug', () => got++);
    assert.equal((await enable(c)).ok, false);
    await wait(300);
    assert.equal(got, 0);
  });

  it('denies a passkey holder in a public room', async () => {
    const { join } = await boot('v2', { devInPublicRooms: true });
    const c = await join();
    await c.timeout(3000).emitWithAck('devAuth', '2010');
    await createHvh(c, false);
    let got = 0;
    c.on('hvhDebug', () => got++);
    assert.equal((await enable(c)).ok, false);
    await wait(300);
    assert.equal(got, 0);
  });

  it('a private legacy-engine room refuses the feed (documented: v2 only)', async () => {
    const { join } = await boot('legacy');
    const c = await join();
    await c.timeout(3000).emitWithAck('devAuth', '2010');
    await createHvh(c, true);
    let got = 0;
    c.on('hvhDebug', () => got++);
    assert.equal((await enable(c)).ok, false);
    await wait(300);
    assert.equal(got, 0);
  });

  it('a passkey holder in a private v2 room gets hvhDebug; turning it off stops it', async () => {
    const { join } = await boot('v2');
    const c = await join();
    await c.timeout(3000).emitWithAck('devAuth', '2010');
    await createHvh(c, true, join);
    let got = 0;
    c.on('hvhDebug', () => got++);
    const r = await enable(c); assert.deepEqual(r, { ok: true });
    await until(() => got > 0);
    assert.ok(got > 0);
    assert.equal((await c.timeout(3000).emitWithAck('devHvhDebug', false)).ok, true);
    await wait(100);
    const after = got;
    await wait(300);
    assert.equal(got, after);
  });

  it('revoking developer status mid-session stops the feed on the next tick', async () => {
    const { server, join } = await boot('v2', { devAccountsOnly: true });
    const c = await join();
    const userId = (server.io.sockets.sockets.values().next().value as { data: { userId: number } }).data.userId;
    server.db.setDeveloper(userId, true);
    await c.timeout(3000).emitWithAck('devAuth', '2010');
    await createHvh(c, true, join);
    let got = 0;
    c.on('hvhDebug', () => got++);
    const r = await enable(c); assert.deepEqual(r, { ok: true });
    await until(() => got > 0);
    assert.ok(got > 0);
    server.db.setDeveloper(userId, false);
    // Frames already in flight may still arrive; the count must settle and then stay put.
    let last = -1;
    for (let i = 0; i < 40 && got !== last; i++) { last = got; await wait(150); }
    const frozen = got;
    await wait(400);
    assert.equal(got, frozen);
  });
});
