import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { MODES, SIM_DT, ZOMBIE, bossNumber, isBossWave, upgradeMultiplier, waveCount, waveKinds, zombieStats } from '@game/shared';
import type { GameRoom } from '../src/rooms/GameRoom';
import { createRoom } from '../src/rooms/modes';
import type { ZombieRoom } from '../src/rooms/ZombieRoom';
import { addPlayer, fakeIo } from './helpers';

const STEP = SIM_DT * 1000;

/** One clock for everything: the rooms use performance.now(), the tests move it by hand. */
const realNow = performance.now.bind(performance);
let clock = realNow();
performance.now = () => clock;
after(() => {
  performance.now = realNow;
});

/** A zombie room with a manual clock: `run(ms)` plays that much time. */
function setup() {
  const { io, events } = fakeIo();
  const room = createRoom(io, { id: 'z', code: 'ZOMBI', name: 'Z', mode: 'zombie', map: 'night', private: true, bots: 0 }, {}) as ZombieRoom;
  clearInterval((room as unknown as { tickTimer: NodeJS.Timeout }).tickTimer);
  const update = (room as unknown as { fixedUpdate(now: number): void }).fixedUpdate.bind(room);
  let now = clock;
  const run = (ms: number) => {
    const end = now + ms;
    while (now < end) {
      now = clock = Math.min(end, now + STEP);
      // Time runs faster than real here, so the per-player input rate limit would starve everyone.
      for (const p of room.players.values()) p.takeInputToken = () => true;
      update(now);
    }
  };
  const me = addPlayer(room, 'Survivor');
  room.startNow();
  const priv = room as unknown as {
    zphase: string;
    wave: number;
    kills: number;
    queue: unknown[];
    zombies: Map<number, { p: import('../src/rooms/ServerPlayer').ServerPlayer; kind: string; maxHp: number; stats: { reward: number } }>;
    blocks: Map<number, unknown>;
    upgrades: Map<number, Record<string, number>>;
    match: { phase: string };
  };
  const zombies = () => [...priv.zombies.values()];
  /** Kills every zombie right now, the way a survivor would. */
  const killAll = () => {
    for (const z of zombies()) if (z.p.alive) room.damage(z.p, me, 100000, false, 'rifle', { x: 0, y: 0, z: 0 }, now);
  };
  return { room, events, me, run, priv, zombies, killAll, now: () => now };
}

describe('Zombie Apocalypse rules', () => {
  it('waves grow, bosses come every fifth wave, and zombies get stronger', () => {
    assert.equal(waveCount(1), 6);
    for (let w = 2; w <= 20; w++) assert.ok(waveCount(w) >= waveCount(w - 1), 'waves never shrink');
    assert.ok(waveCount(999) <= ZOMBIE.count.cap);
    assert.equal(isBossWave(4), false);
    assert.equal(isBossWave(5), true);
    assert.equal(bossNumber(10), 2);
    assert.equal(waveKinds(5).filter((k) => k === 'boss').length, 1);
    assert.equal(waveKinds(4).includes('boss'), false);
    assert.equal(waveKinds(1).every((k) => k === 'walker'), true, 'wave 1 is walkers only');
    assert.ok(waveKinds(3).includes('runner'), 'runners from wave 3');
    assert.ok(waveKinds(5).includes('brute'), 'brutes from wave 5');
    const a = zombieStats('walker', 1);
    const b = zombieStats('walker', 10);
    assert.ok(b.hp > a.hp && b.speed > a.speed && b.damage > a.damage && b.attackMs < a.attackMs);
    assert.ok(zombieStats('boss', 10).hp > zombieStats('boss', 5).hp, 'each boss is tougher');
    assert.ok(zombieStats('walker', 99).speed <= ZOMBIE.perWave.speedCap);
    assert.equal(upgradeMultiplier(0), 1);
    assert.ok(upgradeMultiplier(5) > upgradeMultiplier(1));
  });

  it('the mode is a team of survivors with a cap, on its own night map, with no bots', () => {
    assert.equal(MODES.zombie.zombies, true);
    assert.equal(MODES.zombie.noBots, true);
    assert.equal(MODES.zombie.maxHumans, ZOMBIE.maxHumans);
    assert.deepEqual(MODES.zombie.maps, ['night']);
  });
});

