import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { BOMB, ECONOMY, MAPS, PLAYER, SIM_DT, type RoundState } from '@game/shared';
import type { BombRoom } from '../src/rooms/BombRoom';
import { createRoom } from '../src/rooms/modes';
import type { ServerPlayer } from '../src/rooms/ServerPlayer';
import { addPlayer, fakeIo, place, type RecordedEvent } from './helpers';

let current: BombRoom | null = null;
afterEach(() => current?.close());

const SITE_A = MAPS.sandstown.bombSites!.find((s) => s.id === 'A')!;

/**
 * A ChikenBomb room on Sandstown with a stopped clock: `step(ms)` runs the fixed update with a
 * fake time, so rounds that last minutes take a few milliseconds here.
 */
function setup(players = 2) {
  const { io, events } = fakeIo();
  const room = createRoom(io, { id: 't', code: 'BOMB1', name: 'Bomb', mode: 'bomb', map: 'sandstown', private: true }, {}) as BombRoom;
  current = room;
  clearInterval((room as unknown as { tickTimer: NodeJS.Timeout }).tickTimer);
  const all: ServerPlayer[] = [];
  for (let i = 0; i < players; i++) all.push(addPlayer(room, `P${i}`));
  const t = all.filter((p) => p.info.team === 1);
  const ct = all.filter((p) => p.info.team === 2);
  let now = performance.now();
  const update = (room as unknown as { fixedUpdate(now: number): void }).fixedUpdate.bind(room);
  const step = (ms: number) => {
    const end = now + ms;
    while (now < end) {
      now = Math.min(end, now + SIM_DT * 1000);
      update(now);
    }
  };
  room.startNow();
  return { room, events, t, ct, step, get now() { return now; } };
}

const round = (room: BombRoom): RoundState => room.roundState;
/** Holds use (E) standing still, the way an input frame would set it. */
const holdUse = (p: ServerPlayer, on = true) => {
  p.useHeld = on;
  p.lastInput = { seq: 1, forward: 0, right: 0, jump: false, yaw: 0, pitch: 0, use: on };
};
const killAll = (room: BombRoom, victims: ServerPlayer[], by: ServerPlayer | null = null) => {
  for (const v of victims) {
    v.shieldUntil = 0;
    room.damage(v, by, 1000, false, by ? by.weapon : 'world', { x: 0, y: 0, z: 0 }, performance.now());
  }
};
/** Skip warmup and buy time: round 1 is live. */
const toLive = (s: ReturnType<typeof setup>) => {
  s.step(BOMB.warmupMs + 50);
  s.step(BOMB.buyMs + 50);
};
const named = (events: RecordedEvent[], name: string) => events.filter((e) => e.event === name).map((e) => e.args[0] as Record<string, unknown>);

