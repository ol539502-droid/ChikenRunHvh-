import {
  BLOCK_ID_BASE,
  BLOCK_SIZE,
  DEFAULT_MODS,
  PLAYER,
  WEAPONS,
  ZOMBIE,
  ZOMBIE_SHOP_BY_ID,
  blockAabb,
  bossNumber,
  cellKey,
  heightOf,
  isBossWave,
  isKnifeSkin,
  isMelee,
  isSidearm,
  sanitizeMods,
  upgradeMultiplier,
  upgradePrice,
  waveKinds,
  zombieStats,
  type Aabb,
  type Appearance,
  type BlockState,
  type BuyResult,
  type KillCause,
  type Vec3,
  type WeaponId,
  type ZombieGear,
  type ZombieKind,
  type ZombiePhase,
  type ZombieState,
} from '@game/shared';
import { GameRoom, type PlayerProfile } from './GameRoom';
import type { ServerPlayer } from './ServerPlayer';
import { ZombieBrain, type Zombie, type ZombieHost } from './zombies/ZombieBrain';

const EPS = 1e-4;

function overlaps(a: Aabb, b: Aabb): boolean {
  return a.minX < b.maxX - EPS && a.maxX > b.minX + EPS && a.minY < b.maxY - EPS && a.maxY > b.minY + EPS && a.minZ < b.maxZ - EPS && a.maxZ > b.minZ + EPS;
}

const BOSS_NAMES = ['Rotten King', 'The Gravedigger', 'Mother Hen', 'Lord Drumstick', 'The Plague Rooster'];

/** How each kind of zombie looks (the chicken skin and hat). */
const LOOKS: Record<ZombieKind, Appearance> = {
  walker: { skin: 'zombie', hat: 'none', beak: 'black', shoes: 'none' },
  runner: { skin: 'mint', hat: 'none', beak: 'red', shoes: 'none' },
  brute: { skin: 'shadow', hat: 'helmet', beak: 'black', shoes: 'black' },
  boss: { skin: 'lava', hat: 'devil', beak: 'black', shoes: 'black' },
};

interface PlacedBlock {
  state: BlockState;
  hp: number;
  expiresAt: number;
}

/**
 * Zombie Apocalypse. The survivors (one team) fight wave after wave of zombies: ordinary bot
 * chickens driven by ZombieBrain. Between waves there are 10 seconds to shop (heals, armor,
 * ammo, guns, gun upgrades). Every fifth wave a boss comes with the horde. C builds a wall that
 * disappears after 10 seconds, and zombies can break it. When every survivor is down, it is over.
 */
export class ZombieRoom extends GameRoom {
  private zphase: ZombiePhase = 'prep';
  private wave = 1;
  private kills = 0;
  private prepEndsAt = 0;
  private queue: ZombieKind[] = [];
  private nextSpawnAt = 0;
  private nextStateAt = 0;
  private bossPid = 0;
  private readonly zombies = new Map<number, Zombie>();
  private readonly upgrades = new Map<number, Record<string, number>>();
  private readonly brain: ZombieBrain;
  private readonly host: ZombieHost;

  private readonly blocks = new Map<number, PlacedBlock>();
  private readonly cells = new Map<string, number>();
  private readonly lastBuildAt = new Map<number, number>();
  private nextBlockId = 1;

  constructor(...args: ConstructorParameters<typeof GameRoom>) {
    super(...args);
    this.host = {
      world: this.world,
      map: this.map,
      survivors: () => this.survivors(),
      input: (p, frame) => this.handleInput(p, frame),
      swing: (z, dir, now) => this.handleFire(z.p, { shot: ++z.shot, weapon: 'knife', dx: dir.x, dy: dir.y, dz: dir.z, t: now, aiming: false }),
      hitBlock: (id, damage) => this.damageBlock(id, damage),
      slam: (z, now) => this.slam(z, now),
      summon: (z, now) => this.summonHelp(z, now),
    };
    this.brain = new ZombieBrain(this.host);
  }

  // ---------------------------------------------------------------------------
  // Who is who
  // ---------------------------------------------------------------------------

  /** Survivors who are alive. */
  private survivors(): ServerPlayer[] {
    const out: ServerPlayer[] = [];
    for (const p of this.players.values()) if (!p.info.undead && p.alive) out.push(p);
    return out;
  }

