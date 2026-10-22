import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SIM_DT, normalize, type InputFrame } from '@game/shared';
import { LATE_CSGO, poseMatrix, type CommandIntent, type ShotVerdict } from '@game/shared/hvh/v2';
import type { ServerPlayer } from '../../src/rooms/ServerPlayer';
import { HvhRoom } from '../../src/rooms/HvhRoom';
import { addPlayer, fakeIo, place, stepRoom } from '../helpers';

/*
 * I4: a target that sends no commands beyond maxChoke stays hittable: every silent tick past
 * maxChoke pushes a record of where the server has the player (after the coast). Minor 3: the R55
 * mid-air hold of a partial charge lasts chargeTicks silent ticks at most, then the player coasts.
 */

const TICK_MS = SIM_DT * 1000;
const IDLE: CommandIntent = { fire: false, choke: false, doubleTap: false, hideShots: false };
const WALL_ID = 1_000_000;

function silentDuel(opts: { wall?: boolean } = {}) {
  const { io } = fakeIo();
  const room = new HvhRoom(io, { id: 'hvh-silent', code: 'HVHSI', name: 'Silent', mode: 'hvh', map: 'flat', private: true, hvhEngine: 'v2', hvhRounds: false }, {});
  const verdicts: ShotVerdict[] = [];
  room.addVerdictListener((v) => verdicts.push(v));
  const a = addPlayer(room, 'A');
  const b = addPlayer(room, 'B');
  a.info.team = 1;
  b.info.team = 2;
  room.startNow();
  place(a, 20, 20);
  place(b, 20, 12);
  a.shieldUntil = b.shieldUntil = 0;
  a.hvhEnabled = b.hvhEnabled = true;
  a.takeInputToken = b.takeInputToken = () => true;
  // A wall between them (no line of sight) lets B charge.
  if (opts.wall) room.world.add(WALL_ID, { minX: -40, maxX: 40, minY: 0, maxY: 20, minZ: 15, maxZ: 16 });
  let now = performance.now();
  const seqs = new Map<number, number>();
  const send = (p: ServerPlayer, intent: Partial<CommandIntent> = {}, over: Partial<InputFrame> = {}) => {
    const seq = (seqs.get(p.pid) ?? 0) + 1;
    seqs.set(p.pid, seq);
    room.handleInput(p, { seq, forward: 0, right: 0, jump: false, yaw: 0, pitch: 0, intent: { ...IDLE, ...intent }, ...over });
  };
  const step = () => stepRoom(room, (now += TICK_MS));
  const aimAt = (q: ServerPlayer, group: string): Partial<InputFrame> => {
    const r = room.v2State(q.pid)!.history.records().at(-1)!;
    const c = poseMatrix(r, r.pose).boxes.find((box) => box.group === group)!.center;
    const eye = room.eyeOf(a);
    const dir = normalize({ x: c.x - eye.x, y: c.y - eye.y, z: c.z - eye.z });
    return { yaw: Math.atan2(-dir.x, -dir.z), pitch: Math.asin(dir.y) };
  };
  for (let i = 0; i < 3; i++) { send(a); send(b); step(); }
  return { room, a, b, send, step, aimAt, verdicts };
}

describe('silent targets (I4, Minor 3)', () => {
  it('a target that sends nothing for 40 ticks can still be hit (the review probe)', (t) => {
    const { room, a, b, send, step, aimAt, verdicts } = silentDuel();
    t.after(() => room.close());
    holdDeagle(a);
    for (let i = 0; i < 40; i++) { send(a); step(); }
    assert.equal(room.v2State(b.pid)!.history.records().at(-1)!.tick, room.hvhTick, 'a record for the newest silent tick');
    send(a, { fire: true }, aimAt(b, 'chest'));
    step();
    const shot = verdicts.find((v) => v.shooterId === String(a.pid) && v.bullet === 1);
    assert.equal(shot?.cause, 'hit', JSON.stringify(shot));
    assert.ok(b.hp < 100);
  });

  it('within maxChoke a silent player pushes no record (as a choke)', (t) => {
    const { room, a, b, send, step } = silentDuel();
    t.after(() => room.close());
    const last = room.v2State(b.pid)!.history.records().at(-1)!.tick;
    for (let i = 0; i < LATE_CSGO.maxChoke; i++) { send(a); step(); }
    assert.equal(room.v2State(b.pid)!.history.records().at(-1)!.tick, last);
    send(a);
    step();
    assert.equal(room.v2State(b.pid)!.history.records().at(-1)!.tick, room.hvhTick, 'past maxChoke the silent ticks are recorded');
  });

  it('the coasted records follow the coast: a silent player falling is recorded where the server has them', (t) => {
    const { room, a, b, send, step } = silentDuel();
    t.after(() => room.close());
    place(b, 20, 12, 3);
    for (let i = 0; i < LATE_CSGO.maxChoke + 10; i++) { send(a); step(); }
    const r = room.v2State(b.pid)!.history.records().at(-1)!;
    assert.deepEqual(r.position, { x: b.state.x, y: b.state.y, z: b.state.z });
    assert.ok(r.valid);
    assert.ok(b.state.y < 3, 'the silent player fell (coast)');
  });

  it('a partial charge holds a silent player in the air for chargeTicks ticks, then they coast (Minor 3)', (t) => {
    const { room, a, b, send, step } = silentDuel({ wall: true });
    t.after(() => room.close());
    place(b, 20, 12, 3);
    for (let i = 0; i < LATE_CSGO.chargeTicks / 2; i++) { send(a); send(b, { doubleTap: true }); step(); }
    assert.equal(room.tickbaseOf(b.pid)?.charge, LATE_CSGO.chargeTicks / 2, 'precondition: a partial charge');
    assert.equal(b.state.y, 3, 'precondition: held in the air');
    for (let i = 0; i < LATE_CSGO.chargeTicks; i++) { send(a); step(); }
    assert.equal(b.state.y, 3, 'held for chargeTicks silent ticks (R55)');
    send(a);
    step();
    assert.ok(b.state.y < 3, 'then the hold ends and the player falls');
  });

  it('a silent player never moves more than one coast step per tick', (t) => {
    const { room, a, b, send, step } = silentDuel();
    t.after(() => room.close());
    send(b, {}, { forward: 1 });
    step();
    let z = b.state.z;
    for (let i = 0; i < 40; i++) {
      send(a);
      step();
      // The coast invents no presses: speed only bleeds off, so each tick moves less than one run step.
      assert.ok(Math.abs(b.state.z - z) <= 6.25 * SIM_DT + 1e-9, `tick ${i}`);
      z = b.state.z;
    }
  });
});

function holdDeagle(p: ServerPlayer): void {
  p.weaponSlot = p.info.loadout.indexOf('deserteagle');
  assert.ok(p.weaponSlot >= 0);
}
