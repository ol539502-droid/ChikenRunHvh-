import {
  BOMB,
  BOMB_START_LOADOUT,
  BUY_ITEMS,
  BUY_ITEMS_BY_ID,
  ECONOMY,
  PLAYER,
  PROJECTILES,
  WEAPONS,
  canTeamBuy,
  isKnifeSkin,
  isMelee,
  isSidearm,
  noBomb,
  round,
  teamName,
  type BombSite,
  type BuyResult,
  type KillCause,
  type RoundEndReason,
  type RoundState,
  type Team,
  type WeaponId,
  bombHoldsPlayer,
  makeRay,
  raycastWorld,
} from '@game/shared';
import { GameRoom, type BotGoal } from './GameRoom';
import type { ServerPlayer } from './ServerPlayer';

/** How close a chikenT person must be to take the bomb from a bot. */
const HANDOVER_RANGE = 2.5;

const REASON_TEXT: Record<RoundEndReason, string> = {
  exploded: 'the bomb exploded',
  defused: 'the bomb was defused',
  eliminated: 'the other team was wiped out',
  time: 'time ran out',
};

/** The bomb going off: like a huge rocket blast. */
const BOMB_BLAST = { ...PROJECTILES.rocket, damage: BOMB.blastDamage, splashRadius: BOMB.blastRadius, knockback: 22, selfDamageScale: 1 };

/**
 * ChikenBomb. chikenT (team 1) plant the bomb on site A or B, chikenCT (team 2) defuse it.
 *
 * A match is a 40 s warmup (free respawns, free buying), then rounds until a team has won
 * BOMB.roundsToWin: 15 s buy time frozen in spawn, then 1:50 to plant (and 40 s fuse once
 * planted). The dead wait for the next round. Money comes from kills and round results and is
 * spent in the buy menu; survivors keep what they bought.
 */
export class BombRoom extends GameRoom {
  private state: RoundState = { phase: 'warmup', round: 0, endsAt: null, bomb: noBomb(), winner: 0, reason: null };
  /** Rounds lost in a row, per team (raises the loss bonus). */
  private lossStreak: [number, number] = [0, 0];
  /** The site chikenT bots go for this round. */
  private targetSite: BombSite | null = null;

  /** The current round (for tests and the client on joining). */
  get roundState(): RoundState {
    return this.state;
  }

  // ---------------------------------------------------------------------------
  // Match and round flow
  // ---------------------------------------------------------------------------

  protected override onMatchStart(now: number): void {
    this.lossStreak = [0, 0];
    for (const p of this.players.values()) {
      p.money = ECONOMY.max;
      p.hasKit = false;
      this.resetLoadout(p);
      this.announcePlayer(p);
    }
    this.state = { phase: 'warmup', round: 0, endsAt: now + BOMB.warmupMs, bomb: noBomb(), winner: 0, reason: null };
    this.emitRound();
    this.emitMoneyToAll();
    this.systemMessage('Warmup: buy anything for free and get used to the map. Round 1 starts in 40 seconds.');
  }

  protected override fixedUpdate(now: number): void {
    super.fixedUpdate(now);
    if (this.phase === 'waiting' || this.phase === 'countdown') {
      if (this.state.phase !== 'warmup' || this.state.endsAt !== null) this.idle(now);
      return;
    }
    if (this.phase !== 'playing') return;
    const s = this.state;
    switch (s.phase) {
      case 'warmup':
        if (s.endsAt !== null && now >= s.endsAt) this.startRound(1, now);
        break;
      case 'buy':
        if (now >= (s.endsAt ?? 0)) this.goLive(now);
        break;
      case 'live':
        this.updateBomb(now);
        if (this.state.phase === 'live') this.checkLive(now);
        break;
      case 'planted':
        this.updateBomb(now);
        if (this.state.phase === 'planted') this.checkPlanted(now);
        break;
      case 'over':
        if (now >= (s.endsAt ?? 0)) this.startRound(s.round + 1, now);
        break;
    }
  }