describe('ChikenBomb rounds', () => {
  it('warmup, then buy time frozen in spawn with $800 and a bomb carrier, then the round', () => {
    const s = setup(4);
    assert.equal(round(s.room).phase, 'warmup');
    assert.equal(s.t.length, 2);
    s.step(BOMB.warmupMs + 50);
    const r = round(s.room);
    assert.equal(r.phase, 'buy');
    assert.equal(r.round, 1);
    for (const p of [...s.t, ...s.ct]) {
      assert.equal(p.frozen, true, 'frozen during buy time');
      assert.equal(p.money, ECONOMY.start);
      assert.deepEqual(p.info.loadout, ['pistol', 'knife']);
    }
    assert.ok(s.t.some((p) => p.pid === r.bomb.carrier), 'a chikenT carries the bomb');
    s.step(BOMB.buyMs + 50);
    assert.equal(round(s.room).phase, 'live');
    assert.ok([...s.t, ...s.ct].every((p) => !p.frozen));
  });

  it('dead players wait for the next round; survivors keep their guns', () => {
    const s = setup(4);
    s.step(BOMB.warmupMs + 50);
    const [a, b] = s.t;
    a!.money = 5000;
    assert.equal(s.room.handleBuy(a!, 'rifle').ok, true);
    s.step(BOMB.buyMs + 50);
    killAll(s.room, [b!]);
    s.step(10_000);
    assert.equal(b!.alive, false, 'no respawn mid-round');
    killAll(s.room, s.ct);
    assert.equal(round(s.room).phase, 'over');
    assert.equal(round(s.room).winner, 1);
    s.step(BOMB.roundEndMs + 50);
    assert.equal(round(s.room).round, 2);
    assert.equal(b!.alive, true, 'everyone is back for the next round');
    assert.deepEqual(a!.info.loadout, ['rifle', 'pistol', 'knife'], 'the survivor kept the rifle');
    assert.deepEqual(b!.info.loadout, ['pistol', 'knife']);
  });

  it('chikenCT win when time runs out without a plant', () => {
    const s = setup(2);
    toLive(s);
    s.step(BOMB.roundMs + 100);
    assert.equal(round(s.room).phase, 'over');
    assert.equal(round(s.room).winner, 2);
    assert.equal(round(s.room).reason, 'time');
  });

  it('money: kills, knife kills, wins and the loss bonus', () => {
    const s = setup(4);
    toLive(s);
    const [t1] = s.t;
    const [ct1, ct2] = s.ct;
    killAll(s.room, [ct1!], t1!);
    assert.equal(t1!.money, ECONOMY.start + ECONOMY.kill);
    t1!.weaponSlot = t1!.info.loadout.indexOf('knife');
    // The knife kill (+$1500) is also the last chikenCT: the round ends right away (+ the win).
    killAll(s.room, [ct2!], t1!);
    assert.equal(round(s.room).winner, 1);
    assert.equal(t1!.money, ECONOMY.start + ECONOMY.kill + ECONOMY.meleeKill + ECONOMY.win);
    assert.equal(ct1!.money, ECONOMY.start + ECONOMY.loss);
  });

  it('first team to 6 rounds wins the match', () => {
    const s = setup(2);
    s.step(BOMB.warmupMs + 50);
    for (let i = 0; i < BOMB.roundsToWin; i++) {
      s.step(BOMB.buyMs + 50);
      killAll(s.room, s.ct);
      if (i < BOMB.roundsToWin - 1) s.step(BOMB.roundEndMs + 50);
    }
    assert.equal(s.room.phase, 'ended');
    const match = named(s.events, 'match').at(-1)!;
    assert.equal(match.winnerTeam, 1);
  });
});

