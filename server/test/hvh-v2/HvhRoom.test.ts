import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  MAX_REWIND_MS, PLAYER, SIM_DT, SNAPSHOT_RATE, WEAPONS, hopMaxFor, makeRay, moveSpeedFor, normalize, rayHvhMatrix, stepPlayer, unpackPlayer, wrapAngle,
  type InputFrame, type MoveState, type Vec3,
} from '@game/shared';
import { FLICK_TICKS, LATE_CSGO, PEEK_TICKS, fireIntervalTicks, guessedPose, poseMatrix, uniformAntiAim, type CommandIntent, type LagRecord, type ShotVerdict, type StanceAA } from '@game/shared/hvh/v2';
import type { ServerPlayer } from '../../src/rooms/ServerPlayer';
import { GameRoom, parseInput } from '../../src/rooms/GameRoom';
import { HvhRoom, hvhEngineFrom, type HvhEngine } from '../../src/rooms/HvhRoom';
import { createRoom } from '../../src/rooms/modes';
import { addPlayer, fakeIo, place, stepRoom } from '../helpers';

const TICK_MS = SIM_DT * 1000;
const IDLE: CommandIntent = { fire: false, choke: false, doubleTap: false, hideShots: false };

function makeHvh(engine: HvhEngine) {
  const { io, events } = fakeIo();
  const room = new HvhRoom(io, { id: 'hvh-v2', code: 'HVH01', name: 'HvH v2', mode: 'hvh', map: 'flat', private: true, hvhEngine: engine }, {});
  const verdicts: ShotVerdict[] = [];
  room.addVerdictListener((v) => verdicts.push(v));
  return { room, events, verdicts };
}

/** Two scripted players on opposite teams, spawned, unshielded, AA tools enabled. */
function duel(engine: HvhEngine = 'v2') {
  const made = makeHvh(engine);
  const { room } = made;
  const a = addPlayer(room, 'A');
  const b = addPlayer(room, 'B');
  a.info.team = 1;
  b.info.team = 2;
  room.startNow();
  place(a, 20, 20);
  place(b, 20, 10);
  a.shieldUntil = b.shieldUntil = 0;
  a.hvhEnabled = b.hvhEnabled = true;
  return { ...made, a, b };
}

function command(seq: number, intent?: Partial<CommandIntent>): InputFrame & { intent?: CommandIntent; clientTick?: number } {
  const frame: InputFrame & { intent?: CommandIntent; clientTick?: number } = { seq, forward: 0, right: 0, jump: false, yaw: 0, pitch: 0 };
  if (intent) frame.intent = { ...IDLE, ...intent };
  return frame;
}

function recordOf(room: HvhRoom, pid: number): LagRecord {
  const r = room.v2State(pid)!.history.records().at(-1);
  assert.ok(r, 'the player has a lag record');
  return r;
}

function boxCentre(room: HvhRoom, pid: number, group: string): Vec3 {
  const r = recordOf(room, pid);
  return poseMatrix(r, r.pose).boxes.find((b) => b.group === group)!.center;
}

function anglesTo(from: Vec3, to: Vec3): { dir: Vec3; yaw: number; pitch: number } {
  const dir = normalize({ x: to.x - from.x, y: to.y - from.y, z: to.z - from.z });
  return { dir, yaw: Math.atan2(-dir.x, -dir.z), pitch: Math.asin(dir.y) };
}

function intersects(room: HvhRoom, pid: number, origin: Vec3, dir: Vec3): boolean {
  const r = recordOf(room, pid);
  return rayHvhMatrix(makeRay(origin, dir), poseMatrix(r, r.pose), 100) !== null;
}

/** One tick of idle commands for every listed player. */
function idleTick(room: HvhRoom, players: ServerPlayer[], seqs: Map<number, number>, now: number): void {
  for (const p of players) {
    const seq = (seqs.get(p.pid) ?? 0) + 1;
    seqs.set(p.pid, seq);
    room.handleInput(p, command(seq, {}));
  }
  stepRoom(room, now);
}

type Sent = { event: string; data: unknown };
function fakeSocket(p: ServerPlayer, sink: Sent[]): void {
  const socket = { emit(event: string, data: unknown) { sink.push({ event, data }); }, to() { return { emit() {} }; }, leave() {}, volatile: { emit() {} } };
  Object.defineProperty(p, 'socket', { value: socket });
}

/** A wall across the field between A (z 20) and B (z 10): no line of sight, so DT and hide shots charge. */
const WALL = { minX: -40, maxX: 40, minY: 0, maxY: 20, minZ: 14, maxZ: 15 };
const WALL_ID = 1_000_000;

function hiddenDuel() {
  const made = duel();
  made.room.world.add(WALL_ID, WALL);
  made.a.takeInputToken = made.b.takeInputToken = () => true;
  return made;
}

/** Drives A with one command per server tick. */
function driver(room: HvhRoom, p: ServerPlayer) {
  let seq = 0;
  let now = performance.now();
  return {
    get seq() { return seq; },
    get now() { return now; },
    /** The frame the server will run for the next command (as handleInput parses it). */
    frame(over: Partial<InputFrame> = {}): InputFrame {
      return parseInput({ ...command(seq + 1), ...over })!;
    },
    tick(intent: Partial<CommandIntent>, over: Partial<InputFrame> = {}, before?: () => void): void {
      room.handleInput(p, { ...command(++seq, intent), ...over });
      before?.();
      stepRoom(room, (now += TICK_MS));
    },
  };
}

/** `p`'s movement state after `steps` plain stepPlayer calls of `frame`, on a copy. */
function walked(room: HvhRoom, p: ServerPlayer, frame: InputFrame, steps: number): MoveState {
  const copy = structuredClone(p.state);
  for (let i = 0; i < steps; i++) stepPlayer(copy, frame, SIM_DT, room.world, p.moveMods(), hopMaxFor(p.weapon), moveSpeedFor(p.weapon), true);
  return copy;
}

function holdDeagle(p: ServerPlayer): void {
  const slot = p.info.loadout.indexOf('deserteagle');
  assert.ok(slot >= 0, 'v2 spawns carry the Desert Eagle');
  p.weaponSlot = slot;
}

function threePlayers(nearX: number) {
  const made = duel();
  const { room, a, b } = made;
  const c = addPlayer(room, 'C');
  c.info.team = 2;
  room.respawnPlayer(c, performance.now());
  place(b, nearX, 15);
  place(c, 20, 10);
  b.shieldUntil = c.shieldUntil = 0;
  const seqs = new Map<number, number>();
  let now = performance.now();
  for (let i = 0; i < 3; i++) idleTick(room, [a, b, c], seqs, (now += TICK_MS));
  return { ...made, c, seqs, now };
}

