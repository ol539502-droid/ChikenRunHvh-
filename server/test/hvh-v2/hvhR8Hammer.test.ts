import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SIM_DT, WEAPONS, normalize, type InputFrame, type Vec3 } from '@game/shared';
import { HAMMER_GRACE, hammerTicks, poseMatrix, type CommandIntent, type ShotVerdict } from '@game/shared/hvh/v2';
import type { ServerPlayer } from '../../src/rooms/ServerPlayer';
import { HvhRoom } from '../../src/rooms/HvhRoom';
import { addPlayer, fakeIo, place, stepRoom } from '../helpers';

/*
 * I1 / R69: the server times the R8 hammer. Bullet 1 of an R8 needs hammerTicks commands the server
 * executed with the trigger held (intent.trigger, or the fire itself) before the shot's command,
 * counted per executed command so a seq jump cannot fake the time (rounded up like the fire
 * interval); otherwise it is 'rejected / hammer' and spends nothing. A hammer back for more than
 * HAMMER_GRACE commands with no shot drops and the pull starts over (no pre-cocked hold).
 */

const TICK_MS = SIM_DT * 1000;
const IDLE: CommandIntent = { fire: false, choke: false, doubleTap: false, hideShots: false };

function r8Duel() {
  const { io } = fakeIo();
  const room = new HvhRoom(io, { id: 'hvh-r8', code: 'HVHR8', name: 'R8', mode: 'hvh', map: 'flat', private: true, hvhEngine: 'v2', hvhRounds: false }, {});
  const verdicts: ShotVerdict[] = [];
  room.addVerdictListener((v) => verdicts.push(v));
  const a = addPlayer(room, 'A');
  const b = addPlayer(room, 'B');
  a.info.team = 1;
  b.info.team = 2;
  room.startNow();
  place(a, 20, 20);
  place(b, 20, 17);
  a.shieldUntil = b.shieldUntil = 0;
  a.hvhEnabled = b.hvhEnabled = true;
  a.takeInputToken = b.takeInputToken = () => true;
  hold(a, 'r8');
  let now = performance.now();
  let aSeq = 0;
  let bSeq = 0;
  const tick = (intent: Partial<CommandIntent> | null, over: Partial<InputFrame> = {}): void => {
    if (intent) room.handleInput(a, { seq: ++aSeq, forward: 0, right: 0, jump: false, yaw: 0, pitch: 0, intent: { ...IDLE, ...intent }, ...over });
    room.handleInput(b, { seq: ++bSeq, forward: 0, right: 0, jump: false, yaw: 0, pitch: 0, intent: IDLE });
    stepRoom(room, (now += TICK_MS));
  };
  for (let i = 0; i < 3; i++) tick({});
  const aimAtChest = (): Partial<InputFrame> => {
    const r = room.v2State(b.pid)!.history.records().at(-1)!;
    const chest = poseMatrix(r, r.pose).boxes.find((box) => box.group === 'chest')!.center;
    const eye = room.eyeOf(a);
    const dir = normalize({ x: chest.x - eye.x, y: chest.y - eye.y, z: chest.z - eye.z } as Vec3);
    return { yaw: Math.atan2(-dir.x, -dir.z), pitch: Math.asin(dir.y) };
  };
  const shots = () => verdicts.filter((v) => v.shooterId === String(a.pid) && v.bullet === 1);
  /** A command of A's lost on the way (or skipped by a modified client): its seq is never sent. */
  const lose = (n = 1): void => { aSeq += n; };
  /** Several of A's commands arriving together (a choke batch), then one server tick. */
  const batch = (intents: Partial<CommandIntent>[], over: Partial<InputFrame> = {}): void => {
    for (const intent of intents) room.handleInput(a, { seq: ++aSeq, forward: 0, right: 0, jump: false, yaw: 0, pitch: 0, intent: { ...IDLE, ...intent }, ...over });
    tick(null);
  };
  return { room, a, b, tick, lose, batch, aimAtChest, shots };
}

function hold(p: ServerPlayer, weapon: 'r8' | 'deserteagle'): void {
  if (!p.info.loadout.includes(weapon)) p.info.loadout.push(weapon);
  p.weaponSlot = p.info.loadout.indexOf(weapon);
  p.mags.set(weapon, p.magazineSize(weapon));
  p.switchReadyAt = 0;
}

const HAMMER = hammerTicks(WEAPONS.r8);

