import { MAX_PENDING_FIRES } from '@game/shared';
import { EMPTY_TICKBASE, LATE_CSGO, movementSteps, stepTickbase, type CommandIntent, type EraTable, type TickAction, type TickContext, type TickbaseState } from '@game/shared/hvh/v2';

/** Upper bound on commands kept while waiting for the server to execute them (about 2 s of ticks). */
export const MAX_UNACKED = 128;

/** `intent` is as built; `shot` is the fire message attached to it (stepped as intent.fire), if any. */
interface Entry { seq: number; intent: CommandIntent; shot?: number; ctx: TickContext; before: TickbaseState; after: TickbaseState; action: TickAction }

export const NO_SIGHT: TickContext = Object.freeze({ enemyVisible: false });
/** What a command the server will not step through the tickbase does: one plain movement step. */
const RUN: TickAction = Object.freeze({ kind: 'run' });

/**
 * Client-side prediction of the server's per-player tickbase. It holds no HvH rules: every step
 * is the shared `stepTickbase`, replayed exactly as the server runs it. Mirrors LocalPlayer's
 * movement reconciliation: drop acknowledged commands, snap to the server state, replay the rest.
 */
export class PredictedTickbase {
  private current: TickbaseState;
  private unacked: Entry[] = [];
  /** Commands referenced by `fire` messages already sent, oldest first (the server's pending fires). */
  private shots: number[] = [];
  private mismatchCount = 0;
  private lastApplied = -Infinity;
  /** The newest seq handed to the socket; the server runs only seqs above the last it accepted. */
  private lastSent = -Infinity;
  /** False until we hold a server state; until then nothing can be compared. */
  private synced: boolean;
  /** False while our own player is dead: the server runs commands then without stepping the tickbase. */
  private alive = true;

  constructor(private readonly era: EraTable = LATE_CSGO, initial?: TickbaseState) {
    this.current = initial ? { ...initial } : EMPTY_TICKBASE(0);
    this.synced = initial !== undefined;
  }

  get state(): TickbaseState { return this.current; }
  get mismatches(): number { return this.mismatchCount; }
  get pendingCount(): number { return this.unacked.length; }

  /**
   * Run one command the server can execute, in seq order. The server drops a command whose seq is
   * not above the last one it accepted, so we skip those too. Returns false when skipped. `ctx` is
   * the enemy sight the command is predicted with; reconcile replays the command with the same one.
   * LocalPlayer applies each command when it is built (its movement depends on the action); `sent`
   * then takes back the commands the network loses.
   */
  apply(seq: number, intent: CommandIntent, ctx: TickContext = NO_SIGHT): boolean {
    if (seq <= this.lastApplied) return false;
    this.lastApplied = seq;
    if (!this.alive) return false;
    this.unacked.push(this.step({ seq, intent, ctx, before: this.current, after: this.current, action: RUN }));
    if (this.unacked.length > MAX_UNACKED) this.unacked.shift();
    return true;
  }

  /**
   * Command `seq` leaves for the server (LocalPlayer.emitted). Seqs go out in order unless the
   * simulated link loses or reorders them, and the server runs only seqs above the last it
   * accepted, so every predicted command below `seq` that never left will never run: it is
   * dropped, any fire message it carried waits for the next command (as on the server), and the
   * later commands are replayed. Returns the dropped seqs (LocalPlayer drops their movement too).
   */
  sent(seq: number): number[] {
    if (seq <= this.lastSent) return [];
    const after = this.lastSent;
    this.lastSent = seq;
    const i = this.unacked.findIndex((e) => e.seq > after && e.seq < seq);
    if (i < 0) return [];
    const replayed = this.unacked.splice(i);
    const dropped = replayed.filter((e) => e.seq < seq).map((e) => e.seq);
    this.shots = [...replayed.flatMap((e) => (e.shot === undefined ? [] : [e.shot])), ...this.shots].slice(-MAX_PENDING_FIRES);
    this.current = replayed[0]!.before;
    for (const e of replayed) if (e.seq >= seq) this.unacked.push(this.step(e));
    return dropped;
  }

