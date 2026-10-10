import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { PLAYER, WEAPONS, normalize } from '@game/shared';
import type { GameRoom } from '../src/rooms/GameRoom';
import type { ServerPlayer } from '../src/rooms/ServerPlayer';
import { addPlayer, makeRoom, place, stepRoom, type RecordedEvent } from './helpers';

let current: GameRoom | null = null;
afterEach(() => current?.close());

function setup(mode: 'ffa' | 'tdm' = 'ffa') {
  const made = makeRoom(mode);
  current = made.room;
  const a = addPlayer(made.room, 'Alice', 1);
  const b = addPlayer(made.room, 'Bob', 2);
  // Clear lane on the farm: a looks down -Z at b, 10 m away.
  place(a, 20, -5);
  place(b, 20, -15);
  a.yaw = 0;
  b.yaw = 0;
  return { ...made, a, b };
}

let shotSeq = 0;
function fire(room: GameRoom, shooter: ServerPlayer, target: { x: number; y: number; z: number }, extra: { t?: number } = {}) {
  const eye = { x: shooter.state.x, y: shooter.state.y + PLAYER.eyeHeight, z: shooter.state.z };
  const d = normalize({ x: target.x - eye.x, y: target.y - eye.y, z: target.z - eye.z });
  shooter.lastFireAt = -Infinity;
  room.handleFire(shooter, { shot: ++shotSeq, weapon: shooter.weapon, dx: d.x, dy: d.y, dz: d.z, t: extra.t ?? performance.now(), aiming: true });
}

function useWeapon(room: GameRoom, p: ServerPlayer, slot: number) {
  room.handleSwitch(p, slot);
  p.switchReadyAt = 0;
}

const named = (events: RecordedEvent[], name: string) => events.filter((e) => e.event === name).map((e) => e.args[0] as Record<string, unknown>);

describe('hitscan combat', () => {
  it('damages a body shot by the weapon damage', () => {
    const { room, a, b } = setup();
    fire(room, a, { x: 20, y: 0.6, z: -15 });
    assert.equal(b.hp, PLAYER.maxHealth - WEAPONS.rifle.damage);
    assert.equal(a.mag, WEAPONS.rifle.magazine - 1);
  });

  it('kills with a sniper headshot', () => {
    const { room, events, a, b } = setup();
    useWeapon(room, a, 2);
    fire(room, a, { x: 20, y: 1.27, z: -15.3 });
    assert.equal(b.alive, false);
    const kill = named(events, 'kill').at(-1)!;
    assert.deepEqual(kill, { killer: a.pid, victim: b.pid, cause: 'sniper', headshot: true });
  });

  it('is blocked by walls', () => {
    const { room, a, b } = setup();
    // The east cover wall (x = 11.5..12.5) sits between them.
    place(a, 9, 0);
    place(b, 15, 0);
    fire(room, a, { x: 15, y: 0.6, z: 0 });
    assert.equal(b.hp, PLAYER.maxHealth);
  });

  it('rewinds the target to what the shooter saw (lag compensation)', () => {
    const { room, a, b } = setup();
    const now = performance.now();
    // Bob was at x = 20 a moment ago and has since run to x = 26.
    b.history.clear();
    b.history.push({ t: now - 200, x: 20, y: 0, z: -15, yaw: 0, alive: true, scale: 1 });
    b.history.push({ t: now - 150, x: 20, y: 0, z: -15, yaw: 0, alive: true, scale: 1 });
    b.history.push({ t: now, x: 26, y: 0, z: -15, yaw: 0, alive: true, scale: 1 });
    place(b, 26, -15);
    fire(room, a, { x: 20, y: 0.6, z: -15 }, { t: now - 180 });
    assert.ok(b.hp < PLAYER.maxHealth, 'shot at the old position should hit');
    const hpAfter = b.hp;
    fire(room, a, { x: 20, y: 0.6, z: -15 }, { t: now });
    assert.equal(b.hp, hpAfter, 'shot at the old position with no rewind should miss');
  });

  it('enforces fire rate and ammo', () => {
    const { room, a, b } = setup();
    fire(room, a, { x: 20, y: 0.6, z: -15 });
    const hp = b.hp;
    // Same instant, no lastFireAt reset: rejected.
    const d = normalize({ x: 0, y: -0.07, z: -1 });
    room.handleFire(a, { shot: ++shotSeq, weapon: 'rifle', dx: d.x, dy: d.y, dz: d.z, t: performance.now(), aiming: true });
    assert.equal(b.hp, hp);
    // Empty magazine: rejected.
    a.mags.set('rifle', 0);
    fire(room, a, { x: 20, y: 0.6, z: -15 });
    assert.equal(b.hp, hp);
    // Wrong weapon: rejected.
    a.mags.set('rifle', 5);
    a.lastFireAt = -Infinity;
    room.handleFire(a, { shot: ++shotSeq, weapon: 'sniper', dx: d.x, dy: d.y, dz: d.z, t: performance.now(), aiming: true });
    assert.equal(b.hp, hp);
  });

  it('lets armor soak half the damage', () => {
    const { room, a, b } = setup();
    b.armor = 100;
    fire(room, a, { x: 20, y: 0.6, z: -15 });
    const dmg = WEAPONS.rifle.damage;
    assert.equal(b.armor, 100 - dmg * PLAYER.armorAbsorb);
    assert.equal(b.hp, PLAYER.maxHealth - dmg * (1 - PLAYER.armorAbsorb));
  });

  it('respects spawn protection', () => {
    const { room, a, b } = setup();
    b.shieldUntil = performance.now() + 10_000;
    fire(room, a, { x: 20, y: 0.6, z: -15 });
    assert.equal(b.hp, PLAYER.maxHealth);
  });

  it('has no friendly fire in team modes', () => {
    const { room, a, b } = setup('tdm');
    b.info.team = a.info.team;
    fire(room, a, { x: 20, y: 0.6, z: -15 });
    assert.equal(b.hp, PLAYER.maxHealth);
  });

  it('reloads to a full magazine after the reload time', () => {
    const { room, a } = setup();
    a.mags.set('rifle', 3);
    room.handleReload(a);
    assert.ok(a.reloadUntil > 0);
    stepRoom(room, a.reloadUntil + 1);
    assert.equal(a.mag, WEAPONS.rifle.magazine);
    assert.equal(a.reloadUntil, 0);
  });
});

