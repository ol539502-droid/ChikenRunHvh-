import assert from 'node:assert/strict';
import { it } from 'node:test';
import { DEFAULT_MODS } from '@game/shared';
import { defaultConfig, importConfig, presetConfigs, sanitizeConfig, toServerMods } from '../src/dev/config';
import { BINDS } from '../src/keybinds';
it('migrates unsafe legacy configurations and clamps supported HvH choices',()=>{
  const c={
    ...defaultConfig(),
    legit:{...defaultConfig().legit,aim:{enabled:true}},
    rage:{...defaultConfig().rage,weapon:{noRecoil:true,noSpread:true,infiniteAmmo:true,rapidFire:true},move:{speed:5,fly:true},antiAim:{spin:true}},
    weapons:{selected:'sniper' as const,damage:20},
    skeet:{...defaultConfig().skeet,aimStyle:'legit',smoothing:20},
  };
  c.rage.aim.silent=false;c.rage.aim.fov=999;
  c.hvh.antiAim.desync=999;c.hvh.aim.reaction=0;c.hvh.aim.hitchance=Infinity;c.misc.freeCam=true;
  const safe=sanitizeConfig(c);
  assert.equal('aim' in safe.legit,false);
  for(const key of ['weapon','move','antiAim']) assert.equal(key in safe.rage,false);
  assert.deepEqual(safe.weapons,{selected:'sniper'});
  assert.equal('aimStyle' in safe.skeet,false);assert.equal('smoothing' in safe.skeet,false);
  assert.equal(safe.rage.aim.silent,true);assert.equal(safe.misc.freeCam,false);
  assert.equal(safe.rage.aim.fov,360);
  assert.equal(safe.hvh.antiAim.desync,58);assert.equal(safe.hvh.aim.reaction,100);assert.equal(safe.hvh.aim.hitchance,60);
  assert.deepEqual(toServerMods(c),DEFAULT_MODS,'even unsanitized configs cannot request altered stats');
  assert.deepEqual(importConfig(JSON.stringify({format:'chikengun-dev-config',name:'Old',config:c})).config,safe);
});
it('every shipped preset keeps baseline stats and non-conflicting hotkeys',()=>{
  const p=presetConfigs();assert.deepEqual(p.map(p=>p.name),['Balanced','Precision','Aggressive','Scout']);
  for(const n of p){assert.deepEqual(toServerMods(n.config),DEFAULT_MODS);assert.deepEqual(sanitizeConfig(n.config),n.config);}
  for (const panel of ['lab', 'skeet'] as const) {
    for (const c of [defaultConfig(panel), ...presetConfigs(panel).map(p => p.config)]) {
      const hotkeys = [c.hvh.aim.overrideKey, c.hvh.aim.bodyKey, c.hvh.movement.peekKey, c.hvh.invertKey];
      assert.equal(new Set(hotkeys).size, hotkeys.length);
      for (const key of hotkeys) assert.ok(!BINDS.some(b => b.code === key), `${panel}: ${key} conflicts with a game action`);
      assert.equal(c.hvh.movement.slowKey, BINDS.find(b => b.id === 'slowWalk')!.code, 'slow walk intentionally shares its game action');
    }
  }
});
it('preserves an explicitly saved auto-peek key',()=>{
  assert.equal(sanitizeConfig({hvh:{movement:{peekKey:'KeyZ'}}}).hvh.movement.peekKey,'KeyZ');
});
