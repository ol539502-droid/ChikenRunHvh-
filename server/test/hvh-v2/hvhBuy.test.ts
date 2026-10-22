import assert from 'node:assert/strict';
import { describe, it, type TestContext } from 'node:test';
import type { WeaponId } from '@game/shared';
import { HVH_MAINS, HVH_PISTOLS } from '@game/shared/hvh/v2';
import { GameRoom } from '../../src/rooms/GameRoom';
import { HvhRoom } from '../../src/rooms/HvhRoom';
import type { ServerPlayer } from '../../src/rooms/ServerPlayer';
import { addPlayer, fakeIo, stepRoom } from '../helpers';
import { CLOCK_BASE, TICK_MS, makeMatch } from './hvhMatch';

const MAINS: readonly WeaponId[] = HVH_MAINS;
const PISTOLS: readonly WeaponId[] = HVH_PISTOLS;

/** A seeded 5v5 v2 match (scripted players, no bots) with the round flow and a clock the test moves. */
function buyMatch(t: TestContext) {
  const m = makeMatch(11, { rounds: true });
  t.after(() => m.room.close());
  let now = CLOCK_BASE;
  const step = (ms = TICK_MS) => { now += ms; stepRoom(m.room, now); };
  const until = (phase: string) => {
    for (let i = 0; i < 10 && m.room.hvhRound.phase !== phase; i++) step(Math.max(TICK_MS, (m.room.hvhRound.endsAt ?? now) - now));
    assert.equal(m.room.hvhRound.phase, phase);
  };
  const kill = (p: ServerPlayer) => { p.shieldUntil = 0; m.room.damage(p, null, 1000, false, 'world', { x: 0, y: 0, z: 0 }, now); };
  return { ...m, step, until, kill, get now() { return now; } };
}

/** A public v2 (or legacy) HvH room that tops itself up with bots, as quick play does. */
function fillRoom(t: TestContext, seed: number, engine: 'v2' | 'legacy' = 'v2') {
  const { io } = fakeIo();
  const room = new HvhRoom(io, { id: `fill-${seed}`, code: 'FILL1', name: 'Fill', mode: 'hvh', map: 'farm', private: false, fillBots: true, hvhEngine: engine, seed }, {});
  t.after(() => room.close());
  const human = addPlayer(room, 'Human');
  let now = CLOCK_BASE;
  stepRoom(room, now);
  const step = (ms = TICK_MS) => { now += ms; stepRoom(room, now); };
  const until = (phase: string) => {
    for (let i = 0; i < 10 && room.hvhRound.phase !== phase; i++) step(Math.max(TICK_MS, (room.hvhRound.endsAt ?? now) - now));
    assert.equal(room.hvhRound.phase, phase);
  };
  const bots = () => [...room.players.values()].filter((p) => p.info.bot);
  return { room, human, step, until, bots };
}

function assertArsenalLoadout(p: ServerPlayer, where: string): void {
  assert.equal(p.info.loadout.length, 2, `${where}: two weapons (${p.info.loadout.join(', ')})`);
  assert.ok(MAINS.includes(p.info.loadout[0]!), `${where}: slot 0 is a main (${p.info.loadout[0]})`);
  assert.ok(PISTOLS.includes(p.info.loadout[1]!), `${where}: slot 1 is a pistol (${p.info.loadout[1]})`);
}

