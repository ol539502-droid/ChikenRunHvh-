import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { CommandChoker, defaultHvhCore, fakeLagTicks } from '@game/shared';
import { DEFAULT_ERA_ID, ERAS, LATE_CSGO } from '@game/shared/hvh/v2';
import { commandIntent } from '../../src/hvh/PredictedTickbase';
import {
  CONFIG_VERSION, clearMigrationNotice, defaultConfig, migrationNotice, pendingMigrationNotice, queueMigrationNotice, exportConfig, importConfig, loadConfigs, loadCurrentMigrated, migrateConfig, presetConfigs, saveCurrent,
} from '../../src/dev/config';
import { HVH_PANELS } from '../../src/dev/panels';
import { BINDS } from '../../src/keybinds';

/** Every leaf path of a plain JSON object, computed independently of the code under test. */
function leaves(o: unknown, prefix = ''): string[] {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return [prefix];
  return Object.entries(o as Record<string, unknown>).flatMap(([k, v]) => leaves(v, prefix ? `${prefix}.${k}` : k));
}

/** A config saved before v2: no version, legacy-only settings changed from their defaults. */
function legacySaved(): Record<string, unknown> {
  const c = structuredClone(defaultConfig('skeet')) as unknown as Record<string, any>;
  delete c.version;
  c.hvh.antiAim = { ...c.hvh.antiAim, enabled: true, mode: 'left', jitter: 33, desync: 51 };
  c.hvh.exploit = 'doubleTap';
  c.skeet.fakeLag = { enabled: true, limit: 99, mode: 'random', breakOnShot: false };
  c.hvh.core = { ...c.hvh.core, fakeLag: 40, defensive: true, antiBruteforce: false, fakeDuck: true, era: 'defensive' };
  c.skeet.antiAim.jitterMode = 'threeway';
  c.skeet.antiAim.states.standing.desync = 12;
  c.rage.aim.enabled = true;
  return c;
}

