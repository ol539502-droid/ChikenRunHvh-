/// <reference types="vite/client" />
import assert from 'node:assert/strict';
import { it } from 'node:test';
import { PerspectiveCamera } from 'three';
import { CollisionWorld } from '@game/shared';
import { defaultConfig } from '../src/dev/config';
import { DevRuntime } from '../src/dev/DevRuntime';
import type { Dev } from '../src/dev/Dev';
import type { GameSession } from '../src/game/GameSession';
import { WeaponController } from '../src/game/WeaponController';

function fixture() {
  const element = () => ({setAttribute() {}, append() {}, prepend() {}, getContext: () => ({})});
  Object.defineProperty(globalThis, 'document', { configurable:true, value: {
    createElement:element, getElementById:()=>null, body:element(),
  }});
  const config = defaultConfig('skeet');
  Object.assign(config.rage.aim,{enabled:true,autoTarget:true,hitbox:'body'});
  Object.assign(config.hvh.aim,{minDamage:1,hitchance:0,airHitchance:0,bodyAim:'off'});
  Object.assign(config.skeet.profiles.deserteagle,{minDamage:1,hitchance:0,bodyAim:'off',autoStop:false});
  const weapons = new WeaponController(['rifle','pistol']);
  const eye = {x:0,y:0.91,z:0};
  const remote = {info:{pid:2,name:'Opponent'},latestAt:1000,latest:{
    alive:true,x:0,y:0,z:-10,vx:0,vy:0,vz:0,yaw:0,pitch:0,horizontalSpeed:0,
    crouching:false,onGround:true,hp:100,armor:0,simulationTime:1000,weapon:'rifle',
  }};
  let speed = 0;
  const session = {weapons,camera:new PerspectiveCamera(),mode:{id:'hvh',wallbang:false},
    local:{alive:true,car:null,onGround:true,server:{}},remotes:{players:new Map([[2,remote]])},
    collision:new CollisionWorld(100),serverNow:()=>1000,eye:()=>eye,horizontalSpeed:()=>speed,
    isFriendly:()=>false,setSkeetVisuals() {},
  } as unknown as GameSession;
  const dev = {config,active:true,panelId:'skeet',menuOpen:false,ping:()=>0,hud:{},sessionStarted() {},
    input:{active:true,yaw:0,pitch:0,aiming:false,firing:false,isDown:()=>false},
  } as unknown as Dev;
  const runtime = new DevRuntime(dev);
  runtime.attach(session);
  runtime.beforeFrame(session,0,1000);
  assert.equal(runtime.diagnostics.state,'Ready','a real scan acquires a ready candidate');
  return {runtime,session,config,weapons,eye,setSpeed:(value:number)=>{speed=value;},
    refreshConfig:()=>{dev.config={...config};}};
}

it('reports current weapon gates after a ready HvH scan, without spending ammunition', () => {
  for (const gate of ['Cooldown','Reloading','Switching weapon','Empty'] as const) {
    const {runtime,weapons} = fixture();
    if (gate === 'Empty') for(let t=0;t<weapons.magazineSize();t++) weapons.trigger(true,t*1000,true);
    else weapons.trigger(true,1000,true);
    if (gate === 'Reloading') assert.equal(weapons.reload(1001),true);
    if (gate === 'Switching weapon') assert.equal(weapons.switchTo(1,1001),true);
    const mag = weapons.mag;
    assert.equal(runtime.wantsFire(1002),false);
    assert.equal(runtime.diagnostics.state,gate);
    assert.equal(runtime.wantsFire(1002),false,'repeated same-frame check retains its gate');
    assert.equal(runtime.diagnostics.state,gate);
    assert.equal(weapons.mag,mag);
  }
});

it('refreshes damage diagnostics when the current shot fails its gate', () => {
  const {runtime,session} = fixture();
  assert.ok(runtime.diagnostics.damage>0);
  session.collision.add(1,{minX:-5,maxX:5,minY:0,maxY:3,minZ:-6,maxZ:-4});
  assert.equal(runtime.wantsFire(1000),false);
  assert.equal(runtime.diagnostics.state,'Waiting for damage');
  assert.equal(runtime.diagnostics.damage,0);
  assert.equal(runtime.diagnostics.chance,0);
});

it('refreshes accuracy diagnostics after movement since the last ready scan', () => {
  const {runtime,config,setSpeed,refreshConfig} = fixture();
  const scanChance = runtime.diagnostics.chance;
  config.skeet.profiles.deserteagle.hitchance=100;
  refreshConfig();
  setSpeed(30);
  assert.equal(runtime.wantsFire(1000),false);
  assert.equal(runtime.diagnostics.state,'Waiting for accuracy');
  assert.ok(runtime.diagnostics.chance<scanChance);
  setSpeed(0);
  config.skeet.profiles.deserteagle.hitchance=0;
  refreshConfig();
  assert.equal(runtime.wantsFire(1000),true,'the final same-frame check can recover after movement');
  assert.equal(runtime.diagnostics.state,'Ready');
});

it('keeps the movement gate when the scan is not ready', () => {
  const {runtime,session,config,setSpeed,refreshConfig} = fixture();
  config.skeet.profiles.deserteagle.autoStop=true;
  refreshConfig();
  setSpeed(6);
  runtime.beforeFrame(session,0,1001);
  assert.equal(runtime.wantsFire(1001),false);
  assert.notEqual(runtime.diagnostics.state,'Ready');
});
