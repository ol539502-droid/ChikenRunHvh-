import assert from 'node:assert/strict';
import { it } from 'node:test';
import { SIM_DT, type ModeId } from '@game/shared';
import { GameRoom } from '../src/rooms/GameRoom';
import { addPlayer, fakeIo, place, stepRoom } from './helpers';

function botRoom(mode: ModeId = 'hvh') {
  const { io } = fakeIo();
  const room = new GameRoom(io, { id: 'bot-movement', code: 'BOT02', name: 'Bot movement test', mode, map: 'flat', private: true, bots: 1 }, {});
  const enemy = addPlayer(room, 'Opponent');
  room.bots.add();
  const bot = [...room.players.values()].find(p => p.info.bot)!;
  room.startNow();
  bot.info.team = 2; enemy.info.team = 1;
  place(bot, 20, 20); place(enemy, 20, 12);
  bot.lookYaw = bot.yaw = 0;
  bot.shieldUntil = enemy.shieldUntil = 0;
  return { room, bot, enemy };
}

it('HvH bots pursue a public record around a finite tall wall instead of walking into it forever', t => {
  t.mock.method(Math, 'random', () => 0.5);
  const { room, bot } = botRoom(); t.after(() => room.close());
  // Melee has no rage shot candidate, so the pursuit target survives the movement test.
  bot.info.loadout = ['knife'];
  room.world.add(1000, { minX: 17, maxX: 23, minY: 0, maxY: 4, minZ: 15.5, maxZ: 16.5 });
  let now = performance.now();
  let crossed = false;
  for (let tick = 0; tick < 640; tick++) {
    bot.takeInputToken = () => true;
    stepRoom(room, now += SIM_DT * 1000);
    if (bot.state.z < 15) { crossed = true; break; }
  }
  assert.ok(crossed, `bot never passed the wall: ${bot.state.x}, ${bot.state.z}`);
});

it('ordinary bots retain their obstacle steering', t => {
  t.mock.method(Math, 'random', () => 0.5);
  const { room, bot } = botRoom('ffa'); t.after(() => room.close());
  room.world.add(1000, { minX: 17, maxX: 23, minY: 0, maxY: 4, minZ: 15.5, maxZ: 16.5 });
  room.roamSpots = () => [{ x: 20, z: 12 }];
  let now = performance.now();
  let steered = false;
  for (let tick = 0; tick < 160; tick++) {
    bot.takeInputToken = () => true;
    stepRoom(room, now += SIM_DT * 1000);
    if (Math.abs(bot.state.x - 20) > 2) { steered = true; break; }
  }
  assert.ok(steered, 'ordinary bot must still steer sideways at a tall wall');
});

it('HvH public-record pursuit uses the existing map waypoint route', t => {
  t.mock.method(Math, 'random', () => 0.5);
  const { room, bot } = botRoom(); t.after(() => room.close());
  room.world.add(1000, { minX: 17, maxX: 23, minY: 0, maxY: 4, minZ: 15.5, maxZ: 16.5 });
  Object.defineProperty(room, 'map', { value: { ...room.map, nav: [{ x: 24, z: 20 }, { x: 24, z: 12 }] } });
  const now = performance.now();
  room.bots.update(now); stepRoom(room, now + SIM_DT * 1000);
  assert.ok(bot.lastInput!.right > 0.9 && Math.abs(bot.lastInput!.forward) < 0.01, 'first movement must follow the side waypoint');
});