describe('migrateConfig', () => {
  it('keeps AA base, jitter, desync, fake-lag limit (clamped to 14) and the DT/HS toggle', () => {
    const { config, reset } = migrateConfig(legacySaved());
    assert.equal(config.version, CONFIG_VERSION);
    assert.equal(config.hvh.antiAim.mode, 'left');
    assert.equal(config.hvh.antiAim.jitter, 33);
    assert.equal(config.hvh.antiAim.desync, 51);
    assert.equal(config.hvh.antiAim.enabled, true);
    assert.equal(config.hvh.exploit, 'doubleTap');
    assert.equal(config.skeet.fakeLag.enabled, true);
    assert.equal(config.skeet.fakeLag.limit, 14);
    assert.equal(config.skeet.fakeLag.breakOnShot, false);
    assert.equal(config.skeet.fakeLag.mode, 'random', 'choke mode is batching policy; CommandChoker still applies it');
    assert.equal(config.hvh.core!.fakeLag, 14);
    assert.equal(config.rage.aim.enabled, true, 'non-mechanics settings carry over');
    for (const kept of ['hvh.antiAim.mode', 'hvh.antiAim.jitter', 'hvh.antiAim.desync', 'hvh.exploit', 'skeet.fakeLag.limit', 'skeet.fakeLag.enabled', 'hvh.core.fakeLag'])
      assert.ok(!reset.includes(kept), `${kept} must not be reset`);
    const hs = legacySaved() as Record<string, any>; hs.hvh.exploit = 'hideShots';
    assert.equal(migrateConfig(hs).config.hvh.exploit, 'hideShots');
    const mid = legacySaved() as Record<string, any>; mid.skeet.fakeLag.limit = 13;
    assert.equal(migrateConfig(mid).config.skeet.fakeLag.limit, 13);
  });

  it('lists the legacy-only fields in reset but keeps their values for legacy rooms', () => {
    const old = legacySaved() as Record<string, any>;
    old.skeet.antiAim.enabled = false;
    const { config, reset } = migrateConfig(old);
    for (const path of ['hvh.core.defensive', 'hvh.core.antiBruteforce', 'hvh.core.fakeDuck', 'skeet.antiAim.enabled', 'skeet.antiAim.jitterMode', 'skeet.antiAim.states.standing.desync'])
      assert.ok(reset.includes(path), `${path} listed (got ${reset.join(', ')})`);
    assert.equal(config.hvh.core!.defensive, true);
    assert.equal('antiBruteforce' in config.hvh.core!, false, 'anti-bruteforce is dropped, not kept');
    assert.equal(config.hvh.core!.fakeDuck, true);
    assert.equal(config.skeet.antiAim.enabled, false, 'stance builder stays off');
    assert.equal(config.skeet.antiAim.jitterMode, 'threeway');
    assert.equal(config.skeet.antiAim.states.standing.desync, 12);
    assert.equal(new Set(reset).size, reset.length, 'no duplicates');
    const notice = migrationNotice(reset);
    assert.match(notice, /Not used in v2 rooms \(kept for legacy\): .*hvh\.core\.fakeDuck/);
    assert.doesNotMatch(notice, /kept for legacy\)[^.]*antiBruteforce/);
    assert.match(notice, /Reset to defaults: hvh\.core\.antiBruteforce\./);
  });

  it('kept legacy settings survive a save/load round-trip', () => {
    const old = legacySaved() as Record<string, any>;
    old.skeet.antiAim.enabled = false;
    const back = migrateConfig(JSON.parse(JSON.stringify(migrateConfig(old).config)));
    assert.deepEqual(back.reset, []);
    assert.equal(back.config.skeet.antiAim.enabled, false);
    assert.equal(back.config.hvh.core!.fakeDuck, true);
  });

  it('lists only fields that actually changed: an untouched legacy config resets nothing', () => {
    const c = structuredClone(defaultConfig()) as unknown as Record<string, unknown>;
    delete c.version;
    assert.deepEqual(migrateConfig(c).reset, []);
  });

  it('migrated and untouched configs select the default era table; legacy hvh.core.era is untouched', () => {
    const { config } = migrateConfig(legacySaved());
    assert.equal(config.skeet.era, DEFAULT_ERA_ID);
    assert.equal(config.hvh.core!.era, 'defensive');
    const untouched = structuredClone(defaultConfig()) as unknown as Record<string, any>;
    delete untouched.version; delete untouched.skeet.era;
    const u = migrateConfig(untouched).config;
    assert.equal(u.skeet.era, 'late-csgo');
    assert.equal(u.hvh.core!.era, 'tickbase');
    assert.ok(ERAS[u.skeet.era]);
    assert.equal(defaultConfig().skeet.era, DEFAULT_ERA_ID);
  });

  it('a corrupt or non-object config gives defaults with every field in reset', () => {
    const every = leaves(defaultConfig()).sort();
    for (const bad of [null, undefined, 42, 'garbage', [], [1, 2], true]) {
      const { config, reset } = migrateConfig(bad);
      assert.deepEqual(config, defaultConfig(), String(bad));
      assert.deepEqual([...reset].sort(), every, String(bad));
    }
  });

  it('an already-migrated config resets nothing and migration is idempotent', () => {
    const once = migrateConfig(legacySaved()).config;
    const twice = migrateConfig(structuredClone(once));
    assert.deepEqual(twice.reset, []);
    assert.deepEqual(twice.config, once);
    for (const panel of ['lab', 'skeet'] as const) for (const p of presetConfigs(panel)) assert.deepEqual(migrateConfig(p.config).reset, [], p.name);
  });

  it('migrated configs still produce a valid legacy loadout', () => {
    const { config } = migrateConfig(legacySaved());
    const loadout = HVH_PANELS.skeet.loadout(config);
    assert.equal(loadout.exploit, 'doubleTap');
    assert.equal(loadout.antiAim.mode, 'left');
    assert.equal(loadout.core!.fakeLag, 14);
    assert.equal(loadout.core!.era, 'defensive', 'legacy rooms keep their era profile');
  });

  it('the HvH binds do not collide with game actions or each other; the defensive key is gone', () => {
    for (const panel of ['lab', 'skeet'] as const) {
      const c = defaultConfig(panel);
      assert.equal('defensive' in c.hvh || 'defensiveKey' in c.hvh, false, 'defensive is a per-stance anti-aim pattern now');
      const keys = [c.hvh.aim.overrideKey, c.hvh.aim.bodyKey, c.hvh.movement.peekKey, c.hvh.invertKey];
      assert.equal(new Set(keys).size, keys.length);
      assert.ok(!keys.some(k => BINDS.some(b => b.code === k)));
    }
  });
});

