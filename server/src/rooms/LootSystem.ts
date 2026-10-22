import {
  BONUS,
  JETPACK,
  LOOT,
  PICKUP_AMOUNT,
  PLAYER,
  makeRay,
  rayAabb,
  raycastWorld,
  isPowerUp,
  type DropKind,
  type DropState,
  type LootPhase,
  type LootState,
  type PickupKind,
  type Ray,
  type Vec3,
} from '@game/shared';
import type { GameRoom } from './GameRoom';
import type { ServerPlayer } from './ServerPlayer';

interface Loot {
  id: number;
  /** Centre of the floating box. */
  x: number;
  y: number;
  z: number;
  /** The surface below the box (players stand here to collect). */
  floor: number;
  phase: LootPhase;
  pickup: PickupKind | null;
  /** When the current phase ends (pickup expires / box respawns). */
  until: number;
}

const WEIGHTS: [PickupKind, number][] = [
  ['medkit', 30],
  ['armor', 25],
  ['fuel', 25],
  ['eggs', 20],
];

/** @param eggs whether eggs may come out (not in weapon-restricted modes like Knife Fight) */
function randomPickup(eggs: boolean, random: () => number): PickupKind {
  const weights = eggs ? WEIGHTS : WEIGHTS.filter(([kind]) => kind !== 'eggs');
  const total = weights.reduce((sum, [, w]) => sum + w, 0);
  let r = random() * total;
  for (const [kind, w] of weights) {
    r -= w;
    if (r < 0) return kind;
  }
  return 'medkit';
}

/** Floating mystery boxes: shoot one open, then walk over the item it drops. Kills drop bonuses too. */
export class LootSystem {
  private readonly room: GameRoom;
  private readonly boxes: Loot[];
  private readonly drops = new Map<number, DropState & { until: number }>();
  private nextDropId = 1;

  constructor(room: GameRoom) {
    this.room = room;
    this.boxes = (room.mode.noDrops ? [] : room.map.loot).map((spot, i) => ({
      id: i,
      x: spot.x,
      y: (spot.y ?? 0) + LOOT.hover,
      z: spot.z,
      floor: spot.y ?? 0,
      phase: 0,
      pickup: null,
      until: 0,
    }));
  }

  states(): LootState[] {
    return this.boxes.map((b) => ({ id: b.id, phase: b.phase, pickup: b.pickup }));
  }

  /** Bonuses lying around (for players joining mid-match). */
  dropStates(): DropState[] {
    return [...this.drops.values()].map(({ id, kind, x, y, z }) => ({ id, kind, x, y, z }));
  }

  /** A kill: a random pickup falls to the ground where the victim was. */
  dropBonus(at: Vec3, now: number): void {
    this.dropAt(at, randomPickup(!this.room.mode.weapons, this.room.random), now, BONUS.lifetimeMs);
  }

  /** Drops `kind` where `at` is (it lands on whatever is below), for `lifetimeMs`. */
  dropAt(at: Vec3, kind: DropKind, now: number, lifetimeMs: number): void {
    // Land on whatever is below (a roof, a crate, or the ground).
    const below = raycastWorld(makeRay({ x: at.x, y: at.y + 0.5, z: at.z }, { x: 0, y: -1, z: 0 }), this.room.world, at.y + 1);
    const y = below ? Math.max(0, at.y + 0.5 - below.t) : 0;
    const drop = { id: this.nextDropId++, kind, x: at.x, y, z: at.z, until: now + lifetimeMs };
    this.drops.set(drop.id, drop);
    while (this.drops.size > BONUS.max) this.removeDrop([...this.drops.keys()][0]!, 0);
    this.room.io.to(this.room.channel).emit('drop', { id: drop.id, kind: drop.kind, x: drop.x, y: drop.y, z: drop.z });
  }

  private removeDrop(id: number, pid: number): void {
    if (this.drops.delete(id)) this.room.io.to(this.room.channel).emit('dropGone', { id, pid });
  }

  reset(): void {
    for (const id of [...this.drops.keys()]) this.removeDrop(id, 0);
    for (const b of this.boxes) {
      b.phase = 0;
      b.pickup = null;
      b.until = 0;
    }
  }