  /** Steps `e` from the current state, attaching the oldest waiting fire message as the server does. */
  private step(e: Entry): Entry {
    const shot = this.attaches(e.seq) ? this.shots.shift() : undefined;
    const { next, action } = stepTickbase(this.current, shot === undefined ? e.intent : { ...e.intent, fire: true }, this.era, e.ctx);
    const stepped = { ...e, shot, before: this.current, after: next, action };
    this.current = next;
    return stepped;
  }

  /**
   * The action `apply(seq, intent, ctx)` would take now, changing nothing. Movement is predicted
   * before the command's choke bit is decided; that bit only picks 'choke' over 'run', so it never
   * changes movementSteps.
   */
  peek(seq: number, intent: CommandIntent, ctx: TickContext = NO_SIGHT): TickAction {
    if (seq <= this.lastApplied || !this.alive) return RUN;
    return stepTickbase(this.current, this.attaches(seq) ? { ...intent, fire: true } : intent, this.era, ctx).action;
  }

  /**
   * Whether command `seq` should be predicted with a traced enemy sight: an exploit on and not
   * firing. The server also skips the trace at a full charge (enemyInSight), where sight cannot
   * change the action; the client traces then too, because a correction from hvhState can turn
   * that full charge into a partial one, and the replay must then step with a real sight.
   */
  needsSight(seq: number, intent: CommandIntent): boolean {
    return (intent.doubleTap || intent.hideShots) && !intent.fire && !this.attaches(seq);
  }

  /** Movement steps of predicted command `seq` (after the latest replay), or undefined if not held. */
  stepsFor(seq: number): number | undefined {
    const e = this.unacked.find((x) => x.seq === seq);
    return e && movementSteps(e.action);
  }

  /**
   * The server attaches the oldest waiting fire message to the first command with seq >= its
   * reference (HvhRoom.runCommand), also when the command that carried the shot was lost.
   */
  private attaches(seq: number): boolean {
    const shot = this.shots[0];
    return shot !== undefined && shot <= seq;
  }

  /**
   * A life boundary (our own death or spawn). The server resets the tickbase on both
   * (HvhRoom.onPlayerDeath / spawn) and clears its pending fires, so nothing predicted so far
   * still applies: drop it, start from `state` (default EMPTY_TICKBASE), and compare nothing until
   * the next hvhState. With `alive` false (death), commands are not predicted until the next reset.
   */
  reset(state?: TickbaseState, alive = true): void {
    this.current = state ? { ...state } : EMPTY_TICKBASE(0);
    this.unacked = [];
    this.shots = [];
    this.synced = false;
    this.alive = alive;
  }

  /**
   * A v2 hitscan `fire` message referencing command `seq` was sent. It leaves at once, while the
   * command can still be held, delayed or lost on the way; prediction attaches it like the server.
   */
  shot(seq: number): void {
    this.shots.push(seq);
    if (this.shots.length > MAX_PENDING_FIRES) this.shots.shift();
  }

  /** `server` is the state after the command `lastAckSeq`. */
  reconcile(server: TickbaseState, lastAckSeq: number): void {
    const at = this.unacked.find((e) => e.seq === lastAckSeq);
    if (this.synced && at) {
      const p = at.after;
      const same = p.tickbase === server.tickbase && p.charge === server.charge && p.choked === server.choked
        && p.armed === server.armed;
      if (!same) this.mismatchCount++;
    }
    this.synced = true;
    this.unacked = this.unacked.filter((e) => e.seq > lastAckSeq);
    let s: TickbaseState = { ...server };
    for (const e of this.unacked) {
      const step = stepTickbase(s, e.shot === undefined ? e.intent : { ...e.intent, fire: true }, this.era, e.ctx);
      e.before = s;
      s = e.after = step.next;
      e.action = step.action;
    }
    this.current = s;
  }
}

/**
 * Intent for one outgoing command.
 * - fire: only the command that carries a shot (`shotSeq` is the seq the `fire` message references),
 *   and only for hitscan weapons. Holding the trigger without a shot never sets it.
 * - choke: only a frame the CommandChoker holds back; the frame that releases a batch is not choke.
 * There is no defensive intent: defensive is an anti-aim pattern, not a tickbase shift.
 */
