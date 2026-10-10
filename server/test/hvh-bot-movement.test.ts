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