  /** Waiting for players: no round, nobody frozen, the dead come back. */
  private idle(now: number): void {
    for (const p of this.players.values()) {
      p.frozen = false;
      if (!p.alive) p.respawnAt = now;
    }
    this.state = { phase: 'warmup', round: 0, endsAt: null, bomb: noBomb(), winner: 0, reason: null };
    this.emitRound();
  }

  private startRound(n: number, now: number): void {
    const first = n === 1;
    for (const p of this.players.values()) {
      // Survivors keep their guns, armor and grenades; everyone else starts over.
      const keep = !first && p.alive ? { armor: p.armor, eggs: p.eggs, smokes: p.smokes, flashes: p.flashes } : null;
      if (first) {
        p.money = ECONOMY.start;
        p.hasKit = false;
      }
      if (!keep) this.resetLoadout(p);
      this.spawn(p, now, true);
      if (keep) Object.assign(p, keep);
      p.frozen = true;
      this.announcePlayer(p);
    }
    if (first) this.lossStreak = [0, 0];
    this.projectiles.clear();
    const sites = this.map.bombSites ?? [];
    this.targetSite = sites[Math.floor(Math.random() * sites.length)] ?? null;
    const ts = [...this.players.values()].filter((p) => p.info.team === 1);
    // A person gets the bomb if there is one on the team (bots hand it over when asked, too).
    const humans = ts.filter((p) => !p.info.bot);
    const pool = humans.length > 0 ? humans : ts;
    const carrier = pool[Math.floor(Math.random() * pool.length)];
    this.state = { phase: 'buy', round: n, endsAt: now + BOMB.buyMs, bomb: { ...noBomb(), carrier: carrier?.pid ?? 0 }, winner: 0, reason: null };
    for (const p of this.players.values()) if (p.info.bot) this.botBuy(p);
    this.emitRound();
    this.emitMoneyToAll();
  }

  private goLive(now: number): void {
    for (const p of this.players.values()) p.frozen = false;
    this.state = { ...this.state, phase: 'live', endsAt: now + BOMB.roundMs };
    this.emitRound();
  }

  /** Round wins before the bomb is planted: a wiped-out team, or time running out. */
  private checkLive(now: number): void {
    const { t, ct, tPlayers, ctPlayers } = this.counts();
    if (tPlayers > 0 && ctPlayers > 0) {
      if (ct === 0) return this.endRound(1, 'eliminated', now);
      if (t === 0) return this.endRound(2, 'eliminated', now);
    }
    if (now >= (this.state.endsAt ?? Infinity)) this.endRound(2, 'time', now);
  }

  /** Once planted: the bomb goes off, or every chikenCT is down. Dead chikenT don't matter. */
  private checkPlanted(now: number): void {
    if (now >= (this.state.bomb.explodeAt ?? Infinity)) {
      // Round over first: the blast's kills then can't trigger another check (or explosion).
      this.endRound(1, 'exploded', now);
      this.explode(now);
      return;
    }
    const { ct, ctPlayers } = this.counts();
    if (ctPlayers > 0 && ct === 0) this.endRound(1, 'eliminated', now);
  }

  private endRound(winner: 1 | 2, reason: RoundEndReason, now: number): void {
    if (this.state.phase === 'over') return;
    const loser: 1 | 2 = winner === 1 ? 2 : 1;
    for (const p of this.players.values()) {
      p.frozen = false;
      if (p.info.team === winner) p.money += reason === 'exploded' || reason === 'defused' ? ECONOMY.bombWin : ECONOMY.win;
      else if (p.info.team === loser) {
        p.money += Math.min(ECONOMY.lossMax, ECONOMY.loss + ECONOMY.lossStep * this.lossStreak[loser - 1]);
        if (loser === 1 && this.state.bomb.site !== null) p.money += ECONOMY.plantedLoss;
      }
      p.money = Math.min(ECONOMY.max, p.money);
    }
    this.lossStreak[winner - 1] = 0;
    this.lossStreak[loser - 1] = Math.min(this.lossStreak[loser - 1] + 1, 4);
    this.state = { ...this.state, phase: 'over', endsAt: now + BOMB.roundEndMs, winner, reason, bomb: { ...this.state.bomb, action: null } };
    this.systemMessage(`${teamName(this.mode, winner)} win the round: ${REASON_TEXT[reason]}.`);
    this.emitRound();
    this.emitMoneyToAll();
    this.addTeamScore(winner, 1);
    this.checkScoreLimit(now);
  }

