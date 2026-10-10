import { HITBOX, chickenHeadCenter, directionFromAngles, eyeHeightOf, makeRay, raycastWorld, round, type MeleeTarget, type Vec3 } from '@game/shared';
import type { GameRoom } from './GameRoom';
import type { ServerPlayer } from './ServerPlayer';

/**
 * FaceChiken anti-cheat. The browser can't be trusted (anyone can change the page), so it all
 * runs here, on what the server already knows:
 *
 * - Fog of war: an enemy's position is only sent to you once you could see them (or they're
 *   very close), so a wallhack has nothing to draw.
 * - Silent aim: a shot must go roughly where the player was looking. Shots far off every recent
 *   view direction are thrown away and counted.
 * - Aim lock: people's hits land all over the head; an aimbot hits its exact middle. Hits are
 *   measured from the centre (0 = dead centre, 1 = the edge) and a match average that's too
 *   small is flagged.
 * - Snaps: a big flick of the view that ends dead on a head, shot within a few frames.
 * - Headshot rate: almost nothing but headshots over many hits.
 *
 * Each sign adds to a suspicion score; at 100 the player is removed from the match, takes the
 * loss, and gets a strike (strikes ban them from FaceChiken for a while, see Database).
 */
export const AC = {
  /** View directions remembered per player (input frames, ~60 a second). */
  viewHistory: 8,
  /** A shot further than this from every recent view direction is impossible for a real client. */
  silentAimDeg: 38,
  silentAimScore: 15,
  /** Aim lock: after this many head hits, an average distance from the centre below this... */
  lockMinHeadHits: 12,
  lockHeadMean: 0.22,
  lockMinBodyHits: 15,
  lockBodyMean: 0.16,
  /** Snaps: the view turned at least this far in the last few frames, landing this close to the centre. */
  snapDeg: 55,
  snapFrames: 4,
  snapPrecision: 0.25,
  snapScore: 12,
  /** Headshot rate: this many player hits, nearly all of them heads. */
  rateMinHits: 30,
  rateHeadshots: 0.9,
  rateScore: 50,
  kickScore: 100,
  /** Fog of war: always sent when this close; kept for a moment after going out of sight. */
  fogNear: 7,
  fogLingerMs: 600,
  /** Where the viewer and the target will be this far ahead (seconds), so peeking isn't late. */
  fogLead: 0.15,
} as const;

export type AntiCheatMode = 'enforce' | 'log' | 'off';

interface Watch {
  views: { yaw: number; pitch: number }[];
  score: number;
  reasons: Map<string, number>;
  headErrors: number[];
  bodyErrors: number[];
  hits: number;
  headshots: number;
  silent: number;
  snaps: number;
  rateFlagged: boolean;
  lockFlagged: boolean;
  /** Fog of war: pid → until when they stay visible to this player. */
  seen: Map<number, number>;
}

const DEG = Math.PI / 180;

function angle(a: Vec3, b: Vec3): number {
  const la = Math.hypot(a.x, a.y, a.z);
  const lb = Math.hypot(b.x, b.y, b.z);
  if (la < 1e-9 || lb < 1e-9) return 0;
  return Math.acos(Math.max(-1, Math.min(1, (a.x * b.x + a.y * b.y + a.z * b.z) / (la * lb))));
}

const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / Math.max(1, xs.length);

export class AntiCheat {
  private readonly watches = new Map<number, Watch>();

  constructor(
    private readonly room: GameRoom,
    readonly mode: AntiCheatMode,
  ) {}

  private watch(p: ServerPlayer): Watch {
    let w = this.watches.get(p.pid);
    if (!w) {
      w = { views: [], score: 0, reasons: new Map(), headErrors: [], bodyErrors: [], hits: 0, headshots: 0, silent: 0, snaps: 0, rateFlagged: false, lockFlagged: false, seen: new Map() };
      this.watches.set(p.pid, w);
    }
    return w;
  }

  /** A new match: everyone starts clean. */
  reset(): void {
    this.watches.clear();
  }

  forget(p: ServerPlayer): void {
    this.watches.delete(p.pid);
  }

  /** Every input frame: remember where they were looking. */
  onInput(p: ServerPlayer, yaw: number, pitch: number): void {
    const w = this.watch(p);
    w.views.push({ yaw, pitch });
    if (w.views.length > AC.viewHistory) w.views.shift();
  }

  /**
   * Before a shot is used: false if it can't have come from a real client (silent aim). Third
   * person aims from the camera, a little off the eyes, so close targets can be ~20° off; past
   * AC.silentAimDeg from every recent view nothing legitimate is left.
   */
  allowShot(p: ServerPlayer, aim: Vec3): boolean {
    if (this.mode === 'off') return true;
    const w = this.watch(p);
    if (w.views.length === 0) return true;
    const nearest = Math.min(...w.views.map((v) => angle(aim, directionFromAngles(v.yaw, v.pitch))));
    if (nearest <= AC.silentAimDeg * DEG) return true;
    w.silent++;
    this.suspect(p, 'silent aim', AC.silentAimScore, { offByDeg: Math.round(nearest / DEG) });
    return this.mode !== 'enforce';
  }

