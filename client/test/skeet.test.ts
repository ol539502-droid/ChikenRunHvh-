import assert from 'node:assert/strict';
import { it } from 'node:test';
import { CROUCH, DEFAULT_MODS, HITBOX, WEAPONS, WEAPON_IDS } from '@game/shared';
import { defaultConfig, exportConfig, importConfig, loadConfigs, loadCurrent, presetConfigs, sanitizeConfig, saveConfigs, saveCurrent, toServerMods } from '../src/dev/config';
import { SKEET_GROUPS, skeetEffectiveConfig, skeetProfile, skeetWeaponGroup } from '../src/dev/skeet/model';
import { skeetPointOffsets, skeetSafeRay } from '../src/dev/skeet/points';
it('native menu colors and all six materials survive config export while invalid values are bounded', () => {
  const c=defaultConfig('skeet');
  Object.assign(c.skeet.native,{Visuals_ColoredModels_playerMaterial:5,Visuals_Other_droppedWeapons:999,Color_Players_glow_3:-1,Misc_overrideFov:Infinity,Visuals_Players_boundingBox:9});
  const safe=sanitizeConfig(c);
  assert.equal(safe.skeet.native.Visuals_ColoredModels_playerMaterial,5);
  assert.equal(safe.skeet.native.Visuals_Other_droppedWeapons,3);
  assert.equal(safe.skeet.native.Color_Players_glow_3,0);
  assert.equal(safe.skeet.native.Misc_overrideFov,0);
  assert.equal(safe.skeet.native.Visuals_Players_boundingBox,1);
  assert.deepEqual(importConfig(exportConfig({name:'Native menu',config:safe})).config.skeet.native,safe.skeet.native);
});
it('weapon profiles cover the complete roster and fall back without mutating normal stats or Lab settings', () => {
  const c = defaultConfig('skeet');
  assert.equal(skeetWeaponGroup(WEAPONS.deagle), 'pistols'); assert.equal(skeetWeaponGroup(WEAPONS.scout), 'snipers');
  assert.equal(skeetWeaponGroup(WEAPONS.autoshotgun), 'shotguns'); assert.equal(skeetWeaponGroup(WEAPONS.lmg), 'heavy');
  assert.equal(skeetWeaponGroup(WEAPONS.rocket), 'general'); assert.equal(skeetWeaponGroup(WEAPONS.butterfly), 'general');
  for (const id of WEAPON_IDS) assert.ok(SKEET_GROUPS.includes(skeetWeaponGroup(WEAPONS[id])));
  c.skeet.profiles.snipers.enabled = false; assert.equal(skeetProfile(c, WEAPONS.sniper), c.skeet.profiles.general);
  c.skeet.profiles.pistols.minDamage = 45;
  const applied = skeetEffectiveConfig(c, WEAPONS.deagle);
  assert.equal(applied.hvh.aim.minDamage, 45); assert.equal(c.hvh.aim.minDamage, 20);
  assert.equal(c.skeet.profiles.rifles.minDamage, 20); assert.deepEqual(toServerMods(applied), DEFAULT_MODS);
});
it('Skeet configs clamp every new numeric policy and preserve safe legacy imports', () => {
  const raw = defaultConfig('skeet'); raw.skeet.profiles.snipers.pointScale = 999; raw.skeet.profiles.pistols.hitchance = -1;
  raw.skeet.resolver.history = Infinity; raw.skeet.resolver.memoryMs = 9999; raw.skeet.antiAim.states.moving.desync = 999;
  raw.skeet.cosmetics.tint = 'javascript:evil';
  const safe = sanitizeConfig(raw);
  assert.equal(safe.skeet.profiles.snipers.pointScale, 75); assert.equal(safe.skeet.profiles.pistols.hitchance, 0);
  assert.equal(safe.skeet.resolver.history, 8); assert.equal(safe.skeet.resolver.memoryMs, 1200);
  assert.equal(safe.skeet.antiAim.states.moving.desync, 58); assert.equal(safe.skeet.cosmetics.tint, '#b6d77a');
  assert.deepEqual(importConfig(exportConfig({ name: 'Skeet test', config: safe })).config, safe);
  for (const preset of presetConfigs('skeet')) { assert.deepEqual(sanitizeConfig(preset.config), preset.config); assert.deepEqual(toServerMods(preset.config), DEFAULT_MODS); }
});
it('Lab and Skeet current settings and named presets survive reload in separate stores', t => {
  const store = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v) } });
  t.after(() => Reflect.deleteProperty(globalThis, 'localStorage'));
  const lab = defaultConfig(), skeet = defaultConfig('skeet'); lab.hvh.aim.minDamage = 33; skeet.skeet.profiles.snipers.minDamage = 70;
  saveCurrent(lab); saveCurrent(skeet, 'skeet'); saveConfigs([{ name: 'Lab only', config: lab }]); saveConfigs([{ name: 'Skeet only', config: skeet }], 'skeet');
  assert.equal(loadCurrent().hvh.aim.minDamage, 33); assert.equal(loadCurrent('skeet').skeet.profiles.snipers.minDamage, 70);
  assert.equal(loadConfigs()[0]!.name, 'Lab only'); assert.equal(loadConfigs('skeet')[0]!.name, 'Skeet only');
});
it('migrates old public-real and visual resolver configs to the observable center assumption', () => {
  for (const mode of ['real', 'visual']) {
    const c = defaultConfig('skeet');
    assert.equal(sanitizeConfig({ ...c, skeet: { ...c.skeet, resolver: { ...c.skeet.resolver, mode } } }).skeet.resolver.mode, 'center');
  }
});
it('multipoints stay inside standing and crouching hit volumes and safe points reject ambiguous head edges', () => {
  for (const scale of [1, CROUCH.scale]) for (const part of ['head', 'body'] as const) {
    const radius = (part === 'head' ? HITBOX.headRadius : HITBOX.bodyRadius) * scale;
    for (const point of skeetPointOffsets(part, scale, 999, true)) assert.ok(Math.hypot(point.x, point.y, point.z) < radius);
    assert.equal(skeetPointOffsets(part, scale, 50, false).length, 1);
  }
  const target = { x: 0, y: 0, z: 10, yaw: 0, scale: 1, hp: 100, armor: 0 }, eye = { x: 0, y: HITBOX.headHeight, z: 0 };
  assert.equal(skeetSafeRay(eye, { x: 0, y: 0, z: 10 }, target, 25, 20), true);
  assert.equal(skeetSafeRay(eye, { x: 0.22, y: 0, z: 9.7 }, target, 0, 20), true);
  assert.equal(skeetSafeRay(eye, { x: 0.22, y: 0, z: 9.7 }, target, 25, 20), false);
});

it('every saved native menu field has a matching C++ bridge case, both ways', async () => {
  const { readFileSync } = await import('node:fs');
  const { NATIVE_FIELDS } = await import('../src/dev/skeet/nativeFields');
  const bridge = readFileSync(new URL('../native/skeet/config_bridge.inc', import.meta.url), 'utf8');
  const [set, get] = bridge.split('float native_get');
  NATIVE_FIELDS.forEach((f, i) => {
    assert.equal(f.id, i, 'ids run 0, 1, 2…');
    // Arrays (colours, multi-selects) end in _0, _1…: that index must be the one the case uses.
    const path = `g_Config.${f.field}${/_\d$/.test(f.key) ? `[${f.component}]` : ''}`;
    assert.ok(set!.includes(`case ${f.id}: ${path}=`), `native_set ${f.id} ${f.key}`);
    assert.ok(get!.includes(`case ${f.id}: return ${path};`), `native_get ${f.id} ${f.key}`);
  });
});
