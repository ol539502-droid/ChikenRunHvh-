import assert from 'node:assert/strict';
import { after, before, it } from 'node:test';
import { io as connect, type Socket } from 'socket.io-client';
import { MODE_IDS, MODES } from '@game/shared';
import { startGameServer, type RunningServer } from '../src/app';

/**
 * Hostile input: a real client fires every event the server listens to with junk (wrong types,
 * huge numbers, NaN-like values, deep objects, prototype keys) in a match of every mode. The
 * server must stay up and keep answering.
 */
let server: RunningServer;
let base: string;
const sockets: Socket[] = [];

before(async () => {
  server = await startGameServer({ port: 0, dbPath: ':memory:', authPerMinute: 1000, guestsPerHour: 100_000, devPasskey: 'fuzz-secret-key' });
  base = `http://localhost:${server.port}`;
});
after(async () => {
  for (const s of sockets) s.disconnect();
  await server.close();
});

async function guestSocket(): Promise<Socket> {
  const res = await fetch(`${base}/api/auth/guest`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-session-transport': 'token' } });
  const { token } = (await res.json()) as { token: string };
  const s = connect(base, { transports: ['websocket'], auth: { token }, reconnection: false });
  sockets.push(s);
  await new Promise<void>((resolve, reject) => { s.once('connect', () => resolve()); s.once('connect_error', reject); });
  return s;
}

const EVENTS = ['aim', 'build', 'buy', 'chat', 'createRoom', 'devAction', 'devAuth', 'devHvh', 'devMods', 'devStatus', 'fire', 'friendRemove', 'friendRequest',
  'friendRespond', 'friendsList', 'hvhReady', 'input', 'joinRoom', 'latency', 'listRooms', 'partyAnswer', 'partyInvite', 'partyKick', 'partyLeave', 'partyState',
  'quickPlay', 'reload', 'report', 'switchTeam', 'switchWeapon', 'throw', 'trainingGive', 'unbuild', 'useVehicle', 'zombieBuild', 'zombieRestart'];

const deep = (n: number): unknown => (n === 0 ? {} : { a: deep(n - 1) });
const JUNK: unknown[] = [
  undefined, null, 0, -1, 1e308, -1e308, 2 ** 53 + 1, 'x', '', 'a'.repeat(5000), true, [], [1, 2, 3], {}, deep(60),
  JSON.parse('{"__proto__":{"polluted":1},"constructor":{"prototype":{"x":1}}}'),
  { seq: 'NaN', forward: 'Infinity', right: null, yaw: {}, pitch: [], jump: 'yes' },
  { seq: 1e20, forward: 1e9, right: -1e9, yaw: 1e300, pitch: -1e300, jump: true, crouch: 1 },
  { shot: -5, weapon: 'nuke', dx: 0, dy: 0, dz: 0, seq: 1 },
  { kind: 'giveWeapon', weapon: 'golden', target: 1 }, { kind: 'teleport', x: 1e300, y: NaN, z: 'q' },
  { mode: 'face', map: 'nowhere' }, { mode: '__proto__' }, { code: { $ne: 1 } }, { roomId: ['a'] },
  { weapon: 'toString' }, { grenade: 'constructor' }, { cx: 1e9, cy: -1, cz: 0.5, kind: 'stone' }, { pid: -1, reason: 'spam' },
];

async function alive(s: Socket): Promise<boolean> {
  return await Promise.race([
    new Promise<boolean>((resolve) => s.emit('latency', () => resolve(true))),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 3000)),
  ]);
}

async function storm(s: Socket): Promise<void> {
  for (const event of EVENTS) {
    for (const a of JUNK) {
      s.emit(event, a);
      s.emit(event, a, () => {});
      s.emit(event, a, a, () => {});
    }
  }
  await new Promise((r) => setTimeout(r, 300));
}

it('junk on every event, outside and inside a match of every mode, never takes the server down', async () => {
  const errors: unknown[] = [];
  const onError = (e: unknown) => errors.push(e);
  process.on('uncaughtException', onError);
  try {
    const s = await guestSocket();
    await storm(s);
    assert.ok(await alive(s), 'still answering after junk outside a match');
    s.disconnect();
    for (const mode of MODE_IDS) {
      if (MODES[mode].ranked) continue; // matchmaking only for registered players
      // A fresh player each time (the storm uses up a player's join rate limit, as it should).
      const p = await guestSocket();
      const joined = await new Promise<{ ok: boolean; error?: string }>((resolve) => p.emit('quickPlay', { mode }, resolve));
      assert.ok(joined.ok, `${mode}: joined (${joined.error})`);
      await storm(p);
      assert.ok(await alive(p), `${mode}: still answering`);
      p.disconnect();
    }
    // A second, ordinary player can still play.
    const other = await guestSocket();
    const joined = await new Promise<{ ok: boolean }>((resolve) => other.emit('quickPlay', { mode: 'ffa' }, resolve));
    assert.ok(joined.ok, 'a fresh player can still join');
    assert.equal(({} as Record<string, unknown>).polluted, undefined, 'no prototype pollution');
    assert.deepEqual(errors, [], 'no uncaught exceptions');
  } finally {
    process.off('uncaughtException', onError);
  }
});