  /** A single-bullet hitscan hit: how close to the middle of the head or body it was. */
  onHit(p: ServerPlayer, eye: Vec3, aim: Vec3, target: MeleeTarget<ServerPlayer>, headshot: boolean): void {
    if (this.mode === 'off') return;
    const w = this.watch(p);
    const s = target.scale;
    const centre = headshot
      ? chickenHeadCenter(target, target.yaw, s, target.pitch)
      : { x: target.x, y: target.y + (HITBOX.bodyHeight * s) / 2, z: target.z };
    const to = { x: centre.x - eye.x, y: centre.y - eye.y, z: centre.z - eye.z };
    const dist = Math.hypot(to.x, to.y, to.z);
    if (dist < 2) return; // point blank says nothing
    const radius = headshot ? HITBOX.headRadius * s : 0.5 * s;
    const error = Math.min(1, angle(aim, to) / Math.atan(radius / dist));
    w.hits++;
    if (headshot) {
      w.headshots++;
      w.headErrors.push(error);
    } else w.bodyErrors.push(error);

    // A big flick of the view in the last few frames that lands dead centre on a head.
    if (headshot && error <= AC.snapPrecision && w.views.length >= 2) {
      const recent = w.views.slice(-AC.snapFrames);
      const last = recent[recent.length - 1]!;
      const turned = Math.max(...recent.map((v) => angle(directionFromAngles(v.yaw, v.pitch), directionFromAngles(last.yaw, last.pitch))));
      if (turned >= AC.snapDeg * DEG) {
        w.snaps++;
        this.suspect(p, 'aim snap', AC.snapScore, { turnedDeg: Math.round(turned / DEG), precision: round(error, 2) });
      }
    }
    if (!w.lockFlagged) {
      const head = w.headErrors.length >= AC.lockMinHeadHits && mean(w.headErrors) <= AC.lockHeadMean;
      const body = w.bodyErrors.length >= AC.lockMinBodyHits && mean(w.bodyErrors) <= AC.lockBodyMean;
      if (head || body) {
        w.lockFlagged = true;
        this.suspect(p, 'aim lock', AC.kickScore, { headHits: w.headErrors.length, headMean: round(mean(w.headErrors), 2), bodyHits: w.bodyErrors.length, bodyMean: round(mean(w.bodyErrors), 2) });
      }
    }
    if (!w.rateFlagged && w.hits >= AC.rateMinHits && w.headshots / w.hits >= AC.rateHeadshots) {
      w.rateFlagged = true;
      this.suspect(p, 'headshot rate', AC.rateScore, { hits: w.hits, headshots: w.headshots });
    }
  }

  private suspect(p: ServerPlayer, reason: string, score: number, details: Record<string, unknown>): void {
    const w = this.watch(p);
    w.score += score;
    w.reasons.set(reason, (w.reasons.get(reason) ?? 0) + 1);
    if (w.score < AC.kickScore || p.info.bot) return;
    const summary = [...w.reasons.entries()].map(([r, n]) => (n > 1 ? `${r} ×${n}` : r)).join(', ');
    this.room.caughtCheating(p, summary, { ...details, score: w.score, hits: w.hits, headshots: w.headshots, silent: w.silent, snaps: w.snaps }, this.mode === 'enforce');
    // Logged once per match in watch-only mode; removed players are forgotten anyway.
    w.score = Number.NEGATIVE_INFINITY;
  }

  // ---------------------------------------------------------------------------
  // Fog of war
  // ---------------------------------------------------------------------------

  /** Could `viewer` see `target` about now (with a little lead, a margin and a short memory)? */
  visible(viewer: ServerPlayer, target: ServerPlayer, now: number): boolean {
    if (!viewer.alive || !target.alive) return true;
    const w = this.watch(viewer);
    const dx = target.state.x - viewer.state.x;
    const dz = target.state.z - viewer.state.z;
    if (Math.hypot(dx, target.state.y - viewer.state.y, dz) <= AC.fogNear) {
      w.seen.set(target.pid, now + AC.fogLingerMs);
      return true;
    }
    if (this.lineOfSight(viewer, target)) {
      w.seen.set(target.pid, now + AC.fogLingerMs);
      return true;
    }
    return (w.seen.get(target.pid) ?? 0) > now;
  }

  private lineOfSight(viewer: ServerPlayer, target: ServerPlayer): boolean {
    const v = viewer.state;
    const t = target.state;
    const eyes = [
      { x: v.x, y: v.y + eyeHeightOf(v), z: v.z },
      { x: v.x + v.vx * AC.fogLead, y: v.y + eyeHeightOf(v) + v.vy * AC.fogLead, z: v.z + v.vz * AC.fogLead },
    ];
    // Head, chest and feet, now and a moment ahead, plus the body's edges across the line of sight.
    const ahead = { x: t.x + t.vx * AC.fogLead, y: t.y + t.vy * AC.fogLead, z: t.z + t.vz * AC.fogLead };
    const dx = t.x - v.x;
    const dz = t.z - v.z;
    const len = Math.hypot(dx, dz) || 1;
    const side = { x: -dz / len, z: dx / len };
    const points: Vec3[] = [];
    for (const base of [t, ahead]) {
      for (const h of [1.35, 0.75, 0.2]) points.push({ x: base.x, y: base.y + h, z: base.z });
      for (const s of [-0.45, 0.45]) points.push({ x: base.x + side.x * s, y: base.y + 0.75, z: base.z + side.z * s });
    }
    for (const eye of eyes) {
      for (const p of points) {
        const d = { x: p.x - eye.x, y: p.y - eye.y, z: p.z - eye.z };
        const dist = Math.hypot(d.x, d.y, d.z);
        if (dist < 1e-6) return true;
        if (!raycastWorld(makeRay(eye, { x: d.x / dist, y: d.y / dist, z: d.z / dist }), this.room.world, dist - 0.05)) return true;
      }
    }
    return false;
  }
}
