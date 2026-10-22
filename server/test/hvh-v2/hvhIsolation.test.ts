/*
 * Gate (R39): no HvH v2 rule leaks into other modes. For every mode the room factory creates other
 * than 'hvh', a seeded short match runs twice: once with HvH intents (fire, choke, DT, HS,
 * defensive, plus a clientTick) injected into every command, once without. Outcomes must be
 * identical.
 *
 * Non-HvH rooms (bots, zombies, bomb rounds, loot) draw on Math.random and read performance.now
 * in many places, so each run installs a deterministic harness for its duration: Math.random is a
 * seeded mulberry32 and performance.now is the driver's tick clock. Both runs get the same seed.
 *
 * "Outcome" per mode: every room broadcast in order, everything sent to each player's own socket (spawns, kills, damage, scores, rounds, loot,
 * zombie waves, ...), and per tick, per player: position, hp, armor, alive, kills, deaths, score,
 * weapon, magazine, acked seq; plus the match phase and team scores per tick.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DEFAULT_APPEARANCE, DEFAULT_LOADOUT, INTERP_DELAY_MS, MODES, MODE_IDS, mulberry32, type ModeId } from '@game/shared';
import { createRoom } from '../../src/rooms/modes';
import type { GameRoom } from '../../src/rooms/GameRoom';
import type { ServerPlayer } from '../../src/rooms/ServerPlayer';
import { fakeIo, place, stepRoom } from '../helpers';
import { CLOCK_BASE, TICK_MS, prng } from './hvhMatch';

const TICKS = 1_200;
/** Modes whose fighting starts late (bomb warmup + 15 s freeze, zombie countdown + first wave) run longer. */
const LONG_TICKS = 2_200;
const LONG: readonly ModeId[] = ['bomb', 'face', 'zombie', 'backrooms'];
const CLUSTER: readonly ModeId[] = ['bomb', 'face'];
const HUMANS = 4;
const SEED = 0x150;
const INJECTED = { fire: true, choke: true, doubleTap: true, hideShots: true, defensive: true };

/** Every mode createRoom can build except HvH. */
const MODES_UNDER_TEST = MODE_IDS.filter((m): m is Exclude<ModeId, 'hvh'> => m !== 'hvh');

const ticksFor = (mode: ModeId): number => (LONG.includes(mode) ? LONG_TICKS : TICKS);

function withDeterministicGlobals<T>(seed: number, clock: { now: number }, fn: () => T): T {
  const random = Math.random;
  const now = performance.now;
  Math.random = mulberry32(seed);
  performance.now = () => clock.now;
  try {
    return fn();
  } finally {
    Math.random = random;
    performance.now = now;
  }
}

interface TickOutcome { phase: string; players: { pid: number; hp: number }[] }

interface Outcome {
  events: unknown[];
  /** Per human: everything the room sent to that player's socket, in order. */
  sent: unknown[][];
  /** Any player with the HvH tools on (never in a non-HvH room). */
  hvhEnabled: boolean;
  ticks: unknown[];
  stats: { moved: boolean; damage: number; kills: number; fires: number };
}