  private humans(): ServerPlayer[] {
    const out: ServerPlayer[] = [];
    for (const p of this.players.values()) if (!p.info.undead) out.push(p);
    return out;
  }

  private aliveZombies(): number {
    let n = 0;
    for (const z of this.zombies.values()) if (z.p.alive) n++;
    return n;
  }

  private emitMoney(p: ServerPlayer): void {
    p.socket?.emit('money', { money: p.money });
  }

  private gearOf(p: ServerPlayer): ZombieGear {
    return { upgrades: { ...(this.upgrades.get(p.pid) ?? {}) } };
  }

  private publicState(): ZombieState {
    const boss = this.bossPid ? this.players.get(this.bossPid) : undefined;
    return {
      phase: this.zphase,
      wave: this.wave,
      endsAt: this.zphase === 'prep' && this.phase === 'playing' ? this.prepEndsAt : null,
      alive: this.aliveZombies(),
      left: this.queue.length + this.aliveZombies(),
      kills: this.kills,
      boss: boss?.alive ? { pid: boss.pid, name: boss.info.name } : null,
    };
  }

  private emitState(now: number): void {
    this.nextStateAt = now + 250;
    this.io.to(this.channel).emit('zombie', this.publicState());
  }

  // ---------------------------------------------------------------------------
  // Joining, starting, finishing
  // ---------------------------------------------------------------------------

  /** Survivors are always one team; zombies are the other. */
  override join(socket: Parameters<GameRoom['join']>[0], profile: PlayerProfile) {
    return super.join(socket, profile.bot ? profile : { ...profile, team: 1 });
  }

  protected override joinExtras(player: ServerPlayer) {
    const now = performance.now();
    return {
      blocks: [...this.blocks.values()].map((b) => ({ ...b.state, ttl: Math.max(0, Math.round(b.expiresAt - now)) })),
      money: player.money,
      zombie: { state: this.publicState(), gear: this.gearOf(player) },
    };
  }

  protected override onPlayerJoin(p: ServerPlayer, _now: number): void {
    if (p.info.undead || p.info.bot) return;
    p.money = this.phase === 'playing' ? Math.max(p.money, ZOMBIE.startMoney) : ZOMBIE.startMoney;
    this.emitMoney(p);
  }

  protected override onPlayerLeave(p: ServerPlayer): void {
    this.upgrades.delete(p.pid);
    this.lastBuildAt.delete(p.pid);
  }

  protected override onMatchStart(now: number): void {
    this.clearZombies();
    this.clearBlocks();
    this.upgrades.clear();
    this.kills = 0;
    this.wave = 1;
    this.bossPid = 0;
    this.queue = [];
    this.zphase = 'prep';
    this.prepEndsAt = now + ZOMBIE.prepMs;
    for (const p of this.humans()) {
      p.money = ZOMBIE.startMoney;
      this.resetGear(p);
      this.announcePlayer(p);
      this.emitMoney(p);
      p.socket?.emit('zombieGear', this.gearOf(p));
    }
    this.emitState(now);
    this.systemMessage('🧟 Zombie Apocalypse: wave 1 starts in 10 seconds. B opens the shop, C builds a wall that lasts 10 seconds.');
  }

  /** Back to the starting guns (a pistol and your knife). */
  private resetGear(p: ServerPlayer): void {
    p.info.loadout = (this.mode.weapons ?? ['pistol', 'knife']).map((w) => (w === 'knife' && isKnifeSkin(p.melee) ? p.melee : w));
    p.weaponSlot = 0;
    for (const id of p.info.loadout) p.mags.set(id, p.magazineSize(id));
    p.reloadUntil = 0;
    p.eggs = p.smokes = p.flashes = 0;
  }

