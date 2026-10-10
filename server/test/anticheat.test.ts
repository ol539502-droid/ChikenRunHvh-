import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { DEFAULT_APPEARANCE, HITBOX, MAPS, PLAYER, createCollisionWorld, isSpaceFree, makeRay, raycastWorld, type WorldSnapshot } from '@game/shared';
import { GameDatabase, RANKED_BAN_MS } from '../src/db/Database';
import { AC, type AntiCheatMode } from '../src/rooms/AntiCheat';
import type { GameRoom, RoomHooks } from '../src/rooms/GameRoom';
import { createRoom } from '../src/rooms/modes';
import { RoomManager } from '../src/rooms/RoomManager';
import type { ServerPlayer } from '../src/rooms/ServerPlayer';
import type { GameSocket } from '../src/types';
import { fakeIo, place } from './helpers';

let current: GameRoom | null = null;
afterEach(() => current?.close());

/** A socket that records what it's sent. */
function fakeSocket(id: string, userId: number) {
  const sent: { event: string; args: unknown[] }[] = [];
  const emit = (event: string, ...args: unknown[]) => {
    sent.push({ event, args });
    return true;
  };
  const socket = { id, data: { userId }, join: () => undefined, leave: () => undefined, emit, volatile: { emit }, to: () => ({ emit: () => true }) } as unknown as GameSocket;
  return { socket, sent };
}

function setup(players: number, hooks: RoomHooks = {}, antiCheat: AntiCheatMode = 'enforce') {
  const { io } = fakeIo();
  const room = createRoom(io, { id: 'ac', code: 'FAIR1', name: 'Fair', mode: 'face', map: 'sandstown', private: false, antiCheat }, hooks);
  current = room;
  clearInterval((room as unknown as { tickTimer: NodeJS.Timeout }).tickTimer);
  clearInterval((room as unknown as { snapshotTimer: NodeJS.Timeout }).snapshotTimer);
  const all: { p: ServerPlayer; sent: { event: string; args: unknown[] }[] }[] = [];
  for (let i = 0; i < players; i++) {
    const { socket, sent } = fakeSocket(`s${i}`, i + 1);
    const res = room.join(socket, { userId: i + 1, name: `P${i}`, appearance: { ...DEFAULT_APPEARANCE }, loadout: ['rifle', 'knife'] });
    if (!res.ok) throw new Error(res.error);
    const p = room.players.get(res.selfPid)!;
    p.shieldUntil = 0;
    all.push({ p, sent });
  }
  room.startNow();
  // Starting the match respawns everyone with spawn protection.
  for (const { p } of all) p.shieldUntil = 0;
  return { room, all, t: all.filter((x) => x.p.info.team === 1), ct: all.filter((x) => x.p.info.team === 2) };
}

/** One server tick (records positions for lag compensation). */
const tick = (room: GameRoom) => (room as unknown as { fixedUpdate(now: number): void }).fixedUpdate(performance.now());

let seq = 0;
/** Looks in a direction (the input frames the anti-cheat remembers). */
function look(room: GameRoom, p: ServerPlayer, yaw: number, pitch: number, frames = 3) {
  for (let i = 0; i < frames; i++) {
    p.takeInputToken = () => true;
    room.handleInput(p, { seq: ++seq, forward: 0, right: 0, jump: false, yaw, pitch });
  }
}
let shotSeq = 0;
function shoot(room: GameRoom, p: ServerPlayer, d: { x: number; y: number; z: number }) {
  p.lastFireAt = -Infinity;
  p.switchReadyAt = 0;
  p.reloadUntil = 0;
  p.mags.set(p.weapon, 30);
  const l = Math.hypot(d.x, d.y, d.z);
  room.handleFire(p, { shot: ++shotSeq, weapon: p.weapon, dx: d.x / l, dy: d.y / l, dz: d.z / l, t: performance.now(), aiming: true });
}
const anglesOf = (d: { x: number; y: number; z: number }) => ({ yaw: Math.atan2(-d.x, -d.z), pitch: Math.atan2(d.y, Math.hypot(d.x, d.z)) });
const headOf = (p: ServerPlayer) => ({ x: p.state.x - Math.sin(p.yaw) * HITBOX.headForward, y: p.state.y + HITBOX.headHeight, z: p.state.z - Math.cos(p.yaw) * HITBOX.headForward });

