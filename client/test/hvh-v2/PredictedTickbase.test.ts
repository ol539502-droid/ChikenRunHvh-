import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { EMPTY_TICKBASE, LATE_CSGO, movementSteps, stepTickbase, type CommandIntent, type TickAction, type TickbaseState } from '@game/shared/hvh/v2';
import { CommandChoker } from '@game/shared';
import { CommandClock, PredictedTickbase, TickClock, commandIntent, shotReference } from '../../src/hvh/PredictedTickbase';

const era = LATE_CSGO;
const NONE: CommandIntent = { fire: false, choke: false, doubleTap: false, hideShots: false };
const HIDDEN = { enemyVisible: false };
const FIRE_DT: CommandIntent = { ...NONE, fire: true, doubleTap: true };
const CHOKE: CommandIntent = { ...NONE, choke: true };

/** Server side: runs stepTickbase and serialises like hvhStateEvent. */
function serverRun(start: TickbaseState, intents: CommandIntent[]): TickbaseState {
  let s = start;
  for (const i of intents) s = stepTickbase(s, i, era, HIDDEN).next;
  return { ...s };
}

const script: CommandIntent[] = [
  ...Array.from({ length: 30 }, () => NONE), CHOKE, CHOKE, FIRE_DT, NONE, NONE, FIRE_DT,
  ...Array.from({ length: 20 }, () => NONE),
];