describe('HvhRoom v2 tick pipeline', () => {
  it('with the exploits off every command moves and nothing charges, even with no enemy in view', (t) => {
    const { room, a } = hiddenDuel();
    t.after(() => room.close());
    let now = performance.now();
    const tickbase = room.tickbaseOf(a.pid)!.tickbase;
    for (let seq = 1; seq <= 40; seq++) {
      const z = a.state.z;
      room.handleInput(a, { ...command(seq, {}), forward: 1 });
      stepRoom(room, (now += TICK_MS));
      assert.equal(a.lastSeq, seq, `command ${seq} executed this tick (no coasting)`);
      assert.ok(a.state.z < z, `command ${seq} moved the player`);
    }
    assert.equal(a.lastSeq, 40);
    assert.equal(room.tickbaseOf(a.pid)?.charge, 0);
    assert.equal(room.tickbaseOf(a.pid)?.tickbase, tickbase + 40, 'tickbase advanced once per command');
  });

  it('a ray through only the guessed body names that target and is a resolver miss', (t) => {
    const { room, a, b, verdicts } = duel();
    t.after(() => room.close());
    b.hvh.antiAim = { ...b.hvh.antiAim, enabled: true, mode: 'backward', desync: 58, jitter: 0 };
    const seqs = new Map<number, number>();
    let now = performance.now();
    // Inverted desync: the real body is on the right; with no eye offset the resolver guesses left.
    for (let i = 0; i < 3; i++) {
      for (const p of [a, b]) {
        const seq = (seqs.get(p.pid) ?? 0) + 1;
        seqs.set(p.pid, seq);
        room.handleInput(p, { ...command(seq, {}), invert: p === b });
      }
      stepRoom(room, (now += TICK_MS));
    }
    const r = recordOf(room, b.pid);
    assert.equal(r.pose.realSide, 'right');
    const guessed = poseMatrix(r, guessedPose(r.pose, 'left'));
    const real = poseMatrix(r, r.pose);
    const eye = room.eyeOf(a);
    const aim = guessed.boxes.map((box) => anglesTo(eye, box.center))
      .find((x) => rayHvhMatrix(makeRay(eye, x.dir), real, 100) === null && rayHvhMatrix(makeRay(eye, x.dir), guessed, 100) !== null);
    assert.ok(aim, 'precondition: some guessed hitbox is clear of the real body');
    room.handleInput(a, { ...command(seqs.get(a.pid)! + 1, { fire: true }), yaw: aim.yaw, pitch: aim.pitch });
    room.handleInput(b, { ...command(seqs.get(b.pid)! + 1, {}), invert: true });
    stepRoom(room, (now += TICK_MS));
    const shot = verdicts.find((v) => v.shooterId === String(a.pid));
    assert.deepEqual([shot?.targetId, shot?.cause, shot?.guessed, shot?.real], [String(b.pid), 'resolver', 'left', 'right']);
  });

  it('a command-level fire with a melee weapon is rejected as wrong weapon', (t) => {
    const { room, a, verdicts } = duel();
    t.after(() => room.close());
    a.info.loadout.push('knife');
    a.weaponSlot = a.info.loadout.length - 1;
    room.handleInput(a, command(1, { fire: true }));
    stepRoom(room, performance.now() + TICK_MS);
    assert.deepEqual(verdicts.map((v) => [v.cause, v.reason]), [['rejected', 'wrong weapon']]);
  });

  it('a shot at a spawn-protected target still spends ammo, the fire interval and the own shield', (t) => {
    const { room, a, b, verdicts } = duel();
    t.after(() => room.close());
    place(b, 20, 17);
    const seqs = new Map<number, number>();
    let now = performance.now();
    for (let i = 0; i < 3; i++) idleTick(room, [a, b], seqs, (now += TICK_MS));
    b.shieldUntil = now + 60_000;
    a.shieldUntil = now + 60_000;
    const mag = a.mag;
    const aim = anglesTo(room.eyeOf(a), boxCentre(room, b.pid, 'chest'));
    let seq = seqs.get(a.pid)!;
    room.handleInput(a, { ...command(++seq, { fire: true }), yaw: aim.yaw, pitch: aim.pitch });
    stepRoom(room, (now += TICK_MS));
    room.handleInput(a, { ...command(++seq, { fire: true }), yaw: aim.yaw, pitch: aim.pitch });
    stepRoom(room, (now += TICK_MS));
    const shots = verdicts.filter((v) => v.shooterId === String(a.pid));
    assert.deepEqual(shots.map((v) => v.reason), ['spawn protection', 'fire interval']);
    assert.equal(a.mag, mag - 1, 'the protected shot spent one round');
    assert.equal(a.shieldUntil, 0, 'firing ends the shooter\'s own spawn shield');
    assert.equal(b.hp, 100);
  });

  it('a near enemy beside the line does not steal a head shot on a far enemy', (t) => {
    const { room, a, b, c, seqs, now } = threePlayers(20.75);
    t.after(() => room.close());
    const eye = room.eyeOf(a);
    const aim = anglesTo(eye, boxCentre(room, c.pid, 'head'));
    assert.equal(intersects(room, b.pid, eye, aim.dir), false, 'precondition: the ray misses B');
    const verdicts: ShotVerdict[] = [];
    room.addVerdictListener((v) => verdicts.push(v));
    room.handleInput(a, { ...command(seqs.get(a.pid)! + 1, { fire: true }), yaw: aim.yaw, pitch: aim.pitch });
    stepRoom(room, now + TICK_MS);
    assert.equal(verdicts.find((v) => v.shooterId === String(a.pid))?.targetId, String(c.pid));
  });

  it('a client naming a far enemy behind a near intersected enemy gets the near enemy', (t) => {
    const { room, a, b, c, seqs, now: last } = threePlayers(20);
    t.after(() => room.close());
    const eye = room.eyeOf(a);
    const aim = anglesTo(eye, boxCentre(room, c.pid, 'head'));
    assert.equal(intersects(room, b.pid, eye, aim.dir), true, 'precondition: B is in the way');
    const verdicts: ShotVerdict[] = [];
    room.addVerdictListener((v) => verdicts.push(v));
    const seq = seqs.get(a.pid)! + 1;
    const now = last + TICK_MS;
    room.handleFire(a, { shot: 1, weapon: a.weapon, dx: aim.dir.x, dy: aim.dir.y, dz: aim.dir.z, t: now, aiming: false, command: seq,
      intent: { target: c.pid, source: 'CENTER', recordT: now, yaw: 0 } });
    room.handleInput(a, { ...command(seq, {}), yaw: aim.yaw, pitch: aim.pitch });
    stepRoom(room, now);
    assert.equal(verdicts.find((v) => v.shooterId === String(a.pid))?.targetId, String(b.pid));
  });

  it('flood verdicts reach only the sender', (t) => {
    const { room, a, b } = duel();
    t.after(() => room.close());
    const toA: Sent[] = [];
    const toB: Sent[] = [];
    fakeSocket(a, toA);
    fakeSocket(b, toB);
    room.damage(b, a, 1000, false, a.weapon, room.eyeOf(a), performance.now());
    assert.equal(b.alive, false, 'B is a spectator');
    a.takeInputToken = () => true;
    for (let seq = 1; seq <= 40; seq++) room.handleInput(a, command(seq, {}));
    assert.equal(toA.filter((e) => e.event === 'shotVerdict').length, 8);
    assert.equal(toB.filter((e) => e.event === 'shotVerdict').length, 0);
  });

  it('the input limiter still applies in v2', (t) => {
    const { room, a } = duel();
    t.after(() => room.close());
    a.takeInputToken = () => false;
    room.handleInput(a, command(1, {}));
    assert.equal(room.queuedCommands(a.pid), 0);
  });

  it('a pending fire consumed while preparing is rejected as actions blocked', (t) => {
    const { room, a, verdicts } = duel();
    t.after(() => room.close());
    room.handleInput(a, command(1, {}));
    room.handleFire(a, { shot: 1, weapon: a.weapon, dx: 0, dy: 0, dz: -1, t: performance.now(), aiming: false, command: 1 });
    a.hvhPreparing = true;
    stepRoom(room, performance.now() + TICK_MS);
    assert.deepEqual(verdicts.map((v) => [v.cause, v.reason]), [['rejected', 'actions blocked']]);
  });

  it('pending fires cleared by death, and fires while dead, are rejected as actions blocked', (t) => {
    const { room, a, b, verdicts } = duel();
    t.after(() => room.close());
    room.handleFire(a, { shot: 1, weapon: a.weapon, dx: 0, dy: 0, dz: -1, t: performance.now(), aiming: false, command: 5 });
    room.damage(a, b, 1000, false, b.weapon, room.eyeOf(b), performance.now());
    assert.deepEqual(verdicts.map((v) => [v.cause, v.reason]), [['rejected', 'actions blocked']]);
    room.handleFire(a, { shot: 2, weapon: a.weapon, dx: 0, dy: 0, dz: -1, t: performance.now(), aiming: false });
    assert.deepEqual(verdicts.map((v) => v.reason), ['actions blocked', 'actions blocked']);
  });

  it('a pending fire whose weapon became melee is rejected as wrong weapon', (t) => {
    const { room, a, verdicts } = duel();
    t.after(() => room.close());
    room.handleInput(a, command(1, {}));
    room.handleFire(a, { shot: 1, weapon: a.weapon, dx: 0, dy: 0, dz: -1, t: performance.now(), aiming: false, command: 1 });
    a.info.loadout.push('knife');
    a.weaponSlot = a.info.loadout.length - 1;
    stepRoom(room, performance.now() + TICK_MS);
    assert.deepEqual(verdicts.map((v) => [v.cause, v.reason]), [['rejected', 'wrong weapon']]);
  });

  it('a v2 choke freezes the public snapshot until the flush', (t) => {
    const { room, a, b } = duel();
    t.after(() => room.close());
    const seqs = new Map<number, number>();
    let now = performance.now();
    for (let i = 0; i < 3; i++) idleTick(room, [b], seqs, (now += TICK_MS));
    const view = () => room.snapshot(now, a.pid).p.find((s) => s[0] === b.pid)!;
    const before = view();
    let seq = seqs.get(b.pid)!;
    for (let i = 0; i < 10; i++) {
      room.handleInput(b, { ...command(++seq, { choke: true }), forward: 1, yaw: 0.5 });
      stepRoom(room, (now += TICK_MS));
      assert.equal(room.tickbaseOf(b.pid)?.choked, i + 1);
      assert.deepEqual(view(), before, `choke tick ${i + 1}: public state frozen`);
    }
    room.handleInput(b, { ...command(++seq, {}), forward: 1, yaw: 0.5 });
    stepRoom(room, (now += TICK_MS));
    const after = unpackPlayer(view());
    assert.notDeepEqual([after.x, after.z], [unpackPlayer(before).x, unpackPlayer(before).z], 'the flush publishes the new position');
    assert.ok(Math.abs(after.yaw - 0.5) < 1e-3, 'public yaw is the observed eye yaw');
  });

  it('a hit on a spawn-protected target is rejected and deals no damage', (t) => {
    const { room, a, b, verdicts } = duel();
    t.after(() => room.close());
    place(b, 20, 17);
    const seqs = new Map<number, number>();
    let now = performance.now();
    for (let i = 0; i < 3; i++) idleTick(room, [a, b], seqs, (now += TICK_MS));
    b.shieldUntil = now + 60_000;
    const aim = anglesTo(room.eyeOf(a), boxCentre(room, b.pid, 'chest'));
    room.handleInput(a, { ...command(seqs.get(a.pid)! + 1, { fire: true }), yaw: aim.yaw, pitch: aim.pitch });
    stepRoom(room, (now += TICK_MS));
    const shot = verdicts.find((v) => v.shooterId === String(a.pid) && v.bullet === 1);
    assert.deepEqual([shot?.cause, shot?.reason, shot?.targetId], ['rejected', 'spawn protection', String(b.pid)]);
    assert.equal(b.hp, 100);
  });

  it('v2 targets wear armor: a Desert Eagle chest hit takes its armor penetration', (t) => {
    const { room, a, b, verdicts } = duel();
    t.after(() => room.close());
    place(b, 20, 17);
    a.info.loadout.push('deserteagle');
    a.weaponSlot = a.info.loadout.length - 1;
    a.mags.set('deserteagle', a.magazineSize('deserteagle'));
    const seqs = new Map<number, number>();
    let now = performance.now();
    for (let i = 0; i < 3; i++) idleTick(room, [a, b], seqs, (now += TICK_MS));
    const eye = room.eyeOf(a);
    const aim = anglesTo(eye, boxCentre(room, b.pid, 'chest'));
    const r = recordOf(room, b.pid);
    const distance = rayHvhMatrix(makeRay(eye, aim.dir), poseMatrix(r, r.pose), 100)!.t;
    room.handleInput(a, { ...command(seqs.get(a.pid)! + 1, { fire: true }), yaw: aim.yaw, pitch: aim.pitch });
    stepRoom(room, (now += TICK_MS));
    const shot = verdicts.find((v) => v.shooterId === String(a.pid) && v.bullet === 1);
    assert.deepEqual([shot?.cause, shot?.hitgroup], ['hit', 'chest']);
    // Desert Eagle: 53 damage, range modifier 0.85 per 12.5 m, chest x1, armor penetration 0.932.
    // Spread only moves the hit point by millimetres, so the falloff barely changes.
    const unarmored = 53 * 0.85 ** (distance / 12.5);
    assert.ok(Math.abs(shot!.damage! - unarmored * 0.932) < 0.01, `${shot!.damage} vs ${unarmored * 0.932}`);
  });

  it('calling processPlayerTick twice in one tick pushes one record and does not throw', (t) => {
    const { room, a } = duel();
    t.after(() => room.close());
    room.handleInput(a, command(1, {}));
    room.handleInput(a, command(2, {}));
    room.processPlayerTick(String(a.pid));
    room.processPlayerTick(String(a.pid));
    assert.equal(room.v2State(a.pid)!.history.records().length, 1);
    stepRoom(room, performance.now() + TICK_MS);
  });

  it('burst is capped at maxProcessTicks', (t) => {
    const { room, a } = duel();
    t.after(() => room.close());
    a.takeInputToken = () => true;
    for (let seq = 1; seq <= 30; seq++) room.handleInput(a, command(seq, {}));
    stepRoom(room, performance.now() + TICK_MS);
    assert.equal(LATE_CSGO.maxProcessTicks, 16);
    assert.equal(a.lastSeq, 16, 'exactly 16 commands executed this tick');
    assert.equal(room.queuedCommands(a.pid), 14, '14 remain queued');
  });

  it('flood drops oldest with verdict', (t) => {
    const { room, a, verdicts } = duel();
    t.after(() => room.close());
    a.takeInputToken = () => true;
    for (let seq = 1; seq <= 40; seq++) room.handleInput(a, command(seq, {}));
    const flood = verdicts.filter((v) => v.cause === 'rejected' && v.reason === 'command flood');
    assert.equal(flood.length, 8);
    assert.equal(verdicts.length, 8);
    assert.ok(flood.every((v) => v.shooterId === String(a.pid)));
    assert.equal(room.queuedCommands(a.pid), 32);
    stepRoom(room, performance.now() + TICK_MS);
    assert.equal(a.lastSeq, 8 + 16, 'the 8 oldest were dropped, so execution starts at seq 9');
  });

  it('R41: charging never blocks fire (the fire interval counts server ticks, not tickbase)', (t) => {
    const { room, a, b, verdicts } = hiddenDuel();
    t.after(() => room.close());
    assert.equal(room.tickbaseOf(a.pid)?.charge, 0, 'a fresh spawn has no charge');
    // A gun that cycles within one DT shift (v2 spawns carry the slower arsenal).
    a.info.loadout.push('rifle');
    a.weaponSlot = a.info.loadout.length - 1;
    a.mags.set('rifle', a.magazineSize('rifle'));
    const interval = fireIntervalTicks(WEAPONS[a.weapon]);
    assert.ok(interval > 1 && interval - 1 < LATE_CSGO.chargeTicks);
    let now = performance.now();
    let seq = 0;
    let bSeq = 0;
    // b idles every tick (one lag record per tick).
    const step = (): void => {
      room.handleInput(b, command(++bSeq, {}));
      stepRoom(room, (now += TICK_MS));
    };
    // Plain shots (DT off), through the wall.
    const fire = (): void => {
      const aim = anglesTo(room.eyeOf(a), boxCentre(room, b.pid, 'chest'));
      room.handleInput(a, { ...command(++seq, { fire: true }), yaw: aim.yaw, pitch: aim.pitch });
      step();
    };
    step();
    fire();
    const firstTick = room.hvhTick;
    const tickbase = room.tickbaseOf(a.pid)!.tickbase;
    // DT on for interval - 1 ticks with no enemy in view: every one is a charge tick (tickbase frozen).
    for (let i = 0; i < interval - 1; i++) {
      room.handleInput(a, command(++seq, { doubleTap: true }));
      step();
    }
    assert.equal(room.tickbaseOf(a.pid)?.charge, interval - 1, 'the idle ticks charged');
    assert.equal(room.tickbaseOf(a.pid)?.tickbase, tickbase, 'charge ticks did not advance tickbase');
    fire();
    assert.equal(room.hvhTick, firstTick + interval, 'the first tick the weapon interval allows');
    const shots = verdicts.filter((v) => v.shooterId === String(a.pid));
    assert.equal(shots.length, 2);
    assert.ok(shots.every((v) => v.cause !== 'rejected'), `both shots fired (${shots.map((v) => `${v.cause}${v.reason ? `:${v.reason}` : ''}`).join(', ')})`);
  });

  it('dt fires two bullets same tick', (t) => {
    const { room, a, verdicts } = hiddenDuel();
    t.after(() => room.close());
    let now = performance.now();
    let seq = 0;
    for (let i = 0; i < LATE_CSGO.chargeTicks; i++) {
      room.handleInput(a, command(++seq, { doubleTap: true }));
      stepRoom(room, (now += TICK_MS));
    }
    assert.equal(room.tickbaseOf(a.pid)?.charge, LATE_CSGO.chargeTicks, 'full charge');
    room.handleInput(a, command(++seq, { fire: true, doubleTap: true }));
    stepRoom(room, (now += TICK_MS));
    const shots = verdicts.filter((v) => v.shooterId === String(a.pid) && v.cause !== 'tickbase');
    assert.deepEqual(shots.map((v) => v.bullet), [1, 2]);
    assert.equal(shots[0]!.tick, shots[1]!.tick, 'same server tick');
    assert.equal(shots[0]!.tick, room.hvhTick);
    assert.equal(room.tickbaseOf(a.pid)?.charge, 0);
  });

  it('death cancels pending dt bullet', (t) => {
    const { room, a, b, verdicts } = hiddenDuel();
    t.after(() => room.close());
    let now = performance.now();
    let seq = 0;
    for (let i = 0; i < LATE_CSGO.chargeTicks; i++) {
      room.handleInput(a, command(++seq, { doubleTap: true }));
      stepRoom(room, (now += TICK_MS));
    }
    room.handleInput(a, command(++seq, { fire: true, doubleTap: true }));
    now += TICK_MS;
    room.processPlayerTick(String(a.pid), now);
    assert.deepEqual(verdicts.filter((v) => v.shooterId === String(a.pid)).map((v) => v.bullet), [1]);
    // B kills A in the same server tick, before bullet 2 is processed.
    assert.notEqual(room.v2State(a.pid)?.pendingBullet, null, 'bullet 2 is pending before the death');
    room.damage(a, b, 1000, true, b.weapon, room.eyeOf(b), now);
    assert.equal(a.alive, false);
    assert.equal(room.v2State(a.pid)?.pendingBullet, null, 'death cancels bullet 2');
    room.flushPendingBullets(now);
    assert.equal(verdicts.filter((v) => v.shooterId === String(a.pid) && v.bullet === 2).length, 0, 'no bullet-2 verdict');
    room.respawnPlayer(a, now);
    assert.equal(a.alive, true);
    assert.equal(room.tickbaseOf(a.pid)?.charge, 0);
    // A death with a partial charge, then a respawn: the new life starts empty.
    place(a, 20, 20);
    for (let i = 0; i < 5; i++) {
      room.handleInput(a, command(++seq, { doubleTap: true }));
      stepRoom(room, (now += TICK_MS));
    }
    assert.ok(room.tickbaseOf(a.pid)!.charge > 0);
    a.shieldUntil = 0;
    room.damage(a, b, 1000, true, b.weapon, room.eyeOf(b), now);
    assert.equal(a.alive, false);
    room.respawnPlayer(a, now);
    assert.equal(room.tickbaseOf(a.pid)?.charge, 0);
  });

  it('a tickbase reject becomes a verdict and the command still runs', (t) => {
    const { room, a, verdicts } = hiddenDuel();
    t.after(() => room.close());
    const d = driver(room, a);
    for (let i = 0; i < 5; i++) d.tick({ doubleTap: true });
    assert.equal(room.tickbaseOf(a.pid)?.charge, 5, 'a partial charge');
    const z = a.state.z;
    d.tick({ fire: true, doubleTap: true }, { forward: 1 });
    const tb = verdicts.filter((v) => v.cause === 'tickbase');
    assert.equal(tb.length, 1);
    assert.equal(tb[0]!.reason, 'double tap not charged');
    assert.equal(a.lastSeq, d.seq);
    assert.ok(a.state.z < z, 'the rejected command still moved the player');
    assert.equal(room.tickbaseOf(a.pid)?.charge, 0, 'the partial charge is lost');
    assert.deepEqual(verdicts.filter((v) => v.cause !== 'tickbase').map((v) => v.bullet), [1], 'and it fired a plain shot');
  });

  it('hvhState reports the own tickbase (charge and armed), era and acknowledged command', (t) => {
    const { room, a } = hiddenDuel();
    t.after(() => room.close());
    const sent: { event: string; data: unknown }[] = [];
    Object.defineProperty(a, 'socket', { value: { emit(event: string, data: unknown) { sent.push({ event, data }); }, to() { return { emit() {} }; }, leave() {}, volatile: { emit() {} } } });
    room.handleInput(a, command(1, { doubleTap: true }));
    stepRoom(room, performance.now() + TICK_MS);
    const state = sent.filter((s) => s.event === 'hvhState').at(-1)?.data as { tickbase: { charge: number; armed: boolean }; era: string; lastAckSeq: number };
    assert.ok(state, 'hvhState sent to the owner');
    assert.equal(state.era, LATE_CSGO.id);
    assert.equal(state.lastAckSeq, 1, 'a charge command is acknowledged');
    assert.equal(state.tickbase.charge, 1);
    assert.equal(state.tickbase.armed, true);
    assert.ok(!('ticksSinceShift' in state.tickbase), 'no recharge counter is sent');
  });

  it('hvhState reports how many of the owner commands are still queued (for client clock correction)', (t) => {
    const { room, a } = duel();
    t.after(() => room.close());
    const sent: { event: string; data: unknown }[] = [];
    Object.defineProperty(a, 'socket', { value: { emit(event: string, data: unknown) { sent.push({ event, data }); }, to() { return { emit() {} }; }, leave() {}, volatile: { emit() {} } } });
    a.takeInputToken = () => true; // the legacy input limiter is not under test
    const now = performance.now();
    // Spend the burst budget, then five commands arrive in one tick: one runs, four wait.
    for (let seq = 1; seq <= 16; seq++) room.handleInput(a, command(seq, {}));
    stepRoom(room, now + TICK_MS);
    for (let seq = 17; seq <= 21; seq++) room.handleInput(a, command(seq, {}));
    stepRoom(room, now + 2 * TICK_MS);
    const state = sent.filter((s) => s.event === 'hvhState').at(-1)?.data as { queued: number; lastAckSeq: number };
    assert.equal(state.lastAckSeq, 17);
    assert.equal(state.queued, 4);
  });

  it('legacy flag untouched', (t) => {
    // Same scripted inputs through a plain GameRoom and an HvhRoom on the legacy engine.
    const run = (legacyRoom: GameRoom) => {
      t.after(() => legacyRoom.close());
      const a = addPlayer(legacyRoom, 'A');
      const b = addPlayer(legacyRoom, 'B');
      a.info.team = 1;
      b.info.team = 2;
      legacyRoom.startNow();
      place(a, 20, 20);
      place(b, 20, 10);
      a.takeInputToken = () => true;
      const now = 1_000_000;
      for (let seq = 1; seq <= 20; seq++) {
        legacyRoom.handleInput(a, { ...command(seq, { fire: true, doubleTap: true }), forward: 1, right: seq % 2 });
        stepRoom(legacyRoom, now + seq * TICK_MS);
      }
      return { snapshot: legacyRoom.snapshot(now + 21 * TICK_MS, a.pid).p, lastSeq: a.lastSeq, queued: a.commands.size, intent: 'intent' in (a.lastInput ?? {}) };
    };
    const { io } = fakeIo();
    const plain = run(new GameRoom(io, { id: 'plain', code: 'PLN01', name: 'plain', mode: 'hvh', map: 'flat', private: true }, {}));
    const { room, events, verdicts } = makeHvh('legacy');
    const legacy = run(room);
    assert.deepEqual(legacy, plain);
    assert.equal(legacy.intent, false);
    assert.equal(verdicts.length, 0);
    assert.ok(!events.some((e) => e.event === 'shotVerdict' || e.event === 'hvhState'));
  });

  it('no hvh outside hvh', (t) => {
    const { io, events } = fakeIo();
    const room = createRoom(io, { id: 'ffa', code: 'FFA01', name: 'ffa', mode: 'ffa', map: 'flat', private: true, hvhEngine: 'v2' }, {});
    t.after(() => room.close());
    assert.ok(!(room instanceof HvhRoom));
    const p = addPlayer(room, 'P');
    room.startNow();
    place(p, 20, 20);
    p.takeInputToken = () => true;
    const now = performance.now();
    for (let seq = 1; seq <= 20; seq++) {
      room.handleInput(p, { ...command(seq, { fire: true, doubleTap: true, choke: true }), forward: 1 });
      stepRoom(room, now + seq * TICK_MS);
    }
    assert.equal(p.lastSeq, 20, 'one command per tick, as always');
    assert.equal('intent' in (p.lastInput ?? {}), false);
    assert.equal(p.lastShotSeq, 0, 'intent.fire never fires outside HvH');
    assert.ok(!events.some((e) => e.event === 'shotVerdict' || e.event === 'hvhState'));
  });

  it('HVH_ENGINE picks the engine and only the HvH mode gets an HvhRoom', (t) => {
    assert.equal(hvhEngineFrom({ HVH_ENGINE: 'v2' }), 'v2');
    assert.equal(hvhEngineFrom({ HVH_ENGINE: 'V2' }), 'legacy');
    assert.equal(hvhEngineFrom({}), 'legacy');
    assert.equal(hvhEngineFrom({ HVH_ENGINE: 'legacy' }), 'legacy');
    const { io } = fakeIo();
    const v2 = createRoom(io, { id: 'a', code: 'AAA01', name: 'a', mode: 'hvh', map: 'flat', private: true, hvhEngine: 'v2' }, {});
    const legacy = createRoom(io, { id: 'b', code: 'BBB01', name: 'b', mode: 'hvh', map: 'flat', private: true }, {});
    t.after(() => { v2.close(); legacy.close(); });
    assert.ok(v2 instanceof HvhRoom && v2.hvhEngine === 'v2');
    assert.ok(legacy instanceof HvhRoom && legacy.hvhEngine === 'legacy');
    assert.equal(v2.mode.wallhack, true);
    assert.equal(v2.mode.wallbang, true);
    assert.equal(v2.mode.teamKills, true);
  });
});