  protected override fixedUpdate(now: number): void {
    super.fixedUpdate(now);
    if (this.phase !== 'playing') return;
    this.updateBlocks(now);

    if (this.zphase === 'prep') {
      if (now >= this.prepEndsAt) this.startWave(now);
      return;
    }
    if (this.zphase !== 'wave') return;

    // Zombies come out a few at a time.
    if (this.queue.length > 0 && now >= this.nextSpawnAt && this.aliveZombies() < ZOMBIE.maxAlive) {
      this.nextSpawnAt = now + ZOMBIE.spawnEveryMs;
      this.spawnZombie(this.queue.shift()!, now);
    }
    for (const z of this.zombies.values()) {
      if (z.p.alive) this.brain.update(z, now);
      else if (z.diedAt !== null && now - z.diedAt > ZOMBIE.corpseMs) {
        this.zombies.delete(z.p.pid);
        this.removePlayer(z.p);
      }
    }
    if (this.survivors().length === 0) return this.gameOver(now);
    if (this.queue.length === 0 && this.aliveZombies() === 0) return this.clearWave(now);
    if (now >= this.nextStateAt) this.emitState(now);
  }

  private startWave(now: number): void {
    this.zphase = 'wave';
    this.queue = waveKinds(this.wave);
    // The boss walks out a little way into the horde.
    if (isBossWave(this.wave)) {
      const at = this.queue.indexOf('boss');
      this.queue.splice(at, 1);
      this.queue.splice(Math.min(3, this.queue.length), 0, 'boss');
    }
    this.nextSpawnAt = now;
    this.systemMessage(`🧟 Wave ${this.wave}${isBossWave(this.wave) ? ': a BOSS is coming!' : ''}`);
    this.emitState(now);
  }

  private clearWave(now: number): void {
    const bonus = ZOMBIE.clearBonus.base + ZOMBIE.clearBonus.perWave * this.wave;
    for (const p of this.survivors()) {
      p.money += bonus;
      this.emitMoney(p);
    }
    this.systemMessage(`✅ Wave ${this.wave} cleared! +${bonus} each. Shop (B) is open for 10 seconds.`);
    this.wave++;
    this.zphase = 'prep';
    this.prepEndsAt = now + ZOMBIE.prepMs;
    this.bossPid = 0;
    // Everyone who went down is back for the next wave.
    for (const p of this.humans()) if (!p.alive) this.spawn(p, now, true);
    this.emitState(now);
  }

  private gameOver(now: number): void {
    this.zphase = 'over';
    this.bossPid = 0;
    this.systemMessage(`💀 Game over: you reached wave ${this.wave} with ${this.kills} zombie kills.`);
    this.clearZombies();
    this.clearBlocks();
    this.emitState(now);
    this.endMatch(now);
  }

  /** Play again after game over (the Restart button). */
  handleZombieRestart(p: ServerPlayer): void {
    if (p.info.undead || this.phase !== 'ended') return;
    this.startNow();
  }

  private clearZombies(): void {
    for (const z of [...this.zombies.values()]) this.removePlayer(z.p);
    this.zombies.clear();
  }

  // ---------------------------------------------------------------------------
  // Zombies
  // ---------------------------------------------------------------------------

  /** A spot at the edge, a good way from every survivor. */
  private zombieSpawn(): { x: number; z: number } {
    const survivors = this.survivors();
    const spots = this.map.spawns.filter((s) => s.team === 2);
    const far = spots.filter((s) => survivors.every((p) => Math.hypot(p.state.x - s.x, p.state.z - s.z) >= ZOMBIE.spawnMinDistance));
    const pool = far.length > 0 ? far : spots;
    const spot = pool[Math.floor(Math.random() * pool.length)] ?? { x: 0, z: 0 };
    return { x: spot.x + (Math.random() - 0.5) * 3, z: spot.z + (Math.random() - 0.5) * 3 };
  }