/** Two open spots on Sandstown `dist` apart with a clear line between them. */
function openPair(dist: number) {
  const world = createCollisionWorld(MAPS.sandstown);
  for (let x = -30; x <= 30; x += 2) {
    for (let z = -30; z <= 30; z += 2) {
      const a = { x, z };
      const b = { x: x + dist, z };
      if (!isSpaceFree(a.x, 0, a.z, world) || !isSpaceFree(b.x, 0, b.z, world)) continue;
      const blocked = [0.3, 1, 1.6].some((h) => raycastWorld(makeRay({ x: a.x, y: h, z: a.z }, { x: 1, y: 0, z: 0 }), world, dist));
      if (!blocked) return { a, b };
    }
  }
  throw new Error('no open pair');
}

describe('FaceChiken fog of war', () => {
  it("only sends enemies you could see (teammates always); the server still knows where everyone is", () => {
    const s = setup(4);
    const viewer = s.t[0]!;
    const enemy = s.ct[0]!.p;
    const mate = s.t[1]!.p;
    // A wall between them: find a solid box and stand either side of it.
    const world = s.room.world;
    const box = MAPS.sandstown.boxes.find((b) => b.h >= 3 && b.w >= 3 && b.d >= 3 && (b.y ?? 0) === 0 && isSpaceFree(b.x - b.w / 2 - 1.2, 0, b.z, world) && isSpaceFree(b.x + b.w / 2 + 8, 0, b.z, world))!;
    assert.ok(box, 'a wall to hide behind');
    place(viewer.p, box.x - box.w / 2 - 1.2, box.z);
    place(enemy, box.x + box.w / 2 + 8, box.z);
    place(mate, box.x + box.w / 2 + 9, box.z + 1);
    const snap = (who: ServerPlayer) => s.room.snapshotFor(who, performance.now() + 10_000);
    const pids = (w: WorldSnapshot) => w.p.map((p) => p[0]);
    assert.ok(!pids(snap(viewer.p)).includes(enemy.pid), 'the enemy behind the wall is left out');
    assert.ok(pids(snap(viewer.p)).includes(mate.pid), 'teammates are always sent');
    assert.ok(pids(s.room.snapshot()).includes(enemy.pid), 'the server itself still has everyone');
    // Out in the open: visible.
    const { a, b } = openPair(14);
    place(viewer.p, a.x, a.z);
    place(enemy, b.x, b.z);
    assert.ok(pids(snap(viewer.p)).includes(enemy.pid), 'in plain sight');
    // Very close is always sent (no pop-in round corners).
    place(enemy, box.x - box.w / 2 - 1.2, box.z + 3);
    place(viewer.p, box.x - box.w / 2 - 1.2, box.z);
    assert.ok(pids(snap(viewer.p)).includes(enemy.pid));
  });
});

describe('FaceChiken cheat detection', () => {
  it('throws away silent-aim shots and removes someone who keeps doing it', async () => {
    const caught: { reason: string; remove: boolean }[] = [];
    const s = setup(2, { onCheat: (_r, _p, reason, _d, remove) => caught.push({ reason, remove }) });
    const shooter = s.all[0]!.p;
    const victim = s.all[1]!.p;
    const { a, b } = openPair(10);
    place(shooter, a.x, a.z);
    place(victim, b.x, b.z);
    tick(s.room);
    const eye = s.room.eyeOf(shooter);
    const toHead = { x: headOf(victim).x - eye.x, y: headOf(victim).y - eye.y, z: headOf(victim).z - eye.z };
    // Looking the opposite way, shooting at the head.
    const away = anglesOf({ x: -toHead.x, y: 0, z: -toHead.z });
    for (let i = 0; i < 7 && !shooter.removedForCheating; i++) {
      look(s.room, shooter, away.yaw, away.pitch);
      victim.hp = PLAYER.maxHealth;
      shoot(s.room, shooter, toHead);
      assert.equal(victim.hp, PLAYER.maxHealth, 'the shot was thrown away');
    }
    await Promise.resolve();
    assert.ok(shooter.removedForCheating);
    assert.deepEqual(caught.map((c) => c.remove), [true]);
    assert.match(caught[0]!.reason, /silent aim/);
  });

  it('flags hits that are always dead centre (aim lock), not normal ones', async () => {
    const caught: string[] = [];
    const run = (offset: () => number) => {
      const s = setup(2, { onCheat: (_r, _p, reason) => caught.push(reason) });
      const shooter = s.all[0]!.p;
      const victim = s.all[1]!.p;
      const { a, b } = openPair(10);
      place(shooter, a.x, a.z);
      place(victim, b.x, b.z);
      tick(s.room);
      let hits = 0;
      for (let i = 0; i < 40 && hits < AC.lockMinHeadHits + 6; i++) {
        const eye = s.room.eyeOf(shooter);
        const head = headOf(victim);
        // Aim somewhere on the head: the centre, or spread over it like a person.
        const r = offset() * HITBOX.headRadius;
        const a2 = Math.random() * Math.PI * 2;
        const target = { x: head.x, y: head.y + Math.sin(a2) * r, z: head.z + Math.cos(a2) * r * 0.2 };
        const d = { x: target.x - eye.x, y: target.y - eye.y, z: target.z - eye.z };
        const view = anglesOf(d);
        look(s.room, shooter, view.yaw, view.pitch);
        victim.hp = PLAYER.maxHealth;
        shoot(s.room, shooter, d);
        if (victim.hp < PLAYER.maxHealth) hits++;
      }
      assert.ok(hits >= AC.lockMinHeadHits, `enough hits (${hits})`);
      s.room.close();
    };
    run(() => 0.5 + Math.random() * 0.45);
    await Promise.resolve();
    assert.deepEqual(caught, [], 'normal aim is fine');
    run(() => 0);
    await Promise.resolve();
    assert.ok(caught.some((r) => /aim lock/.test(r)), `aimbot caught (${caught.join('; ')})`);
  });

  it("watch-only mode logs but doesn't remove anyone", async () => {
    const caught: boolean[] = [];
    const s = setup(2, { onCheat: (_r, _p, _reason, _d, remove) => caught.push(remove) }, 'log');
    const shooter = s.all[0]!.p;
    const victim = s.all[1]!.p;
    const { a, b } = openPair(10);
    place(shooter, a.x, a.z);
    place(victim, b.x, b.z);
    const eye = s.room.eyeOf(shooter);
    const head = headOf(victim);
    const d = { x: head.x - eye.x, y: head.y - eye.y, z: head.z - eye.z };
    const away = anglesOf({ x: -d.x, y: 0, z: -d.z });
    for (let i = 0; i < 8; i++) {
      look(s.room, shooter, away.yaw, away.pitch);
      shoot(s.room, shooter, d);
    }
    await Promise.resolve();
    assert.deepEqual(caught, [false]);
    assert.equal(shooter.removedForCheating, false);
  });
});