describe('HvH v2 buy menu', () => {
  it('buying scar20 during freeze sets the main, free, and the pick is kept for the next round', (t) => {
    const m = buyMatch(t);
    m.until('freeze');
    const p = m.players[0]!;
    assert.deepEqual(m.room.handleBuy(p, 'scar20', m.now), { ok: true, money: 0 });
    assert.deepEqual(p.info.loadout, ['scar20', 'deserteagle']);
    assert.equal(p.mags.get('scar20'), p.magazineSize('scar20'), 'the new gun comes loaded');
    assert.ok(m.events.some((e) => e.event === 'playerUpdated' && (e.args[0] as { pid: number }).pid === p.pid), 'everyone hears about the new loadout');
    assert.deepEqual(m.room.handleBuy(p, 'r8', m.now), { ok: true, money: 0 });
    assert.deepEqual(p.info.loadout, ['scar20', 'r8'], 'a pistol replaces only the pistol');
    m.until('live');
    for (const q of m.players.filter((q) => q.info.team === 2)) m.kill(q);
    m.step();
    m.until('freeze');
    assert.equal(m.room.hvhRound.round, 2);
    assert.deepEqual(p.info.loadout, ['scar20', 'r8'], 're-applied at the next round start');
    assert.equal(p.mags.get('scar20'), p.magazineSize('scar20'));
  });

  it('buying during the live round is refused and the loadout is unchanged', (t) => {
    const m = buyMatch(t);
    m.until('live');
    const p = m.players[0]!;
    assert.deepEqual(m.room.handleBuy(p, 'scar20', m.now), { ok: false, error: 'Buying is closed.', money: 0 });
    assert.deepEqual(p.info.loadout, ['ssg08', 'deserteagle']);
  });

  it('buying during the round-end banner is refused and the loadout is unchanged', (t) => {
    const m = buyMatch(t);
    m.until('live');
    for (const q of m.players.filter((q) => q.info.team === 2)) m.kill(q);
    m.step();
    assert.equal(m.room.hvhRound.phase, 'over');
    const p = m.players[0]!;
    assert.deepEqual(m.room.handleBuy(p, 'r8', m.now), { ok: false, error: 'Buying is closed.', money: 0 });
    assert.deepEqual(p.info.loadout, ['ssg08', 'deserteagle']);
  });

  it('only arsenal ids can be bought', (t) => {
    const m = buyMatch(t);
    const p = m.players[0]!;
    assert.equal(m.room.hvhRound.phase, 'warmup');
    for (const id of ['ak47', 'rifle', 'knife', 'armor', 42, null]) {
      assert.deepEqual(m.room.handleBuy(p, id, m.now), { ok: false, error: 'Not in the HvH arsenal.', money: 0 }, String(id));
    }
    assert.deepEqual(p.info.loadout, ['ssg08', 'deserteagle']);
    assert.deepEqual(m.room.handleBuy(p, 'r8', m.now), { ok: true, money: 0 }, 'warmup is a buy window too');
    assert.deepEqual(p.info.loadout, ['ssg08', 'r8']);
  });

  it('picks are rate limited: a main and a pistol at once, then one per 250 ms (no broadcast spam)', (t) => {
    const m = buyMatch(t);
    const p = m.players[0]!;
    assert.equal(m.room.hvhRound.phase, 'warmup');
    const updates = () => m.events.filter((e) => e.event === 'playerUpdated' && (e.args[0] as { pid: number }).pid === p.pid).length;
    const before = updates();
    assert.equal(m.room.handleBuy(p, 'scar20', m.now).ok, true);
    assert.equal(m.room.handleBuy(p, 'r8', m.now).ok, true, 'the remembered pair is sent together');
    assert.deepEqual(m.room.handleBuy(p, 'ssg08', m.now), { ok: false, error: 'Picking too fast.', money: 0 });
    assert.deepEqual(p.info.loadout, ['scar20', 'r8'], 'a refused pick changes nothing');
    assert.equal(updates(), before + 2, 'a refused pick is not broadcast');
    assert.deepEqual(m.room.handleBuy(p, 'scar20', m.now), { ok: true, money: 0 }, 'the same pick is a free no-op');
    assert.equal(m.room.handleBuy(p, 'ssg08', m.now + 249).ok, false);
    assert.equal(m.room.handleBuy(p, 'ssg08', m.now + 250).ok, true, 'one more pick per 250 ms');
    assert.deepEqual(p.info.loadout, ['ssg08', 'r8']);
  });

  it('a legacy HvH room keeps the legacy buy behaviour and the profile loadout', (t) => {
    const { io } = fakeIo();
    const room = new HvhRoom(io, { id: 'legacy', code: 'LEG01', name: 'Legacy', mode: 'hvh', map: 'farm', private: true }, {});
    t.after(() => room.close());
    const p = addPlayer(room, 'A');
    const before = [...p.info.loadout];
    const plain = new GameRoom(fakeIo().io, { id: 'plain', code: 'PLN01', name: 'Plain', mode: 'hvh', map: 'farm', private: true }, {});
    t.after(() => plain.close());
    const q = addPlayer(plain, 'B');
    assert.deepEqual(room.handleBuy(p, 'scar20'), plain.handleBuy(q, 'scar20'));
    assert.deepEqual(room.handleBuy(p, 'scar20'), { ok: false, error: 'There is no buy menu in this mode.', money: 0 });
    assert.deepEqual(p.info.loadout, before);
    assert.ok(!before.includes('ssg08'), 'legacy spawns keep the profile loadout');
  });

  it('every v2 spawn carries exactly [main, pistol]: no knife, no grenades', (t) => {
    const m = buyMatch(t);
    for (const p of m.players) {
      assert.deepEqual(p.info.loadout, ['ssg08', 'deserteagle'], `P${p.pid} default`);
      assert.deepEqual([p.eggs, p.smokes, p.flashes], [0, 0, 0]);
      assert.equal(p.mags.get('ssg08'), p.magazineSize('ssg08'));
      assert.equal(p.mags.get('deserteagle'), p.magazineSize('deserteagle'));
    }
    const p = m.players[0]!;
    m.room.handleBuy(p, 'scar20', m.now);
    p.mags.set('scar20', 0);
    m.kill(p);
    m.step(m.room.mode.respawnMs + TICK_MS);
    assert.ok(p.alive, 'respawned in warmup');
    assert.deepEqual(p.info.loadout, ['scar20', 'deserteagle']);
    assert.deepEqual([p.eggs, p.smokes, p.flashes], [0, 0, 0]);
    assert.equal(p.mags.get('scar20'), p.magazineSize('scar20'), 'a new life has full magazines');
    m.until('freeze');
    for (const q of m.players) {
      assertArsenalLoadout(q, `P${q.pid} at freeze`);
      assert.deepEqual([q.eggs, q.smokes, q.flashes], [0, 0, 0]);
    }
  });
});