  private spawnZombie(kind: ZombieKind, now: number, near?: Vec3): ServerPlayer | null {
    const stats = zombieStats(kind, this.wave);
    const boss = kind === 'boss';
    const title = boss ? `☠️ ${BOSS_NAMES[(bossNumber(this.wave) - 1) % BOSS_NAMES.length]}` : kind === 'brute' ? '🧟 Brute' : kind === 'runner' ? '🧟 Runner' : '🧟 Zombie';
    const res = this.join(null, { userId: null, name: title, appearance: LOOKS[kind], loadout: ['knife'], bot: true, team: 2, rank: 1 });
    if (!res.ok) return null;
    const p = this.players.get(res.selfPid)!;
    const at = near ? { x: near.x + (Math.random() - 0.5) * 5, z: near.z + (Math.random() - 0.5) * 5 } : this.zombieSpawn();
    p.respawn(at.x, at.z, Math.atan2(at.x, at.z), now, 0);
    p.info.undead = kind;
    // The mode's weapon list is for survivors: a zombie has only its claws (the knife swing).
    p.info.loadout = ['knife'];
    p.weaponSlot = 0;
    p.mags.set('knife', p.magazineSize('knife'));
    p.switchReadyAt = 0;
    p.mods = sanitizeMods({ speed: stats.speed }, DEFAULT_MODS);
    const flank = this.wave >= ZOMBIE.smart.flankFromWave && this.wave <= 99 && kind !== 'boss' && Math.random() < ZOMBIE.smart.flankShare ? (Math.random() < 0.5 ? 1 : -1) : 0;
    this.zombies.set(p.pid, {
      p,
      kind,
      stats,
      maxHp: stats.hp,
      wave: this.wave,
      flank,
      flanking: flank !== 0,
      seq: 0,
      shot: 0,
      strafe: Math.random() < 0.5 ? 1 : -1,
      nextThink: 0,
      heading: { x: 0, z: 0 },
      path: [],
      pathTarget: null,
      nextPath: 0,
      nextAttack: now + 600,
      progressAt: now,
      progressPos: { x: p.state.x, z: p.state.z },
      jumpTicks: 0,
      nextSlam: now + ZOMBIE.boss.slam.everyMs,
      slamAt: 0,
      summoned: false,
      diedAt: null,
    });
    this.announcePlayer(p);
    if (boss) {
      this.bossPid = p.pid;
      this.systemMessage(`☠️ ${p.info.name} has risen!`);
    }
    return p;
  }

  /** Boss: the ground slam lands. */
  private slam(z: Zombie, now: number): void {
    const s = ZOMBIE.boss.slam;
    const at = { x: z.p.state.x, y: z.p.state.y, z: z.p.state.z };
    this.io.to(this.channel).emit('explode', { id: -1, kind: 'rocket', x: at.x, y: at.y + 0.3, z: at.z });
    for (const p of this.survivors()) {
      const dx = p.state.x - at.x;
      const dz = p.state.z - at.z;
      const d = Math.hypot(dx, dz);
      if (d > s.radius || Math.abs(p.state.y - at.y) > 2.2) continue;
      const power = 1 - d / (s.radius * 1.3);
      this.damage(p, z.p, Math.round(s.damage * (1 + 0.08 * Math.max(0, this.wave - 1)) * (0.5 + power / 2)), false, 'world', at, now);
      p.state.vx += (dx / (d || 1)) * s.knockback * power;
      p.state.vz += (dz / (d || 1)) * s.knockback * power;
      p.state.vy = Math.max(p.state.vy, 4.5);
      p.state.onGround = false;
    }
    // The blast breaks builds too.
    for (const b of [...this.blocks.values()]) {
      const c = blockAabb(b.state.cx, b.state.cy, b.state.cz);
      if (Math.hypot((c.minX + c.maxX) / 2 - at.x, (c.minZ + c.maxZ) / 2 - at.z) < s.radius) this.removeBlock(b.state.id);
    }
  }

  /** Boss: calls zombies round itself. */
  private summonHelp(z: Zombie, now: number): void {
    this.systemMessage(`☠️ ${z.p.info.name} calls for help!`);
    for (let i = 0; i < ZOMBIE.boss.summon.count; i++) {
      this.spawnZombie(i % 3 === 2 ? 'runner' : 'walker', now, { x: z.p.state.x, y: 0, z: z.p.state.z });
    }
  }

  // ---------------------------------------------------------------------------
  // Fighting
  // ---------------------------------------------------------------------------

