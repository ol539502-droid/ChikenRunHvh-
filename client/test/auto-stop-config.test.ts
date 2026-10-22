import assert from 'node:assert/strict';
import {it} from 'node:test';
import {WEAPONS} from '@game/shared';
import {defaultConfig,sanitizeConfig,exportConfig,importConfig} from '../src/dev/config';
import {skeetEffectiveConfig} from '../src/dev/skeet/model';
it('auto-stop options preserve old behavior, round-trip profiles and bound extrapolation settings',()=>{
 const old=defaultConfig();delete (old.hvh.movement as Partial<typeof old.hvh.movement>).autoStopBetweenShots;
 const migrated=sanitizeConfig(old);assert.equal(migrated.hvh.movement.autoStopBetweenShots,true);assert.equal(migrated.hvh.movement.autoStopPredict,false);
 const c=defaultConfig('skeet');Object.assign(c.hvh.movement,{autoStopSlowWalk:true,autoStopPredict:true,autoStopBetweenShots:false,autoStopPredictMs:999});
 const safe=sanitizeConfig(c);assert.equal(safe.hvh.movement.autoStopPredictMs,300);assert.deepEqual(importConfig(exportConfig({name:'Predict stop',config:safe})).config,safe);
 c.hvh.movement.autoStopPredictMs=-5;assert.equal(sanitizeConfig(c).hvh.movement.autoStopPredictMs,50);
});
it('Skeet weapon overrides retain all shared auto-stop options while selecting their own master switch',()=>{
 const c=defaultConfig('skeet');Object.assign(c.hvh.movement,{autoStopSlowWalk:true,autoStopPredict:true,autoStopBetweenShots:false});
 c.skeet.profiles.ssg08.autoStop=false;
 const sniper=skeetEffectiveConfig(c,WEAPONS.sniper);assert.equal(sniper.hvh.movement.autoStop,false);assert.equal(sniper.hvh.movement.autoStopSlowWalk,true);
 assert.equal(sniper.hvh.movement.autoStopPredict,true);assert.equal(sniper.hvh.movement.autoStopBetweenShots,false);
 assert.equal(skeetEffectiveConfig(c,WEAPONS.rifle).hvh.movement.autoStop,true);assert.equal(c.hvh.movement.autoStop,false);
});