  // ---------------------------------------------------------------------------
  // The bomb
  // ---------------------------------------------------------------------------

  private updateBomb(now: number): void {
    const bomb = this.state.bomb;
    if (this.state.phase === 'live') {
      const carrier = bomb.carrier ? this.players.get(bomb.carrier) : undefined;
      if (carrier) {
        const site = this.siteAt(carrier);
        const planting = bomb.action?.kind === 'plant' && bomb.action.pid === carrier.pid;
        const can = carrier.alive && carrier.useHeld && site !== null && (planting || carrier.state.onGround);
        if (!planting && carrier.info.bot) this.handOver(carrier, now);
        if (planting && !can) this.setAction(null);
        else if (planting && now >= bomb.action!.endsAt) this.plant(carrier, site!, now);
        else if (!planting && can) this.setAction({ pid: carrier.pid, kind: 'plant', startedAt: now, endsAt: now + BOMB.plantMs });
      } else if (!bomb.site) {
        // Dropped: the first chikenT to reach it picks it up.
        for (const p of this.players.values()) {
          if (p.info.team !== 1 || !p.alive || p.frozen) continue;
          if (Math.hypot(p.state.x - bomb.x, p.state.z - bomb.z) > BOMB.pickupRange || Math.abs(p.state.y - bomb.y) > 1.5) continue;
          this.state = { ...this.state, bomb: { ...bomb, carrier: p.pid } };
          this.emitRound();
          break;
        }
      }
      return;
    }
    // Planted: one chikenCT at a time can defuse.
    const action = bomb.action;
    if (action?.kind === 'defuse') {
      const d = this.players.get(action.pid);
      if (!d || !this.canDefuse(d)) this.setAction(null);
      else if (now >= action.endsAt) {
        d.money = Math.min(ECONOMY.max, d.money + ECONOMY.defuse);
        this.endRound(2, 'defused', now);
      }
      return;
    }
    for (const p of this.players.values()) {
      if (p.info.team !== 2 || !this.canDefuse(p)) continue;
      this.setAction({ pid: p.pid, kind: 'defuse', startedAt: now, endsAt: now + (p.hasKit ? BOMB.kitDefuseMs : BOMB.defuseMs) });
      break;
    }
  }

  private canDefuse(p: ServerPlayer): boolean {
    const bomb = this.state.bomb;
    return p.alive && p.useHeld && Math.hypot(p.state.x - bomb.x, p.state.z - bomb.z) <= BOMB.defuseRange && Math.abs(p.state.y - bomb.y) < 2;
  }

/** Planting or defusing: you stay put (see bombHoldsPlayer). */
  protected override movementLocked(p: ServerPlayer): boolean {
    if (this.phase !== 'playing') return false;
    return bombHoldsPlayer(this.state, { pid: p.pid, team: p.info.team, x: p.state.x, y: p.state.y, z: p.state.z, onGround: p.state.onGround, useHeld: p.useHeld }, this.map.bombSites ?? []);
  }

  /** A bot carrying the bomb gives it to a chikenT person who stands next to it holding E. */
  private handOver(bot: ServerPlayer, now: number): void {
    for (const p of this.players.values()) {
      if (p.info.bot || p.info.team !== 1 || !p.alive || !p.useHeld) continue;
      if (Math.hypot(p.state.x - bot.state.x, p.state.z - bot.state.z) > HANDOVER_RANGE) continue;
      this.state = { ...this.state, bomb: { ...this.state.bomb, carrier: p.pid, action: null } };
      p.socket?.emit('notice', `💣 ${bot.info.name} gave you the bomb`);
      this.emitRound();
      void now;
      return;
    }
  }