describe('migrateConfig: per-stance v2 anti-aim (config version 3)', () => {
  const STANCES = ['standing', 'moving', 'airborne', 'crouching', 'slowwalking'] as const;
  /** A config saved at version 2: one AA base, the old defensive toggle and key. */
  function v2Saved(): Record<string, any> {
    const c = structuredClone(defaultConfig('skeet')) as unknown as Record<string, any>;
    c.version = 2;
    delete c.hvh.v2AntiAim;
    c.hvh.antiAim = { ...c.hvh.antiAim, enabled: true, mode: 'right', jitter: 12, desync: 44 };
    c.hvh.defensive = false;
    c.hvh.defensiveKey = 'KeyO';
    return c;
  }


  it('the old single base, jitter and desync become all five stances, defensive off', () => {
    for (const [old, mode, jitter, desync] of [[v2Saved(), 'right', 12, 44], [legacySaved(), 'left', 33, 51]] as const) {
      const { config } = migrateConfig(old);
      assert.equal(config.version, CONFIG_VERSION);
      assert.deepEqual(Object.keys(config.hvh.v2AntiAim.stances).sort(), [...STANCES].sort());
      for (const s of STANCES) {
        assert.deepEqual(config.hvh.v2AntiAim.stances[s], { base: mode, yawOffsetDeg: 0, jitterDeg: jitter, desyncDeg: desync }, s);
        assert.equal(config.hvh.v2AntiAim.defensive[s].enabled, false, s);
      }
      assert.equal(config.hvh.antiAim.mode, mode, 'legacy rooms keep the single stance');
    }
  });

  it('lists the dropped defensive toggle and key only when customised, and nothing a v2 migration already showed', () => {
    assert.deepEqual(migrateConfig(v2Saved()).reset, []);
    const old = v2Saved();
    old.hvh.defensive = true;
    old.hvh.defensiveKey = 'KeyL';
    old.hvh.core.fakeDuck = true; // legacy-only, already reported by the version-2 migration
    const { config, reset } = migrateConfig(old);
    assert.deepEqual(reset.sort(), ['hvh.defensive', 'hvh.defensiveKey']);
    assert.equal('defensive' in config.hvh || 'defensiveKey' in config.hvh, false);
    assert.match(migrationNotice(reset), /Reset to defaults: hvh\.defensive, hvh\.defensiveKey\./);
    const v1 = legacySaved() as Record<string, any>;
    v1.hvh.defensive = true;
    assert.ok(migrateConfig(v1).reset.includes('hvh.defensive'));
  });

  it('a version-3 config keeps its stances; bad values are clamped or dropped', () => {
    const c = structuredClone(defaultConfig('skeet')) as unknown as Record<string, any>;
    c.hvh.v2AntiAim.stances.airborne = { base: 'spin', yawOffsetDeg: 400, jitterDeg: 90, desyncDeg: -5 };
    c.hvh.v2AntiAim.stances.moving.base = 'sideways';
    c.hvh.v2AntiAim.defensive.airborne = { enabled: true, inAir: true, onPeek: 'yes', always: false, pitch: 'random', yaw: 'warp' };
    const { config, reset } = migrateConfig(c);
    assert.deepEqual(reset, []);
    assert.deepEqual(config.hvh.v2AntiAim.stances.airborne, { base: 'spin', yawOffsetDeg: 180, jitterDeg: 45, desyncDeg: 0 });
    assert.equal(config.hvh.v2AntiAim.stances.moving.base, defaultConfig().hvh.v2AntiAim.stances.moving.base);
    assert.deepEqual(config.hvh.v2AntiAim.defensive.airborne, { enabled: true, inAir: true, onPeek: false, always: false, pitch: 'random', yaw: 'off' });
    assert.deepEqual(migrateConfig(JSON.parse(JSON.stringify(config))).config, config, 'round trip');
  });

  it('the skeet panel sends the per-stance config in its loadout', () => {
    const { config } = migrateConfig(v2Saved());
    config.hvh.v2AntiAim.defensive.standing = { enabled: true, inAir: false, onPeek: true, always: false, pitch: 'down', yaw: 'flick' };
    assert.deepEqual(HVH_PANELS.skeet.loadout(config).v2AntiAim, config.hvh.v2AntiAim);
    assert.equal(HVH_PANELS.manual.loadout(config).v2AntiAim, undefined);
  });
});

