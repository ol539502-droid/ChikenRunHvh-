import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BUY_CATEGORIES, BUY_ITEMS, KNIFE_SKINS, WEAPONS, WEAPON_IDS, isMelee, isSidearm } from '../src/index';
import { isHvhArsenal } from '../src/hvh/v2/arsenal';

describe('the ChikenBomb buy menu', () => {
  it('uses the five reference columns and separates equipment from grenades', () => {
    assert.deepEqual(BUY_CATEGORIES.map((c) => c.name), ['Equipment', 'Pistols', 'Mid-Tier', 'Rifles', 'Grenades']);
    for (const item of BUY_ITEMS.filter((i) => i.kind !== 'weapon')) assert.equal(item.category, item.kind === 'armor' || item.kind === 'kit' ? 'equipment' : 'grenade');
  });
  it('sells every gun in the game, each in a column', () => {
    const sold = new Set(BUY_ITEMS.map((i) => i.weapon));
    const guns = WEAPON_IDS.filter((id) => !isMelee(id) && !isHvhArsenal(id));
    assert.deepEqual(guns.filter((id) => !sold.has(id)), [], 'guns missing from the buy menu');
    for (const item of BUY_ITEMS) assert.ok(BUY_CATEGORIES.some((c) => c.id === item.category), `${item.id} has no column`);
    for (const id of ['pistol', 'deagle', 'fiveseven', 'dualies', 'silenced', 'revolver', 'mpistol', 'deserteagle', 'r8'] as const) assert.ok(isSidearm(id), `${id} is a pistol`);
    assert.ok(!isSidearm('ssg08') && !isSidearm('scar20'));
    assert.ok(!isSidearm('rifle') && !isSidearm('smg'));
  });
});

describe('CS2-style knives', () => {
  it('only look different: same stats as the Knife', () => {
    const { id: _id, name: _name, price: _price, model: _model, ...knife } = WEAPONS.knife;
    for (const id of KNIFE_SKINS) {
      const { id: _i, name: _n, price: _p, model: _m, ...skin } = WEAPONS[id];
      assert.deepEqual(skin, knife, id);
    }
  });
});
