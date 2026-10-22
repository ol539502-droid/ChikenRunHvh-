import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ShotVerdict } from '@game/shared/hvh/v2';
import { HitLog, HitLogModel } from '../../src/ui/hvh/HitLog';

describe('HitLog', () => {
  it('hit log uses formatVerdict text', () => {
    const roster = new Map<string, string>([
      ['target-1', 'TargetDummy'],
      ['target-2', 'Bob'],
    ]);
    const nameOf = (id: string) => roster.get(id) ?? id;
    const hitLog = new HitLog(nameOf);

    const hitVerdict: ShotVerdict = {
      shooterId: 'me',
      targetId: 'target-1',
      tick: 1234,
      bullet: 1,
      cause: 'hit',
      damage: 42.1,
      remainingHp: 57.9,
      hitgroup: 'stomach',
    };
    hitLog.push(hitVerdict);

    assert.equal(hitLog.lines.length, 1);
    assert.equal(hitLog.lines[0], 'Hit TargetDummy in the stomach for 42 (58 remaining)');

    const missVerdict: ShotVerdict = {
      shooterId: 'me',
      targetId: 'target-2',
      tick: 1235,
      bullet: 1,
      cause: 'resolver',
      guessed: 'left',
      real: 'right',
    };
    hitLog.push(missVerdict);
    assert.equal(hitLog.lines.length, 2);
    assert.equal(hitLog.lines[1], 'Missed shot due to resolver (guessed left, real right)');
  });

  it('keeps 8 newest', () => {
    const nameOf = (id: string) => id;
    const hitLog = new HitLog(nameOf);

    for (let i = 1; i <= 10; i++) {
      const v: ShotVerdict = {
        shooterId: 'me',
        targetId: `target-${i}`,
        tick: 1000 + i,
        bullet: 1,
        cause: 'hit',
        damage: i * 10,
        remainingHp: 100 - i * 10,
        hitgroup: 'chest',
      };
      hitLog.push(v);
    }

    assert.equal(hitLog.lines.length, 8);
    // 1 and 2 were dropped, 3 through 10 remain
    assert.equal(hitLog.lines[0], 'Hit target-3 in the chest for 30 (70 remaining)');
    assert.equal(hitLog.lines[7], 'Hit target-10 in the chest for 100 (0 remaining)');
  });

  it('fades lines after 5 seconds using injected clock', () => {
    let nowTime = 1000;
    const now = () => nowTime;
    const nameOf = (id: string) => id;
    const hitLog = new HitLog(nameOf, { now });

    const v1: ShotVerdict = {
      shooterId: 'me',
      tick: 100,
      bullet: 1,
      cause: 'spread',
    };
    hitLog.push(v1);

    assert.equal(hitLog.lines.length, 1);
    assert.equal(hitLog.lines[0], 'Missed shot due to spread');

    // Advance 4999 ms -> still within 5000 ms
    nowTime = 1000 + 4999;
    assert.equal(hitLog.lines.length, 1);

    // Advance to 5000 ms elapsed -> exactly 5s or beyond
    nowTime = 1000 + 5000;
    assert.equal(hitLog.lines.length, 0);

    // Push new line at current time
    const v2: ShotVerdict = {
      shooterId: 'me',
      tick: 200,
      bullet: 1,
      cause: 'obstruction',
      material: 'wood',
    };
    hitLog.push(v2);
    assert.equal(hitLog.lines.length, 1);
    assert.equal(hitLog.lines[0], 'Missed shot: blocked by wood');
  });

  it('HitLogModel works as a pure DOM-free model', () => {
    let nowTime = 0;
    const model = new HitLogModel({ maxLines: 3, fadeMs: 1000, now: () => nowTime });
    model.push('line 1');
    model.push('line 2');
    model.push('line 3');
    model.push('line 4');
    assert.deepEqual(model.lines, ['line 2', 'line 3', 'line 4']);
    nowTime = 1001;
    assert.deepEqual(model.lines, []);
  });
});