describe('the bomb', () => {
  it('is planted by holding use on a site, explodes after 40 s and wins for chikenT', () => {
    const s = setup(2);
    toLive(s);
    const carrier = s.t.find((p) => p.pid === round(s.room).bomb.carrier)!;
    const ct = s.ct[0]!;
    place(carrier, SITE_A.x, SITE_A.z);
    place(ct, -38, 0);
    holdUse(carrier);
    s.step(BOMB.plantMs - 500);
    assert.equal(round(s.room).phase, 'live', 'still planting');
    assert.equal(round(s.room).bomb.action?.kind, 'plant');
    s.step(600);
    assert.equal(round(s.room).phase, 'planted');
    assert.equal(round(s.room).bomb.site, 'A');
    assert.equal(carrier.money, ECONOMY.start + ECONOMY.plant);
    holdUse(carrier, false);
    s.step(BOMB.fuseMs + 100);
    assert.equal(round(s.room).winner, 1);
    assert.equal(round(s.room).reason, 'exploded');
  });

  it('the explosion kills chickens nearby once, and the round ends once', () => {
    const s = setup(4);
    toLive(s);
    const carrier = s.t.find((p) => p.pid === round(s.room).bomb.carrier)!;
    place(carrier, SITE_A.x, SITE_A.z);
    holdUse(carrier);
    s.step(BOMB.plantMs + 100);
    holdUse(carrier, false);
    // Everyone stands next to it.
    for (const p of [...s.t, ...s.ct]) {
      p.shieldUntil = 0;
      place(p, SITE_A.x + 1, SITE_A.z + (p.pid % 3));
    }
    const before = s.events.length;
    s.step(BOMB.fuseMs + 100);
    const after = s.events.slice(before);
    assert.equal(after.filter((e) => e.event === 'explode').length, 1, 'one explosion');
    assert.equal(after.filter((e) => e.event === 'round' && (e.args[0] as RoundState).phase === 'over').length, 1, 'one round end');
    assert.ok([...s.t, ...s.ct].every((p) => !p.alive), 'everyone next to the bomb is gone');
    assert.equal(round(s.room).winner, 1);
  });

  it('can’t be planted off-site, and letting go of use cancels', () => {
    const s = setup(2);
    toLive(s);
    const carrier = s.t.find((p) => p.pid === round(s.room).bomb.carrier)!;
    place(carrier, 0, 0);
    holdUse(carrier);
    s.step(BOMB.plantMs + 500);
    assert.equal(round(s.room).phase, 'live', 'not on a site');
    place(carrier, SITE_A.x, SITE_A.z);
    holdUse(carrier);
    s.step(1500);
    assert.equal(round(s.room).bomb.action?.kind, 'plant');
    holdUse(carrier, false);
    s.step(100);
    assert.equal(round(s.room).bomb.action, null, 'released: cancelled');
  });

  it('holding W (or jumping) with E still plants: you stay put, crouched, until it is done', () => {
    const s = setup(2);
    toLive(s);
    const carrier = s.t.find((p) => p.pid === round(s.room).bomb.carrier)!;
    place(carrier, SITE_A.x, SITE_A.z);
    let seq = 5000;
    const start = { x: carrier.state.x, z: carrier.state.z };
    for (let i = 0; i < Math.ceil((BOMB.plantMs + 400) / (SIM_DT * 1000)) && round(s.room).phase === 'live'; i++) {
      carrier.takeInputToken = () => true;
      s.room.handleInput(carrier, { seq: ++seq, forward: 1, right: 1, jump: true, yaw: 0, pitch: 0, use: true });
      s.step(SIM_DT * 1000);
      if (i === 5) assert.equal(carrier.state.crouching, true, 'crouched while planting');
    }
    assert.equal(round(s.room).phase, 'planted', 'planted despite the keys');
    assert.ok(Math.hypot(carrier.state.x - start.x, carrier.state.z - start.z) < 0.05, 'did not move');
  });

  it('a person on the team gets the bomb, and a bot hands it over when asked', () => {
    const { io } = fakeIo();
    const room = createRoom(io, { id: 'h', code: 'HAND1', name: 'Hand', mode: 'bomb', map: 'sandstown', private: true, bots: 4 }, {}) as BombRoom;
    current = room;
    clearInterval((room as unknown as { tickTimer: NodeJS.Timeout }).tickTimer);
    const me = addPlayer(room, 'Me');
    let now = performance.now();
    const update = (room as unknown as { fixedUpdate(now: number): void }).fixedUpdate.bind(room);
    const step = (ms: number) => {
      const end = now + ms;
      while (now < end) {
        now = Math.min(end, now + SIM_DT * 1000);
        update(now);
      }
    };
    step(1500); // the bots arrive
    me.info.team = 1;
    room.startNow();
    step(BOMB.warmupMs + 50);
    assert.equal(round(room).bomb.carrier, me.pid, 'the person carries it');

    // Give it to a bot teammate, then ask for it back.
    const bot = [...room.players.values()].find((p) => p.info.bot && p.info.team === 1);
    assert.ok(bot, 'a chikenT bot');
    (room as unknown as { state: RoundState }).state = { ...round(room), bomb: { ...round(room).bomb, carrier: bot.pid } };
    step(BOMB.buyMs + 50);
    place(me, bot.state.x + 1, bot.state.z);
    holdUse(me);
    step(100);
    assert.equal(round(room).bomb.carrier, me.pid, 'handed over');
  });

  it('a carrier shot in mid-air drops the bomb on the floor, not in the air', () => {
    const s = setup(2);
    toLive(s);
    const carrier = s.t.find((p) => p.pid === round(s.room).bomb.carrier)!;
    place(carrier, 10, -38, 3);
    killAll(s.room, [carrier]);
    assert.ok(round(s.room).bomb.y < 0.05, `on the floor (${round(s.room).bomb.y})`);
  });

  it('is defused by a chikenCT in 10 s, or 5 s with a kit', () => {
    for (const kit of [false, true]) {
      const s = setup(2);
      s.step(BOMB.warmupMs + 50);
      const ct = s.ct[0]!;
      if (kit) {
        ct.money = 1000;
        assert.equal(s.room.handleBuy(ct, 'kit').ok, true);
      }
      s.step(BOMB.buyMs + 50);
      const carrier = s.t.find((p) => p.pid === round(s.room).bomb.carrier)!;
      place(carrier, SITE_A.x, SITE_A.z);
      holdUse(carrier);
      s.step(BOMB.plantMs + 100);
      holdUse(carrier, false);
      const bomb = round(s.room).bomb;
      place(ct, bomb.x + 0.8, bomb.z);
      holdUse(ct);
      const time = kit ? BOMB.kitDefuseMs : BOMB.defuseMs;
      s.step(time - 400);
      assert.equal(round(s.room).phase, 'planted', 'still defusing');
      s.step(500);
      assert.equal(round(s.room).winner, 2, kit ? 'with a kit' : 'without a kit');
      assert.equal(round(s.room).reason, 'defused');
      current?.close();
    }
  });

  it('drops where the carrier dies, and another chikenT picks it up', () => {
    const s = setup(4);
    toLive(s);
    const carrier = s.t.find((p) => p.pid === round(s.room).bomb.carrier)!;
    const other = s.t.find((p) => p !== carrier)!;
    place(carrier, 10, -38);
    killAll(s.room, [carrier]);
    const bomb = round(s.room).bomb;
    assert.equal(bomb.carrier, 0);
    assert.ok(Math.abs(bomb.x - 10) < 0.01 && Math.abs(bomb.z + 38) < 0.01);
    place(s.ct[0]!, 10, -38);
    s.step(100);
    assert.equal(round(s.room).bomb.carrier, 0, 'chikenCT can’t take it');
    place(other, 10.5, -38);
    s.step(100);
    assert.equal(round(s.room).bomb.carrier, other.pid);
  });
});