describe('PredictedTickbase', () => {
  it('prediction matches server', () => {
    const start = EMPTY_TICKBASE(100);
    const p = new PredictedTickbase(era, start);
    script.forEach((intent, i) => p.apply(i + 1, intent));
    for (const ack of [5, 12, script.length]) {
      p.reconcile(serverRun(start, script.slice(0, ack)), ack);
    }
    assert.equal(p.mismatches, 0);
    assert.deepEqual(p.state, serverRun(start, script));
  });

  it('charge x32, a DT shot, charge x32 and a release predict exactly what stepTickbase runs', () => {
    const dt: CommandIntent = { ...NONE, doubleTap: true };
    const seq: CommandIntent[] = [
      ...Array.from({ length: era.chargeTicks }, () => dt), FIRE_DT,
      ...Array.from({ length: era.chargeTicks }, () => dt), NONE, NONE,
    ];
    const start = EMPTY_TICKBASE(100);
    const p = new PredictedTickbase(era, start);
    let s = start;
    const actions: TickAction['kind'][] = [];
    seq.forEach((intent, i) => {
      const step = stepTickbase(s, intent, era, HIDDEN);
      assert.deepEqual(p.peek(i + 1, intent, HIDDEN), step.action, `peek ${i + 1}`);
      p.apply(i + 1, intent, HIDDEN);
      s = step.next;
      actions.push(step.action.kind);
      assert.deepEqual(p.state, s, `command ${i + 1}`);
      assert.equal(p.stepsFor(i + 1), movementSteps(step.action));
    });
    const n = era.chargeTicks;
    assert.deepEqual(actions, [...Array(n).fill('charge'), 'burst', ...Array(n).fill('charge'), 'burst', 'run']);
    assert.equal(p.stepsFor(n + 1), 1 + n);
    assert.equal(p.stepsFor(1), 0);
    p.reconcile(serverRun(start, seq.slice(0, n)), n);
    assert.equal(p.mismatches, 0);
    assert.deepEqual(p.state, s);
  });

  it('peek changes nothing and counts a waiting fire message; needsSight: an exploit on and not firing', () => {
    const p = new PredictedTickbase(era, { ...EMPTY_TICKBASE(0), charge: era.chargeTicks, armed: true });
    const dt: CommandIntent = { ...NONE, doubleTap: true };
    assert.equal(p.peek(1, dt).kind, 'run');
    assert.equal(p.needsSight(1, dt), true, 'full charge: traced anyway, so a corrected replay steps with a real sight');
    p.shot(1);
    assert.equal(p.needsSight(1, dt), false, 'a waiting fire message makes it a shot');
    assert.equal(p.peek(1, dt).kind, 'burst');
    assert.deepEqual(p.state, { ...EMPTY_TICKBASE(0), charge: era.chargeTicks, armed: true });
    assert.equal(p.pendingCount, 0);
    const empty = new PredictedTickbase(era, EMPTY_TICKBASE(0));
    assert.equal(empty.needsSight(1, dt), true);
    assert.equal(empty.needsSight(1, NONE), false, 'exploits off');
    assert.equal(empty.needsSight(1, FIRE_DT), false, 'firing');
    assert.equal(empty.peek(1, dt, { enemyVisible: true }).kind, 'run');
    assert.equal(empty.peek(1, dt, HIDDEN).kind, 'charge');
    assert.equal(empty.stepsFor(1), undefined, 'nothing predicted yet');
  });

  it('after a correction, a command traced at full charge replays with its real sight', () => {
    const dt: CommandIntent = { ...NONE, doubleTap: true };
    const n = era.chargeTicks;
    const p = new PredictedTickbase(era, EMPTY_TICKBASE(0));
    for (let i = 1; i <= n; i++) p.apply(i, dt, HIDDEN);
    assert.equal(p.needsSight(n + 1, dt), true, 'traced although the predicted charge is full');
    p.apply(n + 1, dt, { enemyVisible: true });
    assert.equal(p.stepsFor(n + 1), 1);
    assert.equal(p.state.charge, n, 'a full charge is kept in sight');
    // The server was one charge short: the replayed command sees the enemy and cancels.
    p.reconcile({ tickbase: 0, charge: n - 1, choked: 0, armed: true }, n);
    assert.equal(p.mismatches, 1);
    assert.deepEqual(p.state, stepTickbase({ tickbase: 0, charge: n - 1, choked: 0, armed: true }, dt, era, { enemyVisible: true }).next);
    assert.equal(p.state.charge, 0, 'cancelled, not charged to full');
  });

  it('commands the link lost before a sent one are taken back, and their shot fires on the next command', () => {
    const dt: CommandIntent = { ...NONE, doubleTap: true };
    const n = era.chargeTicks;
    const start = { ...EMPTY_TICKBASE(0), charge: n, armed: true };
    const p = new PredictedTickbase(era, start);
    p.shot(2);
    for (let seq = 1; seq <= 5; seq++) p.apply(seq, dt, HIDDEN);
    assert.equal(p.stepsFor(2), 1 + n, 'predicted: command 2 carries the burst');
    assert.deepEqual(p.sent(1), []);
    // 2 and 3 never left (lost, or late and then dropped by the server): 4 runs next, with the shot.
    assert.deepEqual(p.sent(4), [2, 3]);
    assert.deepEqual(p.sent(3), [], 'a late command was already taken back');
    let expected = stepTickbase(start, dt, era, HIDDEN).next;
    expected = stepTickbase(expected, FIRE_DT, era, HIDDEN).next;
    assert.equal(p.stepsFor(4), 1 + n, 'the burst moved to command 4');
    assert.equal(p.stepsFor(2), undefined);
    expected = stepTickbase(expected, dt, era, HIDDEN).next;
    assert.deepEqual(p.state, expected);
    p.reconcile(serverRun(start, [dt, FIRE_DT]), 4);
    assert.equal(p.mismatches, 0);
    assert.deepEqual(p.state, expected);
  });

  it('reconcile replays unacked', () => {
    const start = EMPTY_TICKBASE(0);
    const p = new PredictedTickbase(era, start);
    const intents = script.slice(0, 14);
    intents.forEach((intent, i) => p.apply(i + 1, intent));
    p.reconcile(serverRun(start, intents.slice(0, 10)), 10);
    // Uncapped full replay (the server's cap only applies on the wire).
    let expected = serverRun(start, intents.slice(0, 10));
    for (const i of intents.slice(10)) expected = stepTickbase(expected, i, era, HIDDEN).next;
    assert.deepEqual(p.state, expected);
    assert.equal(p.mismatches, 0);
  });

  it('apply takes the enemy sight, and reconcile replays each command with the sight it was predicted with', () => {
    const start = EMPTY_TICKBASE(0);
    const p = new PredictedTickbase(era, start);
    const dt: CommandIntent = { ...NONE, doubleTap: true };
    const sight = [false, false, false, true, false, false];
    sight.forEach((enemyVisible, i) => p.apply(i + 1, dt, { enemyVisible }));
    let expected = start;
    const after: TickbaseState[] = [];
    for (const enemyVisible of sight) after.push(expected = stepTickbase(expected, dt, era, { enemyVisible }).next);
    assert.deepEqual(p.state, expected);
    assert.equal(after[3]!.charge, 0, 'the sighting cancelled the charge');
    p.reconcile(after[1]!, 2);
    assert.equal(p.mismatches, 0);
    assert.deepEqual(p.state, expected, 'the replay keeps the sighting at command 4');
  });

  it('a fire message whose command was lost fires on the next command, as the server attaches it', () => {
    const start = { ...EMPTY_TICKBASE(0), charge: era.chargeTicks };
    const p = new PredictedTickbase(era, start);
    const dtArmed: CommandIntent = { ...NONE, doubleTap: true };
    p.shot(3);
    p.apply(1, dtArmed);
    p.apply(2, dtArmed);
    // Command 3 (intent.fire) never left; the fire message did. The server runs it with command 4.
    p.apply(4, dtArmed);
    let expected = start;
    for (const i of [dtArmed, dtArmed, FIRE_DT]) expected = stepTickbase(expected, i, era, HIDDEN).next;
    assert.deepEqual(p.state, expected);
    // Consumed once: the next command is not a shot.
    p.apply(5, NONE);
    assert.deepEqual(p.state, stepTickbase(expected, NONE, era, HIDDEN).next);
  });

  it('keeps at most MAX_PENDING_FIRES waiting shots, dropping the oldest like the server', () => {
    const start = EMPTY_TICKBASE(0);
    const p = new PredictedTickbase(era, start);
    for (const seq of [1, 2, 3, 4, 5]) p.shot(seq);
    for (let seq = 1; seq <= 5; seq++) p.apply(seq + 10, NONE);
    // Shot 1 was dropped: the first four commands fire, the fifth banks (five shots would leave the bank empty).
    let firstFour = start;
    for (const i of [{ ...NONE, fire: true }, { ...NONE, fire: true }, { ...NONE, fire: true }, { ...NONE, fire: true }, NONE]) {
      firstFour = stepTickbase(firstFour, i, era, HIDDEN).next;
    }
    assert.deepEqual(p.state, firstFour);
  });

  it('reset drops predictions and pending shots, and the next hvhState only snaps', () => {
    const start = { ...EMPTY_TICKBASE(0), charge: era.chargeTicks };
    const p = new PredictedTickbase(era, start);
    p.apply(1, NONE);
    p.shot(5);
    p.reset();
    assert.deepEqual(p.state, EMPTY_TICKBASE(0));
    assert.equal(p.pendingCount, 0);
    // The server's fresh life (any tick) is adopted without a mismatch, then prediction resumes.
    const spawned = EMPTY_TICKBASE(400);
    p.apply(2, NONE);
    p.reconcile(serverRun(spawned, [NONE]), 2);
    assert.equal(p.mismatches, 0);
    // Shot 5 was dropped with the old life: command 5 does not fire.
    for (const seq of [3, 4, 5]) p.apply(seq, NONE);
    p.reconcile(serverRun(spawned, [NONE, NONE, NONE, NONE]), 5);
    assert.equal(p.mismatches, 0);
    p.reset(spawned);
    assert.deepEqual(p.state, spawned);
  });

  it('reset at death predicts nothing until the next reset (the server runs those commands without a tickbase)', () => {
    const start = EMPTY_TICKBASE(0);
    const p = new PredictedTickbase(era, start);
    p.apply(1, NONE);
    p.reset(undefined, false);
    assert.equal(p.apply(2, NONE), false);
    assert.equal(p.pendingCount, 0);
    const dead = EMPTY_TICKBASE(50);
    p.reconcile(dead, 2);
    p.reconcile(dead, 3);
    assert.equal(p.mismatches, 0);
    p.reset();
    assert.equal(p.apply(4, NONE), true);
  });

  it('mismatch counted and snaps to server', () => {
    const start = EMPTY_TICKBASE(0);
    const p = new PredictedTickbase(era, start);
    const intents = script.slice(0, 14);
    intents.forEach((intent, i) => p.apply(i + 1, intent));
    const bad = { ...serverRun(start, intents.slice(0, 10)), charge: 3 };
    p.reconcile(bad, 10);
    assert.equal(p.mismatches, 1);
    let expected = bad;
    for (const i of intents.slice(10)) expected = stepTickbase(expected, i, era, HIDDEN).next;
    assert.deepEqual(p.state, expected);
  });

  it('capped ticksSinceShift on the server is not a mismatch', () => {
    const start = EMPTY_TICKBASE(0);
    const p = new PredictedTickbase(era, start);
    const intents = Array.from({ length: 40 }, () => NONE);
    intents.forEach((intent, i) => p.apply(i + 1, intent));
    p.reconcile(serverRun(start, intents), 40);
    assert.equal(p.mismatches, 0);
  });

  it('bounds the unacked buffer', () => {
    const p = new PredictedTickbase(era, EMPTY_TICKBASE(0));
    for (let i = 1; i <= 500; i++) p.apply(i, NONE);
    assert.ok(p.pendingCount <= 128);
  });

  it('first reconcile without prior prediction is not a mismatch', () => {
    const p = new PredictedTickbase(era);
    p.reconcile({ tickbase: 50, charge: 4, choked: 0, armed: false }, 7);
    assert.equal(p.mismatches, 0);
    assert.equal(p.state.tickbase, 50);
  });

  it('a dropped command (seq gap) leaves no mismatch', () => {
    const start = EMPTY_TICKBASE(0);
    const p = new PredictedTickbase(era, start);
    const seqs = [1, 2, 4, 5, 6]; // 3 lost in the network, never emitted
    const executed = seqs.map((q) => script[q - 1]!);
    seqs.forEach((q) => p.apply(q, script[q - 1]!));
    p.reconcile(serverRun(start, executed), 6);
    assert.equal(p.mismatches, 0);
  });

  it('a reordered batch leaves no mismatch', () => {
    const start = EMPTY_TICKBASE(0);
    const p = new PredictedTickbase(era, start);
    const emitted = [1, 2, 5, 6, 3, 4, 7]; // 3,4 arrive late: the server drops them
    const applied = emitted.filter((q) => p.apply(q, script[q - 1]!));
    assert.deepEqual(applied, [1, 2, 5, 6, 7]);
    p.reconcile(serverRun(start, applied.map((q) => script[q - 1]!)), 7);
    assert.equal(p.mismatches, 0);
  });

  it('choke bits follow the actual CommandChoker batches', () => {
    const choker = new CommandChoker();
    const N = 3;
    const bits: boolean[] = [];
    const batches: number[] = [];
    for (let seq = 1; seq <= 8; seq++) {
      const held = choker.wouldHold(N, false);
      bits.push(commandIntent({ seq, shotSeq: null, hitscan: true, held, exploit: 'off' }).choke);
      batches.push(choker.push({ seq } as never, N, false).length);
    }
    assert.deepEqual(bits, [true, true, true, false, true, true, true, false]);
    assert.deepEqual(batches, [0, 0, 0, 4, 0, 0, 0, 4]);
  });

  it('commandIntent has no defensive key', () => {
    const intent = commandIntent({ seq: 1, shotSeq: null, hitscan: true, held: false, exploit: 'doubleTap' });
    assert.deepEqual(Object.keys(intent).sort(), ['choke', 'doubleTap', 'fire', 'hideShots']);
    assert.equal('defensive' in intent, false);
  });

  it('holding fire without a shot sets no fire intent; the shot command does', () => {
    const held = Array.from({ length: 10 }, (_, i) => commandIntent({ seq: i + 1, shotSeq: null, hitscan: true, held: false, exploit: 'doubleTap' }));
    assert.ok(held.every((i) => !i.fire));
    const shot = commandIntent({ seq: 4, shotSeq: 4, hitscan: true, held: true, exploit: 'doubleTap' });
    assert.equal(shot.fire, true);
    assert.equal(shot.choke, false);
    assert.equal(commandIntent({ seq: 4, shotSeq: 4, hitscan: false, held: false, exploit: 'off' }).fire, false);
  });

  it('clientTick lags the latest server tick by about the interpolation delay', () => {
    const clock = new TickClock(64);
    clock.sample(1000, 50_000);
    const now = 50_000;
    assert.equal(clock.viewedTick(now - 100), 993, 'floor(-6.4) ticks back');
    assert.equal(clock.viewedTick(now), 1000);
    assert.equal(clock.viewedTick(now + 1000 / 64 * 10 - 100), 1003);
  });

  it('legacy: fire references server.ack, no shot command, and a shot does not flush', () => {
    assert.deepEqual(shotReference(false, 50, 44), { command: 44, shotSeq: null });
    const choker = new CommandChoker();
    const out = [1, 2].map((seq) => choker.push({ seq } as never, 3, false).length); // fakeLagBreakOnShot off: flush=false
    assert.deepEqual(out, [0, 0]);
  });

  it('v2 with break-on-shot off: a shot during choke stays held and carries intent.fire when released', () => {
    const choker = new CommandChoker();
    const ref = shotReference(true, 2, 0);
    assert.deepEqual(ref, { command: 2, shotSeq: 2 });
    const sent: { seq: number; fire: boolean }[][] = [];
    for (let seq = 1; seq <= 4; seq++) {
      const held = choker.wouldHold(3, false);
      const intent = commandIntent({ seq, shotSeq: ref.shotSeq, hitscan: true, held, exploit: 'off' });
      const batch = choker.push({ seq, intent } as never, 3, false) as unknown as { seq: number; intent: CommandIntent }[];
      if (seq === 2) assert.equal(batch.length, 0, 'shot frame stays held');
      if (batch.length) sent.push(batch.map((c) => ({ seq: c.seq, fire: c.intent.fire })));
    }
    assert.deepEqual(sent, [[{ seq: 1, fire: false }, { seq: 2, fire: true }, { seq: 3, fire: false }, { seq: 4, fire: false }]]);
  });
});

