import assert from 'node:assert/strict';
import { describe, it, type TestContext } from 'node:test';
import type { ServerPlayer } from '../../src/rooms/ServerPlayer';
import { HvhRoom } from '../../src/rooms/HvhRoom';
import { addPlayer, fakeIo, stepRoom } from '../helpers';
import { CLOCK_BASE, TICK_MS, makeMatch } from './hvhMatch';

/*
 * Round flow seams: a human joining a live round takes a dead bot's seat (Minor 5), and a team
 * switch during freeze puts the player straight back into the round (Minor 6).
 */

function clock(room: HvhRoom, start = CLOCK_BASE) {
  let now = start;
  const step = (ms = TICK_MS) => { now += ms; stepRoom(room, now); };
  const until = (phase: string) => {
    for (let i = 0; i < 10 && room.hvhRound.phase !== phase; i++) step(Math.max(TICK_MS, (room.hvhRound.endsAt ?? now) - now));
    assert.equal(room.hvhRound.phase, phase);
  };
  const kill = (p: ServerPlayer) => { p.shieldUntil = 0; room.damage(p, null, 1000, false, 'world', { x: 0, y: 0, z: 0 }, now); };
  return { step, until, kill, get now() { return now; } };
}

function filledRoom(t: TestContext) {
  const { io } = fakeIo();
  const room = new HvhRoom(io, { id: 'fill-flow', code: 'FILL2', name: 'Fill', mode: 'hvh', map: 'farm', private: false, fillBots: true, hvhEngine: 'v2', seed: 5 }, {});
  t.after(() => room.close());
  addPlayer(room, 'Human');
  const c = clock(room);
  c.step();
  const bots = () => [...room.players.values()].filter((p) => p.info.bot);
  assert.equal(room.players.size, 10, 'filled to a 5v5');
  return { room, bots, ...c };
}

describe('HvH v2 round flow seams', () => {
  it('a human joining a live round takes the seat of a dead bot, not a living one (Minor 5)', (t) => {
    const m = filledRoom(t);
    m.until('live');
    const victim = m.bots().at(-2)!;
    m.kill(victim);
    m.step();
    assert.equal(m.room.hvhRound.phase, 'live');
    const alive = m.bots().filter((b) => b.alive).map((b) => b.pid);
    addPlayer(m.room, 'Late');
    for (let i = 0; i < 70; i++) m.step();
    assert.equal(m.room.players.size, 10);
    assert.ok(!m.room.players.has(victim.pid), 'the dead bot left');
    assert.deepEqual(m.bots().filter((b) => b.alive).map((b) => b.pid), alive, 'every living bot stays in the round');
  });

  it('with no dead bot, a living one still makes room', (t) => {
    const m = filledRoom(t);
    m.until('live');
    addPlayer(m.room, 'Late');
    for (let i = 0; i < 70; i++) m.step();
    assert.equal(m.room.players.size, 10);
    assert.equal(m.bots().length, 8);
  });

  it('a team switch during freeze respawns the player into the round on the new side (Minor 6)', (t) => {
    const m = makeMatch(3, { rounds: true, teams: [1, 1, 2] });
    t.after(() => m.room.close());
    const c = clock(m.room);
    c.until('freeze');
    const p = m.players[0]!;
    assert.equal(m.room.switchTeam(p, c.now), null);
    assert.equal(p.info.team, 2);
    assert.ok(p.alive, 'back in the round at once');
    assert.ok(p.frozen, 'frozen with everyone else');
    c.until('live');
    assert.ok(p.alive, 'still in when the round goes live');
  });

  it('a team switch during a live round sits the player out until the next round', (t) => {
    const m = makeMatch(3, { rounds: true, teams: [1, 1, 2] });
    t.after(() => m.room.close());
    const c = clock(m.room);
    c.until('live');
    const p = m.players[0]!;
    assert.equal(m.room.switchTeam(p, c.now), null);
    for (let i = 0; i < 300; i++) c.step();
    assert.equal(m.room.hvhRound.phase, 'live');
    assert.ok(!p.alive, 'no respawn in a live round');
  });
});
