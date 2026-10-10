import { round, type FlagEventKind, type FlagState } from '@game/shared';
import type { GameServer } from '../types';
import { GameRoom, type RoomHooks, type RoomOptions } from './GameRoom';
import type { ServerPlayer } from './ServerPlayer';

const TOUCH_RADIUS = 1.6;
const CAPTURE_RADIUS = 2.2;
/** A dropped flag goes home by itself after this long. */
const AUTO_RETURN_MS = 25_000;
const CAPTURE_SCORE = 300;
const RETURN_SCORE = 50;

interface Flag {
  team: 1 | 2;
  baseX: number;
  baseZ: number;
  x: number;
  y: number;
  z: number;
  carrier: ServerPlayer | null;
  atBase: boolean;
  droppedAt: number;
}

/** Capture the Flag: grab the enemy flag and bring it to your own (while yours is home). */
export class CtfRoom extends GameRoom {
  private readonly flags: Flag[];

  constructor(io: GameServer, options: RoomOptions, hooks: RoomHooks) {
    super(io, options, hooks);
    this.flags = this.map.flags.map((f) => ({ team: f.team, baseX: f.x, baseZ: f.z, x: f.x, y: 0, z: f.z, carrier: null, atBase: true, droppedAt: 0 }));
  }

  protected override joinExtras(_player: ServerPlayer) {
    return { blocks: [], flags: this.states() };
  }

  protected override onMatchStart(_now: number): void {
    for (const f of this.flags) this.home(f);
    for (const p of this.players.values()) p.carryingFlag = 0;
    this.emitFlag('returned', 1, 0);
  }

  protected override onPlayerDeath(victim: ServerPlayer, now: number): void {
    super.onPlayerDeath(victim, now);
    this.drop(victim, now);
  }

  protected override onPlayerLeave(player: ServerPlayer): void {
    this.drop(player, performance.now());
  }

  protected override fixedUpdate(now: number): void {
    super.fixedUpdate(now);
    if (!this.flags) return;
    const playing = this.phase === 'playing';
    for (const flag of this.flags) {
      if (flag.carrier) {
        const c = flag.carrier;
        flag.x = c.state.x;
        flag.y = c.state.y;
        flag.z = c.state.z;
        const own = this.flags.find((f) => f.team === c.info.team);
        if (playing && own?.atBase && Math.hypot(c.state.x - own.baseX, c.state.z - own.baseZ) < CAPTURE_RADIUS) this.capture(c, flag, now);
        continue;
      }
      if (!flag.atBase && now - flag.droppedAt > AUTO_RETURN_MS) {
        this.home(flag);
        this.emitFlag('returned', flag.team, 0);
        continue;
      }
      if (!playing) continue;
      for (const p of this.players.values()) {
        if (!p.alive || Math.hypot(p.state.x - flag.x, p.state.z - flag.z) > TOUCH_RADIUS || Math.abs(p.state.y - flag.y) > 2) continue;
        if (p.info.team !== flag.team && !p.carryingFlag && !p.vehicle) {
          flag.carrier = p;
          flag.atBase = false;
          p.carryingFlag = flag.team;
          p.shieldUntil = 0;
          this.emitFlag('taken', flag.team, p.pid);
          break;
        }
        if (p.info.team === flag.team && !flag.atBase) {
          this.home(flag);
          p.info.score += RETURN_SCORE;
          this.emitFlag('returned', flag.team, p.pid);
          this.emitScores();
          break;
        }
      }
    }
  }

  private capture(carrier: ServerPlayer, flag: Flag, now: number): void {
    this.home(flag);
    carrier.carryingFlag = 0;
    carrier.info.score += CAPTURE_SCORE;
    this.addTeamScore(carrier.info.team, 1);
    this.emitFlag('captured', flag.team, carrier.pid);
    this.checkScoreLimit(now);
  }

  private drop(p: ServerPlayer, now: number): void {
    const flag = this.flags?.find((f) => f.carrier === p);
    p.carryingFlag = 0;
    if (!flag) return;
    flag.carrier = null;
    flag.atBase = false;
    flag.droppedAt = now;
    flag.x = p.state.x;
    flag.y = p.state.y;
    flag.z = p.state.z;
    this.emitFlag('dropped', flag.team, p.pid);
  }

  private home(flag: Flag): void {
    if (flag.carrier) flag.carrier.carryingFlag = 0;
    flag.carrier = null;
    flag.atBase = true;
    flag.x = flag.baseX;
    flag.y = 0;
    flag.z = flag.baseZ;
  }

  private states(): FlagState[] {
    return this.flags.map((f) => ({ team: f.team, x: round(f.x, 2), y: round(f.y, 2), z: round(f.z, 2), carrier: f.carrier?.pid ?? 0, atBase: f.atBase }));
  }

  private emitFlag(kind: FlagEventKind, team: 1 | 2, pid: number): void {
    this.io.to(this.channel).emit('flag', { kind, team, pid, flags: this.states() });
  }
}