describe('charge and burst', () => {
  const N = LATE_CSGO.chargeTicks;

  it('with DT on and no enemy visible, the commands stop the player dead and fill the charge', (t) => {
    const { room, a } = hiddenDuel();
    t.after(() => room.close());
    const d = driver(room, a);
    const at = { x: a.state.x, y: a.state.y, z: a.state.z };
    for (let i = 1; i <= N; i++) {
      d.tick({ doubleTap: true }, { forward: 1, right: 1 });
      assert.deepEqual({ x: a.state.x, y: a.state.y, z: a.state.z }, at, `charge tick ${i}: no movement`);
      // Acknowledged like any command, so the client's CommandClock sees no backlog.
      assert.equal(a.lastSeq, d.seq, `charge tick ${i} is acknowledged`);
      assert.equal(room.queuedCommands(a.pid), 0);
    }
    assert.equal(room.tickbaseOf(a.pid)?.charge, N, 'full charge');
    assert.equal(a.state.horizontalSpeed, 0);
  });

  it('a charge mid-air freezes the height (no gravity) and resumes the fall afterwards', (t) => {
    const { room, a } = hiddenDuel();
    t.after(() => room.close());
    place(a, 20, 20, 2);
    a.state.vy = -3;
    const d = driver(room, a);
    for (let i = 1; i <= N; i++) {
      d.tick({ doubleTap: true }, { forward: 1 });
      assert.equal(a.state.y, 2, `charge tick ${i}: y unchanged`);
      assert.equal(a.state.vy, 0, 'vertical velocity is zeroed');
    }
    assert.equal(room.tickbaseOf(a.pid)?.charge, N);
    d.tick({ doubleTap: true }, { forward: 1 });
    assert.ok(a.state.y < 2, 'a charged player falls again');
  });

  it('a DT shot spends the charge: two bullets from the pre-burst eye, then 1 + chargeTicks steps of movement', (t) => {
    const { room, a, verdicts } = hiddenDuel();
    t.after(() => room.close());
    holdDeagle(a);
    const d = driver(room, a);
    for (let i = 0; i < N; i++) d.tick({ doubleTap: true }, { forward: 1 });
    const frame = d.frame({ forward: 1 });
    const own = walked(room, a, frame, 1);
    const expected = walked(room, a, frame, 1 + N);
    const z = a.state.z;
    room.handleInput(a, { ...command(d.seq + 1, { fire: true, doubleTap: true }), forward: 1 });
    room.processPlayerTick(String(a.pid), d.now + TICK_MS);
    // Bullet 2 waits for the end of the tick; it left from the eye after the command's own step.
    const origin = room.v2State(a.pid)!.pendingBullet?.aim.origin;
    assert.deepEqual([origin?.x, origin?.z], [own.x, own.z], 'the bullets leave from the pre-burst eye');
    room.flushPendingBullets(d.now + TICK_MS);
    const shots = verdicts.filter((v) => v.shooterId === String(a.pid));
    assert.deepEqual(shots.map((v) => v.bullet), [1, 2], 'two bullet verdicts');
    assert.ok(shots.every((v) => v.cause !== 'rejected' && v.cause !== 'tickbase'), shots.map((v) => `${v.cause}:${v.reason ?? ''}`).join(', '));
    assert.deepEqual([a.state.x, a.state.y, a.state.z], [expected.x, expected.y, expected.z], 'the burst is 1 + chargeTicks normal movement steps');
    assert.ok(z - a.state.z > 1.5, `about ${N} ticks of walking (moved ${z - a.state.z} m)`);
    assert.equal(room.tickbaseOf(a.pid)?.charge, 0);
  });

  it('after the burst every command moves one normal step again (no speed-up)', (t) => {
    const { room, a } = hiddenDuel();
    t.after(() => room.close());
    const d = driver(room, a);
    for (let i = 0; i < N; i++) d.tick({ doubleTap: true }, { forward: 1 });
    d.tick({ fire: true, doubleTap: true }, { forward: 1 });
    // DT off: with it on and no enemy in view, these would charge again.
    for (let i = 0; i < 5; i++) {
      const next = walked(room, a, d.frame({ forward: 1 }), 1);
      d.tick({}, { forward: 1 });
      assert.deepEqual([a.state.x, a.state.z], [next.x, next.z], `command ${i + 1} after the burst: one step`);
    }
  });

  it('bursting into a wall stops at the wall (the normal collision)', (t) => {
    const { room, a } = hiddenDuel();
    t.after(() => room.close());
    place(a, 20, WALL.maxZ + 1);
    const d = driver(room, a);
    for (let i = 0; i < N; i++) d.tick({ doubleTap: true }, { forward: 1, right: 0.5 });
    const expected = walked(room, a, d.frame({ forward: 1, right: 0.5 }), 1 + N);
    const x = a.state.x;
    d.tick({ fire: true, doubleTap: true }, { forward: 1, right: 0.5 });
    assert.deepEqual([a.state.x, a.state.z], [expected.x, expected.z]);
    assert.ok(a.state.z >= WALL.maxZ + PLAYER.radius - 1e-6, `stopped at the wall (z ${a.state.z})`);
    assert.ok(a.state.x > x + 0.5, 'and slid along it');
  });

  it('a burst standing still gives no displacement', (t) => {
    const { room, a, verdicts } = hiddenDuel();
    t.after(() => room.close());
    holdDeagle(a);
    const d = driver(room, a);
    for (let i = 0; i < N; i++) d.tick({ doubleTap: true });
    const at = [a.state.x, a.state.y, a.state.z];
    d.tick({ fire: true, doubleTap: true });
    assert.deepEqual(verdicts.filter((v) => v.shooterId === String(a.pid)).map((v) => v.bullet), [1, 2]);
    assert.deepEqual([a.state.x, a.state.y, a.state.z], at);
    assert.equal(room.tickbaseOf(a.pid)?.charge, 0);
  });

  it('toggling DT off while charged releases the burst without a shot', (t) => {
    const { room, a, verdicts } = hiddenDuel();
    t.after(() => room.close());
    const d = driver(room, a);
    for (let i = 0; i < N; i++) d.tick({ doubleTap: true }, { forward: 1 });
    const expected = walked(room, a, d.frame({ forward: 1 }), 1 + N);
    const mag = a.mag;
    d.tick({}, { forward: 1 });
    assert.deepEqual([a.state.x, a.state.y, a.state.z], [expected.x, expected.y, expected.z]);
    assert.equal(verdicts.length, 0, 'no shot');
    assert.equal(a.mag, mag);
    assert.equal(room.tickbaseOf(a.pid)?.charge, 0);
  });

  it('an enemy coming into view mid-charge cancels it, and that command moves', (t) => {
    const { room, a, b } = hiddenDuel();
    t.after(() => room.close());
    const d = driver(room, a);
    for (let i = 0; i < 10; i++) d.tick({ doubleTap: true }, { forward: 1 });
    assert.equal(room.tickbaseOf(a.pid)?.charge, 10);
    place(b, 25, 20);
    const expected = walked(room, a, d.frame({ forward: 1 }), 1);
    d.tick({ doubleTap: true }, { forward: 1 });
    assert.equal(room.tickbaseOf(a.pid)?.charge, 0, 'the partial charge is lost');
    assert.deepEqual([a.state.x, a.state.z], [expected.x, expected.z], 'the command ran one normal step');
    // In view, nothing charges: every command moves.
    for (let i = 0; i < 5; i++) {
      const z = a.state.z;
      d.tick({ doubleTap: true }, { forward: 1 });
      assert.ok(a.state.z < z);
      assert.equal(room.tickbaseOf(a.pid)?.charge, 0);
    }
  });

  it('with DT on and an enemy in view, commands move and never charge', (t) => {
    const { room, a } = duel();
    t.after(() => room.close());
    a.takeInputToken = () => true;
    const d = driver(room, a);
    for (let i = 0; i < 10; i++) {
      const z = a.state.z;
      d.tick({ doubleTap: true }, { forward: 1 });
      assert.ok(a.state.z < z, `command ${i + 1} moved the player`);
    }
    assert.equal(room.tickbaseOf(a.pid)?.charge, 0);
  });

  it('a teammate in view does not stop the charge', (t) => {
    const { room, a } = hiddenDuel();
    t.after(() => room.close());
    const c = addPlayer(room, 'C');
    c.info.team = 1;
    room.respawnPlayer(c, performance.now());
    place(c, 25, 20);
    const d = driver(room, a);
    for (let i = 0; i < N; i++) d.tick({ doubleTap: true });
    assert.equal(room.tickbaseOf(a.pid)?.charge, N);
  });

  it('death mid-charge, then a respawn, starts at charge 0', (t) => {
    const { room, a, b } = hiddenDuel();
    t.after(() => room.close());
    const d = driver(room, a);
    for (let i = 0; i < 10; i++) d.tick({ doubleTap: true });
    assert.equal(room.tickbaseOf(a.pid)?.charge, 10);
    room.damage(a, b, 1000, true, b.weapon, room.eyeOf(b), d.now);
    assert.equal(a.alive, false);
    assert.equal(room.tickbaseOf(a.pid)?.charge, 0, 'death drops the charge');
    room.respawnPlayer(a, d.now);
    assert.equal(a.alive, true);
    assert.equal(room.tickbaseOf(a.pid)?.charge, 0, 'the new life starts empty');
  });

  it('a dead player never bursts: a fire queued with a full charge does nothing', (t) => {
    const { room, a, b, verdicts } = hiddenDuel();
    t.after(() => room.close());
    const d = driver(room, a);
    for (let i = 0; i < N; i++) d.tick({ doubleTap: true }, { forward: 1 });
    assert.equal(room.tickbaseOf(a.pid)?.charge, N);
    const at = [a.state.x, a.state.y, a.state.z];
    room.handleFire(a, { shot: 1, weapon: a.weapon, dx: 0, dy: 0, dz: -1, t: d.now, aiming: false, command: d.seq + 1 });
    d.tick({ fire: true, doubleTap: true }, { forward: 1 }, () => {
      room.damage(a, b, 1000, true, b.weapon, room.eyeOf(b), d.now);
    });
    assert.equal(a.alive, false);
    assert.deepEqual([a.state.x, a.state.y, a.state.z], at, 'no burst');
    assert.deepEqual(verdicts.filter((v) => v.shooterId === String(a.pid)).map((v) => [v.cause, v.reason]), [['rejected', 'actions blocked']],
      'only the pending fire is answered, and nothing fired');
    assert.equal(room.tickbaseOf(a.pid)?.charge, 0);
  });

  it('a moving burst breaks lag compensation: the pre-burst records are lagcompBreak for later enemy shots', (t) => {
    const { room, a, b, verdicts } = hiddenDuel();
    t.after(() => room.close());
    const d = driver(room, a);
    let bSeq = 0;
    const bIdle = () => room.handleInput(b, command(++bSeq, {}));
    for (let i = 0; i < N; i++) d.tick({ doubleTap: true }, { forward: 1 }, bIdle);
    const before = recordOf(room, a.pid);
    d.tick({}, { forward: 1 }, bIdle); // the release burst
    const after = recordOf(room, a.pid);
    assert.ok(Math.hypot(after.position.x - before.position.x, after.position.z - before.position.z) > LATE_CSGO.lagCompBreakHulls * 2 * PLAYER.radius);
    const history = room.v2State(a.pid)!.history.records();
    assert.ok(history.slice(0, -1).every((r) => !r.valid && r.invalidCause === 'lagcompBreak'), 'every pre-burst record is invalid');
    assert.equal(history.at(-1)!.valid, true, 'the post-burst record is valid');
    // B shoots at where A stood, on the pre-burst tick.
    const chest = poseMatrix(before, before.pose).boxes.find((x) => x.group === 'chest')!.center;
    const aim = anglesTo(room.eyeOf(b), chest);
    d.tick({}, {}, () => room.handleInput(b, { ...command(++bSeq, { fire: true }), yaw: aim.yaw, pitch: aim.pitch, clientTick: before.tick }));
    const shot = verdicts.find((v) => v.shooterId === String(b.pid));
    assert.deepEqual([shot?.targetId, shot?.cause, shot?.invalidCause], [String(a.pid), 'invalidRecord', 'lagcompBreak']);
  });

  it('a missing command mid-charge does not coast: a charging player in the air keeps y and vy (R55)', (t) => {
    const { room, a } = hiddenDuel();
    t.after(() => room.close());
    place(a, 20, 20, 2);
    a.state.vy = -3;
    const d = driver(room, a);
    for (let i = 0; i < N / 2; i++) d.tick({ doubleTap: true }, { forward: 1 });
    assert.equal(room.tickbaseOf(a.pid)?.charge, N / 2, 'precondition: a partial charge');
    for (let i = 0; i < 3; i++) stepRoom(room, d.now + (i + 1) * TICK_MS);
    assert.equal(a.lastSeq, d.seq, 'no command ran');
    assert.deepEqual([a.state.x, a.state.y, a.state.z, a.state.vy], [20, 2, 20, 0], 'held: no gravity, no drift');
  });

  it('a missing command with a full charge or the exploits off coasts as before', (t) => {
    const { room, a } = hiddenDuel();
    t.after(() => room.close());
    place(a, 20, 20, 2);
    const d = driver(room, a);
    for (let i = 0; i < N; i++) d.tick({ doubleTap: true }, { forward: 1 });
    assert.equal(room.tickbaseOf(a.pid)?.charge, N);
    stepRoom(room, d.now + TICK_MS);
    assert.ok(a.state.y < 2, 'a charged player falls on a missing command');
  });

  it('an airborne burst is exactly 1 + chargeTicks normal movement steps', (t) => {
    const { room, a } = hiddenDuel();
    t.after(() => room.close());
    const d = driver(room, a);
    d.tick({}, { forward: 1, jump: true });
    assert.ok(!a.state.onGround && a.state.y > 0, 'precondition: airborne after the jump');
    for (let i = 0; i < N; i++) d.tick({ doubleTap: true }, { forward: 1 });
    assert.equal(room.tickbaseOf(a.pid)?.charge, N);
    assert.ok(!a.state.onGround, 'precondition: the charge held A in the air');
    const y = a.state.y;
    const expected = walked(room, a, d.frame({ forward: 1 }), 1 + N);
    d.tick({ fire: true, doubleTap: true }, { forward: 1 });
    assert.deepEqual([a.state.x, a.state.y, a.state.z], [expected.x, expected.y, expected.z]);
    assert.ok(a.state.y < y, 'gravity runs during the burst steps');
  });

  it('a burst off a ledge is exactly 1 + chargeTicks normal movement steps, and falls', (t) => {
    const { room, a } = hiddenDuel();
    t.after(() => room.close());
    // A 1 m platform A stands on; its edge is 1.5 m ahead, inside the burst (about 3 m).
    room.world.add(WALL_ID + 1, { minX: 15, maxX: 25, minY: 0, maxY: 1, minZ: 18.5, maxZ: 22 });
    place(a, 20, 20, 1);
    a.state.onGround = true;
    const d = driver(room, a);
    for (let i = 0; i < N; i++) d.tick({ doubleTap: true }, { forward: 1 });
    assert.equal(room.tickbaseOf(a.pid)?.charge, N);
    assert.equal(a.state.y, 1, 'precondition: standing on the platform');
    const expected = walked(room, a, d.frame({ forward: 1 }), 1 + N);
    d.tick({ fire: true, doubleTap: true }, { forward: 1 });
    assert.deepEqual([a.state.x, a.state.y, a.state.z], [expected.x, expected.y, expected.z]);
    assert.ok(a.state.z < 18.5 - PLAYER.radius && a.state.y < 1, `the burst left the platform and fell (y ${a.state.y}, z ${a.state.z})`);
  });

  describe('lag-compensated sight (R56)', () => {
    const VISIBLE = { x: 25, z: 20 };
    const HIDDEN_AT = { x: 20, z: 10 };
    const sight = (t: number) => ({ sightT: t }) as Partial<InputFrame>;
    function charging() {
      const made = hiddenDuel();
      const d = driver(made.room, made.a);
      for (let i = 0; i < 5; i++) d.tick({ doubleTap: true });
      assert.equal(made.room.tickbaseOf(made.a.pid)?.charge, 5, 'precondition: a partial charge');
      return { ...made, d };
    }

    it('an enemy only in the latest server state, not yet in the sent snapshot, does not cancel the charge', (t) => {
      const { room, a, b, d } = charging();
      t.after(() => room.close());
      const snap = room.snapshotFor(a, d.now);
      place(b, VISIBLE.x, VISIBLE.z);
      d.tick({ doubleTap: true }, sight(snap.t));
      assert.equal(room.tickbaseOf(a.pid)?.charge, 6, 'traced against the sent snapshot: still hidden');
      d.tick({ doubleTap: true });
      assert.equal(room.tickbaseOf(a.pid)?.charge, 0, 'control: start-of-tick sight sees B and cancels');
    });

    it('an enemy in the sent snapshot cancels the charge, wherever it stands now', (t) => {
      const { room, a, b, d } = charging();
      t.after(() => room.close());
      place(b, VISIBLE.x, VISIBLE.z);
      const snap = room.snapshotFor(a, d.now);
      place(b, HIDDEN_AT.x, HIDDEN_AT.z);
      d.tick({ doubleTap: true }, sight(snap.t));
      assert.equal(room.tickbaseOf(a.pid)?.charge, 0);
    });

    it('a claimed snapshot older than the unlag window falls back to start-of-tick sight', (t) => {
      const { room, a, b, d } = charging();
      t.after(() => room.close());
      place(b, VISIBLE.x, VISIBLE.z);
      const old = room.snapshotFor(a, d.now - MAX_REWIND_MS - 50);
      place(b, HIDDEN_AT.x, HIDDEN_AT.z);
      d.tick({ doubleTap: true }, sight(old.t));
      assert.equal(room.tickbaseOf(a.pid)?.charge, 6, 'the stale snapshot (B visible) is not used');
    });

    it('a claim older than every kept snapshot falls back too', (t) => {
      const { room, a, b, d } = charging();
      t.after(() => room.close());
      room.snapshotFor(a, d.now);
      place(b, VISIBLE.x, VISIBLE.z);
      d.tick({ doubleTap: true }, sight(-1));
      assert.equal(room.tickbaseOf(a.pid)?.charge, 0, 'start-of-tick sight sees B');
    });

    it('a forged future snapshot is clamped to the last one sent', (t) => {
      const { room, a, b, d } = charging();
      t.after(() => room.close());
      const snap = room.snapshotFor(a, d.now);
      place(b, VISIBLE.x, VISIBLE.z);
      d.tick({ doubleTap: true }, sight(snap.t + 1e6));
      assert.equal(room.tickbaseOf(a.pid)?.charge, 6, 'the last sent snapshot (B hidden), not start-of-tick sight');
    });

    it('keeps a fixed number of sent snapshots per viewer', (t) => {
      const { room, a, d } = charging();
      t.after(() => room.close());
      for (let i = 0; i < 100; i++) room.snapshotFor(a, d.now + i);
      assert.equal(room.v2State(a.pid)!.sentSight.length, Math.ceil((MAX_REWIND_MS * SNAPSHOT_RATE) / 1000) + 1);
    });
  });

  it('hide shots: the burst skips the on-shot record', (t) => {
    const { room, a, verdicts } = hiddenDuel();
    t.after(() => room.close());
    const d = driver(room, a);
    for (let i = 0; i < N; i++) d.tick({ hideShots: true }, { forward: 1 });
    const last = recordOf(room, a.pid).tick;
    const expected = walked(room, a, d.frame({ forward: 1 }), 1 + N);
    d.tick({ fire: true, hideShots: true }, { forward: 1 });
    assert.equal(verdicts.filter((v) => v.shooterId === String(a.pid) && v.bullet === 1 && v.cause !== 'rejected').length, 1, 'the shot fired');
    assert.equal(verdicts.filter((v) => v.bullet === 2).length, 0, 'hide shots fires one bullet');
    assert.equal(recordOf(room, a.pid).tick, last, 'no record for the burst tick');
    assert.deepEqual([a.state.x, a.state.y, a.state.z], [expected.x, expected.y, expected.z], 'the burst is 1 + chargeTicks normal movement steps');
    assert.equal(room.tickbaseOf(a.pid)?.charge, 0);
  });
});


