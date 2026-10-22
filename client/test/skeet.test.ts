import assert from 'node:assert/strict';
import { it } from 'node:test';
import { CROUCH, DEFAULT_MODS, HITBOX, WEAPONS, WEAPON_IDS } from '@game/shared';
import { defaultConfig, exportConfig, importConfig, loadConfigs, loadCurrent, presetConfigs, sanitizeConfig, saveConfigs, saveCurrent, toServerMods } from '../src/dev/config';
import { SKEET_PROFILE_IDS, skeetEffectiveConfig, skeetProfile, skeetProfileId } from '../src/dev/skeet/model';
import type { Control, Tab } from '../src/dev/controls';

/** Every control of these tabs, with each picker's sections for every option. */
function controlsOf(tabs: Tab[]): Control[] {
  const expand = (c: Control): Control[] => c.type === 'picker' ? [c, ...c.options.flatMap(o => c.sections(o.value).flatMap(expand))] : [c];
  return tabs.flatMap(t => t.sections.flatMap(s => s.items.flatMap(expand)));
}
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
it('weapon profiles are keyed by the four arsenal guns; legacy-roster guns use the nearest one without mutating normal stats', () => {
  const c = defaultConfig('skeet');
  assert.deepEqual([...SKEET_PROFILE_IDS], ['ssg08', 'scar20', 'deserteagle', 'r8']);
  assert.deepEqual(Object.keys(c.skeet.profiles), ['ssg08', 'scar20', 'deserteagle', 'r8']);
  for (const id of SKEET_PROFILE_IDS) assert.equal(skeetProfileId(WEAPONS[id]), id);
  assert.equal(skeetProfileId(WEAPONS.scout), 'ssg08'); assert.equal(skeetProfileId(WEAPONS.sniper), 'ssg08');
  assert.equal(skeetProfileId(WEAPONS.deagle), 'deserteagle'); assert.equal(skeetProfileId(WEAPONS.pistol), 'deserteagle');
  // R68: every other legacy gun uses the Deagle's profile, whose defaults are the old base profile.
  for (const id of ['rifle', 'smg', 'lmg', 'minigun', 'autoshotgun', 'butterfly', 'rocket'] as const) assert.equal(skeetProfileId(WEAPONS[id]), 'deserteagle', id);
  for (const id of WEAPON_IDS) assert.ok(SKEET_PROFILE_IDS.includes(skeetProfileId(WEAPONS[id])));
  c.skeet.profiles.r8.minDamage = 45;
  assert.equal(skeetProfile(c, WEAPONS.r8), c.skeet.profiles.r8);
  const applied = skeetEffectiveConfig(c, WEAPONS.r8);
  assert.equal(applied.hvh.aim.minDamage, 45); assert.equal(c.hvh.aim.minDamage, 20);
  assert.equal(c.skeet.profiles.deserteagle.minDamage, 20); assert.deepEqual(toServerMods(applied), DEFAULT_MODS);
});
it('Skeet configs clamp every new numeric policy and preserve safe legacy imports', () => {
  const raw = defaultConfig('skeet'); raw.skeet.profiles.ssg08.pointScale = 999; raw.skeet.profiles.r8.hitchance = -1;
  raw.skeet.resolver.history = Infinity; raw.skeet.resolver.memoryMs = 9999; raw.skeet.antiAim.states.moving.desync = 999;
  raw.skeet.cosmetics.tint = 'javascript:evil';
  const safe = sanitizeConfig(raw);
  assert.equal(safe.skeet.profiles.ssg08.pointScale, 75); assert.equal(safe.skeet.profiles.r8.hitchance, 0);
  assert.equal(safe.skeet.resolver.history, 8); assert.equal(safe.skeet.resolver.memoryMs, 1200);
  assert.equal(safe.skeet.antiAim.states.moving.desync, 58); assert.equal(safe.skeet.cosmetics.tint, '#b6d77a');
  assert.deepEqual(importConfig(exportConfig({ name: 'Skeet test', config: safe })).config, safe);
  for (const preset of presetConfigs('skeet')) { assert.deepEqual(sanitizeConfig(preset.config), preset.config); assert.deepEqual(toServerMods(preset.config), DEFAULT_MODS); }
});
it('Lab and Skeet current settings and named presets survive reload in separate stores', t => {
  const store = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v) } });
  t.after(() => Reflect.deleteProperty(globalThis, 'localStorage'));
  const lab = defaultConfig(), skeet = defaultConfig('skeet'); lab.hvh.aim.minDamage = 33; skeet.skeet.profiles.ssg08.minDamage = 70;
  saveCurrent(lab); saveCurrent(skeet, 'skeet'); saveConfigs([{ name: 'Lab only', config: lab }]); saveConfigs([{ name: 'Skeet only', config: skeet }], 'skeet');
  assert.equal(loadCurrent().hvh.aim.minDamage, 33); assert.equal(loadCurrent('skeet').skeet.profiles.ssg08.minDamage, 70);
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

