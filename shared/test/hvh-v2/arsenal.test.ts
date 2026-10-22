import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ARMS_LADDER } from '../../src/arms';
import { BUY_ITEMS, isSidearm } from '../../src/bomb';
import { PLAYER } from '../../src/constants';
import { hvhHitDamage } from '../../src/hvh/ballistics';
import { hvhWeapon } from '../../src/hvh/weapons';
import { CSGO_HITGROUP, HVH_MAINS, HVH_PISTOLS, isHvhArsenal } from '../../src/hvh/v2/arsenal';
import { fireIntervalTicks } from '../../src/hvh/v2/shot';
import { ITEMS, sanitizeLoadout } from '../../src/items';
import { TRAINING_GUNS, TRAINING_KNIVES } from '../../src/training';
import { WEAPONS, WEAPON_IDS, damageAt, spreadFor, type WeaponId } from '../../src/weapons';

const ARSENAL: readonly WeaponId[] = [...HVH_MAINS, ...HVH_PISTOLS];
const open = { wallDistance: 100, passages: [] };

describe('CS:GO arsenal', () => {
  it('lists the four HvH weapons, appended after the existing ids', () => {
    assert.deepEqual(ARSENAL, ['ssg08', 'scar20', 'deserteagle', 'r8']);
    assert.deepEqual(WEAPON_IDS.slice(-4), ARSENAL);
    for (const id of ARSENAL) assert.equal(isHvhArsenal(id), true, id);
    for (const id of ['scout', 'deagle', 'revolver', 'sniper'] as const) assert.equal(isHvhArsenal(id), false, id);
    assert.deepEqual(CSGO_HITGROUP, { head: 4, stomach: 1.25, pelvis: 1.25, leg: 0.75, other: 1 });
    for (const id of ARSENAL) assert.equal(isSidearm(id), (HVH_PISTOLS as readonly WeaponId[]).includes(id), id);
  });

  it('falls off by rangeModifier every 12.5 m (500 Source units)', () => {
    assert.ok(Math.abs(damageAt(WEAPONS.ssg08, 12.5) - 88 * 0.98) < 1e-9);
    // Final CS:GO Desert Eagle (Operation Riptide): 53 damage, range modifier 0.85.
    assert.ok(Math.abs(damageAt(WEAPONS.deserteagle, 25) - 53 * 0.85 ** 2) < 1e-9);
    assert.equal(damageAt(WEAPONS.r8, 0), 86);
    // Legacy weapons keep their linear falloff.
    assert.equal(damageAt(WEAPONS.pistol, 25), WEAPONS.pistol.damage);
  });

  it('gets no HvH tuning; legacy weapons are tuned as before', () => {
    assert.equal(hvhWeapon(WEAPONS.ssg08), WEAPONS.ssg08);
    const scout = hvhWeapon(WEAPONS.scout);
    assert.equal(scout.damage, 40 * 1.6);
    assert.equal(scout.headshotMultiplier, 3);
    assert.equal(scout.spread, 0.003 * 0.45);
  });

  it('uses CS:GO hitgroup multipliers', () => {
    const at5 = damageAt(WEAPONS.scar20, 5);
    assert.ok(Math.abs(hvhHitDamage(WEAPONS.scar20, { t: 5, group: 'stomach', headshot: false }, open) - at5 * 1.25) < 1e-9);
    assert.ok(Math.abs(hvhHitDamage(WEAPONS.scar20, { t: 5, group: 'head', headshot: true }, open) - at5 * 4) < 1e-9);
    assert.ok(Math.abs(hvhHitDamage(WEAPONS.scar20, { t: 5, group: 'leg', headshot: false }, open) - at5 * 0.75) < 1e-9);
    assert.ok(Math.abs(hvhHitDamage(WEAPONS.scar20, { t: 5, group: 'chest', headshot: false }, open) - at5) < 1e-9);
    // CS:GO's stomach hitgroup includes the pelvis (ruling R50).
    assert.ok(Math.abs(hvhHitDamage(WEAPONS.scar20, { t: 5, group: 'pelvis', headshot: false }, open) - at5 * 1.25) < 1e-9);
    assert.ok(Math.abs(hvhHitDamage(WEAPONS.deserteagle, { t: 5, group: 'head', headshot: true }, open) - damageAt(WEAPONS.deserteagle, 5) * 3.9) < 1e-9);
    assert.ok(Math.abs(hvhHitDamage(WEAPONS.ssg08, { t: 5, group: 'head', headshot: true }, open) - damageAt(WEAPONS.ssg08, 5) * 4) < 1e-9);
    assert.ok(Math.abs(hvhHitDamage(WEAPONS.ssg08, { t: 5, group: 'leg', headshot: false }, open) - damageAt(WEAPONS.ssg08, 5) * 0.75) < 1e-9);
    assert.ok(Math.abs(hvhHitDamage(WEAPONS.scout, { t: 5, group: 'pelvis', headshot: false }, open) - damageAt(WEAPONS.scout, 5)) < 1e-9);
    // Legacy weapons keep the old stomach multiplier.
    assert.ok(Math.abs(hvhHitDamage(WEAPONS.scout, { t: 5, group: 'stomach', headshot: false }, open) - damageAt(WEAPONS.scout, 5) * 1.15) < 1e-9);
  });

  it('scoped snipers use the CS:GO scoped inaccuracy; legacy weapons keep the ×0.25 scope', () => {
    // items_game: (spread alt + inaccuracy stand alt) / 1000.
    assert.ok(Math.abs(spreadFor(WEAPONS.ssg08, 0, false, true) - (0.23 + 3) / 1000) < 1e-12);
    assert.ok(Math.abs(spreadFor(WEAPONS.scar20, 0, false, true) - (0.3 + 2) / 1000) < 1e-12);
    // Moving and airborne inaccuracy still add on top while scoped.
    const run = spreadFor(WEAPONS.ssg08, PLAYER.speed, true, true);
    assert.ok(Math.abs(run - (0.00323 + WEAPONS.ssg08.moveSpread + WEAPONS.ssg08.airSpread)) < 1e-12);
    assert.equal(spreadFor(WEAPONS.ssg08, 0, false, false), WEAPONS.ssg08.spread);
    assert.equal(spreadFor(WEAPONS.scout, 0, false, true), WEAPONS.scout.spread * 0.25);
    assert.equal(spreadFor(WEAPONS.deserteagle, 0, false, true), WEAPONS.deserteagle.spread * 0.6);
  });

  it('cycles in whole 64 Hz ticks, rounded up', () => {
    assert.equal(fireIntervalTicks(WEAPONS.ssg08), 80);
    assert.equal(fireIntervalTicks(WEAPONS.scar20), 16);
    assert.equal(fireIntervalTicks(WEAPONS.deserteagle), 15);
    assert.equal(fireIntervalTicks(WEAPONS.r8), 32);
  });

  it('carries the CS:GO armor penetration, range modifier and R8 hammer', () => {
    assert.deepEqual(WEAPONS.ssg08.csgo, { armorPen: 0.85, rangeModifier: 0.98, scopedSpread: 0.00323 });
    assert.deepEqual(WEAPONS.scar20.csgo, { armorPen: 0.825, rangeModifier: 0.98, scopedSpread: 0.0023 });
    assert.deepEqual(WEAPONS.deserteagle.csgo, { armorPen: 0.932, rangeModifier: 0.85 });
    assert.deepEqual(WEAPONS.r8.csgo, { armorPen: 0.932, rangeModifier: 0.94, hammerMs: 400 });
    assert.equal(WEAPONS.scar20.automatic, true);
    assert.equal(WEAPONS.ssg08.scope && WEAPONS.scar20.scope, true);
    assert.equal(WEAPONS.deserteagle.scope || WEAPONS.r8.scope, false);
    for (const id of WEAPON_IDS) assert.equal(WEAPONS[id].csgo !== undefined, isHvhArsenal(id), id);
  });

  it('stays out of the shop, inventory, loadouts, Training, Arms Race and the bomb buy menu', () => {
    const lists: Record<string, readonly string[]> = {
      'ITEMS (shop, daily deals, inventory)': ITEMS.filter((i) => i.slot === 'weapon').map((i) => i.key),
      TRAINING_GUNS, TRAINING_KNIVES, ARMS_LADDER,
      BUY_ITEMS: BUY_ITEMS.flatMap((i) => (i.weapon ? [i.weapon] : [])),
      'sanitizeLoadout': sanitizeLoadout([...ARSENAL, 'pistol'], () => true, 4, ['rifle']),
    };
    for (const [name, list] of Object.entries(lists)) {
      for (const id of ARSENAL) assert.ok(!list.includes(id), `${name} contains ${id}`);
    }
  });
});
