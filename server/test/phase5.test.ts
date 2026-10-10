import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { BLOCK_ID_BASE, BUGGY, MAPS, PLAYER, SIM_DT, blockAabb, stepPlayer, type InputFrame } from '@game/shared';
import type { GameRoom } from '../src/rooms/GameRoom';
import { createRoom } from '../src/rooms/modes';
import type { ServerPlayer } from '../src/rooms/ServerPlayer';
import { addPlayer, fakeIo, place, type RecordedEvent } from './helpers';

let current: GameRoom | null = null;
afterEach(() => current?.close());

function room(mode: 'ffa' | 'tdm' | 'ctf' | 'sandbox' | 'knife', map: 'farm' | 'town' | 'flat' = 'farm', extra: { bots?: number; fillBots?: boolean } = {}) {
  const { io, events } = fakeIo();
  const r = createRoom(io, { id: 't', code: 'TEST1', name: 'Test', mode, map, private: false, ...extra }, {});
  current = r;
  return { room: r, events };
}

/** Runs the room's fixed update `n` times, as the server loop would. */
function tick(r: GameRoom, n: number): void {
  const update = (r as unknown as { fixedUpdate(now: number): void }).fixedUpdate.bind(r);
  for (let i = 0; i < n; i++) update(performance.now());
}