describe('CommandClock (clock correction)', () => {
  /**
   * A client and a server `oneWay` ticks apart. The server starts with `backlog` of our commands
   * queued, runs one per tick (budget refill 1) and reports { lastAckSeq, queued }; the client
   * produces one command per tick unless the clock says skip.
   */
  function simulate(oneWay: number, backlog: number, ticks = 800) {
    const clock = new CommandClock();
    let nextSeq = backlog + 1, lastAck = 0, budget = 0, skips = 0, coasts = 0, started = false;
    const queue: number[] = Array.from({ length: backlog }, (_, i) => i + 1);
    const up: number[][] = [], down: ({ lastAckSeq: number; queued: number } | null)[] = [];
    for (let t = 0; t < ticks; t++) {
      const batch: number[] = [];
      if (clock.skip(nextSeq)) skips++; else batch.push(nextSeq++);
      up.push(batch);
      for (const seq of up.length > oneWay ? up.shift()! : []) queue.push(seq);
      budget = Math.min(16, budget + 1);
      let ran = 0;
      while (budget >= 1 && queue.length && ran < 16) { lastAck = queue.shift()!; budget--; ran++; }
      if (ran) started = true; else if (started) coasts++;
      down.push(ran ? { lastAckSeq: lastAck, queued: queue.length } : null);
      const report = down.length > oneWay ? down.shift()! : null;
      if (report) clock.observe(report.queued, report.lastAckSeq + report.queued);
    }
    return { skips, coasts, queued: queue.length };
  }

  it('drains a backlog to the target without overshooting, whatever the network delay', () => {
    for (const oneWay of [0, 3, 6, 10, 16]) {
      const r = simulate(oneWay, 31);
      assert.equal(r.coasts, 0, `one-way ${oneWay}: the server never runs dry (${JSON.stringify(r)})`);
      assert.ok(r.queued <= 1, `one-way ${oneWay}: drained (${JSON.stringify(r)})`);
      assert.ok(r.skips <= 30, `one-way ${oneWay}: never more skips than the excess (${r.skips})`);
    }
  });

  it('never skips while the server queue stays small, even with fake-lag batches and jitter', () => {
    const clock = new CommandClock();
    for (let i = 0; i < 200; i++) clock.observe(i % 15 === 0 ? 14 : i % 2, 1000 + i);
    let skipped = 0;
    for (let i = 0; i < 200; i++) if (clock.skip(2000 + i)) skipped++;
    assert.equal(skipped, 0);
  });

  it('needs a full window of reports first, and reset forgets them', () => {
    const clock = new CommandClock();
    for (let i = 0; i < 10; i++) clock.observe(30, 100 + i);
    let skipped = 0;
    for (let i = 0; i < 8; i++) if (clock.skip(200)) skipped++;
    for (let i = 0; i < 40; i++) clock.observe(30, 300 + i);
    clock.reset();
    for (let i = 0; i < 8; i++) if (clock.skip(400)) skipped++;
    assert.equal(skipped, 0);
  });
});