it('anti-bruteforce is gone: no Skeet control, no config field, and the skeet loadout sends it off', async () => {
  const { buildSkeetTabs } = await import('../src/dev/skeet/tabs');
  const { HVH_PANELS } = await import('../src/dev/panels');
  const config = defaultConfig('skeet');
  const labels = controlsOf(buildSkeetTabs({ config } as never)).flatMap(c => [c.label, c.hint ?? '']);
  assert.ok(labels.length > 40, 'the tabs were built');
  assert.deepEqual(labels.filter(l => /brute/i.test(l)), []);
  assert.equal('antiBruteforce' in config.hvh.core!, false);
  assert.equal('antiBruteforce' in sanitizeConfig({ ...config, hvh: { ...config.hvh, core: { ...config.hvh.core, antiBruteforce: true } } }).hvh.core!, false);
  assert.equal(HVH_PANELS.skeet.loadout(config).core!.antiBruteforce, false, 'legacy rooms read it as off until cutover');
});

it('the target, shot-log and resolver status box settings are gone from the config and the panel', async () => {
  const { buildSkeetTabs } = await import('../src/dev/skeet/tabs');
  const config = defaultConfig('skeet');
  const paths = controlsOf(buildSkeetTabs({ config } as never)).map(c => ('path' in c ? c.path : undefined) ?? '');
  for (const gone of ['hvh.feedback.targetInfo', 'hvh.feedback.shotLog', 'skeet.indicators.resolver']) assert.ok(!paths.includes(gone), gone);
  assert.deepEqual(Object.keys(config.hvh.feedback), ['resolver']);
  assert.deepEqual(Object.keys(config.skeet.indicators).sort(), ['binds', 'watermark']);
  for (const kept of ['skeet.indicators.binds', 'skeet.indicators.watermark']) assert.ok(paths.includes(kept), kept);
});

/** The parts of Dev the tab builders and control renderer use. */
async function fakeDev() {
  const { getPath, setPath } = await import('../src/dev/config');
  const dev = { config: defaultConfig('skeet'), runtime: { currentSession: null }, get: (p: string) => getPath(dev.config, p),
    set: (p: string, v: unknown) => setPath(dev.config, p, v), click() {}, menuRefresh() {}, notify() {} };
  return dev;
}
const pickersOf = (tab: Tab) => tab.sections.flatMap(s => s.items).filter((c): c is Extract<Control, { type: 'picker' }> => c.type === 'picker');
const labelsOf = (cs: Control[]) => cs.map(c => c.label);

it('Rage has one weapon picker over the four arsenal guns; only scoped guns have auto-scope', async () => {
  const { buildSkeetTabs } = await import('../src/dev/skeet/tabs');
  const tabs = buildSkeetTabs((await fakeDev()) as never), rage = tabs.find(t => t.id === 'rage')!;
  const pickers = pickersOf(rage);
  assert.equal(pickers.length, 1);
  const [weapons] = pickers;
  assert.deepEqual(weapons!.options.map(o => o.value), ['ssg08', 'scar20', 'deserteagle', 'r8']);
  assert.deepEqual(weapons!.options.map(o => o.label), ['SSG 08', 'SCAR-20', 'Desert Eagle', 'R8 Revolver']);
  for (const o of weapons!.options) assert.ok(o.icon.length > 0, `${o.value} has an icon`);
  for (const id of ['ssg08', 'scar20', 'deserteagle', 'r8']) {
    const labels = labelsOf(weapons!.sections(id));
    for (const l of ['Hit chance', 'Minimum damage', 'Hitboxes', 'Multipoint', 'Safe points', 'Auto-stop']) assert.ok(labels.includes(l), `${id}: ${l}`);
    assert.equal(labels.includes('Auto-scope'), id === 'ssg08' || id === 'scar20', `${id} auto-scope`);
    for (const c of weapons!.sections(id)) assert.ok(!('path' in c) || c.path!.startsWith(`skeet.profiles.${id}.`), `${id}: ${c.label}`);
  }
  assert.ok(!rage.sections.some(s => /General fallback|Pistols|Rifles|Snipers|Shotguns|SMGs|Heavy/.test(s.title)), 'no group profile sections');
});

