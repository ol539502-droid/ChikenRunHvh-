/*
 * v2 HvH rounds (R63): a dead player watches a living teammate until they respawn. This is the pure
 * choice of whom to watch; GameSession places the camera. The order is by pid, so cycling is stable
 * while players come and go.
 */

export interface SpectateCandidate {
  readonly pid: number;
  readonly team: number;
  readonly alive: boolean;
}

/** The living players on `team`, in pid order. Team 0 (no teams) has no teammates. */
export function livingTeammates(team: number, players: Iterable<SpectateCandidate>): number[] {
  if (team === 0) return [];
  const pids: number[] = [];
  for (const p of players) if (p.team === team && p.alive) pids.push(p.pid);
  return pids.sort((a, b) => a - b);
}

export class SpectateTarget {
  private pid: number | null = null;

  /** The teammate being watched, or null. */
  get current(): number | null {
    return this.pid;
  }

  /**
   * Keeps the watched teammate while they live. Otherwise the next living teammate after them in
   * pid order (the first one when nobody was watched); null when no teammate lives.
   */
  update(team: number, players: Iterable<SpectateCandidate>): number | null {
    const living = livingTeammates(team, players);
    if (this.pid === null || !living.includes(this.pid)) this.pid = this.after(living, 1);
    return this.pid;
  }

  /** A click: the next (`dir` 1) or previous (-1) living teammate, wrapping around. */
  cycle(team: number, players: Iterable<SpectateCandidate>, dir: 1 | -1 = 1): number | null {
    this.pid = this.after(livingTeammates(team, players), dir);
    return this.pid;
  }

  /** The player respawned: spectating ends. */
  reset(): void {
    this.pid = null;
  }

  /** The living teammate `dir` steps from the watched pid (which may have died or left). */
  private after(living: readonly number[], dir: 1 | -1): number | null {
    if (living.length === 0) return null;
    if (this.pid === null) return living[0]!;
    const from = this.pid;
    if (dir === 1) return living.find((pid) => pid > from) ?? living[0]!;
    return [...living].reverse().find((pid) => pid < from) ?? living[living.length - 1]!;
  }
}

/** Time constant of the spectate view's yaw smoothing, seconds. */
export const SPECTATE_YAW_TAU = 0.25;
/** Fastest turn of the spectate view, radians per second. */
export const SPECTATE_MAX_TURN = 2 * Math.PI;

function wrap(a: number): number {
  return Math.atan2(Math.sin(a), Math.cos(a));
}

/**
 * The spectate camera's yaw. The followed teammate's public eye yaw is anti-aimed, so jitter and
 * defensive flicks would shake a camera that copies it: the view eases towards it (time constant
 * SPECTATE_YAW_TAU, the short way round) and never turns faster than SPECTATE_MAX_TURN. A spin
 * still turns the view, at that rate at most.
 */
export class SmoothedYaw {
  private yaw: number | null = null;

  /** A new teammate: the next step snaps to their yaw. */
  reset(): void {
    this.yaw = null;
  }

  step(target: number, dt: number): number {
    if (this.yaw === null) return (this.yaw = target);
    const delta = wrap(target - this.yaw) * (1 - Math.exp(-Math.max(0, dt) / SPECTATE_YAW_TAU));
    const limit = SPECTATE_MAX_TURN * Math.max(0, dt);
    this.yaw = wrap(this.yaw + Math.max(-limit, Math.min(limit, delta)));
    return this.yaw;
  }
}

/** The spectate view's pitch stays within this of level, radians (defensive pitch snaps to +-89 deg). */
export const SPECTATE_PITCH_BAND = (30 * Math.PI) / 180;
/** Time constant of the spectate view's pitch smoothing, seconds (pitch flicks come in 4-tick bursts). */
export const SPECTATE_PITCH_TAU = 0.5;

/**
 * The spectate camera's pitch (M2). The public pitch is anti-aimed too ('down', 'random' and
 * 'jitter' windows snap it to +-89 deg for a few ticks), so the target is clamped to a calm band
 * around level, then eased like the yaw (SPECTATE_PITCH_TAU, at most SPECTATE_MAX_TURN).
 */
export class SmoothedPitch {
  private pitch: number | null = null;

  /** A new teammate: the next step snaps to their pitch. */
  reset(): void {
    this.pitch = null;
  }

  step(target: number, dt: number): number {
    const calm = Math.max(-SPECTATE_PITCH_BAND, Math.min(SPECTATE_PITCH_BAND, target));
    if (this.pitch === null) return (this.pitch = calm);
    const delta = (calm - this.pitch) * (1 - Math.exp(-Math.max(0, dt) / SPECTATE_PITCH_TAU));
    const limit = SPECTATE_MAX_TURN * Math.max(0, dt);
    this.pitch += Math.max(-limit, Math.min(limit, delta));
    return this.pitch;
  }
}