describe('Zombie Apocalypse match', () => {
  it('starts with a 10 second countdown, then wave 1 sends zombies at the survivors', () => {
    const t = setup();
    assert.equal(t.priv.zphase, 'prep');
    assert.equal(t.priv.wave, 1);
    assert.equal(t.me.money, ZOMBIE.startMoney);
    t.run(ZOMBIE.prepMs - 500);
    assert.equal(t.priv.zphase, 'prep');
    assert.equal(t.zombies().length, 0);
    t.run(700);
    assert.equal(t.priv.zphase, 'wave');
    t.run(3000);
    const zs = t.zombies();
    assert.ok(zs.length >= 5, `zombies are coming (${zs.length})`);
    for (const z of zs) {
      assert.equal(z.p.info.team, 2);
      assert.equal(z.p.info.undead, 'walker');
      assert.equal(z.p.info.bot, true);
    }
    assert.equal(t.me.info.team, 1);
    t.room.close();
  });

  it('a zombie’s health bar is its share of its real health, and guns can be upgraded', () => {
    const t = setup();
    t.run(ZOMBIE.prepMs + 2500);
    const z = t.zombies()[0]!;
    assert.equal(z.maxHp, zombieStats('walker', 1).hp);
    // 30 damage of a 60 health zombie: half way.
    t.room.damage(z.p, t.me, 30, false, 'rifle', { x: 0, y: 0, z: 0 }, t.now());
    assert.equal(Math.round(z.p.hp), 50);
    // Level 2 upgrade: 1.5× damage.
    t.priv.upgrades.set(t.me.pid, { rifle: 2 });
    const z2 = t.zombies()[1]!;
    t.room.damage(z2.p, t.me, 10, false, 'rifle', { x: 0, y: 0, z: 0 }, t.now());
    assert.equal(Math.round(z2.p.hp), Math.round(100 - ((10 * upgradeMultiplier(2)) * 100) / z2.maxHp));
    t.room.close();
  });

  it('no friendly fire, and zombies do not hurt each other', () => {
    const t = setup();
    const mate = addPlayer(t.room, 'Mate');
    t.run(ZOMBIE.prepMs + 2500);
    const [a, b] = t.zombies();
    t.room.damage(mate, t.me, 50, false, 'rifle', { x: 0, y: 0, z: 0 }, t.now());
    assert.equal(mate.hp, 100, 'survivors can’t shoot each other');
    t.room.damage(b!.p, a!.p, 50, false, 'knife', { x: 0, y: 0, z: 0 }, t.now());
    assert.equal(b!.p.hp, 100, 'zombies can’t hurt zombies');
    t.room.close();
  });

  it('clearing a wave pays money, opens a 10 second shop, and the next wave is bigger', () => {
    const t = setup();
    t.run(ZOMBIE.prepMs + 1000);
    // Wave 1 in full: let all of it spawn, kill as they come.
    for (let i = 0; i < 40 && t.priv.zphase === 'wave'; i++) {
      t.run(500);
      t.killAll();
    }
    t.run(100);
    assert.equal(t.priv.zphase, 'prep', 'wave 1 cleared');
    assert.equal(t.priv.wave, 2);
    assert.ok(t.me.money > ZOMBIE.startMoney, 'kill money and the wave bonus');
    assert.equal(t.priv.kills, 6);

    // The shop works now: first aid heals, a gun upgrade costs money, and it is closed during waves.
    const before = t.me.money;
    t.me.hp = 20;
    const heal = t.room.handleBuy(t.me, 'heal-50');
    assert.equal(heal.ok, true);
    assert.equal(t.me.hp, 70);
    assert.equal(t.me.money, before - 50);
    t.me.money = 1000;
    const weapon = t.room.handleBuy(t.me, 'weapon-smg');
    assert.equal(weapon.ok, true);
    assert.ok(t.me.info.loadout.includes('smg'));
    assert.equal(t.room.handleBuy(t.me, 'weapon-smg').ok, false, 'already owned');
    assert.equal(t.room.handleBuy(t.me, 'upgrade').ok, true, 'upgrades the gun in your hands');
    assert.equal(t.priv.upgrades.get(t.me.pid)?.smg, 1);
    t.me.money = 1;
    assert.equal(t.room.handleBuy(t.me, 'armor').ok, false, 'too poor');
    assert.equal(t.room.handleBuy(t.me, 'nonsense').ok, false);

    t.run(ZOMBIE.prepMs + 500);
    assert.equal(t.priv.zphase, 'wave');
    assert.equal(t.room.handleBuy(t.me, 'heal-full').ok, false, 'the shop is closed during a wave');
    assert.equal(t.priv.queue.length + t.zombies().length, waveCount(2), 'wave 2 is bigger');
    t.room.close();
  });

  it('zombies chase the survivor and hit them', () => {
    const t = setup();
    try {
      t.run(ZOMBIE.prepMs);
      // (They may even finish you off and the game restarts: watch the lowest health.)
      let lowest = t.me.hp;
      let nearest = Infinity;
      for (let i = 0; i < 100; i++) {
        t.run(500);
        lowest = Math.min(lowest, t.me.hp);
        for (const z of t.zombies()) nearest = Math.min(nearest, Math.hypot(z.p.state.x - t.me.state.x, z.p.state.z - t.me.state.z));
      }
      assert.ok(nearest < 3, `they come all the way to you (nearest ${nearest.toFixed(1)} m)`);
      assert.ok(lowest < 100, `they hurt you (lowest hp ${lowest})`);
    } finally {
      t.room.close();
    }
  });

  it('when every survivor is down it is game over; Restart plays again from wave 1', () => {
    const t = setup();
    t.run(ZOMBIE.prepMs + 2000);
    t.room.damage(t.me, t.zombies()[0]!.p, 1000, false, 'world', { x: 0, y: 0, z: 0 }, t.now());
    t.run(100);
    assert.equal(t.priv.zphase, 'over');
    assert.equal(t.priv.match.phase, 'ended');
    assert.equal(t.zombies().length, 0, 'the zombies are cleared away');
    t.room.handleZombieRestart(t.me);
    assert.equal(t.priv.match.phase, 'playing');
    assert.equal(t.priv.zphase, 'prep');
    assert.equal(t.priv.wave, 1);
    assert.equal(t.priv.kills, 0);
    assert.equal(t.me.alive, true);
    assert.equal(t.me.money, ZOMBIE.startMoney);
    t.room.close();
  });

  it('C builds a wall that disappears after 10 seconds, and zombies can break it', () => {
    const t = setup();
    t.run(500);
    const events = t.events;
    t.room.handleZombieBuild(t.me);
    const built = t.priv.blocks.size;
    assert.ok(built >= 3, `a wall (${built} blocks)`);
    assert.ok(events.filter((e) => e.event === 'blockPlaced').every((e) => (e.args[0] as { ttl: number }).ttl === ZOMBIE.build.ttlMs));
    // Too soon for another.
    t.room.handleZombieBuild(t.me);
    assert.equal(t.priv.blocks.size, built);
    t.run(ZOMBIE.build.ttlMs - 600);
    assert.equal(t.priv.blocks.size, built, 'still there just before 10 seconds');
    t.run(1200);
    assert.equal(t.priv.blocks.size, 0, 'gone after 10 seconds');
    assert.ok(events.filter((e) => e.event === 'blockRemoved').length >= built);

    // A zombie chewing through it.
    t.run(ZOMBIE.build.cooldownMs);
    t.room.handleZombieBuild(t.me);
    const id = [...t.priv.blocks.keys()][0]!;
    (t.room as unknown as { damageBlock(id: number, d: number): void }).damageBlock(id, ZOMBIE.build.blockHp + 1);
    assert.equal(t.priv.blocks.has(id), false);
    t.room.close();
  });

  it('a boss wave sends a boss with a horde; killing it pays a lot', () => {
    const t = setup();
    // Jump to wave 5.
    t.priv.wave = 5;
    t.run(ZOMBIE.prepMs + 6000);
    const boss = t.zombies().find((z) => z.kind === 'boss');
    assert.ok(boss, 'the boss is out');
    assert.equal(t.room.players.get(boss!.p.pid)?.info.undead, 'boss');
    assert.ok(t.zombies().length > 3, 'with a horde');
    const before = t.me.money;
    t.room.damage(boss!.p, t.me, 1e9, false, 'rifle', { x: 0, y: 0, z: 0 }, t.now());
    assert.ok(t.me.money - before >= boss!.stats.reward);
    t.room.close();
  });

  it('only one kind of room has all this: other modes are untouched', () => {
    const { io } = fakeIo();
    const room = createRoom(io, { id: 'f', code: 'FFA01', name: 'F', mode: 'ffa', map: 'farm', private: true, bots: 0 }, {}) as GameRoom;
    clearInterval((room as unknown as { tickTimer: NodeJS.Timeout }).tickTimer);
    const p = addPlayer(room, 'A');
    room.handleZombieBuild(p);
    room.handleZombieRestart(p);
    assert.equal(room.handleBuy(p, 'heal-50').ok, false);
    room.close();
  });
});