it('Anti-aim: enable, at targets, freestanding, invert key and one Defensive toggle; then a five-stance picker; then DT and hide shots', async () => {
  const { buildSkeetTabs } = await import('../src/dev/skeet/tabs');
  const dev = await fakeDev();
  const aa = buildSkeetTabs(dev as never).find(t => t.id === 'antiaim')!;
  assert.deepEqual(labelsOf(aa.sections[0]!.items), ['Enable anti-aim', 'At targets', 'Freestanding', 'Invert desync', 'Defensive']);
  const pickers = pickersOf(aa);
  assert.equal(pickers.length, 1);
  assert.ok(aa.sections[1]!.items.includes(pickers[0]!), 'the stance picker comes second');
  const stance = pickers[0]!;
  assert.deepEqual(stance.options.map(o => o.value), ['standing', 'moving', 'airborne', 'crouching', 'slowwalking']);
  for (const s of stance.options.map(o => o.value)) {
    const paths = stance.sections(s).map(c => ('path' in c ? c.path : undefined) ?? '');
    for (const key of ['base', 'yawOffsetDeg', 'jitterDeg', 'desyncDeg']) assert.ok(paths.includes(`hvh.v2AntiAim.stances.${s}.${key}`), `${s} ${key}`);
    for (const key of ['inAir', 'onPeek', 'always', 'pitch', 'yaw']) assert.ok(paths.includes(`hvh.v2AntiAim.defensive.${s}.${key}`), `${s} defensive ${key}`);
    assert.ok(!paths.includes(`hvh.v2AntiAim.defensive.${s}.enabled`), 'on/off is the one shared toggle');
  }
  assert.ok(aa.sections[2]!.items.some(c => c.label === 'Exploit mode'), 'DT and hide shots follow the picker');
  const all = controlsOf([aa]);
  assert.ok(!all.some(c => c.label === 'Use state builder'));
  assert.ok(!all.some(c => 'path' in c && (c.path?.startsWith('skeet.antiAim.states.') || c.path === 'hvh.antiAim.mode')));
  assert.ok(!aa.sections.some(s => /Base stance|[Ss]tance$/.test(s.title) && !s.items.includes(stance)), 'no legacy stance sections');
  // R57: the shared toggle writes every stance's defensive `enabled`.
  const defensive = aa.sections[0]!.items[4]! as Extract<Control, { type: 'toggle' | 'check' }>;
  assert.equal(defensive.bind!.get(), false);
  defensive.bind!.set(true);
  assert.deepEqual(Object.values(dev.config.hvh.v2AntiAim.defensive).map(d => d.enabled), [true, true, true, true, true]);
  assert.equal(defensive.bind!.get(), true);
  defensive.bind!.set(false);
  assert.deepEqual(Object.values(dev.config.hvh.v2AntiAim.defensive).map(d => d.enabled), [false, false, false, false, false]);
});

it('each tab remembers its own picker selection', async () => {
  const { buildSkeetTabs } = await import('../src/dev/skeet/tabs');
  const dev = await fakeDev();
  const picker = (id: string) => pickersOf(buildSkeetTabs(dev as never).find(t => t.id === id)!)[0]!;
  const was = { rage: picker('rage').bind.get(), antiaim: picker('antiaim').bind.get() };
  try {
    picker('rage').bind.set('r8');
    picker('antiaim').bind.set('airborne');
    assert.equal(picker('rage').bind.get(), 'r8');
    assert.equal(picker('antiaim').bind.get(), 'airborne');
    picker('rage').bind.set('ssg08');
    assert.equal(picker('antiaim').bind.get(), 'airborne');
  } finally {
    // The picks live for the page session: leave them as found for later tests.
    picker('rage').bind.set(was.rage);
    picker('antiaim').bind.set(was.antiaim);
  }
});