describe('explosive eggs', () => {
  it('damages and knocks back chickens in the blast, but not through walls', () => {
    const { room, a, b } = setup();
    place(b, 20, -9);
    const now = performance.now();
    room.handleThrow(a, { kind: 'egg', seq: 1, dx: 0, dy: -0.2, dz: -1 });
    assert.equal(a.eggs, PLAYER.startEggs - 1);
    for (let i = 0; i < 120 && b.hp === PLAYER.maxHealth; i++) room.projectiles.update(now + i * 16);
    assert.ok(b.hp < PLAYER.maxHealth, `egg should hurt Bob (hp ${b.hp})`);
    assert.ok(b.state.vy > 0 || !b.state.onGround, 'knocked into the air');
  });

  it('has a throw cooldown and runs out of eggs', () => {
    const { room, a } = setup();
    room.handleThrow(a, { kind: 'egg', seq: 1, dx: 0, dy: 0, dz: -1 });
    room.handleThrow(a, { kind: 'egg', seq: 2, dx: 0, dy: 0, dz: -1 });
    assert.equal(a.eggs, PLAYER.startEggs - 1, 'second throw within the cooldown is ignored');
    a.nextThrowAt = 0;
    room.handleThrow(a, { kind: 'egg', seq: 3, dx: 0, dy: 0, dz: -1 });
    a.nextThrowAt = 0;
    room.handleThrow(a, { kind: 'egg', seq: 4, dx: 0, dy: 0, dz: -1 });
    assert.equal(a.eggs, 0);
  });
});

describe('loot boxes', () => {
  it('breaks when shot and gives its pickup to whoever walks over it', () => {
    const { room, events, a } = setup();
    // Loot spot #1 floats at (16, 0.9, 0). Stand east of it and shoot west.
    place(a, 19, 0);
    fire(room, a, { x: 16, y: 0.9, z: 0 });
    const opened = named(events, 'loot').find((e) => e.id === 1);
    assert.ok(opened && opened.phase === 1, 'box opened');
    a.hp = 10;
    a.armor = 0;
    a.state.fuel = 0;
    a.eggs = 0;
    place(a, 16, 0);
    room.loot.update(performance.now());
    const picked = named(events, 'pickup').at(-1);
    assert.ok(picked && picked.pid === a.pid, 'picked up');
  });
});

describe('match flow', () => {
  it('ends at the score limit and rewards coins to the winner', () => {
    let rewarded: { userId: number; coins: number; won: boolean }[] = [];
    const made = makeRoom('ffa', 'farm', {
      onMatchEnd: (_room, results) => {
        rewarded = results;
        return new Map(results.map((r) => [r.userId, { coins: 1000 + r.coins, xp: r.xp, levelCoins: 0 }]));
      },
    });
    current = made.room;
    const a = addPlayer(made.room, 'Alice', 1);
    const b = addPlayer(made.room, 'Bob', 2);
    made.room.startNow();
    for (const p of [a, b]) p.shieldUntil = 0;
    a.info.kills = 24;
    made.room.damage(b, a, 500, false, 'rifle', { x: 0, y: 0, z: 0 }, performance.now());
    assert.equal(made.room.phase, 'ended');
    const alice = rewarded.find((r) => r.userId === 1)!;
    const bob = rewarded.find((r) => r.userId === 2)!;
    assert.ok(alice.won && !bob.won);
    assert.ok(alice.coins > bob.coins);
    const match = named(made.events, 'match').at(-1)!;
    assert.equal(match.winnerPid, a.pid);
  });

  it('counts team kills towards the team score', () => {
    const { room, a, b } = setup('tdm');
    a.info.team = 1;
    b.info.team = 2;
    room.startNow();
    a.shieldUntil = b.shieldUntil = 0;
    place(a, 20, -5);
    place(b, 20, -15);
    room.damage(b, a, 500, false, 'rifle', { x: 0, y: 0, z: 0 }, performance.now());
    assert.equal(a.info.kills, 1);
    assert.equal(b.info.deaths, 1);
  });

  it('balances teams as players join', () => {
    const made = makeRoom('tdm');
    current = made.room;
    const teams = ['A', 'B', 'C', 'D'].map((n) => addPlayer(made.room, n).info.team);
    assert.equal(teams.filter((t) => t === 1).length, 2);
    assert.equal(teams.filter((t) => t === 2).length, 2);
  });
});

