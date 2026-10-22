import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ShotVerdict } from '@game/shared/hvh/v2';
import { defaultConfig } from '../../src/dev/config';
import type { Dev } from '../../src/dev/Dev';
import { DevRuntime } from '../../src/dev/DevRuntime';
import { HitLog, initHvhV2Ui } from '../../src/ui/hvh/HitLog';
import { withFakeDom } from './fakeDom';

describe('v2 HUD: the hit log only', () => {
  it('an active v2 session adds the hit log to the HUD root and no DT/HS/choke indicators', () => withFakeDom((root) => {
    const target: { hitLog: HitLog | null } = { hitLog: null };
    let handler: ((v: ShotVerdict) => void) | null = null;
    assert.equal(initHvhV2Ui(target, () => new HitLog((id) => id, { container: root as unknown as HTMLElement, now: () => 0 }), (h) => (handler = h)), true);
    assert.equal(root.find('hvh-hitlog').length, 1);
    assert.deepEqual(root.find('hvh-indicators'), []);
    assert.equal(root.all().some((e) => /hvh-ind/.test(e.className)), false);
    handler!({ shooterId: 'me', targetId: 'enemy', tick: 50, bullet: 1, cause: 'spread' });
    assert.match(root.text(), /Missed shot due to spread/);
    assert.doesNotMatch(root.text(), /\bDT\b|\bHS\b|CHOKE/);
  }));

  it('legacy rooms (no v2 hvhState) create nothing; a second v2 hvhState creates nothing more', () => {
    const target: { hitLog: HitLog | null } = { hitLog: null };
    let created = 0, registered = 0;
    const create = () => { created++; return new HitLog((id) => id, { now: () => 0 }); };
    const onHvhState = (hvhV2: boolean) => { if (hvhV2) initHvhV2Ui(target, create, () => registered++); };
    onHvhState(false);
    assert.equal(target.hitLog, null);
    assert.equal(created + registered, 0);
    onHvhState(true);
    onHvhState(true);
    assert.equal(created, 1);
    assert.equal(registered, 1);
  });
});

describe('Skeet HUD', () => {
  const fixture = () => {
    const config = defaultConfig('skeet');
    const dev = { config, panelId: 'skeet', fps: () => 144, ping: () => 23, input: { isDown: () => false } } as unknown as Dev;
    return { config, runtime: new DevRuntime(dev) };
  };

  it('has no target/charge status box', () => withFakeDom((root) => {
    const { runtime } = fixture();
    runtime.renderSkeetHud(true, 1000);
    assert.deepEqual(root.find('dev-tactical'), []);
    assert.equal(root.all().some((e) => e.getAttribute('role') === 'status' && !e.hidden), false);
    assert.doesNotMatch(root.text(), /charge|EXPLOIT|DOUBLE TAP|HIDE SHOTS/i);
  }));

  it('still renders the watermark and the keybind list, each behind its toggle', () => withFakeDom((root) => {
    const { config, runtime } = fixture();
    runtime.renderSkeetHud(true, 1000);
    const [watermark] = root.find('skeet-watermark'), [binds] = root.find('skeet-binds');
    assert.equal(watermark!.hidden, false);
    assert.equal(watermark!.textContent, 'skeet · chicken hvh · 144 fps · 23 ms');
    assert.equal(binds!.hidden, false);
    assert.match(binds!.textContent, /^keybinds\nbody aim · hold\n/);
    assert.match(binds!.textContent, /invert · hold/);
    config.skeet.indicators.watermark = false;
    config.skeet.indicators.binds = false;
    runtime.renderSkeetHud(true, 2000);
    assert.equal(watermark!.hidden, true);
    assert.equal(binds!.hidden, true);
    config.skeet.indicators.watermark = config.skeet.indicators.binds = true;
    runtime.renderSkeetHud(false, 3000);
    assert.equal(watermark!.hidden, true, 'hidden outside an active Skeet HvH session');
  }));
});
