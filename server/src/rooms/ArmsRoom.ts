import { ARMS_FINAL_LEVEL, ARMS_LADDER, WEAPONS, armsLoadout, isMelee, type KillCause } from '@game/shared';
import { GameRoom } from './GameRoom';
import type { ServerPlayer } from './ServerPlayer';

/**
 * Arms Race (free for all). Everyone climbs the same weapon ladder: a kill with your current
 * weapon gives you the next one. A knife kill also knocks the victim back a step. The first kill
 * with the last weapon, the Golden Knife, wins; when time runs out, the highest step wins.
 */
export class ArmsRoom extends GameRoom {
  levelOf(p: ServerPlayer): number {
    return p.info.level ?? 0;
  }

  protected override onMatchStart(_now: number): void {
    for (const p of this.players.values()) this.setLevel(p, 0);
  }

  protected override onPlayerJoin(p: ServerPlayer, _now: number): void {
    // Late joiners start at the bottom (but get a chance: at the lowest step anyone's on).
    const others = [...this.players.values()].filter((o) => o !== p).map((o) => this.levelOf(o));
    this.setLevel(p, this.phase === 'playing' && others.length > 0 ? Math.max(0, Math.min(...others)) : 0);
  }

  protected override spawn(p: ServerPlayer, now: number, announce: boolean): void {
    super.spawn(p, now, announce);
    // Guns only: no grenades in Arms Race.
    p.eggs = p.smokes = p.flashes = 0;
  }

  protected override onKill(victim: ServerPlayer, attacker: ServerPlayer | null, cause: KillCause, now: number): void {
    if (this.phase !== 'playing' || !attacker || attacker === victim) return;
    const level = this.levelOf(attacker);
    const current = ARMS_LADDER[level];
    const knifed = cause in WEAPONS && isMelee(cause as keyof typeof WEAPONS);
    if (knifed && this.levelOf(victim) > 0) this.setLevel(victim, this.levelOf(victim) - 1, 'knifed');
    if (cause !== current && !knifed) return;
    if (level >= ARMS_FINAL_LEVEL) {
      this.systemMessage(`🏁 ${attacker.info.name} wins Arms Race with the Golden Knife!`);
      this.endMatch(now, attacker);
      return;
    }
    this.setLevel(attacker, level + 1, 'up');
  }

  /** Time ran out: the highest step wins (most kills breaks a tie). */
  protected override endMatch(now: number, winner?: ServerPlayer): void {
    const leader = winner ?? [...this.players.values()].sort((a, b) => this.levelOf(b) - this.levelOf(a) || b.info.kills - a.info.kills)[0];
    super.endMatch(now, leader);
  }

  override emitScores(): void {
    // The scoreboard's score column shows the ladder step.
    for (const p of this.players.values()) p.info.score = this.levelOf(p) + 1;
    super.emitScores();
  }

  private setLevel(p: ServerPlayer, level: number, why?: 'up' | 'knifed'): void {
    p.info.level = level;
    p.info.loadout = armsLoadout(level);
    p.weaponSlot = 0;
    p.reloadUntil = 0;
    p.burstShots = 0;
    for (const id of p.info.loadout) p.mags.set(id, p.magazineSize(id));
    this.announcePlayer(p);
    if (why === 'up' && level === ARMS_FINAL_LEVEL) this.systemMessage(`🌟 ${p.info.name} has the Golden Knife!`);
  }
}