describe('migrateConfig: no status box or anti-bruteforce (config version 4)', () => {
  /** A config saved at version 3, with the dropped fields at their old defaults. */
  function v3Saved(): Record<string, any> {
    const c = structuredClone(defaultConfig('skeet')) as unknown as Record<string, any>;
    c.version = 3;
    c.hvh.feedback = { shotLog: true, targetInfo: true, resolver: true };
    c.skeet.indicators = { resolver: true, binds: true, watermark: true };
    c.hvh.core.antiBruteforce = true;
    return c;
  }

  it('drops the fields; untouched ones are not listed, customised ones are', () => {
    const quiet = migrateConfig(v3Saved());
    assert.deepEqual(quiet.reset, []);
    assert.deepEqual(Object.keys(quiet.config.hvh.feedback), ['resolver']);
    assert.equal('resolver' in quiet.config.skeet.indicators, false);
    assert.equal('antiBruteforce' in quiet.config.hvh.core!, false);
    const old = v3Saved();
    old.hvh.feedback.targetInfo = false;
    old.skeet.indicators.resolver = false;
    old.hvh.core.antiBruteforce = false;
    const { reset } = migrateConfig(old);
    assert.deepEqual([...reset].sort(), ['hvh.core.antiBruteforce', 'hvh.feedback.targetInfo', 'skeet.indicators.resolver']);
    assert.match(migrationNotice(reset), /Reset to defaults: /);
  });

  it('a version-3 config keeps its per-stance anti-aim (it is not rebuilt from the single legacy stance)', () => {
    const old = v3Saved();
    old.hvh.v2AntiAim.stances.airborne = { base: 'spin', yawOffsetDeg: 30, jitterDeg: 5, desyncDeg: 20 };
    old.hvh.v2AntiAim.defensive.moving = { enabled: true, inAir: false, onPeek: true, always: false, pitch: 'up', yaw: 'flick' };
    const { config } = migrateConfig(old);
    assert.deepEqual(config.hvh.v2AntiAim.stances.airborne, { base: 'spin', yawOffsetDeg: 30, jitterDeg: 5, desyncDeg: 20 });
    assert.deepEqual(config.hvh.v2AntiAim.defensive.moving, { enabled: true, inAir: false, onPeek: true, always: false, pitch: 'up', yaw: 'flick' });
    const future = structuredClone(old);
    future.version = 99;
    assert.deepEqual(migrateConfig(future).config.hvh.v2AntiAim, config.hvh.v2AntiAim, 'a newer version is never rebuilt either');
  });
});