  /** The bomb site a player stands on, or null. */
  private siteAt(p: ServerPlayer): BombSite | null {
    for (const site of this.map.bombSites ?? []) if (Math.hypot(p.state.x - site.x, p.state.z - site.z) <= site.radius) return site;
    return null;
  }

  private plant(p: ServerPlayer, site: BombSite, now: number): void {
    p.money = Math.min(ECONOMY.max, p.money + ECONOMY.plant);
    this.emitMoney(p);
    this.state = {
      ...this.state,
      phase: 'planted',
      endsAt: now + BOMB.fuseMs,
      bomb: { carrier: 0, x: round(p.state.x, 2), y: round(p.state.y, 2), z: round(p.state.z, 2), site: site.id, explodeAt: now + BOMB.fuseMs, action: null },
    };
    this.systemMessage(`💣 The bomb has been planted at ${site.id}!`);
    this.emitRound();
  }

  private explode(now: number): void {
    const { x, y, z } = this.state.bomb;
    this.io.to(this.channel).emit('explode', { id: -1, kind: 'rocket', x, y: y + 0.4, z });
    this.projectiles.blastAt({ x, y: y + 0.6, z }, BOMB_BLAST, null, 'bomb', now);
  }

  /** Drops the bomb where `p` is (carrier died or left), and stops anything `p` was doing. */
  private release(p: ServerPlayer): void {
    const bomb = this.state.bomb;
    let changed = false;
    let next = bomb;
    if (bomb.action?.pid === p.pid) {
      next = { ...next, action: null };
      changed = true;
    }
    if (bomb.carrier === p.pid) {
      next = { ...next, carrier: 0, x: round(p.state.x, 2), y: round(this.floorBelow(p.state.x, p.state.y, p.state.z), 2), z: round(p.state.z, 2) };
      changed = true;
    }
    if (!changed) return;
    this.state = { ...this.state, bomb: next };
    this.emitRound();
  }

  /** Height of whatever is under (x, y, z): a box top, or the ground. */
  private floorBelow(x: number, y: number, z: number): number {
    const hit = raycastWorld(makeRay({ x, y: y + 0.1, z }, { x: 0, y: -1, z: 0 }), this.world, y + 0.1);
    return hit ? Math.max(0, y + 0.1 - hit.t) : 0;
  }

  private setAction(action: RoundState['bomb']['action']): void {
    this.state = { ...this.state, bomb: { ...this.state.bomb, action } };
    this.emitRound();
  }

  // ---------------------------------------------------------------------------
  // Players
  // ---------------------------------------------------------------------------

  protected override onPlayerJoin(p: ServerPlayer, _now: number): void {
    p.money = this.state.phase === 'warmup' ? ECONOMY.max : ECONOMY.start;
    if (this.phase !== 'playing') return;
    if (this.state.phase === 'buy') p.frozen = true;
    // Mid-round: watch until the next round starts.
    if (this.state.phase === 'live' || this.state.phase === 'planted' || this.state.phase === 'over') {
      p.alive = false;
      p.respawnAt = Infinity;
    }
  }

  /** Switching team during buy time: straight to your new team's spawn (frozen like everyone), not out for the round. */
  protected override onTeamSwitched(p: ServerPlayer, now: number): void {
    if (this.phase !== 'playing' || this.state.phase !== 'buy') return;
    this.spawn(p, now, true);
    p.frozen = true;
  }

  protected override onPlayerDeath(victim: ServerPlayer, now: number): void {
    super.onPlayerDeath(victim, now);
    this.release(victim);
    if (this.phase !== 'playing' || this.state.phase === 'warmup') return;
    // No respawning until the next round; what you had is gone.
    victim.respawnAt = Infinity;
    victim.hasKit = false;
    this.resetLoadout(victim);
  }