describe('per-stance anti-aim and defensive patterns', () => {
  /** A's eye yaw offset from its backward base (aim yaw 0), degrees. */
  const offsetOf = (room: HvhRoom, pid: number) => wrapAngle(room.v2State(pid)!.pose.eyeYaw - Math.PI) / (Math.PI / 180);
  const STANCE: StanceAA = { base: 'backward', yawOffsetDeg: 0, jitterDeg: 0, desyncDeg: 30 };
  const near = (actual: number, expected: number, msg: string) => assert.ok(Math.abs(actual - expected) < 1e-9, `${msg}: ${actual}`);

  /** A behind the wall from B, with AA on and the on-peek flick on every stance. */
  function peekDuel() {
    const made = hiddenDuel();
    const { stances, defensive } = uniformAntiAim(STANCE);
    for (const k of Object.keys(defensive) as (keyof typeof defensive)[]) {
      defensive[k] = { enabled: true, inAir: false, onPeek: true, always: false, pitch: 'zero', yaw: 'flick' };
    }
    made.a.hvh.antiAim = { ...made.a.hvh.antiAim, enabled: true };
    made.a.hvh.v2AntiAim = { stances, defensive };
    return { ...made, d: driver(made.room, made.a) };
  }

  it('an enemy appearing gives PEEK_TICKS commands of defensive yaw (the flick on the first FLICK_TICKS), then none', (t) => {
    const { room, a, b, d } = peekDuel();
    t.after(() => room.close());
    for (let i = 0; i < 10; i++) {
      d.tick({});
      assert.equal(offsetOf(room, a.pid), 0, `hidden, command ${i}: the plain stance`);
    }
    place(b, 25, 20);
    for (let i = 0; i < PEEK_TICKS; i++) {
      d.tick({});
      assert.equal(room.v2State(a.pid)!.peek.at(-1), PEEK_TICKS - i, `window command ${i}: peekTicksLeft`);
      near(offsetOf(room, a.pid), i < FLICK_TICKS ? 120 : 0, `window command ${i}: the first window flicks +120`);
    }
    for (let i = 0; i < 12; i++) {
      d.tick({});
      assert.equal(room.v2State(a.pid)!.peek.at(-1), 0);
      assert.equal(offsetOf(room, a.pid), 0, `still visible, command ${i}: no new window`);
    }
    // Hidden again, then seen again: a new window, flicking to the other side.
    place(b, 20, 10);
    d.tick({});
    place(b, 25, 20);
    d.tick({});
    assert.equal(room.v2State(a.pid)!.peek.at(-1), PEEK_TICKS);
    near(offsetOf(room, a.pid), -120, 'the second window flicks -120');
  });

  it('the on-peek watch traces once while nothing moves, and again as soon as the enemy does (M6)', (t) => {
    const { room, a, b, d } = peekDuel();
    t.after(() => room.close());
    d.tick({});
    const memo = room.v2State(a.pid)!.sightMemo;
    const first = memo.traces;
    assert.ok(first >= 1, 'precondition: the watch traces');
    for (let i = 0; i < 30; i++) d.tick({});
    assert.equal(memo.traces, first, 'standing still against a still enemy: the last trace answers');
    assert.equal(room.v2State(a.pid)!.peek.at(-1), 0, 'hidden: no window');
    place(b, 25, 20);
    d.tick({});
    assert.equal(memo.traces, first + 1, 'the enemy moved: traced again');
    assert.equal(room.v2State(a.pid)!.peek.at(-1), PEEK_TICKS, 'and the window opens on that command, as without the memo');
  });

  it('the on-peek flick fires on the first FLICK_TICKS window commands at every tickbase alignment', (t) => {
    for (const align of [0, 2, 4, 6]) {
      const { room, a, b, d } = peekDuel();
      t.after(() => room.close());
      // Idle until the next command's tickbase (before + 1) is `align` mod 8.
      d.tick({});
      while ((room.tickbaseOf(a.pid)!.tickbase + 1) % 8 !== align) d.tick({});
      place(b, 25, 20);
      for (let w = 0; w < 8; w++) {
        d.tick({});
        const tick = room.tickbaseOf(a.pid)!.tickbase;
        if (w === 0) assert.equal(tick % 8, align, 'precondition: the window opens at this alignment');
        // On for the first FLICK_TICKS window commands, off for the rest of the window and after it.
        near(offsetOf(room, a.pid), w < Math.min(FLICK_TICKS, PEEK_TICKS) ? 120 : 0, `align ${align}, window command ${w} (tick ${tick})`);
      }
    }
  });

  it('the window spends no charge and shifts no tickbase', (t) => {
    const { room, a, b, d } = peekDuel();
    t.after(() => room.close());
    for (let i = 0; i < 4; i++) d.tick({});
    const start = room.tickbaseOf(a.pid)!.tickbase;
    place(b, 25, 20);
    for (let i = 0; i < PEEK_TICKS; i++) d.tick({});
    assert.equal(room.tickbaseOf(a.pid)!.tickbase, start + PEEK_TICKS);
    assert.equal(room.tickbaseOf(a.pid)!.charge, 0);
    assert.ok(recordOf(room, a.pid).valid, 'records stay valid (no lag-compensation effect)');
  });

  it('the stance picks its own config; a loadout without one uses the single legacy stance', (t) => {
    const { room, a, d } = peekDuel();
    t.after(() => room.close());
    a.hvh.v2AntiAim!.stances.standing = { ...STANCE, base: 'left' };
    d.tick({});
    assert.ok(Math.abs(wrapAngle(room.v2State(a.pid)!.pose.eyeYaw - Math.PI / 2)) < 1e-9, 'standing: left');
    a.hvh.v2AntiAim = undefined;
    a.hvh.antiAim = { ...a.hvh.antiAim, mode: 'right', jitter: 0 };
    d.tick({});
    assert.ok(Math.abs(wrapAngle(room.v2State(a.pid)!.pose.eyeYaw + Math.PI / 2)) < 1e-9, 'legacy fallback: right');
  });

  it('no on-peek pattern: the peek window stays closed', (t) => {
    const { room, a, b, d } = peekDuel();
    t.after(() => room.close());
    for (const s of Object.values(a.hvh.v2AntiAim!.defensive)) s.onPeek = false;
    d.tick({});
    place(b, 25, 20);
    d.tick({});
    assert.equal(room.v2State(a.pid)!.peek.at(-1), 0);
    assert.equal(offsetOf(room, a.pid), 0);
  });
});