describe('the buy menu', () => {
  it('only during buy time (free in warmup), only for your team, only with enough money', () => {
    const s = setup(2);
    const t = s.t[0]!;
    const ct = s.ct[0]!;
    assert.equal(s.room.handleBuy(t, 'sniper').ok, true, 'warmup: free');
    s.step(BOMB.warmupMs + 50);
    assert.equal(t.money, ECONOMY.start);
    assert.equal(s.room.handleBuy(t, 'rifle').error, 'Not enough money.');
    assert.equal(s.room.handleBuy(t, 'golden').error, 'Only chikenCT can buy that.');
    assert.equal(s.room.handleBuy(t, 'kit').error, 'Only chikenCT can buy that.');
    assert.equal(s.room.handleBuy(ct, 'rifle').error, 'Only chikenT can buy that.');
    const res = s.room.handleBuy(t, 'armor');
    assert.deepEqual(res, { ok: true, money: ECONOMY.start - 650 });
    assert.equal(t.armor, PLAYER.maxArmor);
    assert.equal(s.room.handleBuy(t, 'armor').error, 'Your armor is already full.');
    assert.equal(s.room.handleBuy(t, 'nonsense').error, 'Unknown item.');
    s.step(BOMB.buyMs + 50);
    t.money = 9000;
    assert.equal(s.room.handleBuy(t, 'smg').error, 'You can only buy during buy time.');
  });

  it('a new gun replaces your old one, next to the pistol and knife', () => {
    const s = setup(2);
    s.step(BOMB.warmupMs + 50);
    const t = s.t[0]!;
    t.money = 10_000;
    s.room.handleBuy(t, 'smg');
    s.room.handleBuy(t, 'rifle');
    assert.deepEqual(t.info.loadout, ['rifle', 'pistol', 'knife']);
    assert.equal(t.weapon, 'rifle', 'switched to it');
    assert.equal(t.money, 10_000 - 1250 - 2700);
  });

  it('no shooting during buy time', () => {
    const s = setup(2);
    s.step(BOMB.warmupMs + 50);
    const t = s.t[0]!;
    const before = t.mag;
    t.lastFireAt = -Infinity;
    s.room.handleFire(t, { shot: 1, weapon: t.weapon, dx: 0, dy: 0, dz: -1, t: performance.now(), aiming: false });
    assert.equal(t.mag, before);
  });

  it('there is no buy menu in other modes', () => {
    const { io } = fakeIo();
    const tdm = createRoom(io, { id: 'x', code: 'TDM01', name: 'x', mode: 'tdm', map: 'sandstown', private: false }, {});
    const p = addPlayer(tdm, 'A');
    assert.equal(tdm.handleBuy(p, 'armor').ok, false);
    tdm.close();
  });
});

