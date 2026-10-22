import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { HvhBuyModel, HVH_BUY_STORAGE_KEY, isTypingTarget, menuKey } from '../../src/ui/hvh/HvhBuyMenu';

function memoryStore(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return { data, get: (k: string) => data.get(k) ?? null, set: (k: string, v: string) => void data.set(k, v) };
}

describe('HvhBuyModel', () => {
  it('has two categories with the exact arsenal ids', () => {
    const model = new HvhBuyModel(memoryStore());
    assert.deepEqual(model.categories.map((c) => ({ id: c.id, items: [...c.items] })), [
      { id: 'main', items: ['ssg08', 'scar20'] },
      { id: 'pistol', items: ['deserteagle', 'r8'] },
    ]);
  });

  it('defaults to SSG 08 + Desert Eagle', () => {
    assert.deepEqual(new HvhBuyModel(memoryStore()).selected, { main: 'ssg08', pistol: 'deserteagle' });
    // No storage at all (node, private mode): still the default.
    assert.deepEqual(new HvhBuyModel().selected, { main: 'ssg08', pistol: 'deserteagle' });
  });

  it("pick('r8') replaces the pistol only; a main replaces the main only", () => {
    const model = new HvhBuyModel(memoryStore());
    assert.equal(model.pick('r8'), 'pistol');
    assert.deepEqual(model.selected, { main: 'ssg08', pistol: 'r8' });
    assert.equal(model.pick('scar20'), 'main');
    assert.deepEqual(model.selected, { main: 'scar20', pistol: 'r8' });
  });

  it('ignores ids outside the arsenal', () => {
    const model = new HvhBuyModel(memoryStore());
    assert.equal(model.pick('ak47'), null);
    assert.equal(model.pick('knife'), null);
    assert.deepEqual(model.selected, { main: 'ssg08', pistol: 'deserteagle' });
  });

  it('remembers the last pick across models, and ignores a broken or stale saved pick', () => {
    const store = memoryStore();
    new HvhBuyModel(store).pick('scar20');
    new HvhBuyModel(store).pick('r8');
    assert.deepEqual(new HvhBuyModel(store).selected, { main: 'scar20', pistol: 'r8' });
    assert.deepEqual(new HvhBuyModel(memoryStore({ [HVH_BUY_STORAGE_KEY]: '{not json' })).selected, { main: 'ssg08', pistol: 'deserteagle' });
    assert.deepEqual(new HvhBuyModel(memoryStore({ [HVH_BUY_STORAGE_KEY]: JSON.stringify({ main: 'r8', pistol: 'ak47' }) })).selected,
      { main: 'ssg08', pistol: 'deserteagle' });
  });

  it('a refused pick re-syncs the selection from the loadout the server kept, without forgetting the saved pick (M4)', () => {
    const store = memoryStore();
    const model = new HvhBuyModel(store);
    model.pick('scar20');
    model.pick('r8');
    // The server refused both (picking too fast): the player still carries SSG 08 + Desert Eagle.
    assert.equal(model.sync(['ssg08', 'deserteagle']), true);
    assert.deepEqual(model.selected, { main: 'ssg08', pistol: 'deserteagle' });
    assert.equal(model.sync(['ssg08', 'deserteagle']), false, 'already in sync');
    // Not a loadout from the arsenal (legacy kit, empty): the selection is left alone.
    assert.equal(model.sync(['pistol', 'knife']), false);
    assert.deepEqual(model.selected, { main: 'ssg08', pistol: 'deserteagle' });
    assert.deepEqual(new HvhBuyModel(store).selected, { main: 'scar20', pistol: 'r8' }, 'the next window retries the saved pick');
  });

  it('the passive freeze menu leaves the weapon slot keys to the game; the opened menu picks with them (Minor 9)', () => {
    for (const key of ['1', '2', '3', '4']) {
      assert.equal(menuKey({ key, code: `Digit${key}` }, true, 4), null, `passive ${key}`);
      assert.deepEqual(menuKey({ key, code: `Digit${key}` }, false, 4), { pick: Number(key) - 1 }, `opened ${key}`);
    }
    assert.equal(menuKey({ key: '5', code: 'Digit5' }, false, 4), null, 'past the last card');
    for (const passive of [true, false]) {
      assert.equal(menuKey({ key: 'Escape', code: 'Escape' }, passive, 4), 'close');
      assert.equal(menuKey({ key: 'w', code: 'KeyW' }, passive, 4), null);
    }
    assert.equal(menuKey({ key: 'b', code: 'KeyB' }, false, 4), 'close');
    assert.equal(menuKey({ key: 'b', code: 'KeyB' }, true, 4), null, 'passive: B goes to the game, which opens the menu to pick');
  });

  it('keys typed into chat or a text field are not menu keys', () => {
    assert.equal(isTypingTarget({ tagName: 'INPUT' }), true);
    assert.equal(isTypingTarget({ tagName: 'TEXTAREA' }), true);
    assert.equal(isTypingTarget({ tagName: 'DIV', isContentEditable: true }), true);
    assert.equal(isTypingTarget({ tagName: 'BUTTON', isContentEditable: false }), false);
    assert.equal(isTypingTarget({ tagName: 'BODY' }), false);
    assert.equal(isTypingTarget(null), false);
  });

  it('a storage that throws never breaks picking', () => {
    const model = new HvhBuyModel({ get: () => { throw new Error('denied'); }, set: () => { throw new Error('denied'); } });
    assert.equal(model.pick('r8'), 'pistol');
    assert.deepEqual(model.selected, { main: 'ssg08', pistol: 'r8' });
  });
});
