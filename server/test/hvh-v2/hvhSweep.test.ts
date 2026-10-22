/*
 * Task 10 (round redesign): the balance sweep's rule (checkBalance) on synthetic matrices, the
 * grid and CLI of the charge-and-burst model, and small runSweep checks (determinism, and that the
 * Mirage duel really exercises the round-start charge, the burst and the mid-round recharge). The
 * full and quick sweeps run through `npm run sweep` / `npm run sweep:quick`, never in `npm test`.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DEFENSIVES, EXPLOITS, FULL_GRID, PAIRINGS, QUICK_GRID, antiAimFor, cellSE, checkBalance, classifyCounters, configName,
  createStats, fieldSE, parseArgs, runSweep, runSweepParallel, threeCycles, type SweepConfig, type WinMatrix,
} from '../../../tools/hvh-sweep';

/** rate[i][j] for i < j from `upper`; rate[j][i] = 1 - rate[i][j]; the diagonal is unused (NaN). */
function matrix(configs: string[], upper: Record<string, number>, rounds = 10): WinMatrix {
  const n = configs.length;
  const rate = configs.map(() => configs.map(() => Number.NaN));
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const r = upper[`${configs[i]}>${configs[j]}`];
      assert.ok(r !== undefined, `pair ${configs[i]} vs ${configs[j]} given`);
      rate[i]![j] = r;
      rate[j]![i] = 1 - r;
    }
  }
  return { configs, rate, rounds: configs.map(() => configs.map(() => rounds)) };
}

describe('checkBalance', () => {
  it('flags a config that wins 0.70 against the field as dominant', () => {
    // A beats B and C 0.70 each (field rate 0.70); B and C split 0.50.
    const m = matrix(['A', 'B', 'C'], { 'A>B': 0.7, 'A>C': 0.7, 'B>C': 0.5 });
    const r = checkBalance(m);
    assert.equal(r.ok, false);
    assert.deepEqual(r.dominant, ['A']);
    // Nobody beats A by 0.55, so A is also uncountered; B and C are countered by A.
    assert.deepEqual(r.uncountered, ['A']);
  });

  it('flags a config nobody beats by at least 0.55 as uncountered, even when it is not dominant', () => {
    // Rock-paper-scissors among A, B, C (each 0.60 over the next), plus D that every config beats
    // only 0.52 (D's best opponent wins 0.52 < 0.55) while D loses on average (field rate 0.48).
    const m = matrix(['A', 'B', 'C', 'D'], {
      'A>B': 0.6, 'B>C': 0.6, 'A>C': 0.4, // C beats A 0.60
      'A>D': 0.52, 'B>D': 0.52, 'C>D': 0.52,
    });
    const r = checkBalance(m);
    assert.equal(r.ok, false);
    assert.deepEqual(r.dominant, []);
    assert.deepEqual(r.uncountered, ['D']);
  });

  it('a counter at exactly 0.55 counts; a field rate of exactly 0.55 is not dominant', () => {
    const m = matrix(['A', 'B', 'C'], { 'A>B': 0.45, 'A>C': 0.65, 'B>C': 0.45 });
    // Field: A (0.45 + 0.65) / 2 = 0.55; B (0.55 + 0.45) / 2 = 0.50; C (0.35 + 0.55) / 2 = 0.45.
    // Counters: A by B (0.55), B by C (0.55), C by A (0.65).
    const r = checkBalance(m);
    assert.deepEqual(r, { ok: true, dominant: [], uncountered: [] });
  });

  it('a balanced matrix (a cycle of counters, every field rate 0.50) is ok', () => {
    const m = matrix(['A', 'B', 'C'], { 'A>B': 0.6, 'B>C': 0.6, 'A>C': 0.4 });
    assert.deepEqual(checkBalance(m), { ok: true, dominant: [], uncountered: [] });
  });

  it('ignores the diagonal (mirror matches are excluded)', () => {
    const m = matrix(['A', 'B', 'C'], { 'A>B': 0.6, 'B>C': 0.6, 'A>C': 0.4 });
    m.rate[0]![0] = 1;
    m.rate[1]![1] = 0;
    assert.deepEqual(checkBalance(m), { ok: true, dominant: [], uncountered: [] });
  });
});

describe('report statistics', () => {
  it('cellSE is the binomial SE; fieldSE combines the cells', () => {
    const m = matrix(['A', 'B', 'C'], { 'A>B': 0.6, 'B>C': 0.6, 'A>C': 0.4 }, 100);
    assert.ok(Math.abs(cellSE(m, 0, 1) - Math.sqrt(0.24 / 100)) < 1e-12);
    assert.ok(Math.abs(fieldSE(m, 0) - Math.sqrt(2 * 0.24 / 100) / 2) < 1e-12);
  });

  it('classifies counters with a 1 SE margin around 0.55', () => {
    // 100 rounds, SE about 0.05. Best counters: A <- B 0.62 (>= 0.55 + 0.049: countered);
    // B <- C 0.52 (within 0.55 +- 0.050: inconclusive); C <- B 0.48 (< 0.55 - 0.050: uncountered).
    const m = matrix(['A', 'B', 'C'], { 'A>B': 0.38, 'A>C': 0.4, 'B>C': 0.48 }, 100);
    assert.deepEqual(classifyCounters(m), { countered: ['A'], uncountered: ['C'], inconclusive: ['B'] });
  });

  it('counts 3-cycles at >= 0.55 (none in a transitive matrix)', () => {
    assert.equal(threeCycles(matrix(['A', 'B', 'C'], { 'A>B': 0.6, 'B>C': 0.6, 'A>C': 0.4 })), 1);
    assert.equal(threeCycles(matrix(['A', 'B', 'C'], { 'A>B': 0.6, 'B>C': 0.6, 'A>C': 0.7 })), 0);
  });
});