describe('melee', () => {
  function knifeOut(room: GameRoom, p: ServerPlayer) {
    p.info.loadout = [...p.info.loadout, 'knife'];
    p.mags.set('knife', WEAPONS.knife.magazine);
    useWeapon(room, p, p.info.loadout.length - 1);
  }

  it('a knife hits a chicken in reach without using ammo, and misses one out of reach', () => {
    const { room, events, a, b } = setup();
    knifeOut(room, a);
    fire(room, a, { x: 20, y: 0.6, z: -15 });
    assert.equal(b.hp, PLAYER.maxHealth, '10 m away is out of reach');
    place(b, 20, -6.5);
    fire(room, a, { x: 20, y: 0.6, z: -6.5 });
    assert.equal(b.hp, PLAYER.maxHealth - WEAPONS.knife.damage);
    assert.equal(a.mag, WEAPONS.knife.magazine, 'melee never uses ammo');
    const swing = named(events, 'shot').at(-1)!;
    assert.equal(swing.weapon, 'knife');
    assert.deepEqual(swing.hits, [1]);
  });

  it('kills show the melee weapon in the kill feed', () => {
    const { room, events, a, b } = setup();
    knifeOut(room, a);
    place(b, 20, -6.5);
    for (let i = 0; i < 4 && b.alive; i++) fire(room, a, { x: 20, y: 0.6, z: -6.5 });
    assert.equal(b.alive, false);
    assert.equal(named(events, 'kill').at(-1)!.cause, 'knife');
  });
});

describe('second-wave guns', () => {
  /** Puts a weapon in `p`'s hands. */
  function give(room: GameRoom, p: ServerPlayer, weapon: keyof typeof WEAPONS) {
    p.info.loadout = [weapon, ...p.info.loadout.filter((w) => w !== weapon)];
    p.mags.set(weapon, WEAPONS[weapon].magazine);
    useWeapon(room, p, 0);
  }
  /** Runs the projectile simulation forward. */
  function fly(room: GameRoom, ms: number) {
    const start = performance.now();
    for (let t = 0; t <= ms; t += 1000 / 60) room.projectiles.update(start + t);
  }

  it('a crossbow bolt hits directly: body damage, and a headshot kills', () => {
    const { room, a, b } = setup();
    give(room, a, 'crossbow');
    fire(room, a, { x: 20, y: 0.6, z: -15 });
    fly(room, 600);
    assert.equal(b.hp, PLAYER.maxHealth - WEAPONS.crossbow.damage);
    a.mags.set('crossbow', 1);
    fire(room, a, { x: 20, y: 1.27, z: -15.3 });
    fly(room, 600);
    assert.equal(b.alive, false, 'headshot bolt');
  });

  it('Egg Launcher kills count as Egg Launcher kills', () => {
    const { room, events, a, b } = setup();
    give(room, a, 'launcher');
    b.hp = 10;
    // Close, so the egg lands on Bob before it drops.
    place(b, 20, -9);
    fire(room, a, { x: 20, y: 0.6, z: -9 });
    fly(room, 1500);
    assert.equal(b.alive, false);
    assert.equal(named(events, 'kill').at(-1)!.cause, 'launcher');
  });

  it('the burst rifle fires three quick shots per pull, then waits', () => {
    const { room, a } = setup();
    give(room, a, 'burst');
    const full = a.mag;
    const shoot = (seq: number) => room.handleFire(a, { shot: seq, weapon: 'burst', dx: 0, dy: 0, dz: -1, t: performance.now(), aiming: false });
    // Pretend the burst gaps passed (performance.now() barely moves inside a test).
    shoot(1001);
    for (let i = 0; i < 4; i++) {
      a.lastFireAt -= WEAPONS.burst.burst!.gapMs;
      shoot(1002 + i);
    }
    assert.equal(full - a.mag, 3, 'only three shots in a burst');
  });
});