it('legacy HvH rooms aim as before Task 12 by default: non-arsenal rifles, heavy guns and melee keep the old base profile', () => {
  // The pre-Task-12 default 'rifles', 'heavy' and 'general' group profiles, written out.
  const oldBase = { minDamage: 20, hitchance: 60, bodyAim: 'lethal', multipoint: true, pointScale: 50, safePoints: true, autoStop: true, autoScope: false };
  const c = defaultConfig('skeet');
  for (const id of ['rifle', 'lmg', 'minigun', 'butterfly'] as const) {
    assert.deepEqual({ ...skeetProfile(c, WEAPONS[id]) }, oldBase, id);
    const aim = skeetEffectiveConfig(c, WEAPONS[id]).hvh.aim;
    assert.equal(aim.minDamage, 20, id);
    assert.equal(aim.hitchance, 60, id);
    assert.equal(aim.bodyAim, 'lethal', id);
  }
});

it('a picker renders an icon row; clicking an icon shows only that value\'s controls beneath it', async () => {
  const { withFakeDom } = await import('./hvh-v2/fakeDom');
  const { renderControl } = await import('../src/dev/controls');
  const dev = await fakeDev();
  let selected = 'a';
  const picker: Control = { type: 'picker', label: 'Weapon', bind: { get: () => selected, set: v => { selected = v; } },
    options: [{ value: 'a', label: 'Alpha', icon: 'A' }, { value: 'b', label: 'Beta', icon: 'B' }],
    sections: v => v === 'a' ? [{ type: 'toggle', label: 'Alpha only', path: 'misc.crosshair' }] : [{ type: 'toggle', label: 'Beta one', path: 'misc.ping' }, { type: 'toggle', label: 'Beta two', path: 'misc.coords' }] };
  withFakeDom(() => {
    const { el } = renderControl(dev as never, picker);
    const root = el as unknown as import('./hvh-v2/fakeDom').FakeElement;
    const icons = root.find('dev-picker-icon');
    assert.deepEqual(icons.map(i => i.text()), ['A', 'B']);
    assert.deepEqual(icons.map(i => i.getAttribute('aria-label')), ['Alpha', 'Beta']);
    assert.equal(icons[0]!.getAttribute('aria-pressed'), 'true');
    const body = () => root.find('dev-picker-body')[0]!;
    assert.match(body().text(), /Alpha only/);
    icons[1]!.listeners.click!();
    assert.equal(selected, 'b');
    assert.doesNotMatch(body().text(), /Alpha only/);
    assert.match(body().text(), /Beta one.*Beta two/);
    assert.deepEqual(icons.map(i => i.getAttribute('aria-pressed')), ['false', 'true']);
  });
});

it('every setting has one control across the Skeet tabs and the native menu; Misc is at most 4 short sections', async () => {
  const { buildSkeetTabs } = await import('../src/dev/skeet/tabs');
  const { NATIVE_CONFIG_PATHS } = await import('../src/dev/skeet/nativeFields');
  const tabs = buildSkeetTabs((await fakeDev()) as never);
  const owners = new Map<string, string[]>();
  const own = (path: string, who: string) => owners.set(path, [...(owners.get(path) ?? []), who]);
  for (const t of tabs) for (const c of controlsOf([t])) if ('path' in c && c.path) own(c.path, `${t.id}: ${c.label}`);
  for (const [field, path] of Object.entries(NATIVE_CONFIG_PATHS)) own(path, `native ${field}`);
  assert.ok(owners.size > 100, 'the tabs were built');
  assert.deepEqual([...owners].filter(([, who]) => who.length > 1), []);
  const misc = tabs.find(t => t.id === 'misc')!;
  assert.ok(misc.sections.length <= 4, `${misc.sections.length} Misc sections`);
  for (const s of misc.sections) assert.ok(s.items.length <= 9, `${s.title}: ${s.items.length} controls`);
  const labels = controlsOf([misc]).map(c => c.label);
  assert.equal(new Set(labels).size, labels.length, `repeated Misc labels: ${labels.join(', ')}`);
  assert.ok(!labels.some(l => /third person/i.test(l)), 'the native Force third person covers it');
  for (const kept of ['Keybind list', 'Watermark']) assert.ok(labels.includes(kept), kept);
});
