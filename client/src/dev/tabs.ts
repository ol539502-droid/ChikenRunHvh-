import { WEAPONS, WEAPON_IDS, damageAt, hvhWeapon } from '@game/shared';
import { DEFAULT_ERA_ID, ERAS } from '@game/shared/hvh/v2';
import { defaultLook, SURFACES } from '../game/look';
import { getCameraMode, setCameraMode } from '../game/CameraRig';
import type { Control, Tab } from './controls';
import type { Dev } from './Dev';
import { configsPanel } from './panels/configs';
import { playersPanel } from './panels/players';

export function buildTabs(dev: Dev): Tab[] {
  const toggle=(label:string,path:string,hint?:string):Control=>({type:'toggle',label,path,hint});
  const slider=(label:string,path:string,unit?:string,hint?:string):Control=>({type:'slider',label,path,unit,hint});
  const key=(label:string,path:string,hint?:string):Control=>({type:'key',label,path,hint});
  const select=(label:string,path:string,hint?:string):Control=>({type:'select',label,path,hint});
  const info=(label:string,value:()=>string,hint?:string):Control=>({type:'info',label,value,hint});
  const era=()=>ERAS[dev.config.skeet.era]??ERAS[DEFAULT_ERA_ID]!;
  const selected=()=>dev.runtime.currentSession?.mode.id === 'hvh' ? hvhWeapon(WEAPONS[dev.config.weapons.selected]) : WEAPONS[dev.config.weapons.selected];
  return [
    {id:'aim',label:'Aim',icon:'⌖',configKey:['rage.aim','hvh.aim','legit.trigger'],sections:[
      {title:'HvH rules',icon:'◇',wide:true,items:[info('Equal stats',()=> 'Normal damage · spread · recoil · ammo · movement'),info('Shot policy',()=> 'Enemies only · valid bullet paths · real server hitboxes','Minimum damage / hitchance are estimates. Manual shots stay available; cover and recoil still matter.')]},
      {title:'Targeting',icon:'⌖',items:[toggle('Aim assist','rage.aim.enabled','Silent aim for manual and automatic shots'),toggle('Auto fire','rage.aim.autoTarget','Normal fire timers and ammunition apply'),toggle('Target lock','rage.aim.lock'),select('Target priority','rage.aim.priority'),select('Hitbox','rage.aim.hitbox'),slider('Aim FOV','rage.aim.fov','°','Total coverage; 360° includes targets behind you'),info('Silent aim',()=> 'Shots track the selected target; your view stays under mouse control')]},
      {title:'Shot selection',icon:'◎',items:[slider('Minimum damage','hvh.aim.minDamage','HP','Predicted health damage after armor; lethal shots can pass'),slider('Hit chance','hvh.aim.hitchance','%','Sampled from actual speed, weapon spread and the current shot path'),select('Body aim preference','hvh.aim.bodyAim'),toggle('Autowall','hvh.aim.autowall','Shared ballistics; loss depends on material thickness'),key('Force body aim','hvh.aim.bodyKey','Hold J by default'),slider('Damage override threshold','hvh.aim.damageOverride','HP'),key('Damage override key','hvh.aim.overrideKey','Hold H; changes the threshold, never weapon damage')]},
      {title:'Trigger',icon:'ϟ',items:[toggle('Trigger assist','legit.trigger.enabled','Used when aim assist is off'),slider('Trigger delay','legit.trigger.delay','ms'),slider('Trigger FOV','legit.trigger.fov','°'),key('Trigger key','legit.trigger.key','Empty = always active while playing')]},
      {title:'Decision weights and history',icon:'◎',items:[slider('Air hit chance','hvh.aim.airHitchance','%'),slider('HP-relative damage','hvh.aim.hpRelative','HP','-1 disables; otherwise require enemy HP plus this value'),slider('Records per target','hvh.aim.maxRecords'),slider('Damage weight','hvh.aim.damageWeight'),slider('Safety weight','hvh.aim.safetyWeight'),slider('Accuracy weight','hvh.aim.accuracyWeight'),slider('Resolver weight','hvh.aim.confidenceWeight'),toggle('Prefer safe points','hvh.aim.preferSafe','Raises geometric overlap in candidate scoring')]},
      {title:'Target point policy',icon:'◎',items:[toggle('Force safe points','hvh.aim.forceSafe','Require full overlap across plausible body hypotheses'),toggle('Multipoint','hvh.aim.multipoint'),slider('Point scale','hvh.aim.pointScale','%','Reduced dynamically by speed and resolver uncertainty')]},
    ]},
    {id:'antiaim',label:'Anti-aim',icon:'↻',configKey:['hvh.antiAim','hvh.invertKey'],sections:[
      {title:'Hidden body orientation',icon:'↻',items:[toggle('Enable anti-aim','hvh.antiAim.enabled','HvH only. The server computes both headings'),select('Yaw base','hvh.antiAim.mode'),select('Pitch','hvh.antiAim.pitch','Physical head pose; Down tucks the head while keeping the camera free'),slider('Desync angle','hvh.antiAim.desync','°','Requested body delta; movement and crouch constrain it'),slider('Jitter amplitude','hvh.antiAim.jitter','°','Capped at 45°'),slider('Jitter interval','hvh.antiAim.jitterInterval','ms','1–600 ms; phase sampled at 64 simulation ticks per second'),slider('Spin speed','hvh.antiAim.spinSpeed','°/s'),key('Invert desync','hvh.invertKey','Hold K to switch sides')]},
      {title:'Resolver & counterplay',icon:'◈',items:[select('Resolver policy','hvh.resolverPolicy'),toggle('Resolve hidden hitboxes','hvh.feedback.resolver','Estimate hidden body yaw from public animation and shot outcomes'),info('Hidden hitboxes',()=> 'Eye yaw is public · body yaw is estimated','Wrong resolver hypotheses can miss. Safe points test several reconstructed skeletons.'),info('Limits',()=> 'Bounded animation · normal health · real historical rewind')]},
    ]},
    {id:'network',label:'Simulation',icon:'⌁',configKey:'hvh.core',sections:[
      {title:'HvH rules',icon:'⌁',items:[select('Era table','skeet.era','Saved with your config; v2 servers always run late-csgo'),info('Era limits',()=>{const e=era();return `${e.id} · choke ${e.maxChoke} · charge ${e.chargeTicks} ticks`;},'From the shared era table'),select('Era profile','hvh.core.era','Legacy rooms only'),toggle('Defensive transition','hvh.core.defensive','Legacy rooms only (defensive era)'),slider('Choked commands','hvh.core.fakeLag','ticks'),select('Choke mode','hvh.core.fakeLagMode'),toggle('Fake duck','hvh.core.fakeDuck','Alternates real crouch commands during a choke cycle')]},
      {title:'Practice connection',icon:'⌁',items:[slider('Simulated latency','hvh.core.latencyMs','ms'),slider('Simulated jitter','hvh.core.jitterMs','ms'),slider('Packet loss','hvh.core.packetLoss','fraction'),info('Timing',()=> '64 simulation ticks / second · 20 snapshots / second')]},
    ]},
    {id:'exploits',label:'Exploits',icon:'ϟ',configKey:'hvh.exploit',sections:[
      {title:'Shared charge',icon:'ϟ',items:[{type:'select',label:'Exploit mode',path:'hvh.exploit',options:[{value:'off',label:'Off'},{value:'doubleTap',label:'Double Tap'},{value:'hideShots',label:'Hide Shots'}]},
        info('Double Tap',()=> 'Two bullets now · full charge','Consumes two rounds and full charge. Burst cooldown is at least 313 ms; slower guns keep their normal cooldown. Projectiles, melee and native bursts cannot use exploits.'),info('Hide Shots',()=> '44% charge · keep your pose for 300 ms','Fires one round without exposing your shot-facing body or lower-body update. Tracers, damage and collision remain active.'),info('Tradeoff',()=> 'Recharge: 2 seconds idle · 4 with fake lag','Firing pauses recharge. Modes and guns share the same charge; respawn starts empty.')]},
    ]},
    {id:'movement',label:'Movement',icon:'➶',configKey:['legit.move','hvh.movement','misc.autoJump'],sections:[
      {title:'Auto stop and peeking',icon:'➶',items:[toggle('Auto-stop','hvh.movement.autoStop','Enables automatic ground movement control for accurate shots'),
        toggle('Slow-walk auto stop','hvh.movement.autoStopSlowWalk','Keeps your movement direction at walking speed; counter-stops if a shot needs stationary accuracy'),
        toggle('Between shots','hvh.movement.autoStopBetweenShots','Keeps auto stop active during weapon cooldown; off lets you move between shot opportunities'),
        toggle('Predict auto stop','hvh.movement.autoStopPredict','Extrapolates recent enemy movement to prepare before a likely peek'),
        slider('Prediction look-ahead','hvh.movement.autoStopPredictMs','ms','50–300 ms; stale, abrupt or blocked movement is rejected'),
        info('Auto-stop state',()=>dev.runtime.autoStopState),
        info('Slow walk',()=> 'Hold Shift to walk slowly with less movement spread','Available to every player, including Manual play'),toggle('Auto-peek return','hvh.movement.peekAssist','Hold key to mark an anchor; after shooting, release movement keys to return'),key('Auto-peek key','hvh.movement.peekKey','Hold Z; release to cancel. Jumping, blocked route or manual movement cancels return.'),info('Peek state',()=>dev.runtime.peekState)]},
      {title:'Movement helpers',icon:'⌁',items:[toggle('Bunny hop','legit.move.bhop','Hold Space to re-jump on landing; speed comes from air strafing'),toggle('Auto strafe','legit.move.autoStrafe','Optimizes air strafing in your WASD direction without turning your view'),toggle('Subtick strafe','hvh.movement.subtickStrafe','Faster air acceleration through repeated steering; normal jump and takeoff limits'),toggle('Jump buffer','legit.move.jumpAssist','Remembers a jump pressed just before landing'),info('Movement limits',()=> 'Shared acceleration · ground friction · bounded takeoff')]},
    ]},
    {id:'visuals',label:'Visuals',icon:'◈',configKey:['visuals','legit.wall'],sections:[
      {title:'Player ESP',icon:'☐',items:[toggle('Enable ESP','visuals.esp.enabled'),...(['box','name','health','distance','weapon','skeleton','snaplines','headCircle','glow'] as const).map(k=>toggle(k==='headCircle'?'Head circle':k[0].toUpperCase()+k.slice(1),`visuals.esp.${k}`)),toggle('Wall silhouettes','legit.wall.enabled','HvH already provides enemy silhouettes to everyone'),{type:'color',label:'Enemy color',path:'visuals.colors.enemy'},{type:'color',label:'Friendly color',path:'visuals.colors.friendly'},slider('ESP opacity','visuals.colors.opacity')]},
      {title:'Arena markers',icon:'◇',items:[toggle('Items','visuals.world.items'),toggle('Projectiles / vehicles','visuals.world.weapons'),toggle('Objectives','visuals.world.objectives'),toggle('Hitboxes','visuals.world.hitboxes'),toggle('Collision outlines','visuals.world.collision')]},
    ]},
    {id:'weapons',label:'Weapons',icon:'✦',configKey:'weapons.selected',sections:[
      {title:'Weapon reference',icon:'✦',wide:true,items:[{type:'select',label:'Weapon reference',path:'weapons.selected',options:WEAPON_IDS.map(id=>({value:id,label:WEAPONS[id].name}))},info('Damage at 10 / 30 / 60 m',()=> selected().projectile?'Explosive splash': [10,30,60].map(d=>`${Math.round(damageAt(selected(),d)*selected().pellets)} HP`).join(' / ')),info('Fire interval / magazine',()=>`${selected().fireInterval} ms / ${selected().magazine} rounds`),info('Reload time',()=>`${selected().reloadTime} ms`),info('Weapon tuning',()=> 'Stats are fixed by the server','This reference does not equip or modify a weapon.')]},
    ]},
    {id:'world',label:'World',icon:'⛰',configKey:'world',sections:[
      {title:'Local arena palette',icon:'◐',items:[...SURFACES.map(s=>({type:'color' as const,label:s[0].toUpperCase()+s.slice(1),path:`world.${s}`})),{type:'color',label:'Sky',path:'world.zenith'},{type:'color',label:'Horizon',path:'world.horizon'},slider('Exposure','world.exposure'),{type:'buttons',label:'Reset palette',items:[{label:'Default palette',run:()=>{dev.set('world',defaultLook());dev.menuRefresh();}}]}]},
    ]},
    {id:'telemetry',label:'Telemetry',icon:'▤',configKey:['misc','hvh.feedback'],sections:[
      {title:'Readouts',icon:'◎',items:[toggle('FPS counter','misc.fpsCounter'),toggle('Ping','misc.ping'),toggle('Coordinates','misc.coords'),toggle('Speed','misc.speed'),toggle('Map information','misc.mapInfo'),toggle('Crosshair','misc.crosshair'),toggle('Hitmarker','misc.hitmarker'),toggle('Damage indicator','misc.damageIndicator'),{type:'toggle',label:'Third person',bind:{get:()=>getCameraMode()==='third',set:v=>setCameraMode(v?'third':'first')}},{type:'buttons',label:'Crosshair',items:[{label:'Edit crosshair',run:()=>dev.openCrosshairSettings()}]}]},
      {title:'Match roster',icon:'☺',wide:true,items:[{type:'custom',label:'Players',render:()=>playersPanel(dev)}]},
    ]},
    {id:'configs',label:'Configs',icon:'▣',sections:[{title:'Configurations',icon:'▣',wide:true,items:[{type:'custom',label:'Configs',keywords:'save load delete rename export import preset',render:()=>configsPanel(dev)}]}]},
    {id:'settings',label:'Settings',icon:'☰',configKey:'settings',sections:[
      {title:'Menu',icon:'▦',items:[key('Menu key','settings.menuKey','Insert by default; also available from Pause → HvH panels'),slider('Menu scale','settings.scale','×'),slider('Menu opacity','settings.opacity'),slider('Animation speed','settings.animSpeed','×'),select('Theme','settings.theme'),{type:'color',label:'Accent',path:'settings.accent'},toggle('Sounds','settings.sounds'),toggle('Notifications','settings.notifications'),{type:'buttons',label:'Reset all',items:[{label:'Reset all settings',run:()=>{dev.resetAll();dev.menuRefresh();}}]}]},
    ]},
  ];
}