function runMode(mode: ModeId, inject: boolean): Outcome {
  const clock = { now: CLOCK_BASE };
  return withDeterministicGlobals(SEED, clock, () => {
    const { io, events } = fakeIo();
    const def = MODES[mode];
    // The cheapest map the mode allows (farm / flat), else its first; bots where the mode has seats and allows them.
    const map = def.maps.find((m) => m === 'farm' || m === 'flat' || m === 'sandstown') ?? def.maps[0]!;
    // Zombie modes: one seat below maxHumans, because a room at maxHumans refuses the zombie bots too
    // (GameRoom.join checks isFull before anything else; see the Task 13 report).
    const humanCount = def.zombies ? Math.min(HUMANS, (def.maxHumans ?? def.maxPlayers) - 1) : Math.min(HUMANS, def.maxHumans ?? def.maxPlayers);
    const bots = def.noBots ? 0 : Math.min(2, def.maxPlayers - humanCount);
    const room: GameRoom = createRoom(io, {
      id: `iso-${mode}`, code: 'ISO01', name: 'Isolation', mode, map, private: true, seed: SEED, ...(bots > 0 ? { bots } : {}),
    }, {});
    try {
      const humans: ServerPlayer[] = [];
      const sent: unknown[][] = [];
      for (let i = 0; i < humanCount; i++) {
        const res = room.join(null, { userId: null, name: `H${i}`, appearance: { ...DEFAULT_APPEARANCE }, loadout: [...DEFAULT_LOADOUT] });
        if (!res.ok) throw new Error(`${mode}: ${res.error}`);
        const p = room.players.get(res.selfPid)!;
        // A per-player socket sink (as hvhMatch), so traffic sent to one player is part of the outcome too.
        const sink: unknown[] = [];
        sent.push(sink);
        const emit = (event: string, ...args: unknown[]) => { sink.push(structuredClone({ event, args })); return true; };
        Object.defineProperty(p, 'socket', { value: { id: `iso-${i}`, emit, to() { return { emit() { return true; } }; }, leave() {}, join() {}, volatile: { emit } } });
        humans.push(p);
      }
      room.startNow(clock.now);
      // Bomb modes spawn the teams far apart behind walls: start the scripted players face to face (warmup is free play).
      if (CLUSTER.includes(mode)) humans.forEach((p, i) => place(p, room.map.spawns[0]!.x + (i % 2) * 6, room.map.spawns[0]!.z + i * 0.8));
      const scripts = humans.map((_, i) => prng(SEED * 7 + i));
      const seqs = humans.map(() => 0);
      const shots = humans.map(() => 0);
      const start = humans.map((p) => ({ x: p.state.x, z: p.state.z }));
      let fires = 0;
      const ticks: unknown[] = [];
      const total = ticksFor(mode);
      for (let tick = 1; tick <= total; tick++) {
        clock.now = CLOCK_BASE + tick * TICK_MS;
        humans.forEach((p, i) => {
          const r = scripts[i]!;
          // Aim at the nearest living opponent (bots and zombies included; everyone without teams).
          let best: ServerPlayer | undefined;
          let bestD = Infinity;
          for (const q of room.players.values()) {
            if (q === p || !q.alive || (p.info.team !== 0 && q.info.team === p.info.team)) continue;
            const d = Math.hypot(q.state.x - p.state.x, q.state.z - p.state.z);
            if (d < bestD) { bestD = d; best = q; }
          }
          const eye = room.eyeOf(p);
          let yaw = (r() * 2 - 1) * Math.PI;
          let pitch = 0;
          let dir = { x: -Math.sin(yaw), y: 0, z: -Math.cos(yaw) };
          if (best) {
            const dx = best.state.x - eye.x, dy = best.state.y + 0.8 - eye.y, dz = best.state.z - eye.z;
            const len = Math.hypot(dx, dy, dz);
            dir = { x: dx / len, y: dy / len, z: dz / len };
            yaw = Math.atan2(-dx, -dz);
            pitch = Math.asin(dy / len);
          }
          const seq = ++seqs[i]!;
          const command: Record<string, unknown> = {
            seq, forward: r() < 0.7 ? 1 : 0, right: r() < 0.3 ? (r() < 0.5 ? -1 : 1) : 0, jump: r() < 0.03, crouch: r() < 0.05, yaw, pitch,
          };
          if (inject) { command.intent = { ...INJECTED }; command.clientTick = room.hvhTick; }
          room.handleInput(p, command);
          if (p.alive && p.mag <= 0) room.handleReload(p, clock.now);
          else if (p.alive && best && r() < 0.15) {
            fires++;
            room.handleFire(p, { shot: ++shots[i]!, weapon: p.weapon, dx: dir.x, dy: dir.y, dz: dir.z, t: clock.now - INTERP_DELAY_MS, command: seq, aiming: false });
          }
        });
        stepRoom(room, clock.now);
        ticks.push({
          phase: room.phase,
          players: [...room.players.values()].map((p) => ({
            pid: p.pid, x: p.state.x, y: p.state.y, z: p.state.z, hp: p.hp, armor: p.armor, alive: p.alive,
            kills: p.info.kills, deaths: p.info.deaths, score: p.info.score, weapon: p.weapon, mag: p.mag, lastSeq: p.lastSeq,
          })),
        });
      }
      const recorded = events.map((e) => structuredClone({ event: e.event, args: e.args }));
      // Damage events go to player sockets (these players have none): count hp drops instead.
      let damage = 0;
      for (let t = 1; t < ticks.length; t++) {
        const before = new Map((ticks[t - 1] as TickOutcome).players.map((p) => [p.pid, p.hp]));
        for (const p of (ticks[t] as TickOutcome).players) if (p.hp < (before.get(p.pid) ?? 0) && p.hp > 0) damage++;
      }
      const kills = recorded.filter((e) => e.event === 'kill').length;
      const moved = humans.some((p, i) => Math.hypot(p.state.x - start[i]!.x, p.state.z - start[i]!.z) > 1);
      const hvhEnabled = [...room.players.values()].some((p) => p.hvhEnabled);
      return { events: recorded, sent, ticks, hvhEnabled, stats: { moved, damage, kills, fires } };
    } finally {
      room.close();
    }
  });
}

describe('HvH v2 isolation gate', () => {
  it('covers every non-HvH mode the room factory builds', () => {
    assert.deepEqual([...MODES_UNDER_TEST].sort(), MODE_IDS.filter((m) => m !== 'hvh').sort());
    assert.equal(MODES_UNDER_TEST.length, 13);
  });

  for (const mode of MODES_UNDER_TEST) {
    it(`${mode}: HvH intents in every command change nothing`, () => {
      const plain = runMode(mode, false);
      const injected = runMode(mode, true);
      console.log(`[hvhIsolation] ${mode}: events ${plain.events.length}, socket messages ${plain.sent.flat().length}, hits taken ${plain.stats.damage}, kills ${plain.stats.kills}, fire requests ${plain.stats.fires}, moved ${plain.stats.moved}`);
      assert.ok(plain.stats.moved, `${mode}: the scripted players moved`);
      assert.ok(plain.stats.damage > 0, `${mode}: someone took damage`);
      assert.equal(injected.ticks.length, ticksFor(mode));
      for (let t = 0; t < ticksFor(mode); t++) assert.deepStrictEqual(injected.ticks[t], plain.ticks[t], `${mode}: tick ${t + 1}`);
      assert.deepStrictEqual(injected.events, plain.events, `${mode}: room broadcasts`);
      assert.deepStrictEqual(injected.sent, plain.sent, `${mode}: per-player socket traffic`);
      assert.ok(plain.sent.some((s) => s.length > 0), `${mode}: players received socket traffic`);
      // No HvH-only traffic and no HvH tools, with or without the injected intents.
      for (const run of [plain, injected]) {
        assert.equal(run.hvhEnabled, false, `${mode}: hvhEnabled stays false`);
        const hvh = run.sent.flat().filter((m) => ['hvhState', 'shotVerdict', 'hvhDebug'].includes((m as { event: string }).event));
        assert.deepEqual(hvh, [], `${mode}: no HvH v2 messages`);
      }
    });
  }
});