describe('strikes and bans', () => {
  it('each strike bans from FaceChiken for longer; clearing lifts it', () => {
    const db = new GameDatabase(':memory:');
    const id = db.createUser('Sus', 0);
    assert.equal(db.rankedBan(id), null);
    const t0 = 1_000_000;
    db.addStrike(id, 'aim lock', {}, t0);
    assert.equal(db.rankedBan(id, t0 + 1000)!.until, t0 + RANKED_BAN_MS[0]);
    assert.equal(db.rankedBan(id, t0 + RANKED_BAN_MS[0] + 1), null, 'the first one wears off');
    db.addStrike(id, 'silent aim', {}, t0 + RANKED_BAN_MS[0] + 5);
    assert.equal(db.rankedBan(id, t0 + RANKED_BAN_MS[0] + 10)!.until, t0 + RANKED_BAN_MS[0] + 5 + RANKED_BAN_MS[1]);
    db.addStrike(id, 'aim lock', {}, t0 + RANKED_BAN_MS[0] + 10);
    assert.equal(db.rankedBan(id, t0 * 1000)!.until, Number.POSITIVE_INFINITY, 'third strike: for good');
    assert.equal(db.strikes(id).length, 3);
    assert.equal(db.clearStrikes(id), 3);
    assert.equal(db.rankedBan(id), null);
    db.close();
  });

  it('a caught player is removed with a strike, and a banned one cannot queue', async () => {
    const db = new GameDatabase(':memory:');
    const { io } = fakeIo();
    const rooms = new RoomManager(io, db);
    const ids = ['a', 'b', 'c', 'd'].map((n) => {
      const id = db.createUser(n, 0);
      db.setCredentials(id, `user_${n}`, 'hash');
      return id;
    });
    const sockets = ids.map((id, i) => fakeSocket(`k${i}`, id));
    for (const { socket } of sockets) assert.equal(rooms.join(socket, rooms.quickPlay('face')).ok, true);
    const room = rooms.roomOf('k0')!;
    const cheater = room.playerFor('k0')!;
    room.caughtCheating(cheater, 'aim lock', { test: true }, true);
    await Promise.resolve();
    assert.equal(rooms.roomOf('k0'), undefined, 'out of the room');
    assert.ok(sockets[0]!.sent.some((m) => m.event === 'roomClosed' && /anti-cheat/.test(String(m.args[0]))));
    assert.equal(db.strikes(ids[0]!).length, 1);
    const again = rooms.join(sockets[0]!.socket, rooms.quickPlay('face'));
    assert.equal(again.ok, false);
    assert.match(again.ok ? '' : again.error, /banned from FaceChiken/);
    for (const { socket } of sockets) rooms.leave(socket);
    rooms.closeAll();
    db.close();
  });
});