describe('config loading with migration', () => {
  const store = new Map<string, string>();
  beforeEach(() => {
    store.clear();
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k),
    };
  });

  it('reports reset fields until the migrated config is saved, then never again', () => {
    store.set('chikengun:dev:skeet', JSON.stringify(legacySaved()));
    const first = loadCurrentMigrated('skeet');
    assert.ok(first.reset.includes('hvh.core.defensive'));
    assert.ok(loadCurrentMigrated('skeet').reset.length > 0, 'not saved yet: still pending');
    saveCurrent(first.config, 'skeet');
    const after = loadCurrentMigrated('skeet');
    assert.deepEqual(after.reset, []);
    assert.deepEqual(after.config, first.config);
  });

  it('pending notice entries survive a reload and clear after they are shown', () => {
    assert.deepEqual(pendingMigrationNotice(), []);
    queueMigrationNotice(['Old: hvh.core.fakeDuck']);
    queueMigrationNotice(['hvh.core.defensive', 'Old: hvh.core.fakeDuck']);
    // A reload re-reads storage only.
    assert.deepEqual(pendingMigrationNotice(), ['Old: hvh.core.fakeDuck', 'hvh.core.defensive']);
    assert.deepEqual(queueMigrationNotice([]), ['Old: hvh.core.fakeDuck', 'hvh.core.defensive']);
    assert.match(migrationNotice(pendingMigrationNotice()), /kept for legacy\): Old: hvh\.core\.fakeDuck, hvh\.core\.defensive/);
    clearMigrationNotice();
    assert.deepEqual(pendingMigrationNotice(), []);
    store.set('chikengun:dev-migration-notice', '{broken');
    assert.deepEqual(pendingMigrationNotice(), []);
  });

  it('a missing config is not a migration; unreadable JSON resets everything', () => {
    assert.deepEqual(loadCurrentMigrated('skeet'), { config: defaultConfig('skeet'), reset: [] });
    store.set('chikengun:dev:skeet', '{not json');
    const broken = loadCurrentMigrated('skeet');
    assert.deepEqual(broken.config, defaultConfig('skeet'));
    assert.deepEqual([...broken.reset].sort(), leaves(defaultConfig()).sort());
  });

  it('saved and imported legacy configs are migrated', () => {
    store.set('chikengun:dev-configs:skeet', JSON.stringify([{ name: 'Old', config: legacySaved() }]));
    const [old] = loadConfigs('skeet');
    assert.equal(old!.config.version, CONFIG_VERSION);
    assert.equal(old!.config.skeet.fakeLag.limit, 14);
    const imported = importConfig(JSON.stringify({ format: 'chikengun-dev-config', version: 1, name: 'Old', config: legacySaved() }));
    assert.ok(imported.reset.includes('skeet.antiAim.jitterMode'));
    assert.equal(imported.config.hvh.antiAim.desync, 51);
    const roundTrip = importConfig(exportConfig({ name: 'New', config: imported.config }));
    assert.deepEqual(roundTrip.reset, []);
    assert.deepEqual(roundTrip.config, imported.config);
  });
});

describe('panel values reach intents through the shared rules only', () => {
  it('the exploit setting reaches the intent; there is no defensive intent any more', () => {
    const base = { seq: 5, shotSeq: null, hitscan: true, held: false, exploit: 'off' as const };
    const none = { fire: false, choke: false, doubleTap: false, hideShots: false };
    assert.deepEqual(commandIntent(base), none);
    assert.deepEqual(commandIntent({ ...base, exploit: 'doubleTap' }), { ...none, doubleTap: true });
    assert.deepEqual(commandIntent({ ...base, exploit: 'hideShots' }), { ...none, hideShots: true });
  });

  it('a 14-tick choke limit holds 14 commands in v2 rooms and stays capped at 12 in legacy rooms', () => {
    const core = { ...defaultHvhCore(), fakeLag: 14 };
    assert.equal(fakeLagTicks(core, 1, 0), 12, 'legacy cap unchanged');
    assert.equal(fakeLagTicks(core, 1, 0, false, LATE_CSGO.maxChoke), 14);
    const frame = (seq: number) => ({ seq, forward: 0, right: 0, yaw: 0, pitch: 0, jump: false, crouch: false, jet: false, firing: false, use: false } as never);
    for (const [max, held] of [[undefined, 12], [LATE_CSGO.maxChoke, 14]] as const) {
      const choker = new CommandChoker();
      let n = 0;
      for (let seq = 1; seq <= 20; seq++) { if (choker.push(frame(seq), 14, false, max).length) break; n++; }
      assert.equal(n, held);
    }
  });
});