describe('HvH v2 5v5 bot fill', () => {
  it('with one human, a v2 room fills to 10 players; bots keep exploits off', (t) => {
    const f = fillRoom(t, 5);
    assert.equal(f.room.players.size, 10);
    assert.equal(f.bots().length, 9);
    const teams = [...f.room.players.values()].map((p) => p.info.team);
    assert.deepEqual([teams.filter((x) => x === 1).length, teams.filter((x) => x === 2).length], [5, 5], 'a 5v5');
    for (const b of f.bots()) {
      assert.equal(b.hvh.exploit, 'off');
      assertArsenalLoadout(b, b.info.name);
    }
  });

  it('a legacy HvH room still fills to 4', (t) => {
    const f = fillRoom(t, 5, 'legacy');
    assert.equal(f.room.players.size, 4);
  });

  it('each bot picks a main and a pistol at round start from the seeded room RNG', (t) => {
    const picks = (seed: number) => {
      const f = fillRoom(t, seed);
      f.room.startNow(CLOCK_BASE);
      const rounds: string[][] = [];
      f.until('freeze');
      rounds.push(f.bots().map((b) => b.info.loadout.join('+')));
      for (const b of f.bots()) assertArsenalLoadout(b, `${b.info.name} round 1`);
      return rounds;
    };
    const a = picks(9);
    assert.deepEqual(picks(9), a, 'same seed, same picks');
    assert.ok(new Set(a[0]).size > 1, `the picks vary between bots (${a[0]!.join(', ')})`);
  });
});
