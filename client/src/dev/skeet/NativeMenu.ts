import type { Dev } from '../Dev';
import { h } from '../../ui/dom';
import { CHOICES, RANGES, setPath } from '../config';
import { buildSkeetTabs } from './tabs';
import { NATIVE_FIELDS } from './nativeFields';
import type { Control } from '../controls';

interface NativeModule {
  ccall(name: string, result: string | null, types: string[], values: unknown[]): any;
  UTF8ToString(pointer: number): string;
  HEAPU8: Uint8Array;
  _malloc(bytes: number): number;
  _free(pointer: number): void;
}
let modulePromise: Promise<NativeModule> | undefined;
const canvas = h('canvas', { id: 'skeet-native-canvas', width: 660, height: 560, tabindex: 0, 'aria-label': 'Original C++ Skeet menu' });
/** The menu font has Latin-1 letters only: swap common symbols and drop the rest (like the bots' emoji, which showed as "?"). */
export const menuText = (s: string): string => s.replace(/[\u2013\u2014]/g, '-').replace(/\u2026/g, '...').replace(/\u2192/g, '->').replace(/[^\x20-\x7e\xa0-\xff]/g, '').replace(/\s+/g, ' ').trim();
const call = (m: NativeModule, name: string, ...values: (number | string)[]) => m.ccall(name, null, values.map(v => typeof v), values.map(v => typeof v === 'string' ? menuText(v) : v));
const value = (m: NativeModule, name: string, id: number) => m.ccall(name, 'number', ['number'], [id]) as number;
const mapped: Record<string,string> = {
  'Misc.bunnyHop':'legit.move.bhop', 'Misc.airStrafe':'legit.move.autoStrafe',
  'Misc.logDamageDealt':'hvh.feedback.shotLog',
  'Visuals.Other.crosshair':'misc.crosshair', 'Visuals.Players.hitmarker':'misc.hitmarker',
};