describe('the charge-and-burst grid', () => {
  it('defensive is an anti-aim pattern, not an exploit', () => {
    assert.deepEqual([...EXPLOITS], ['none', 'dt', 'hs', 'fakelag14']);
    assert.deepEqual([...DEFENSIVES], ['off', 'inAir', 'onPeek']);
    assert.deepEqual([...PAIRINGS], ['ssg08', 'scar20', 'mixed']);
    assert.ok(FULL_GRID.every((c) => (EXPLOITS as readonly string[]).includes(c.exploit)));
    // Every preset with every exploit and every defensive mode, once.
    assert.equal(new Set(FULL_GRID.map(configName)).size, FULL_GRID.length);
    assert.equal(FULL_GRID.length % (EXPLOITS.length * DEFENSIVES.length), 0);
    assert.ok(QUICK_GRID.every((q) => FULL_GRID.some((c) => configName(c) === configName(q))));
  });

  it('the defensive modes: in air with a random pitch, on peek with a flick, on every stance', () => {
    const off = antiAimFor({ aa: 'static', exploit: 'none', defensive: 'off' });
    const air = antiAimFor({ aa: 'static', exploit: 'none', defensive: 'inAir' });
    const peek = antiAimFor({ aa: 'static', exploit: 'none', defensive: 'onPeek' });
    for (const d of Object.values(off.defensive)) assert.equal(d.enabled, false);
    for (const d of Object.values(air.defensive)) assert.deepEqual({ ...d }, { enabled: true, inAir: true, onPeek: false, always: false, pitch: 'random', yaw: 'off' });
    for (const d of Object.values(peek.defensive)) assert.deepEqual({ ...d }, { enabled: true, inAir: false, onPeek: true, always: false, pitch: 'down', yaw: 'flick' });
    assert.deepEqual(air.stances, off.stances, 'the defensive mode leaves the stance AA alone');
  });
});

describe('CLI flags', () => {
  it('--def, --recharge and --hs are gone (the charge model has no such tunables)', () => {
    for (const removed of ['--def', '--recharge', '--hs']) assert.throws(() => parseArgs([removed, '12']), new RegExp(removed));
  });

  it('--charge N overrides chargeTicks for one run; an invalid one is refused', () => {
    assert.equal(parseArgs([]).charge, undefined);
    assert.equal(parseArgs(['--charge', '24']).charge, 24);
    assert.throws(() => parseArgs(['--charge', '0']), /chargeTicks/);
    assert.throws(() => parseArgs(['--charge', 'x']), /--charge/);
  });

  it('--pairing picks one weapon pairing; every pairing by default', () => {
    assert.deepEqual(parseArgs([]).pairings, ['ssg08', 'scar20', 'mixed']);
    assert.deepEqual(parseArgs(['--pairing', 'scar20']).pairings, ['scar20']);
    assert.throws(() => parseArgs(['--pairing', 'awp']), /--pairing/);
  });
});

describe('runSweep on Mirage', () => {
  const grid: SweepConfig[] = [
    { aa: 'static', exploit: 'dt', defensive: 'off' },
    { aa: 'jitter', exploit: 'none', defensive: 'onPeek' },
  ];

  it('the same seed gives the same WinMatrix; the matrix is complementary', () => {
    const a = runSweep(grid, 4, 0x14, { pairing: 'mixed' });
    const b = runSweep(grid, 4, 0x14, { pairing: 'mixed' });
    assert.deepStrictEqual(b, a);
    assert.deepEqual(a.configs, ['static/dt/off', 'jitter/none/onPeek']);
    assert.equal(a.rounds[0]![1], 4);
    assert.ok(a.rate[0]![1]! >= 0 && a.rate[0]![1]! <= 1);
    assert.equal(a.rate[0]![1]! + a.rate[1]![0]!, 1);
    // Four rounds give coarse rates (k / 4), so compare the rounds' lengths as well.
    const [sa, sb] = [createStats(), createStats()];
    runSweep(grid, 4, 0x14, { pairing: 'mixed', stats: sa });
    runSweep(grid, 4, 0x15, { pairing: 'mixed', stats: sb });
    assert.notEqual(sb.roundTicks, sa.roundTicks, 'a different seed changes the rounds');
  });

  it('runSweepParallel (worker threads) gives the same matrix and stats as runSweep', async () => {
    const [serial, parallel] = [createStats(), createStats()];
    const a = runSweep(grid, 4, 0x14, { pairing: 'mixed', stats: serial });
    const b = await runSweepParallel(grid, 4, 0x14, 2, { pairing: 'mixed', stats: parallel });
    assert.deepStrictEqual(b, a);
    // Workers merge their stats in any order: compare the causes as sorted entries.
    const plain = (st: typeof serial) => ({ ...st, causes: [...st.causes].map(([k, m]) => [k, [...m].sort()] as const).sort() });
    assert.deepStrictEqual(plain(parallel), plain(serial));
    assert.ok(parallel.rounds > 0);
  });

  it('every DT / HS life goes live charged; bursts and mid-round recharges behind cover happen', () => {
    const stats = createStats();
    runSweep([{ aa: 'static', exploit: 'dt', defensive: 'off' }, { aa: 'static', exploit: 'hs', defensive: 'off' }], 8, 0x14, { pairing: 'scar20', stats });
    assert.equal(stats.exploitLives, 16);
    assert.equal(stats.chargedAtLive, stats.exploitLives, 'each round starts charged (freeze time)');
    assert.ok(stats.bursts > 0, 'bursts');
    assert.ok(stats.recharges > 0, 'a charge completed mid-round (no enemy in sight behind the pillar)');
  });
});