  override damage(victim: ServerPlayer, attacker: ServerPlayer | null, amount: number, headshot: boolean, cause: KillCause, from: Vec3, now: number, flags = 0): void {
    const attackerZombie = attacker?.info.undead !== undefined;
    const victimZombie = victim.info.undead !== undefined;
    // No friendly fire, and zombies don't hurt each other.
    if (attacker && attacker !== victim && attackerZombie === victimZombie) return;
    if (victimZombie) {
      const z = this.zombies.get(victim.pid);
      if (!z) return;
      // Your gun upgrades add damage; the health bar is a share of the zombie's real health.
      if (attacker && cause in WEAPONS) amount *= upgradeMultiplier(this.upgrades.get(attacker.pid)?.[cause] ?? 0);
      amount *= 100 / z.maxHp;
    } else if (attackerZombie && cause === 'knife') {
      // A zombie's claws hurt as much as its wave says.
      amount = this.zombies.get(attacker!.pid)?.stats.damage ?? amount;
    }
    super.damage(victim, attacker, amount, headshot, cause, from, now, flags);
  }

  protected override onKill(victim: ServerPlayer, attacker: ServerPlayer | null, _cause: KillCause, now: number): void {
    victim.respawnAt = Infinity;
    const z = this.zombies.get(victim.pid);
    if (!z) return;
    z.diedAt = now;
    this.kills++;
    // Money for the kill: all of it to who did it, a quarter to everyone else still standing.
    for (const p of this.survivors()) {
      const share = p === attacker ? z.stats.reward : Math.round(z.stats.reward * 0.25);
      if (share <= 0) continue;
      p.money += share;
      this.emitMoney(p);
    }
    if (attacker && !attacker.info.undead && !this.survivors().includes(attacker)) {
      attacker.money += z.stats.reward;
      this.emitMoney(attacker);
    }
    if (z.kind === 'boss') {
      this.bossPid = 0;
      this.systemMessage(`🏆 ${victim.info.name} is dead! +${z.stats.reward} money.`);
    }
    this.emitState(now);
  }

  // ---------------------------------------------------------------------------
  // The shop (B)
  // ---------------------------------------------------------------------------

  override handleBuy(p: ServerPlayer, itemId: unknown): BuyResult {
    const fail = (error: string): BuyResult => ({ ok: false, error, money: p.money });
    const item = typeof itemId === 'string' ? ZOMBIE_SHOP_BY_ID.get(itemId) : undefined;
    if (!item || p.info.undead) return fail('Unknown item.');
    if (this.zphase !== 'prep' || this.phase !== 'playing') return fail('The shop is only open between waves.');
    if (!p.alive) return fail('You can shop once you are back.');

    let price = item.price;
    const weapon = item.kind === 'upgrade' ? p.weapon : item.weapon;
    const level = this.upgrades.get(p.pid)?.[p.weapon] ?? 0;
    const problem =
      (item.kind === 'heal' && p.hp >= PLAYER.maxHealth && 'You are at full health.') ||
      (item.kind === 'armor' && p.armor >= PLAYER.maxArmor && 'Your armor is already full.') ||
      (item.kind === 'egg' && p.eggs >= PLAYER.maxEggs && 'You can’t carry more eggs.') ||
      (item.kind === 'weapon' && p.info.loadout.includes(item.weapon!) && 'You already have that.') ||
      (item.kind === 'upgrade' && isMelee(p.weapon) && 'Take out a gun to upgrade it.') ||
      (item.kind === 'upgrade' && upgradePrice(level) === null && 'That gun is fully upgraded.');
    if (problem) return fail(problem);
    if (item.kind === 'upgrade') price = upgradePrice(level)!;
    if (p.money < price) return fail('Not enough money.');

    switch (item.kind) {
      case 'heal':
        p.hp = Math.min(PLAYER.maxHealth, p.hp + (item.amount ?? 50));
        break;
      case 'armor':
        p.armor = PLAYER.maxArmor;
        break;
      case 'ammo':
        for (const id of p.info.loadout) p.mags.set(id, p.magazineSize(id));
        p.reloadUntil = 0;
        break;
      case 'egg':
        p.eggs++;
        break;
      case 'weapon': {
        // One main gun and one pistol: a pistol replaces your pistol, any other gun your main gun.
        const next = item.weapon!;
        const melee = p.info.loadout.find((w) => isMelee(w)) ?? 'knife';
        const main = p.info.loadout.find((w) => !isMelee(w) && !isSidearm(w));
        const sidearm = p.info.loadout.find((w) => isSidearm(w));
        const list = isSidearm(next) ? [main, next, melee] : [next, sidearm, melee];
        p.info.loadout = list.filter((w): w is WeaponId => w !== undefined);
        p.mags.set(next, p.magazineSize(next));
        p.weaponSlot = p.info.loadout.indexOf(next);
        p.reloadUntil = 0;
        this.announcePlayer(p);
        break;
      }
      case 'upgrade': {
        const levels = this.upgrades.get(p.pid) ?? {};
        levels[weapon!] = level + 1;
        this.upgrades.set(p.pid, levels);
        p.socket?.emit('zombieGear', this.gearOf(p));
        break;
      }
    }
    p.money -= price;
    this.emitMoney(p);
    return { ok: true, money: p.money };
  }

