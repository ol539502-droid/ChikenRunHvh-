import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { ARMS_LADDER, BOMB, BUY_ITEMS, LOADOUT_GROUPS, MODES, SIM_DT, TRAINING_GUNS, WEAPONS, WEAPON_IDS, canBuy, isMelee, loadoutGroup, weaponAllowed, type ModeId, type WeaponId } from '@game/shared';
import { isHvhArsenal } from '@game/shared/hvh/v2';
import { runDevAction } from '../src/dev/devActions';
import type { BombRoom } from '../src/rooms/BombRoom';
import type { GameRoom } from '../src/rooms/GameRoom';
import { createRoom } from '../src/rooms/modes';
import { addPlayer, fakeIo, type RecordedEvent } from './helpers';

let current: GameRoom | null = null;
afterEach(() => current?.close());

const SPECIAL: WeaponId[] = ['minigun', 'golden', 'rocket', 'crossbow', 'launcher', 'goldknife', 'pan', 'katana'];
// The v2 HvH arsenal (ssg08, scar20, deserteagle, r8) is HvH-only and in none of these lists.
const guns = WEAPON_IDS.filter((id) => !isMelee(id) && !isHvhArsenal(id));
const csGuns = guns.filter((id) => WEAPONS[id].category === 'cs');
const named = (events: RecordedEvent[], name: string) => events.filter((e) => e.event === name);

describe('the weapon list', () => {
  it('every weapon has a kind and a category; the specials are exactly ours', () => {
    for (const id of WEAPON_IDS) {
      assert.ok(['pistol', 'smg', 'rifle', 'sniper', 'shotgun', 'heavy', 'melee'].includes(WEAPONS[id].kind), id);
      assert.ok(['cs', 'special'].includes(WEAPONS[id].category), id);
    }
    assert.deepEqual(WEAPON_IDS.filter((id) => WEAPONS[id].category === 'special').sort(), [...SPECIAL].sort());
    assert.equal(WEAPONS.sniper.name, 'AWP');
    assert.equal(WEAPONS.pistol.name, 'Glock-18');
  });

  it('only the CS-only modes (ChikenBomb, FaceChiken) keep specials out', () => {
    const csOnly = Object.values(MODES).filter((m) => m.csOnly).map((m) => m.id).sort();
    assert.deepEqual(csOnly, ['bomb', 'face']);
    assert.equal(weaponAllowed('crossbow', true), false);
    assert.equal(weaponAllowed('crossbow', undefined), true);
    assert.equal(weaponAllowed('ak47', true), true);
  });

  it('CS2-style guns are everywhere: Arms Race, Training, and the buy menu', () => {
    for (const id of csGuns) assert.ok(ARMS_LADDER.includes(id), `Arms Race has the ${id}`);
    assert.deepEqual([...TRAINING_GUNS].sort(), [...guns].sort(), 'Training has every gun');
    const sold = BUY_ITEMS.filter((i) => i.weapon).map((i) => i.weapon!);
    for (const id of csGuns) assert.ok(sold.includes(id), `buy menu sells the ${id}`);
    for (const team of [1, 2] as const) {
      const onSale = BUY_ITEMS.filter((i) => canBuy(i, team, true) && i.weapon);
      assert.equal(onSale.filter((i) => WEAPONS[i.weapon!].category === 'special').length, 0, 'no special guns in the CS-only buy menu');
    }
    assert.ok(BUY_ITEMS.some((i) => i.weapon === 'ak47' && i.team === 1) && BUY_ITEMS.some((i) => i.weapon === 'm4a1' && i.team === 2), 'team rifles kept');
  });

  it('the loadout screen groups every gun once, specials on their own', () => {
    const groups = new Set(LOADOUT_GROUPS.map((g) => g.id));
    for (const id of guns) assert.ok(groups.has(loadoutGroup(id) as never), id);
    assert.deepEqual(guns.filter((id) => loadoutGroup(id) === 'special').sort(), SPECIAL.filter((id) => !isMelee(id)).sort());
  });
});

describe('the server refuses special guns in ChikenBomb and FaceChiken', () => {
  function bomb(mode: ModeId) {
    const { io, events } = fakeIo();
    const room = createRoom(io, { id: 'b', code: 'CSONLY', name: 'Bomb', mode, map: 'sandstown', private: true }, {}) as BombRoom;
    current = room;
    clearInterval((room as unknown as { tickTimer: NodeJS.Timeout }).tickTimer);
    const players = Array.from({ length: mode === 'face' ? 4 : 2 }, (_, i) => addPlayer(room, `P${i}`, mode === 'face' ? 100 + i : null));
    room.startNow();
    const update = (room as unknown as { fixedUpdate(now: number): void }).fixedUpdate.bind(room);
    let now = performance.now();
    const step = (ms: number) => { const end = now + ms; while (now < end) update((now = Math.min(end, now + SIM_DT * 1000))); };
    step(BOMB.warmupMs + 50);
    return { room, events, players, step, get now() { return now; } };
  }

  for (const mode of ['bomb', 'face'] as const) {
    it(`${MODES[mode].name}: not sold, not given, not switched to, not fired`, () => {
      const s = bomb(mode);
      const p = s.players[0]!;
      p.money = 50_000;
      for (const id of ['minigun', 'crossbow', 'launcher', 'rocket', 'golden'] as const) {
        const res = s.room.handleBuy(p, id, s.now);
        assert.equal(res.ok, false, `${id} is not sold`);
        assert.match(res.error!, /isn’t allowed/);
      }
      assert.equal(s.room.handleBuy(p, p.info.team === 1 ? 'ak47' : 'm4a1', s.now).ok, true, 'a CS2 gun is');
      assert.equal(runDevAction(s.room, p, { kind: 'giveWeapon', target: p.pid, weapon: 'crossbow' }).ok, false, 'not given by dev tools');
      // Even smuggled into the loadout, it can't be switched to or fired.
      p.info.loadout = [...p.info.loadout, 'crossbow'];
      s.room.handleSwitch(p, p.info.loadout.length - 1);
      assert.notEqual(p.weapon, 'crossbow', 'no switching to it');
      p.weaponSlot = p.info.loadout.length - 1;
      p.switchReadyAt = 0;
      const before = named(s.events, 'projectile').length + named(s.events, 'shot').length;
      s.room.handleFire(p, { shot: 99, weapon: 'crossbow', dx: 0, dy: 0, dz: -1, t: performance.now(), aiming: false });
      assert.equal(named(s.events, 'projectile').length + named(s.events, 'shot').length, before, 'and it never fires');
    });
  }

  it('everywhere else the specials work (dev give, Training)', () => {
    const room = createRoom(fakeIo().io, { id: 'f', code: 'FFA9', name: 'F', mode: 'ffa', map: 'farm', private: true }, {}) as GameRoom;
    current = room;
    clearInterval((room as unknown as { tickTimer: NodeJS.Timeout }).tickTimer);
    const p = addPlayer(room, 'Dev');
    room.startNow();
    assert.equal(runDevAction(room, p, { kind: 'giveWeapon', target: p.pid, weapon: 'crossbow' }).ok, true);
    assert.equal(p.weapon, 'crossbow');
  });
});