  protected override onKill(victim: ServerPlayer, attacker: ServerPlayer | null, cause: KillCause, now: number): void {
    const phase = this.state.phase;
    if (phase !== 'live' && phase !== 'planted') return;
    if (attacker && attacker !== victim && attacker.info.team !== victim.info.team) {
      const melee = cause in WEAPONS && isMelee(cause as keyof typeof WEAPONS);
      attacker.money = Math.min(ECONOMY.max, attacker.money + (melee ? ECONOMY.meleeKill : ECONOMY.kill));
      this.emitMoney(attacker);
    }
    // A team wiped out ends the round right away.
    if (phase === 'live') this.checkLive(now);
    else this.checkPlanted(now);
  }

  protected override onPlayerLeave(player: ServerPlayer): void {
    this.release(player);
    // FaceChiken: walking out of a match that's underway is a loss.
    if (this.phase === 'playing' && this.state.phase !== 'warmup') this.recordLeaver(player);
  }

  protected override joinExtras(player: ServerPlayer) {
    return { round: this.state, money: player.money };
  }

  protected override actionsBlocked(): boolean {
    return this.state.phase === 'buy';
  }

  /** Back to the starting pistol and knife (dead players, new matches). Your own knife skin stays. */
  private resetLoadout(p: ServerPlayer): void {
    p.info.loadout = BOMB_START_LOADOUT.map((w) => (w === 'knife' && isKnifeSkin(p.melee) ? p.melee : w));
    p.weaponSlot = 0;
    p.reloadUntil = 0;
    for (const id of p.info.loadout) p.mags.set(id, p.magazineSize(id));
  }

  // ---------------------------------------------------------------------------
  // Buy menu
  // ---------------------------------------------------------------------------

  override handleBuy(p: ServerPlayer, itemId: unknown): BuyResult {
    const fail = (error: string): BuyResult => ({ ok: false, error, money: p.money });
    const item = typeof itemId === 'string' ? BUY_ITEMS_BY_ID.get(itemId) : undefined;
    if (!item) return fail('Unknown item.');
    const free = this.state.phase === 'warmup';
    if (this.phase !== 'playing' || (this.state.phase !== 'buy' && !free)) return fail('You can only buy during buy time.');
    if (!p.alive) return fail('You can buy when you respawn.');
    if (!canTeamBuy(item, p.info.team)) return fail(`Only ${teamName(this.mode, item.team as Team)} can buy that.`);
    const price = free ? 0 : item.price;
    const full =
      (item.kind === 'weapon' && p.info.loadout.includes(item.weapon!) && 'You already have that.') ||
      (item.kind === 'armor' && p.armor >= PLAYER.maxArmor && 'Your armor is already full.') ||
      (item.kind === 'eggs' && p.eggs >= PLAYER.maxEggs && 'You can’t carry more eggs.') ||
      (item.kind === 'smoke' && p.smokes >= PLAYER.maxSmokes && 'You can’t carry more smoke grenades.') ||
      (item.kind === 'flash' && p.flashes >= PLAYER.maxFlashes && 'You can’t carry more flashbangs.') ||
      (item.kind === 'kit' && p.hasKit && 'You already have a defuse kit.');
    if (full) return fail(full);
    if (p.money < price) return fail('Not enough money.');

    switch (item.kind) {
      case 'weapon': {
        const weapon = item.weapon!;
        // One main gun and one pistol: a pistol replaces your pistol, any other gun your main gun.
        const melee = p.info.loadout.find((w) => isMelee(w)) ?? 'knife';
        const main = p.info.loadout.find((w) => !isMelee(w) && !isSidearm(w));
        const sidearm = p.info.loadout.find((w) => isSidearm(w));
        const next = isSidearm(weapon) ? [main, weapon, melee] : [weapon, sidearm, melee];
        p.info.loadout = next.filter((w): w is WeaponId => w !== undefined);
        p.mags.set(weapon, p.magazineSize(weapon));
        p.weaponSlot = p.info.loadout.indexOf(weapon);
        p.reloadUntil = 0;
        this.announcePlayer(p);
        break;
      }
      case 'armor':
        p.armor = PLAYER.maxArmor;
        break;
      case 'eggs':
        p.eggs++;
        break;
      case 'smoke':
        p.smokes++;
        break;
      case 'flash':
        p.flashes++;
        break;
      case 'kit':
        p.hasKit = true;
        break;
    }
    p.money -= price;
    return { ok: true, money: p.money };
  }