  // ---------------------------------------------------------------------------
  // Building (C): a wall that lasts 10 seconds
  // ---------------------------------------------------------------------------

  protected override blockKind(blockId: number) {
    return this.blocks.get(blockId)?.state.kind;
  }

  handleZombieBuild(p: ServerPlayer): void {
    if (p.info.undead || !p.alive || this.phase !== 'playing' || this.zphase === 'over') return;
    const now = performance.now();
    if (now - (this.lastBuildAt.get(p.pid) ?? -Infinity) < ZOMBIE.build.cooldownMs) return;
    this.lastBuildAt.set(p.pid, now);

    const b = ZOMBIE.build;
    const fx = -Math.sin(p.yaw);
    const fz = -Math.cos(p.yaw);
    const rx = Math.cos(p.yaw);
    const rz = -Math.sin(p.yaw);
    const half = this.map.halfSize;
    const bodies: Aabb[] = [];
    for (const o of this.players.values()) {
      if (!o.alive) continue;
      const r = PLAYER.radius;
      const s = o.state;
      bodies.push({ minX: s.x - r, maxX: s.x + r, minY: s.y, maxY: s.y + heightOf(s), minZ: s.z - r, maxZ: s.z + r });
    }
    let placed = 0;
    for (let i = -(b.width - 1) / 2; i <= (b.width - 1) / 2; i++) {
      const x = p.state.x + fx * b.ahead + rx * i * BLOCK_SIZE;
      const z = p.state.z + fz * b.ahead + rz * i * BLOCK_SIZE;
      const cx = Math.floor(x / BLOCK_SIZE);
      const cz = Math.floor(z / BLOCK_SIZE);
      for (let cy = 0; cy < b.height; cy++) {
        if (this.blocks.size >= b.maxBlocks) break;
        const key = cellKey(cx, cy, cz);
        if (this.cells.has(key)) continue;
        const box = blockAabb(cx, cy, cz);
        if (box.minX < -half || box.maxX > half || box.minZ < -half || box.maxZ > half) continue;
        if (this.world.query(box.minX, box.minZ, box.maxX, box.maxZ, []).some((other) => overlaps(other, box))) continue;
        if (bodies.some((body) => overlaps(body, box))) continue;
        const state: BlockState = { id: this.nextBlockId++, cx, cy, cz, kind: b.kind };
        this.blocks.set(state.id, { state, hp: b.blockHp, expiresAt: now + b.ttlMs });
        this.cells.set(key, state.id);
        this.world.add(BLOCK_ID_BASE + state.id, box);
        this.io.to(this.channel).emit('blockPlaced', { ...state, ttl: b.ttlMs });
        placed++;
      }
    }
    if (placed === 0) this.lastBuildAt.set(p.pid, now - b.cooldownMs + 300);
  }

  private updateBlocks(now: number): void {
    for (const b of [...this.blocks.values()]) if (now >= b.expiresAt) this.removeBlock(b.state.id);
  }

  private damageBlock(id: number, damage: number): void {
    const b = this.blocks.get(id);
    if (!b) return;
    b.hp -= damage;
    if (b.hp <= 0) this.removeBlock(id);
  }

  private removeBlock(id: number): void {
    const b = this.blocks.get(id);
    if (!b) return;
    this.blocks.delete(id);
    this.cells.delete(cellKey(b.state.cx, b.state.cy, b.state.cz));
    this.world.remove(BLOCK_ID_BASE + id);
    this.io.to(this.channel).emit('blockRemoved', id);
  }

  private clearBlocks(): void {
    for (const id of [...this.blocks.keys()]) this.removeBlock(id);
  }
}
