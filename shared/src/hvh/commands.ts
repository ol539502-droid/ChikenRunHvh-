import { clamp } from '../math';
import { SIM_DT } from '../constants';
import type { InputFrame } from '../physics';
import { HVH, type HvhCoreSettings, type HvhLoadout } from '../hvh';
import type { WeaponDef } from '../weapons';

/** Legacy choke cap. v2 rooms pass their era's maxChoke instead. */
export const LEGACY_MAX_CHOKE = 12;
/** Shared choke policy for outgoing commands and remote presentation. */
export function fakeLagTicks(core: HvhCoreSettings, seq: number, speed: number, shooting = false, maxChoke = LEGACY_MAX_CHOKE): number {
  const limit = clamp(Math.round(core.fakeLag),0,maxChoke);
  if (shooting && core.fakeLagBreakOnShot) return 0;
  const ticks = core.fakeLagMode === 'velocity' ? Math.round(limit * Math.min(1,Math.max(0,speed)/6))
    : core.fakeLagMode === 'peek' ? shooting ? 0 : limit
    : core.fakeLagMode === 'adaptive' ? Math.min(limit,Math.ceil(0.6/Math.max(0.1,speed)/SIM_DT))
    : core.fakeLagMode === 'random' ? Math.floor(((Math.imul(Math.floor(seq/13),1103515245)>>>0)/0x100000000)*(limit+1)) : limit;
  return clamp(ticks,0,limit);
}

/** Correct input axes when changing command angles; world movement intent stays identical. */
export function correctMovement(frame: InputFrame, commandYaw: number): InputFrame {
  const x = -Math.sin(frame.yaw) * frame.forward + Math.cos(frame.yaw) * frame.right;
  const z = -Math.cos(frame.yaw) * frame.forward - Math.sin(frame.yaw) * frame.right;
  return { ...frame, yaw: commandYaw, forward: -Math.sin(commandYaw) * x - Math.cos(commandYaw) * z,
    right: Math.cos(commandYaw) * x - Math.sin(commandYaw) * z };
}
/** At most one normal command per server tick; batching grants no free movement steps. */
export class CommandBuffer {
  private readonly queue: Readonly<InputFrame>[] = [];
  private latest = 0;
  enqueue(frame: InputFrame): boolean {
    if (frame.seq <= this.latest || this.queue.length >= 32) return false;
    this.latest = frame.seq; this.queue.push(Object.freeze({ ...frame })); return true;
  }
  next(): Readonly<InputFrame> | undefined { return this.queue.shift(); }
  clear(): void { this.queue.length = 0; }
  get size(): number { return this.queue.length; }
}
export interface NetworkConfig { latencyMs: number; jitterMs: number; loss: number }
export class NetworkSimulator<T> {
  private queue: { time: number; order: number; payload: T }[] = [];
  private seed: number; private order = 0;
  constructor(readonly config: NetworkConfig, seed = 1) { this.seed = seed; }
  private random(): number { this.seed = (Math.imul(this.seed, 1664525) + 1013904223) >>> 0; return this.seed / 0x100000000; }
  send(payload: T, now: number): void {
    if (this.random() < clamp(this.config.loss, 0, 0.25)) return;
    this.queue.push({ time: now + clamp(this.config.latencyMs + (this.random() * 2 - 1) * this.config.jitterMs, 0, 300), order: this.order++, payload: JSON.parse(JSON.stringify(payload)) as T });
  }
  receive(now: number): T[] {
    this.queue.sort((a, b) => a.time - b.time || a.order - b.order);
    const due = this.queue.filter(p => p.time <= now); this.queue = this.queue.filter(p => p.time > now);
    return due.map(p => p.payload);
  }
}
export class CommandChoker {
  private pending: Readonly<InputFrame>[] = [];
  push(frame: Readonly<InputFrame>, choke: number, flush = false, maxChoke = LEGACY_MAX_CHOKE): readonly InputFrame[] {
    this.pending.push(Object.freeze({ ...frame }));
    if (!flush && this.pending.length <= clamp(Math.round(choke), 0, maxChoke)) return [];
    const batch = this.pending; this.pending = []; return batch;
  }
  /** True when push(frame, choke, flush) would hold the frame back instead of releasing a batch. */
  wouldHold(choke: number, flush = false, maxChoke = LEGACY_MAX_CHOKE): boolean { return !flush && this.pending.length + 1 <= clamp(Math.round(choke), 0, maxChoke); }
  clear(): void { this.pending = []; }
}
export function exploitMode(mode: HvhLoadout['exploit'], weapon: WeaponDef, mag: number): HvhLoadout['exploit'] {
  return weapon.projectile || weapon.melee || weapon.burst || mag < (mode === 'doubleTap' ? 2 : 1) ? 'off' : mode;
}
/** Burst, concealment and defensive transitions spend one shared combat resource. */
export class ExploitResource {
  ticks = 0; playerTick = 0; nextAttackTick = 0; recoveryUntil = 0; protectedUntil = 0; defensiveUntil = 0;
  private wallTick = 0;
  readonly capacity = 32;
  step(wallTick: number, attacking: boolean, choked: boolean): void {
    this.wallTick = wallTick;
    this.playerTick++;
    if (!attacking && wallTick >= this.recoveryUntil) this.ticks = Math.min(this.capacity, this.ticks + (choked ? 0.125 : 0.25));
  }
  reset(): void { this.ticks = this.playerTick = this.nextAttackTick = this.recoveryUntil = this.protectedUntil = this.defensiveUntil = this.wallTick = 0; }
  get charge(): number { return this.ticks / this.capacity; }
  get defensive(): boolean { return this.wallTick < this.defensiveUntil; }
  ready(mode: HvhLoadout['exploit']): boolean { return mode !== 'off' && this.ticks >= (mode === 'doubleTap' ? this.capacity : 14); }
  fire(intervalMs: number, mode: 'off' | 'doubleTap' | 'hideShots', wallTick: number): { shots: number; hidden: boolean } {
    if (this.playerTick < this.nextAttackTick) return { shots: 0, hidden: false };
    const intervalTicks = Math.max(1, Math.ceil(intervalMs / (SIM_DT * 1000)));
    this.nextAttackTick = this.playerTick + intervalTicks;
    const dtCost = this.capacity;
    if (mode === 'doubleTap' && this.ready(mode)) {
      this.ticks -= dtCost;
      this.nextAttackTick = this.playerTick + Math.max(intervalTicks, 20);
      this.recoveryUntil = wallTick + 32; return { shots: 2, hidden: false };
    }
    const hidden = mode === 'hideShots' && this.ready(mode);
    if (hidden) { this.ticks -= 14; this.protectedUntil = wallTick + Math.ceil(HVH.hideMs / (SIM_DT * 1000)); this.recoveryUntil = wallTick + 16; }
    return { shots: 1, hidden };
  }
  defend(wallTick: number): boolean {
    if (this.ticks < 12 || wallTick < this.defensiveUntil) return false;
    this.ticks -= 12; this.defensiveUntil = wallTick + 8; this.recoveryUntil = wallTick + 32; return true;
  }
}