describe('R8 hammer on the server (I1)', () => {
  it('the hammer is 400 ms in commands, rounded up like the fire interval', () => {
    assert.equal(HAMMER, Math.ceil((400 * 64) / 1000));
    assert.equal(hammerTicks(WEAPONS.deserteagle), 0);
  });

  it('an R8 fire with no hammer time is rejected as hammer and spends nothing', (t) => {
    const { room, a, tick, aimAtChest, shots } = r8Duel();
    t.after(() => room.close());
    const mag = a.mag;
    tick({ fire: true }, aimAtChest());
    assert.deepEqual(shots().map((v) => [v.cause, v.reason]), [['rejected', 'hammer']]);
    assert.equal(a.mag, mag);
  });

  it('the trigger held for hammerTicks commands lets the shot go', (t) => {
    const { room, b, tick, aimAtChest, shots } = r8Duel();
    t.after(() => room.close());
    for (let i = 0; i < HAMMER; i++) tick({ trigger: true }, aimAtChest());
    tick({ fire: true }, aimAtChest());
    assert.deepEqual(shots().map((v) => v.cause), ['hit']);
    assert.ok(b.hp < 100);
  });

  it('one command short of the hammer is rejected', (t) => {
    const { room, tick, aimAtChest, shots } = r8Duel();
    t.after(() => room.close());
    for (let i = 0; i < HAMMER - 1; i++) tick({ trigger: true }, aimAtChest());
    tick({ fire: true }, aimAtChest());
    assert.deepEqual(shots().map((v) => [v.cause, v.reason]), [['rejected', 'hammer']]);
  });

  it('a seq jump does not fake the pull: trigger at N, fire at N + hammerTicks is rejected (R69)', (t) => {
    const { room, a, tick, lose, aimAtChest, shots } = r8Duel();
    t.after(() => room.close());
    const mag = a.mag;
    tick({ trigger: true }, aimAtChest());
    lose(HAMMER - 1);
    tick({ fire: true }, aimAtChest());
    assert.deepEqual(shots().map((v) => [v.cause, v.reason]), [['rejected', 'hammer']]);
    assert.equal(a.mag, mag);
  });

  it('an honest choke batch: the held commands count when they run, and the shot goes', (t) => {
    const { room, b, tick, batch, aimAtChest, shots } = r8Duel();
    t.after(() => room.close());
    // Fake lag: 14 commands built over 14 ticks arrive together (the last batch carries the shot).
    const intents: Partial<CommandIntent>[] = [...Array.from({ length: HAMMER }, () => ({ trigger: true })), { fire: true }];
    for (let i = 0; i < intents.length; i += 14) {
      for (let k = 0; k < 13; k++) tick(null);
      batch(intents.slice(i, i + 14), aimAtChest());
    }
    assert.deepEqual(shots().map((v) => v.cause), ['hit']);
    assert.ok(b.hp < 100);
  });

  it('the hammer held back past the grace drops: a pre-cocked shot is rejected and needs a new pull', (t) => {
    const { room, tick, aimAtChest, shots } = r8Duel();
    t.after(() => room.close());
    // Held hammerTicks + HAMMER_GRACE + 1 commands with no shot: the hammer dropped and was pulled again.
    for (let i = 0; i < HAMMER + HAMMER_GRACE + 1; i++) tick({ trigger: true }, aimAtChest());
    tick({ fire: true }, aimAtChest());
    assert.deepEqual(shots().map((v) => [v.cause, v.reason]), [['rejected', 'hammer']]);
    // The new pull: hammerTicks more held commands and the shot goes.
    for (let i = 0; i < HAMMER; i++) tick({ trigger: true }, aimAtChest());
    tick({ fire: true }, aimAtChest());
    assert.deepEqual(shots().map((v) => v.reason ?? v.cause), ['hammer', 'hit']);
  });

  it('a shot anywhere inside the grace still goes (a hammer waiting out the fire interval)', (t) => {
    const { room, tick, aimAtChest, shots } = r8Duel();
    t.after(() => room.close());
    for (let i = 0; i < HAMMER + HAMMER_GRACE; i++) tick({ trigger: true }, aimAtChest());
    tick({ fire: true }, aimAtChest());
    assert.deepEqual(shots().map((v) => v.cause), ['hit']);
  });

  it('releasing the trigger restarts the pull', (t) => {
    const { room, tick, aimAtChest, shots } = r8Duel();
    t.after(() => room.close());
    for (let i = 0; i < HAMMER; i++) tick({ trigger: i !== HAMMER - 5 }, aimAtChest());
    tick({ fire: true }, aimAtChest());
    assert.deepEqual(shots().map((v) => [v.cause, v.reason]), [['rejected', 'hammer']]);
  });

  it('a pull started on another gun does not carry over to the R8', (t) => {
    const { room, a, tick, aimAtChest, shots } = r8Duel();
    t.after(() => room.close());
    hold(a, 'deserteagle');
    for (let i = 0; i < HAMMER; i++) tick({ trigger: true }, aimAtChest());
    hold(a, 'r8');
    tick({ fire: true }, aimAtChest());
    assert.deepEqual(shots().map((v) => [v.cause, v.reason]), [['rejected', 'hammer']]);
  });

  it('a shot spends the pull: the next shot needs a new one', (t) => {
    const { room, tick, aimAtChest, shots } = r8Duel();
    t.after(() => room.close());
    for (let i = 0; i < HAMMER; i++) tick({ trigger: true }, aimAtChest());
    tick({ fire: true }, aimAtChest());
    // Past the fire interval, but the trigger was not held since the shot.
    for (let i = 0; i < 40; i++) tick({}, aimAtChest());
    tick({ fire: true }, aimAtChest());
    assert.deepEqual(shots().map((v) => v.reason ?? v.cause), ['hit', 'hammer']);
  });

  it('a pull does not survive death: the first R8 shot of a new life needs its own pull (M1)', (t) => {
    const { room, a, b, tick, aimAtChest, shots } = r8Duel();
    t.after(() => room.close());
    for (let i = 0; i < HAMMER; i++) tick({ trigger: true }, aimAtChest());
    room.damage(a, b, 1000, false, 'world', { x: 0, y: 0, z: 0 }, performance.now());
    assert.equal(a.alive, false);
    for (let i = 0; i < 400 && !a.alive; i++) tick(null);
    assert.ok(a.alive, 'respawned');
    assert.equal(room.v2State(a.pid)!.hammerHold, 0);
    place(a, 20, 20);
    a.shieldUntil = b.shieldUntil = 0;
    hold(a, 'r8');
    tick({ fire: true }, aimAtChest());
    assert.deepEqual(shots().map((v) => [v.cause, v.reason]), [['rejected', 'hammer']]);
  });

  it('other guns fire on the press', (t) => {
    const { room, a, tick, aimAtChest, shots } = r8Duel();
    t.after(() => room.close());
    hold(a, 'deserteagle');
    tick({ fire: true }, aimAtChest());
    assert.deepEqual(shots().map((v) => v.cause), ['hit']);
  });
});