/** Runs the supplied Menu.cpp and custom ImGui widgets, compiled to WebAssembly. */
export class NativeMenu {
  private root = h('div', { class: 'skeet-native-root dev-layer', role: 'dialog', 'aria-label': 'Skeet HvH panel' });
  private frameId = 0;
  private disposed = false;
  private module: NativeModule | undefined;
  private controls: { id:number; c:Control; last:number; options?:string[] }[] = [];
  private awaitingKey: { path:string; id:number } | undefined;
  private lastFrame = performance.now();
  private sync = true;
  private unsubscribe: () => void;
  private abort = new AbortController();
  private liveAt = 0;
  private playersKey = '';
  private registerPending = false;
  private nativeValues = new Map<number,number>();
  constructor(private dev: Dev, private close: () => void) {
    const status = h('div', { class:'skeet-native-status', role:'status' }, 'Loading your C++ menu…');
    this.root.append(canvas, status); document.body.append(this.root);
    this.unsubscribe = dev.onChange(() => { this.sync = true; });
    this.resize(); window.addEventListener('resize', this.resize, {signal:this.abort.signal});
    void this.init().then(() => {
      if (this.disposed) return;
      status.textContent='Insert / Escape closes · Your original C++ menu';
      this.listen(); this.register(); canvas.focus(); this.frame();
    }).catch(e => { if(!this.disposed) { status.textContent=`Menu could not load: ${String(e)}`; dev.notify('C++ menu failed to load; check the console.','bad'); console.error(e); } });
  }
  private async init(): Promise<void> {
    modulePromise ??= (async () => {
      await new Promise<void>((resolve,reject)=>{const script=document.createElement('script');script.type='module';script.src='/skeet-native/bootstrap.js';script.onload=()=>resolve();script.onerror=()=>reject(new Error('Native menu loader unavailable'));document.head.append(script);});
      const create=(window as unknown as {createSkeetNative:(options:unknown)=>Promise<NativeModule>}).createSkeetNative;
      const m: NativeModule = await create({canvas, locateFile:(path:string)=>`/skeet-native/${path}`});
      call(m,'native_init');
      const img = new Image(); img.src='/skeet-native/background.png'; await img.decode();
      const pixelsCanvas=document.createElement('canvas');pixelsCanvas.width=img.width;pixelsCanvas.height=img.height;
      const ctx=pixelsCanvas.getContext('2d')!;ctx.drawImage(img,0,0);const pixels=ctx.getImageData(0,0,img.width,img.height).data;
      const ptr=m._malloc(pixels.length);m.HEAPU8.set(pixels,ptr);call(m,'native_background',img.width,img.height,ptr);m._free(ptr);
      return m;
    })().catch(error => { modulePromise=undefined; throw error; });
    this.module=await modulePromise;
  }
  private register(): void {
    const m=this.module!;call(m,'native_clear_controls');this.controls=[];let id=1000;
    this.playersKey=this.playerSignature();this.sync=true;
    const add=(group:string,c:Control) => {
      let type=4,min=0,max=1,options:string[]=[];
      if(c.type==='check'||c.type==='toggle')type=0;
      if(c.type==='slider'){type=1;const range=c.path?RANGES[c.path]:undefined;min=c.min??range?.min??0;max=c.max??range?.max??1;}
      if(c.type==='select'){type=2;options=c.options?.map(o=>o.value)??[...(CHOICES[c.path??'']??[])];}
      if(c.type==='buttons')return;
      if(c.type==='key')type=3;
      if(c.type==='color')type=5;
      if(c.type==='custom')return;
      if('path' in c && c.path && ['settings.theme','settings.accent','settings.animSpeed'].includes(c.path))return;
      call(m,'native_add',id,group,c.label,type,min,max,c.type==='select'?c.options?.map(o=>o.label).join('|')??options.join('|'):'',c.hint??'');
      this.controls.push({id,c,last:NaN,options});id++;
    };
    // Buttons are single controls; avoid recursing through their one-item wrapper.
    const addButton=(group:string,label:string,run:()=>void) => {
      const c:Control={type:'buttons',label,items:[{label,run}]};call(m,'native_add',id,group,label,3,0,1,'','');this.controls.push({id:id++,c,last:0});
    };
    for(const tab of buildSkeetTabs(this.dev)) {
      if(tab.id==='visuals'||tab.id==='configs')continue;
      for(const section of tab.sections) {
        const group=tab.id==='rage'?(section.title==='Shot overrides'?'Rage Other':'Aimbot')
          :tab.id==='antiaim'?(section.title==='Resolver'?'Other':section.title.toLowerCase().includes('network')?'Fake lag':'Anti-aimbot angles')
          :tab.id==='fakelag'?'Fake lag':tab.id==='legit'?'Trigger':tab.id==='skins'?(section.title==='Weapon finish'?'Weapon skin':'Weapon stats'):tab.id==='misc'?'Browser Misc':tab.id==='extensions'?'Misc Other':'Settings';
        // Type 6: a section heading.
        call(m,'native_add',id++,group,section.title,6,0,1,'','');
        for(const c of section.items) {
          if(c.type==='buttons')for(const b of c.items)addButton(group,c.items.length===1&&b.label==='Apply'?`Apply ${c.label.toLowerCase()}`:b.label,b.run);
          else add(group,c);
        }
      }
    }
    add('Weapon Selection',{type:'info',label:'Current weapon',value:()=>this.dev.runtime.currentSession?.weapons.def.name??'No match'});
    addButton('Settings','Save current config',()=>{const name='Native Skeet';const config=structuredClone(this.dev.config);const old=this.dev.configs.find(c=>c.name===name);if(old)old.config=config;else this.dev.configs.push({name,config});this.dev.saveConfigList();this.registerPending=true;this.dev.notify('Config saved.','good');});
    for(const saved of this.dev.configs)addButton('Settings',`Load ${saved.name}`,()=>this.dev.replaceConfig(structuredClone(saved.config)));
    addButton('Settings','Reset all settings',()=>this.dev.resetAll());
    for(const p of this.dev.runtime.currentSession?.infos.values()??[]) if(p.pid!==this.dev.runtime.currentSession?.selfPid) {
      for(const key of ['ignore','body'] as const)add('Players',{type:'check',label:`${key==='ignore'?'Ignore':'Body aim'} ${p.name}${p.bot?' (bot)':''}`,bind:{get:()=>this.dev.runtime.playerRule(p.pid)[key],set:v=>this.dev.runtime.setPlayerRule(p.pid,key,v)}});
    }
    add('Adjustments',{type:'info',label:'Opponent overrides',value:()=> 'Ignore excludes assisted targeting. Body aim selects torso points. Both clear on leaving.'});
  }
  private read(c:Control,options:string[]=[]): number {
    if(c.type==='color')return parseInt(String(this.dev.get(c.path)).replace('#',''),16)||0;
    if(c.type==='buttons'||c.type==='key'||c.type==='info')return 0;
    if('bind' in c && c.bind){const v=c.bind.get();return typeof v==='string'?Math.max(0,options.indexOf(v)):Number(v);}
    if('path' in c && c.path){const v=this.dev.get(c.path);return typeof v==='string'?Math.max(0,options.indexOf(v)):Number(v);}
    return 0;
  }
  private write(c:Control,n:number,options:string[]=[],id=0): void {
    if(c.type==='color'){this.dev.set(c.path,`#${Math.round(n).toString(16).padStart(6,'0')}`);return;}
    if(c.type==='buttons'){const b=c.items[0];if(n&&b&&!b.disabled?.())b.run();return;}
    if(c.type==='key'){if(n){this.awaitingKey={path:c.path,id};this.root.classList.add('dev-capturing');call(this.module!,'native_detail',id,'Press a key; Backspace clears the bind.');}return;}
    if(c.type==='toggle'||c.type==='check'){if(c.bind)c.bind.set(!!n);else this.dev.set(c.path!,!!n);}
    if(c.type==='slider'){if(c.bind)c.bind.set(n);else this.dev.set(c.path!,n);}
    if(c.type==='select'){const v=options[Math.round(n)];if(v!==undefined){if(c.bind)c.bind.set(v);else this.dev.set(c.path!,v);}}
  }
  private frame=():void => {
    if(this.disposed||!this.module)return;const m=this.module,now=performance.now();
    if(!this.awaitingKey && (this.registerPending || (now-this.liveAt>250 && this.playersKey!==this.playerSignature()))){this.registerPending=false;this.register();}
    if(this.sync){
      for(const f of NATIVE_FIELDS){const path=mapped[f.field];const n=path?Number(this.dev.get(path)):this.dev.config.skeet.native[f.key]??f.default;call(m,'native_set',f.id,n);this.nativeValues.set(f.id,n);}
      for(const c of this.controls){c.last=this.read(c.c,c.options);call(m,'native_control_set',c.id,c.last);}
      this.sync=false;
    }
    if(now-this.liveAt>250){this.liveAt=now;for(const {id,c} of this.controls){if(c.type==='info')call(m,'native_detail',id,c.value());if(c.type==='key'&&this.awaitingKey?.id!==id)call(m,'native_detail',id,String(this.dev.get(c.path)||'Always'));}}
    this.resize();canvas.style.opacity=String(this.dev.config.settings.opacity);
    call(m,'native_frame',660,560,Math.min(.1,(now-this.lastFrame)/1000));this.lastFrame=now;
    let config: typeof this.dev.config | undefined;
    for(const f of NATIVE_FIELDS){const n=value(m,'native_get',f.id);if(Math.abs(n-(this.nativeValues.get(f.id)??0))<.00001)continue;this.nativeValues.set(f.id,n);config??=structuredClone(this.dev.config);config.skeet.native[f.key]=n;const path=mapped[f.field];if(path)setPath(config,path,!!n);}
    if(config)this.dev.replaceConfig(config);
    for(const c of this.controls){const n=value(m,'native_control_get',c.id);if(Math.abs(n-c.last)<.00001)continue;c.last=n;this.write(c.c,n,c.options,c.id);if(c.c.type==='key'||c.c.type==='buttons'){call(m,'native_control_set',c.id,0);c.last=0;}}
    // Read-only widget bounds support browser interaction tests without changing native layout.
    canvas.dataset.widgets=m.UTF8ToString(m.ccall('native_widgets','number',[],[]));
    this.frameId=requestAnimationFrame(this.frame);
  };
  private listen():void {
    const m=this.module!,signal=this.abort.signal;
    const mouse=(e:MouseEvent,button=-1,down=0,wheel=0)=>{const r=canvas.getBoundingClientRect();call(m,'native_mouse',(e.clientX-r.left)*660/r.width,(e.clientY-r.top)*560/r.height,button,down,wheel);};
    canvas.addEventListener('pointermove',e=>mouse(e),{signal});
    canvas.addEventListener('pointerdown',e=>{canvas.focus();canvas.setPointerCapture(e.pointerId);mouse(e,e.button===1?2:e.button===2?1:0,1);e.preventDefault();},{signal});
    canvas.addEventListener('pointerup',e=>mouse(e,e.button===1?2:e.button===2?1:0,0),{signal});
    canvas.addEventListener('wheel',e=>{mouse(e,-1,0,-Math.sign(e.deltaY));e.preventDefault();},{signal,passive:false});
    canvas.addEventListener('contextmenu',e=>e.preventDefault(),{signal});
    canvas.addEventListener('keydown',e=>{if(this.awaitingKey){if(e.code!=='Escape')this.dev.set(this.awaitingKey.path,e.code==='Backspace'?'':e.code);this.awaitingKey=undefined;this.root.classList.remove('dev-capturing');e.preventDefault();return;}if(e.code==='Insert'||(e.code==='Escape'&&!value(m,'native_popup_count',0))){this.close();return;}call(m,'native_key',e.keyCode,1,+e.ctrlKey,+e.shiftKey,+e.altKey);if(e.key.length===1&&!e.ctrlKey&&!e.altKey)call(m,'native_text',e.key);e.preventDefault();},{signal});
    canvas.addEventListener('keyup',e=>call(m,'native_key',e.keyCode,0,+e.ctrlKey,+e.shiftKey,+e.altKey),{signal});
  }
  private playerSignature(): string { return [...this.dev.runtime.currentSession?.infos.values()??[]].map(p=>`${p.pid}:${p.name}`).join('|'); }
  private resize=():void=>{const scale=Math.min(this.dev.config.settings.scale,(innerWidth-20)/660,(innerHeight-50)/560);this.root.style.setProperty('--native-scale',String(Math.max(.2,scale)));};
  refreshAll():void {this.sync=true;}
  dispose():void {this.disposed=true;cancelAnimationFrame(this.frameId);this.abort.abort();this.unsubscribe();this.root.remove();if(this.module)call(this.module,'native_reset_input');}
}
