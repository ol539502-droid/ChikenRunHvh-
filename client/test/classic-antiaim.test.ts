/// <reference types="vite/client" />
import assert from 'node:assert/strict';
import { it } from 'node:test';
import { wrapAngle, type InputFrame } from '@game/shared';
import { defaultConfig } from '../src/dev/classic/config';
import { DevRuntime } from '../src/dev/classic/DevRuntime';
import type { Dev } from '../src/dev/classic/Dev';
import type { GameSession } from '../src/game/GameSession';

function fixture(mode: string) {
  const element = () => ({ setAttribute() {}, append() {}, prepend() {}, getContext: () => ({}) });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement: element, getElementById: () => null, body: element() } });
  const config = defaultConfig();
  Object.assign(config.rage.antiAim, { spin: true, speed: 720, direction: 'right', pitch: 'down' });
  const dev = { config, active: true } as unknown as Dev;
  const runtime = new DevRuntime(dev);
  const session = { mode: { id: mode }, local: { alive: true, car: null, state: { onGround: true } }, weapons: { weapon: 'rifle' } } as unknown as GameSession;
  (runtime as unknown as { session: GameSession }).session = session;
  return { runtime, session };
}

const frame = (seq: number): InputFrame => ({ seq, forward: 1, right: 0, jump: false, yaw: 0.4, pitch: 0 });

it('the dev cheat spin bot and fake pitch work outside HvH, and you still walk where the camera faces', () => {
  const { runtime, session } = fixture('tdm');
  const a = runtime.modifyFrame(session, frame(1));
  const b = runtime.modifyFrame(session, frame(2));
  assert.equal(a.pitch, -1.2, 'fake pitch down');
  assert.notEqual(a.yaw, b.yaw, 'the body spins');
  // The keys are re-expressed relative to the spinning body: same world direction as the camera's.
  for (const f of [a, b]) {
    const dx = -Math.sin(f.yaw) * f.forward + Math.cos(f.yaw) * f.right;
    const dz = -Math.cos(f.yaw) * f.forward - Math.sin(f.yaw) * f.right;
    assert.ok(Math.abs(wrapAngle(Math.atan2(-dx, -dz) - 0.4)) < 1e-9, 'walks along the camera yaw');
  }
});