let seq = 1000;
function input(r: GameRoom, p: ServerPlayer, frame: Partial<InputFrame>, times = 1): void {
  for (let i = 0; i < times; i++) {
    p.takeInputToken = () => true;
    r.handleInput(p, { seq: ++seq, forward: 0, right: 0, jump: false, yaw: 0, pitch: 0, ...frame });
    tick(r,1);
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const named = (events: RecordedEvent[], name: string) => events.filter((e) => e.event === name).map((e) => e.args[0] as Record<string, unknown>);

describe('vehicles', () => {
  it('lets a chicken get in, drive, and get out beside the car', () => {
    const { room: r } = room('ffa');
    const a = addPlayer(r, 'Driver');
    const spot = MAPS.farm.vehicles[0]!;
    place(a, spot.x - 2, spot.z);
    r.handleUseVehicle(a);
    assert.equal(a.vehicle, 1);
    // Car faces -Z (yaw 0); full throttle for 1 s.
    input(r, a, { forward: 1 }, 60);
    const snap = r.snapshot();
    const car = snap.v[0]!;
    assert.ok(car[4]! > 8, `car speed ${car[4]}`);
    // Snapshots round to millimetres.
    assert.ok(Math.abs(a.state.z - car[2]!) < 1e-3 && Math.abs(a.state.x - car[1]!) < 1e-3, 'driver rides with the car');
    assert.ok(car[2]! < spot.z - 4, 'car moved forward');
    r.handleUseVehicle(a);
    assert.equal(a.vehicle, 0);
    assert.ok(Math.hypot(a.state.x - car[1]!, a.state.z - car[2]!) > 1.5, 'stepped out beside it');
  });

  it('runs over enemies at speed', () => {
    const { room: r } = room('ffa');
    const a = addPlayer(r, 'Driver');
    const b = addPlayer(r, 'Pedestrian');
    const spot = MAPS.farm.vehicles[0]!;
    place(a, spot.x - 2, spot.z);
    r.handleUseVehicle(a);
    input(r, a, { forward: 1 }, 40);
    const car = r.snapshot().v[0]!;
    place(b, car[1]!, car[2]! - 1.5);
    tick(r, 1);
    assert.ok(b.hp < PLAYER.maxHealth, `pedestrian hp ${b.hp}`);
    assert.ok(b.state.vy > 0, 'knocked into the air');
  });

  it('protects the driver from bullets but the car can be wrecked', () => {
    const { room: r, events } = room('ffa');
    const a = addPlayer(r, 'Driver');
    const shooter = addPlayer(r, 'Shooter');
    const spot = MAPS.farm.vehicles[0]!;
    place(a, spot.x - 2, spot.z);
    r.handleUseVehicle(a);
    place(shooter, spot.x, spot.z - 8);
    let shot = 0;
    for (let i = 0; i < 400 && a.vehicle; i++) {
      shooter.lastFireAt = -Infinity;
      shooter.mags.set('rifle', 30);
      r.handleFire(shooter, { shot: ++shot, weapon: 'rifle', dx: 0, dy: -0.05, dz: 1, t: performance.now(), aiming: true });
    }
    assert.equal(a.vehicle, 0, 'wreck throws the driver out');
    assert.ok(named(events, 'explode').some((e) => (e.id as number) < 0), 'wreck explodes');
    assert.ok(shot * 17 >= BUGGY.maxHp);
  });
});

describe('bots', () => {
  it('fill quick-play rooms, wander and fight', async (t) => {
    const { room: r, events } = room('ffa', 'farm', { fillBots: true });
    const human = addPlayer(r, 'Human');
    let hits = 0;
    const damage = r.damage.bind(r);
    r.damage = (victim, ...rest) => {
      if (victim === human) hits++;
      return damage(victim, ...rest);
    };
    await sleep(300);
    const bots = [...r.players.values()].filter((p) => p.info.bot);
    assert.equal(bots.length, 3, 'tops up to 4 players');
    const before = new Map(bots.map((b) => [b.pid, { x: b.state.x, z: b.state.z }]));
    await sleep(2500);
    const moved = bots.filter((b) => Math.hypot(b.state.x - before.get(b.pid)!.x, b.state.z - before.get(b.pid)!.z) > 1);
    assert.ok(moved.length >= 2, 'bots walk around');

    // Reset both lives: wandering can leave this random opponent dead or in mid-air.
    // Aim error is deterministic here; pellet spread still uses the real shared shot seeds.
    const random = Math.random;
    Math.random = () => 0.5;
    t.after(() => { Math.random = random; });
    const bot = bots[0]!;
    r.respawnPlayer(human, performance.now());
    r.respawnPlayer(bot, performance.now());
    for (const other of bots.slice(1)) r.removePlayer(other);
    place(human, 20, -15);
    place(bot, 20, -5);
    human.shieldUntil = 0;
    await sleep(3000);
    assert.ok(named(events, 'shot').some((s) => s.pid === bot.pid), 'bot fires');
    assert.ok(hits > 0, 'bot hits the human');
  });

  it('step aside when the room fills with humans', () => {
    const { room: r } = room('ffa', 'farm', { bots: 11 });
    addPlayer(r, 'H0');
    tick(r, 1);
    assert.equal(r.playerCount, 12);
    addPlayer(r, 'H1');
    assert.equal(r.playerCount, 12, 'a bot left to make room');
    assert.equal(r.humanCount, 2);
  });
});

describe('capture the flag', () => {
  it('takes the enemy flag, drops it on death and captures at home', () => {
    const { room: r, events } = room('ctf');
    const red = addPlayer(r, 'Red');
    const blue = addPlayer(r, 'Blue');
    red.info.team = 1;
    blue.info.team = 2;
    r.startNow();
    red.shieldUntil = blue.shieldUntil = 0;
    const blueFlag = MAPS.farm.flags.find((f) => f.team === 2)!;
    const redBase = MAPS.farm.flags.find((f) => f.team === 1)!;

    place(red, blueFlag.x, blueFlag.z);
    tick(r, 1);
    assert.equal(red.carryingFlag, 2);
    assert.equal(named(events, 'flag').at(-1)!.kind, 'taken');

    r.damage(red, blue, 500, false, 'rifle', { x: 0, y: 0, z: 0 }, performance.now());
    assert.equal(red.carryingFlag, 0);
    assert.equal(named(events, 'flag').at(-1)!.kind, 'dropped');

    // Blue touches its dropped flag: back to base.
    place(blue, red.state.x, red.state.z);
    tick(r, 1);
    assert.equal(named(events, 'flag').at(-1)!.kind, 'returned');

    // Red respawns, grabs it again and runs home.
    red.respawn(blueFlag.x, blueFlag.z, 0, performance.now());
    red.shieldUntil = 0;
    place(blue, -20, 5);
    tick(r, 1);
    assert.equal(red.carryingFlag, 2);
    place(red, redBase.x, redBase.z);
    tick(r, 1);
    const last = named(events, 'flag').at(-1)!;
    assert.equal(last.kind, 'captured');
    assert.equal(red.carryingFlag, 0);
    const scores = named(events, 'scores').at(-1)!;
    assert.deepEqual(scores.teamScores, [1, 0]);
  });
});

describe('sandbox building', () => {
  it('places solid blocks within reach and removes them', () => {
    const { room: r, events } = room('sandbox', 'flat');
    const a = addPlayer(r, 'Builder');
    place(a, 10, 10);
    // Cell (10, 0, 8) is ~2.5 m in front (-Z) of the builder at z = 10.
    r.handleBuild(a, { cx: 8, cy: 0, cz: 6, kind: 'brick' });
    const placed = named(events, 'blockPlaced').at(-1)!;
    assert.equal(placed.kind, 'brick');
    const box = blockAabb(8, 0, 6);
    assert.ok(r.world.get(BLOCK_ID_BASE + (placed.id as number)), 'block is in the collision world');

    // Walk into it: blocked.
    place(a, box.minX + 0.6, box.maxZ + 2);
    for (let i = 0; i < 90; i++) stepPlayer(a.state, { seq: i, forward: 1, right: 0, jump: false, yaw: 0, pitch: 0 }, SIM_DT, r.world);
    assert.ok(a.state.z >= box.maxZ + PLAYER.radius - 1e-6, `stopped at the block (z ${a.state.z})`);

    // Same cell again, far away, or inside a player: rejected.
    const count = named(events, 'blockPlaced').length;
    r.handleBuild(a, { cx: 8, cy: 0, cz: 6, kind: 'wood' });
    r.handleBuild(a, { cx: 30, cy: 0, cz: 30, kind: 'wood' });
    const cell = { cx: Math.floor(a.state.x / 1.2), cy: 0, cz: Math.floor(a.state.z / 1.2) };
    r.handleBuild(a, { ...cell, kind: 'wood' });
    assert.equal(named(events, 'blockPlaced').length, count);

    r.handleUnbuild(a, placed.id);
    assert.equal(events.filter((e) => e.event === 'blockRemoved').length, 1);
    assert.equal(r.world.get(BLOCK_ID_BASE + (placed.id as number)), undefined);
  });
});

describe('Knife Fight', () => {
  it('is 3 vs 3 with knives only and no grenades, and knife bots charge in to stab', async () => {
    const { room: r, events } = room('knife', 'farm', { fillBots: true });
    const human = addPlayer(r, 'Human');
    await sleep(300);
    assert.equal(r.playerCount, 6, 'bots fill it to 3 vs 3');
    const teams = [...r.players.values()].map((p) => p.info.team);
    assert.equal(teams.filter((t) => t === 1).length, 3);
    for (const p of r.players.values()) {
      assert.deepEqual(p.info.loadout, ['knife']);
      assert.equal(p.eggs + p.smokes, 0, 'no grenades');
    }

    let stabbed = 0;
    const damage = r.damage.bind(r);
    r.damage = (victim, attacker, amount, headshot, cause, ...rest) => {
      if (victim === human && cause === 'knife') stabbed++;
      return damage(victim, attacker, amount, headshot, cause, ...rest);
    };
    // An enemy bot 10 m down the clear lane has to close the gap to hit with a knife.
    const bot = [...r.players.values()].find((p) => p.info.bot && p.info.team !== human.info.team)!;
    for (const other of [...r.players.values()]) if (other !== bot && other !== human) other.alive = false;
    place(human, 20, -15);
    place(bot, 20, -5);
    human.shieldUntil = 0;
    await sleep(4000);
    assert.ok(named(events, 'shot').some((s) => s.pid === bot.pid && s.weapon === 'knife'), 'bot swings its knife');
    assert.ok(stabbed > 0, 'and stabs the human');
  });
});