  /** Nearest intact box along a bullet's path. */
  raycast(ray: Ray, maxT: number): { id: number; t: number } | null {
    let best: { id: number; t: number } | null = null;
    const half = LOOT.boxSize / 2;
    for (const b of this.boxes) {
      if (b.phase !== 0) continue;
      const t = rayAabb(ray, { minX: b.x - half, maxX: b.x + half, minY: b.y - half, maxY: b.y + half, minZ: b.z - half, maxZ: b.z + half }, best ? best.t : maxT);
      if (t >= 0) best = { id: b.id, t };
    }
    return best;
  }

  smash(id: number, now: number): void {
    const b = this.boxes[id];
    if (!b || b.phase !== 0) return;
    b.phase = 1;
    b.pickup = randomPickup(!this.room.mode.weapons, this.room.random);
    b.until = now + LOOT.pickupLifetimeMs;
    this.emit(b);
  }

  blast(centre: Vec3, radius: number, now: number): void {
    for (const b of this.boxes) {
      if (b.phase === 0 && Math.hypot(b.x - centre.x, b.y - centre.y, b.z - centre.z) < radius) this.smash(b.id, now);
    }
  }

  update(now: number): void {
    for (const d of [...this.drops.values()]) {
      if (now >= d.until) {
        this.removeDrop(d.id, 0);
        continue;
      }
      for (const p of this.room.players.values()) {
        // Power-ups are for survivors only, and the room decides what they do.
        if (!p.alive || p.vehicle || p.info.undead || !this.inReach({ x: d.x, z: d.z, floor: d.y }, p)) continue;
        if (isPowerUp(d.kind)) this.room.applyPowerUp(d.kind, p, now);
        else if (!this.useful(d.kind, p)) continue;
        else this.apply(d.kind, p);
        this.room.io.to(this.room.channel).emit('pickup', { lootId: -1, pid: p.pid, pickup: d.kind });
        this.removeDrop(d.id, p.pid);
        break;
      }
    }
    for (const b of this.boxes) {
      if (b.phase === 2 && now >= b.until) {
        b.phase = 0;
        b.pickup = null;
        this.emit(b);
      } else if (b.phase === 1) {
        if (now >= b.until) {
          this.empty(b, now);
          continue;
        }
        for (const p of this.room.players.values()) {
          if (!p.alive || p.vehicle || !this.inReach(b, p) || !this.useful(b.pickup!, p)) continue;
          this.apply(b.pickup!, p);
          this.room.io.to(this.room.channel).emit('pickup', { lootId: b.id, pid: p.pid, pickup: b.pickup! });
          this.empty(b, now);
          break;
        }
      }
    }
  }

  private inReach(b: { x: number; z: number; floor: number }, p: ServerPlayer): boolean {
    return Math.hypot(p.state.x - b.x, p.state.z - b.z) < LOOT.collectRadius && Math.abs(p.state.y - b.floor) < LOOT.collectHeight;
  }

  private useful(kind: PickupKind, p: ServerPlayer): boolean {
    switch (kind) {
      case 'medkit':
        return p.hp < PLAYER.maxHealth;
      case 'armor':
        return p.armor < PLAYER.maxArmor;
      case 'fuel':
        return p.state.fuel < JETPACK.maxFuel - 0.05;
      case 'eggs':
        return p.eggs < PLAYER.maxEggs;
    }
  }

  private apply(kind: PickupKind, p: ServerPlayer): void {
    switch (kind) {
      case 'medkit':
        p.hp = Math.min(PLAYER.maxHealth, p.hp + PICKUP_AMOUNT.medkit);
        break;
      case 'armor':
        p.armor = Math.min(PLAYER.maxArmor, p.armor + PICKUP_AMOUNT.armor);
        break;
      case 'fuel':
        p.state.fuel = JETPACK.maxFuel;
        break;
      case 'eggs':
        p.eggs = Math.min(PLAYER.maxEggs, p.eggs + PICKUP_AMOUNT.eggs);
        break;
    }
  }

  private empty(b: Loot, now: number): void {
    b.phase = 2;
    b.pickup = null;
    b.until = now + LOOT.respawnMs;
    this.emit(b);
  }

  private emit(b: Loot): void {
    this.room.io.to(this.room.channel).emit('loot', { id: b.id, phase: b.phase, pickup: b.pickup });
  }
}