describe('migrateConfig: weapon profiles keyed by arsenal gun (config version 5)', () => {
  /** The version-4 group profiles at their defaults (written out, not taken from the code under test). */
  function v4Profiles(): Record<string, any> {
    const base = { enabled: true, minDamage: 20, hitchance: 60, bodyAim: 'lethal', multipoint: true, pointScale: 50, safePoints: true, autoStop: true, autoScope: false };
    return {
      general: { ...base }, pistols: { ...base }, rifles: { ...base },
      snipers: { ...base, minDamage: 45, hitchance: 75, pointScale: 35, autoScope: true },
      shotguns: { ...base, minDamage: 25, hitchance: 55, bodyAim: 'prefer' }, smgs: { ...base, minDamage: 12, hitchance: 55 }, heavy: { ...base },
    };
  }
  function v4Saved(): Record<string, any> {
    const c = structuredClone(defaultConfig('skeet')) as unknown as Record<string, any>;
    c.version = 4;
    c.skeet.profiles = v4Profiles();
    return c;
  }

  it('is version 5', () => assert.equal(CONFIG_VERSION, 5));

  it('an untouched version-4 config migrates silently to the arsenal defaults', () => {
    const { config, reset } = migrateConfig(v4Saved());
    assert.deepEqual(reset, []);
    assert.deepEqual(Object.keys(config.skeet.profiles), ['ssg08', 'scar20', 'deserteagle', 'r8']);
    assert.deepEqual(config.skeet.profiles, defaultConfig('skeet').skeet.profiles);
  });

  it('snipers become ssg08 and scar20, pistols become deserteagle and r8; other groups are listed as dropped', () => {
    const old = v4Saved();
    Object.assign(old.skeet.profiles.snipers, { hitchance: 88, minDamage: 61, safePoints: false, autoScope: false });
    Object.assign(old.skeet.profiles.pistols, { minDamage: 33, bodyAim: 'prefer' });
    old.skeet.profiles.rifles.hitchance = 10;
    old.skeet.profiles.smgs.autoStop = false;
    old.skeet.profiles.general.pointScale = 70;
    const { config, reset } = migrateConfig(old);
    for (const id of ['ssg08', 'scar20'] as const) {
      assert.equal(config.skeet.profiles[id].hitchance, 88, id);
      assert.equal(config.skeet.profiles[id].minDamage, 61, id);
      assert.equal(config.skeet.profiles[id].safePoints, false, id);
      assert.equal(config.skeet.profiles[id].autoScope, false, id);
    }
    for (const id of ['deserteagle', 'r8'] as const) {
      assert.equal(config.skeet.profiles[id].minDamage, 33, id);
      assert.equal(config.skeet.profiles[id].bodyAim, 'prefer', id);
    }
    assert.deepEqual([...reset].sort(), ['skeet.profiles.general.pointScale', 'skeet.profiles.rifles.hitchance', 'skeet.profiles.smgs.autoStop']);
    assert.match(migrationNotice(reset), /Reset to defaults: .*skeet\.profiles\.rifles\.hitchance/);
    assert.deepEqual(migrateConfig(JSON.parse(JSON.stringify(config))).reset, [], 'migrated once');
  });

  it('a group that fell back to the general profile carries the general values, and the override switch is listed', () => {
    const old = v4Saved();
    old.skeet.profiles.snipers.enabled = false;
    old.skeet.profiles.snipers.hitchance = 99; // unused while the override was off
    old.skeet.profiles.general.hitchance = 44;
    const { config, reset } = migrateConfig(old);
    assert.equal(config.skeet.profiles.ssg08.hitchance, 44);
    assert.equal(config.skeet.profiles.scar20.hitchance, 44);
    assert.equal(config.skeet.profiles.deserteagle.hitchance, 60, 'pistols kept their own profile');
    assert.ok(reset.includes('skeet.profiles.snipers.enabled'));
    assert.ok(reset.includes('skeet.profiles.snipers.hitchance'));
    assert.ok(!reset.includes('skeet.profiles.general.hitchance'), 'general was carried over');
  });

  it('unreadable old profile values are dropped to the new defaults', () => {
    const old = v4Saved();
    old.skeet.profiles.snipers.hitchance = 'high';
    old.skeet.profiles.pistols.minDamage = 999;
    const { config } = migrateConfig(old);
    assert.equal(config.skeet.profiles.ssg08.hitchance, defaultConfig('skeet').skeet.profiles.ssg08.hitchance);
    assert.equal(config.skeet.profiles.r8.minDamage, 100);
  });
});