describe('ChikenBomb bots', () => {
  it('a bot carrying the bomb walks to its site and plants it', () => {
    const { io } = fakeIo();
    const room = createRoom(io, { id: 'b', code: 'BOTS1', name: 'Bots', mode: 'bomb', map: 'sandstown', private: true, bots: 2 }, {}) as BombRoom;
    current = room;
    clearInterval((room as unknown as { tickTimer: NodeJS.Timeout }).tickTimer);
    const update = (room as unknown as { fixedUpdate(now: number): void }).fixedUpdate.bind(room);
    let now = performance.now();
    // Add the bots (normally done by the room loop once a human is there).
    const bots = (room as unknown as { bots: { add(): boolean } }).bots;
    bots.add();
    bots.add();
    room.startNow();
    const run = (ms: number) => {
      for (const end = now + ms; now < end; ) {
        now += SIM_DT * 1000;
        update(now);
      }
    };
    // The test runs minutes of game time in milliseconds: skip the speed-hack input limit.
    for (const p of room.players.values()) (p as unknown as { takeInputToken(): boolean }).takeInputToken = () => true;
    run(BOMB.warmupMs + BOMB.buyMs + 100);
    assert.equal(round(room).phase, 'live');
    const players = [...room.players.values()];
    const carrier = players.find((p) => p.pid === round(room).bomb.carrier)!;
    // Keep the chikenCT bot out of the way so this is about walking and planting.
    // (alive, so the round goes on, but idle and untouchable).
    const ct = players.find((p) => p.info.team === 2)!;
    (room as unknown as { bots: { forget(pid: number): void } }).bots.forget(ct.pid);
    ct.shieldUntil = Infinity;
    place(ct, 38, 0);
    run(60_000);
    const r = round(room);
    assert.ok(r.phase === 'planted' || (r.phase === 'over' && r.reason === 'exploded') || r.bomb.site !== null, `bot didn't plant: phase ${r.phase}, carrier at ${carrier.state.x.toFixed(1)},${carrier.state.z.toFixed(1)}`);
  });
});

describe('ChikenBomb pauses', () => {
  it('if a player leaves during buy time, nobody stays frozen', () => {
    const s = setup(2);
    s.step(BOMB.warmupMs + 50);
    assert.equal(s.t[0]!.frozen, true);
    s.room.removePlayer(s.ct[0]!);
    s.step(200);
    assert.equal(s.t[0]!.frozen, false);
    assert.equal(round(s.room).phase, 'warmup');
  });
});

describe('ChikenBomb spawns and defusing bots', () => {
  it('a full team spawns on separate spots at the start of a round', () => {
    const s = setup(10);
    s.step(BOMB.warmupMs + 50);
    const all = [...s.t, ...s.ct];
    for (let i = 0; i < all.length; i++) {
      for (let j = i + 1; j < all.length; j++) {
        const d = Math.hypot(all[i]!.state.x - all[j]!.state.x, all[i]!.state.z - all[j]!.state.z);
        assert.ok(d > 1, `${all[i]!.info.name} and ${all[j]!.info.name} spawned ${d.toFixed(2)} m apart`);
      }
    }
  });

  it('a chikenCT bot walks to a planted bomb and defuses it', () => {
    const { io } = fakeIo();
    const room = createRoom(io, { id: 'd', code: 'DEFU1', name: 'Defuse', mode: 'bomb', map: 'sandstown', private: true, bots: 1 }, {}) as BombRoom;
    current = room;
    clearInterval((room as unknown as { tickTimer: NodeJS.Timeout }).tickTimer);
    const update = (room as unknown as { fixedUpdate(now: number): void }).fixedUpdate.bind(room);
    let now = performance.now();
    const human = addPlayer(room, 'Planter');
    (room as unknown as { bots: { add(): boolean } }).bots.add();
    // The first player's side is random: put the human on chikenT, the bot on chikenCT.
    for (const p of room.players.values()) p.info.team = p === human ? 1 : 2;
    room.startNow();
    for (const p of room.players.values()) (p as unknown as { takeInputToken(): boolean }).takeInputToken = () => true;
    const run = (ms: number) => {
      for (const end = now + ms; now < end; ) {
        now += SIM_DT * 1000;
        update(now);
      }
    };
    run(BOMB.warmupMs + BOMB.buyMs + 100);
    assert.equal(human.info.team, 1, 'the human is chikenT');
    assert.equal(round(room).bomb.carrier, human.pid);
    place(human, SITE_A.x, SITE_A.z);
    holdUse(human);
    run(BOMB.plantMs + 100);
    assert.equal(round(room).phase, 'planted');
    // The planter hides far away (and can't be shot) so the bot only has the bomb to deal with.
    holdUse(human, false);
    place(human, -40, 40);
    human.shieldUntil = Infinity;
    for (let t = 0; t < BOMB.fuseMs - 500 && round(room).phase === 'planted'; t += 100) run(100);
    const r = round(room);
    assert.equal(r.reason, 'defused', `the bot didn't defuse in time (phase ${r.phase}, ${r.reason})`);
  });
});