export function commandIntent(o: {
  seq: number; shotSeq: number | null; hitscan: boolean; held: boolean;
  exploit: 'off' | 'doubleTap' | 'hideShots';
  /** The trigger is down (the R8 hammer pull); sent only for hitscan weapons. */
  trigger?: boolean;
}): CommandIntent {
  const fire = o.hitscan && o.shotSeq === o.seq;
  return {
    fire,
    choke: o.held && !fire,
    doubleTap: o.exploit === 'doubleTap',
    hideShots: o.exploit === 'hideShots',
    ...(o.hitscan && o.trigger ? { trigger: true } : {}),
  };
}

/**
 * What a `fire` message's `command` points at. v2 hitscan: the next command to be built, which
 * carries intent.fire (`shotSeq`). Legacy HvH (and melee/projectile): the last acked seq, as before v2.
 */
export function shotReference(v2Hitscan: boolean, nextSeq: number, ack: number): { command: number; shotSeq: number | null } {
  return v2Hitscan ? { command: nextSeq, shotSeq: nextSeq } : { command: ack, shotSeq: null };
}

/**
 * Clock correction (as CS:GO's): the server runs one of our commands per tick on average, so after
 * any server stall the commands that piled up stay queued for good (input delay, and 'command flood'
 * drops at the cap). When every hvhState in the last `window` showed more than `target` queued, the
 * client skips one command in `every` until the backlog is gone. Short bursts (fake-lag batches,
 * jitter) never trigger it: the window's minimum drops to 0 between them.
 *
 * Reports arrive a round trip late, so each one is corrected by the skips it cannot see yet: a report
 * covers every command up to lastAckSeq + queued, and a skip made while `nextSeq` was beyond that
 * point had not reached the server when it reported.
 */
export class CommandClock {
  private readonly reports: { queued: number; received: number }[] = [];
  /** The nextSeq at each recent skip (the gap sits just before that seq). */
  private skips: number[] = [];
  private sinceSkip = 0;
  constructor(private readonly target = 1, private readonly window = 32, private readonly every = 4) {}
  /** One hvhState: `queued`, and the newest seq the server had (lastAckSeq + queued). */
  observe(queued: number, received: number): void {
    this.reports.push({ queued, received });
    if (this.reports.length > this.window) this.reports.shift();
    const oldest = this.reports[0]!.received;
    this.skips = this.skips.filter((seq) => seq > oldest);
  }
  /** Asked once per command tick, with the seq the next command would get: true means do not produce it. */
  skip(nextSeq: number): boolean {
    this.sinceSkip++;
    if (this.reports.length < this.window || this.sinceSkip < this.every) return false;
    let backlog = Infinity;
    for (const r of this.reports) backlog = Math.min(backlog, r.queued - this.skips.filter((seq) => seq > r.received).length);
    if (backlog <= this.target) return false;
    this.sinceSkip = 0;
    this.skips.push(nextSeq);
    return true;
  }
  reset(): void {
    this.reports.length = 0;
    this.skips = [];
    this.sinceSkip = 0;
  }
}

/**
 * Maps client server-time (ms) to the server's tick counter, which advances at the era tick rate.
 * Each hvhState gives (tick, arrival time). The state was produced one network delay before it
 * arrived, so the estimate lags the true tick by about that delay (the view tick is slightly
 * old, never ahead), small next to the interpolation delay it is used with.
 */
export class TickClock {
  private tick = 0;
  private at = 0;
  private known = false;
  constructor(private readonly tickRate: number = LATE_CSGO.tickRate) {}
  sample(tick: number, serverTimeMs: number): void { this.tick = tick; this.at = serverTimeMs; this.known = true; }
  /** The server tick the client is displaying at `renderTimeMs` (= serverNow() - INTERP_DELAY_MS). */
  viewedTick(renderTimeMs: number): number {
    return this.known ? Math.max(0, this.tick + Math.floor(((renderTimeMs - this.at) * this.tickRate) / 1000)) : 0;
  }
}