it('HvH bots discard old-life aim and return state even when respawn happens between bot updates', t => {
  t.mock.method(Math, 'random', () => 0.5);
  for (const observeDeath of [false, true]) {
    const { room, bot, enemy } = botRoom(); t.after(() => room.close());
    let now = performance.now();
    room.bots.update(now);
    assert.ok(bot.fireQueue.length > 0, 'first life must prime a shot and return state');
    if (observeDeath) { bot.alive = false; room.bots.update(now += SIM_DT * 1000); }
    bot.respawn(30, 20, 0, now += SIM_DT * 1000, 0);
    enemy.respawn(38, 20, 0, now, 0);
    bot.shieldUntil = enemy.shieldUntil = 0;
    bot.takeInputToken = () => true;
    room.bots.update(now);
    const fresh = bot.commands.next()!;
    assert.ok(Math.abs(fresh.yaw + Math.PI / 2) < 0.1, 'new life must scan from its new position');
    assert.ok(Math.abs(fresh.forward) + Math.abs(fresh.right) < 0.01, 'new life must not return to the old spawn');
    place(bot, 31, 20);
    bot.takeInputToken = () => true;
    room.bots.update(now += SIM_DT * 1000);
    const input = bot.commands.next()!;
    const x = -Math.sin(input.yaw) * input.forward + Math.cos(input.yaw) * input.right;
    const z = -Math.cos(input.yaw) * input.forward - Math.sin(input.yaw) * input.right;
    assert.ok(x < -0.9 && Math.abs(z) < 0.01, 'post-shot return must use the new spawn anchor');
  }
});

it('HvH bots run at most one rage scan per server tick, and every bot still scans', t => {
  t.mock.method(Math, 'random', () => 0.5);
  const { io } = fakeIo();
  const room = new GameRoom(io, { id: 'bot-scan', code: 'BOT03', name: 'Bot scan test', mode: 'hvh', map: 'flat', private: true, bots: 6 }, {});
  t.after(() => room.close());
  const enemy = addPlayer(room, 'Opponent');
  for (let i = 0; i < 6; i++) room.bots.add();
  room.startNow();
  enemy.shieldUntil = 0;
  const brains = [...(room.bots as unknown as { brains: Map<number, { hvhNextScan?: number }> }).brains.values()];
  assert.equal(brains.length, 6);
  const scanned = new Set<number>();
  let now = performance.now();
  for (let tick = 0; tick < 64; tick++) {
    now += SIM_DT * 1000;
    const before = brains.map(b => b.hvhNextScan);
    stepRoom(room, now);
    const changed = brains.flatMap((b, i) => (b.hvhNextScan ?? 0) > (before[i] ?? 0) ? [i] : []);
    assert.ok(changed.length <= 1, `tick ${tick}: ${changed.length} bots scanned`);
    changed.forEach(i => scanned.add(i));
  }
  assert.equal(scanned.size, 6, 'every bot scanned within a second');
});

it('when the server runs slow, every HvH bot still gets rage scans (the most overdue bot goes first)', t => {
  t.mock.method(Math, 'random', () => 0.5);
  const { io } = fakeIo();
  const room = new GameRoom(io, { id: 'bot-scan-slow', code: 'BOT04', name: 'Bot scan slow', mode: 'hvh', map: 'flat', private: true, bots: 9 }, {});
  t.after(() => room.close());
  addPlayer(room, 'Opponent');
  for (let i = 0; i < 9; i++) room.bots.add();
  room.startNow();
  // Knives: nobody dies, so every bot is due for scans the whole time (scanRage still runs and finds no shot).
  for (const p of room.players.values()) { p.info.loadout = ['knife']; }
  const brains = [...(room.bots as unknown as { brains: Map<number, { hvhNextScan?: number; p: { alive: boolean } }> }).brains.values()];
  assert.equal(brains.length, 9);
  const scans = brains.map(() => 0);
  let now = performance.now();
  // 40 server ticks a second: fewer scan slots than due bots.
  for (let tick = 0; tick < 160; tick++) {
    now += 25;
    const before = brains.map(b => b.hvhNextScan);
    stepRoom(room, now);
    brains.forEach((b, i) => { if ((b.hvhNextScan ?? 0) > (before[i] ?? 0)) scans[i]!++; });
  }
  // 160 slots over 4 s shared by 9 bots: everyone scans repeatedly, nobody is starved.
  assert.ok(brains.every(b => b.p.alive), 'nobody died');
  assert.ok(Math.min(...scans) >= 10, `scans per bot: ${scans.join(',')}`);
});
