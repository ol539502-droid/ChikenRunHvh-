import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MODES, SIM_DT, TRAINING_GUNS, TRAINING_KNIVES, WEAPONS, isMelee } from '@game/shared';
import { createRoom } from '../src/rooms/modes';
import type { TrainingRoom } from '../src/rooms/TrainingRoom';
import { addPlayer, fakeIo } from './helpers';

/** A Training room with a stopped clock: `step(ms)` runs the fixed update with a fake time. */
function setup(map = MODES.training.maps[0]!) {
  const { io, events } = fakeIo();
  let ended = 0;
  const room = createRoom(io, { id: 't', code: 'TRN1', name: 'Training', mode: 'training', map, private: true }, { onMatchEnd: () => { ended++; return new Map(); } }) as TrainingRoom;
  clearInterval((room as unknown as { tickTimer: NodeJS.Timeout }).tickTimer);
  const me = addPlayer(room, 'Me', 7);
  let now = performance.now();
  const update = (room as unknown as { fixedUpdate(now: number): void }).fixedUpdate.bind(room);
  const step = (ms: number) => { const end = now + ms; while (now < end) { now = Math.min(end, now + SIM_DT * 1000); update(now); } };
  const targets = [...room.players.values()].filter((p) => p.info.bot);
  return { room, events, me, targets, step, get now() { return now; }, get ended() { return ended; } };
}

describe('Training', () => {
  it('has practice targets, one human, no clock and no score limit', () => {
    for (const map of MODES.training.maps) {
      const s = setup(map);
      try {
        assert.ok(s.targets.length >= 6, `${map}: ${s.targets.length} targets`);
        assert.ok(s.room.isFull, 'a second person cannot join');
        s.step(10_000);
        assert.equal((s.room as unknown as { match: { endsAt: number | null } }).match.endsAt, null, 'no timer');
        assert.equal(MODES.training.scoreLimit, 0);
      } finally {
        s.room.close();
      }
    }
  });

  it('you cannot be hurt; a target that goes down scores nothing and comes back at its spot', () => {
    const s = setup();
    try {
      s.step(4000);
      const t = s.targets[0]!;
      const home = { x: t.state.x, z: t.state.z };
      s.room.damage(s.me, t, 500, true, 'rifle', { x: 0, y: 0, z: 0 }, s.now);
      s.room.damage(s.me, s.me, 500, false, 'egg', { x: 0, y: 0, z: 0 }, s.now);
      assert.equal(s.me.alive, true);
      assert.equal(s.me.hp, 100, 'not even self-damage');
      s.room.damage(t, s.me, 500, true, 'rifle', { x: 0, y: 0, z: 0 }, s.now);
      assert.equal(t.alive, false, 'the target went down');
      assert.equal(s.me.info.kills, 0, 'no kill counted');
      assert.equal(s.me.info.score, 0, 'no score');
      s.step(MODES.training.respawnMs + 200);
      assert.equal(t.alive, true, 'back after a few seconds');
      if (!(s.room as unknown as { targets: Map<number, { along: unknown }> }).targets.get(t.pid)?.along) assert.ok(Math.hypot(t.state.x - home.x, t.state.z - home.z) < 0.01, 'at its own spot');
      // A hit target heals once you stop hitting it.
      s.room.damage(t, s.me, 30, false, 'rifle', { x: 0, y: 0, z: 0 }, s.now);
      assert.equal(t.hp, 70);
      s.step(3200);
      assert.equal(t.hp, 100);
    } finally {
      s.room.close();
    }
  });

  it('some targets strafe, and targets never shoot', () => {
    const s = setup();
    try {
      s.step(3000);
      const before = s.targets.map((t) => ({ x: t.state.x, z: t.state.z }));
      s.step(1000);
      const moved = s.targets.filter((t, i) => Math.hypot(t.state.x - before[i]!.x, t.state.z - before[i]!.z) > 0.2);
      assert.ok(moved.length >= 1 && moved.length < s.targets.length, `${moved.length} of ${s.targets.length} move`);
      assert.equal(s.events.filter((e) => e.event === 'shot').length, 0, 'no shots fired by targets');
    } finally {
      s.room.close();
    }
  });

  it('the B menu gives every gun and knife (one gun + one knife), refills grenades, and refuses anything else', () => {
    const s = setup();
    try {
      for (const id of [...TRAINING_GUNS, ...TRAINING_KNIVES]) {
        assert.equal(s.room.give(s.me, { weapon: id }), null, id);
        assert.equal(s.me.weapon, id, `${id} in hand`);
        assert.equal(s.me.info.loadout.length, 2);
        assert.equal(s.me.info.loadout.filter((w) => isMelee(w)).length, 1);
      }
      assert.equal(TRAINING_GUNS.length + TRAINING_KNIVES.length, Object.keys(WEAPONS).length, 'every weapon in the game');
      s.me.eggs = s.me.smokes = 0;
      assert.equal(s.room.give(s.me, { grenade: 'egg' }), null);
      assert.equal(s.room.give(s.me, { grenade: 'smoke' }), null);
      assert.ok(s.me.eggs > 0 && s.me.smokes > 0);
      assert.ok(s.room.give(s.me, { weapon: 'nuke' as never }));
      assert.ok(s.room.give(s.me, { grenade: 'nuke' as never }));
      assert.ok(s.room.give(s.me, null));
    } finally {
      s.room.close();
    }
  });

  it('infinite ammo and instant reload; nothing is ever recorded', () => {
    const s = setup();
    try {
      s.step(100);
      assert.equal(s.me.mods?.infiniteAmmo, true);
      assert.equal(s.me.mods?.instantReload, true);
      s.step(60_000);
      assert.equal(s.ended, 0, 'the match never ends, so no rewards, rank, wins, leaderboard or history');
    } finally {
      s.room.close();
    }
  });
});