describe('R8 hammer for bots (I1)', () => {
  it('a bot with the R8 pulls the hammer before every shot and is never rejected for it', (t) => {
    const { io } = fakeIo();
    const room = new HvhRoom(io, { id: 'hvh-r8-bot', code: 'HVHRB', name: 'R8 bot', mode: 'hvh', map: 'flat', private: true,
      hvhEngine: 'v2', hvhRounds: false, bots: 1, seed: 7 }, {});
    t.after(() => room.close());
    const verdicts: ShotVerdict[] = [];
    room.addVerdictListener((v) => verdicts.push(v));
    const a = addPlayer(room, 'A');
    room.startNow();
    let now = performance.now();
    stepRoom(room, now);
    const bot = [...room.players.values()].find((p) => p.info.bot);
    assert.ok(bot, 'the room added its bot');
    // The test runs faster than real time; the input limiter would drop most commands.
    a.takeInputToken = bot.takeInputToken = () => true;
    a.info.team = bot.info.team === 1 ? 2 : 1;
    a.hp = 100_000;
    let held = 0;
    for (let i = 0; i < 64 * 20 && verdicts.filter((v) => v.shooterId === String(bot.pid) && v.cause !== 'rejected').length < 2; i++) {
      if (bot.weapon !== 'r8') hold(bot, 'r8');
      place(a, bot.state.x, bot.state.z - 6);
      a.shieldUntil = bot.shieldUntil = 0;
      a.hp = 100_000;
      a.alive = true;
      room.handleInput(a, { seq: ++held, forward: 0, right: 0, jump: false, yaw: 0, pitch: 0 });
      stepRoom(room, (now += TICK_MS));
    }
    const shots = verdicts.filter((v) => v.shooterId === String(bot.pid) && v.bullet === 1);
    assert.ok(shots.filter((v) => v.cause !== 'rejected').length >= 2, `the bot fired: ${shots.map((v) => v.reason ?? v.cause).join(', ')}`);
    assert.ok(!shots.some((v) => v.reason === 'hammer'), `no hammer rejections: ${shots.map((v) => v.reason ?? v.cause).join(', ')}`);
  });
});