  /** Bots spend their money at the start of a round: the best gun they can afford, then armor. */
  private botBuy(p: ServerPlayer): void {
    // Bots stick to the classic guns: no explosives or heavy spray.
    const guns = BUY_ITEMS.filter((i) => i.kind === 'weapon' && !isSidearm(i.weapon!) && (i.category === 'rifle' || i.category === 'smg' || i.category === 'sniper' || i.weapon === 'shotgun') && canTeamBuy(i, p.info.team)).sort((a, b) => b.price - a.price);
    const best = guns.find((g) => g.price <= p.money - 650) ?? guns.find((g) => g.price <= p.money);
    if (best && !p.info.loadout.includes(best.weapon!) && !p.info.loadout.some((w) => !isSidearm(w) && !isMelee(w))) this.handleBuy(p, best.id);
    if (p.money >= 650) this.handleBuy(p, 'armor');
    if (p.info.team === 2 && p.money >= 400) this.handleBuy(p, 'kit');
  }

  // ---------------------------------------------------------------------------
  // Bots: what to go and do
  // ---------------------------------------------------------------------------

  override botGoal(p: ServerPlayer): BotGoal | null {
    const s = this.state;
    if (s.phase !== 'live' && s.phase !== 'planted') return null;
    const bomb = s.bomb;
    // Spread the team out a little around the spot they're heading for.
    const spread = (x: number, z: number, r: number): BotGoal => ({ x: x + Math.cos(p.pid * 2.4) * r, z: z + Math.sin(p.pid * 2.4) * r });
    if (p.info.team === 1) {
      if (s.phase === 'planted') return spread(bomb.x, bomb.z, 4);
      if (bomb.carrier === p.pid) {
        const site = this.targetSite;
        if (!site) return null;
        if (Math.hypot(p.state.x - site.x, p.state.z - site.z) <= site.radius - 1.5) return { x: p.state.x, z: p.state.z, use: true };
        return { x: site.x, z: site.z };
      }
      if (bomb.carrier === 0) return { x: bomb.x, z: bomb.z };
      return this.targetSite ? spread(this.targetSite.x, this.targetSite.z, 3.5) : null;
    }
    if (s.phase === 'planted') {
      if (Math.hypot(p.state.x - bomb.x, p.state.z - bomb.z) <= BOMB.defuseRange - 0.5) return { x: bomb.x, z: bomb.z, use: true };
      return { x: bomb.x, z: bomb.z };
    }
    const sites = this.map.bombSites ?? [];
    const site = sites[p.pid % Math.max(1, sites.length)];
    return site ? spread(site.x, site.z, 3) : null;
  }

  // ---------------------------------------------------------------------------

  private counts(): { t: number; ct: number; tPlayers: number; ctPlayers: number } {
    let t = 0;
    let ct = 0;
    let tPlayers = 0;
    let ctPlayers = 0;
    for (const p of this.players.values()) {
      if (p.info.team === 1) {
        tPlayers++;
        if (p.alive) t++;
      } else if (p.info.team === 2) {
        ctPlayers++;
        if (p.alive) ct++;
      }
    }
    return { t, ct, tPlayers, ctPlayers };
  }

  private emitRound(): void {
    this.io.to(this.channel).emit('round', this.state);
  }

  private emitMoney(p: ServerPlayer): void {
    p.socket?.emit('money', { money: p.money });
  }

  private emitMoneyToAll(): void {
    for (const p of this.players.values()) this.emitMoney(p);
  }
}
