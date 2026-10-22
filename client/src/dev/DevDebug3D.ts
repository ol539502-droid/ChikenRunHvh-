import * as THREE from 'three';
import { bodyScale, buildHvhMatrix } from '@game/shared';
import type { GameSession } from '../game/GameSession';
import type { DevConfig } from './config';
import { ResolverSystem, type ShotCandidate } from '@game/shared';
import { HvhDebug } from './HvhDebug';
import { HvhAuthDebug, type HvhDebugFeed } from './HvhAuthDebug';
import { Chicken } from '../game/models/Chicken';
import { nativeOn, nativeColor, nativeValue } from './skeet/visualValues';

const BOX_EDGES = new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1));
const SPHERE_GEOMETRY = new THREE.WireframeGeometry(new THREE.SphereGeometry(1, 10, 6));
const GLOW_GEOMETRY = new THREE.SphereGeometry(1, 16, 12);
/** Collision boxes are rebuilt this often (Sandbox blocks come and go). */
const COLLISION_REFRESH_MS = 1000;

const overlayLine = (color: string) => new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true, opacity: 0.9 });

interface PlayerDebug {
  boxes: THREE.LineSegments[];
  glow: THREE.Mesh;
}

/**
 * 3D developer visuals: hitbox wireframes (exactly the shapes the server tests shots against),
 * collision boxes, and a glow shell that shows chickens through walls. Drawn on top of everything.
 */
export class DevDebug3D {
  private readonly session: GameSession;
  private readonly root = new THREE.Group();
  private readonly players = new Map<number, PlayerDebug>();
  private readonly hitboxMaterial = overlayLine('#ffe14c');
  private readonly headMaterial = overlayLine('#ff4d5e');
  private readonly collisionMaterial = new THREE.LineBasicMaterial({ color: '#4dff88', transparent: true, opacity: 0.55, depthTest: false });
  private readonly glowMaterials = new Map<string, THREE.MeshBasicMaterial>();
  private collision: THREE.LineSegments | null = null;
  private collisionBuiltAt = -Infinity;
  private readonly hvh: HvhDebug | null;
  private readonly authoritative: HvhAuthDebug | null;
  private ghost: Chicken | null = null;
  private readonly ghostMaterial = new THREE.MeshBasicMaterial({transparent:true,opacity:.25,depthWrite:false});

  constructor(session: GameSession, resolver?: ResolverSystem, focus: () => ShotCandidate | null = () => null, feed?: HvhDebugFeed) {
    this.session = session;
    this.root.renderOrder = 999;
    session.camera.parent?.add(this.root);
    this.hvh = session.mode.id === 'hvh' && resolver ? new HvhDebug(session, resolver, focus) : null;
    this.authoritative = session.mode.id === 'hvh' && feed ? new HvhAuthDebug(session.camera.parent, feed) : null;
  }

  update(config: DevConfig | null): void {
    const world = config?.visuals.world;
    const esp = config?.visuals.esp;
    const hitboxes = !!world?.hitboxes;
    const glow = this.session.hvhVisuals ? nativeOn(this.session.hvhVisuals,'Visuals.Players.glow') : !!(esp?.enabled && esp.glow);
    const n=this.session.hvhVisuals;
    if(nativeOn(n,'Visuals.ColoredModels.localFakeShadow') && this.session.local.alive && !this.session.firstPerson){
      if(!this.ghost){this.ghost=new Chicken(this.session.self.appearance,this.session.self.team);this.root.add(this.ghost.root);this.ghost.root.userData.fakeShadow=true;this.ghost.setChams(this.ghostMaterial);}
      this.ghostMaterial.color.set(nativeColor(n!,'Color.ColoredModels.localFakeShadow'));this.ghostMaterial.opacity=.3*nativeValue(n,'Color.ColoredModels.localFakeShadow_3',1);
      this.ghost.root.visible=true;this.ghost.root.position.copy(this.session.local.position);this.ghost.root.rotation.y=this.session.local.server.fakeYaw??this.session.local.server.yaw;
      this.ghost.setAim(this.session.local.server.fakePitch??this.session.local.server.pitch);this.ghost.setCrouch(this.session.local.state.crouching);
    } else if(this.ghost)this.ghost.root.visible=false;
    // v2 rooms: the server's authoritative feed replaces the client-side estimate matrices; the
    // regular pass below then draws the presented pose.
    const v2 = this.session.local.hvhV2;
    this.hvh?.update(hitboxes && !v2);
    this.authoritative?.update(hitboxes && v2, (pid) => this.session.remotes.players.get(pid)?.alive === true);
    this.updatePlayers(hitboxes && (!this.hvh || v2), glow, config);
    this.updateCollision(!!world?.collision);
  }

  private updatePlayers(hitboxes: boolean, glow: boolean, config: DevConfig | null): void {
    const s = this.session;
    const seen = new Set<number>();
    const entries: [number, THREE.Vector3, number, boolean, string, number, number][] = [];
    if (hitboxes || glow) {
      if (s.local.alive) entries.push([s.selfPid, s.local.position, s.mode.id === 'hvh' ? s.local.server.yaw : s.local.chicken.root.rotation.y, false, '#ffffff', bodyScale(s.local.state), s.local.server.fakePitch ?? s.local.server.pitch]);
      for (const [pid, r] of s.remotes.players) {
        if (!r.alive) continue;
        const n=s.hvhVisuals;
        if(n && s.isFriendly(r.info) && !nativeOn(n,'Visuals.Players.teammates'))continue;
        const c = config!.visuals.colors;
        entries.push([pid, r.position, r.yaw, true, n ? nativeColor(n,'Color.Players.glow') : r.info.bot ? c.npc : s.isFriendly(r.info) ? c.friendly : c.enemy, r.scale, r.pitch]);
      }
    }
    for (const [pid, pos, yaw, remote, color, k, pitch] of entries) {
      seen.add(pid);
      const matrix=buildHvhMatrix(pos,yaw,k,pitch);
      let d = this.players.get(pid);
      if (!d) {
        d = {
          boxes: matrix.boxes.map(b=>new THREE.LineSegments(b.half ? BOX_EDGES : SPHERE_GEOMETRY,b.group==='head'?this.headMaterial:this.hitboxMaterial)),
          glow: new THREE.Mesh(GLOW_GEOMETRY),
        };
        for (const o of [...d.boxes, d.glow]) o.renderOrder = 999;
        this.root.add(...d.boxes, d.glow);
        this.players.set(pid, d);
      }
      matrix.boxes.forEach((box,i)=>{
        const line=d!.boxes[i]!;line.visible=hitboxes;line.position.copy(box.center);line.rotation.y=box.yaw;
        if(box.half)line.scale.set(box.half.x*2,box.half.y*2,box.half.z*2);else line.scale.setScalar(box.radius);
      });
      d.glow.visible = glow && remote;
      if (d.glow.visible) {
        d.glow.material = this.glowMaterial(color, s.hvhVisuals ? nativeValue(s.hvhVisuals,'Color.Players.glow_3',1) : config!.visuals.colors.opacity);
        d.glow.position.set(pos.x, pos.y + 0.85, pos.z);
        d.glow.scale.set(0.62, 0.95, 0.72);
      }
    }
    for (const [pid, d] of this.players) {
      if (seen.has(pid)) continue;
      this.root.remove(...d.boxes, d.glow);
      this.players.delete(pid);
    }
  }

  /** Additive, see-through-walls tint in a player's ESP colour. */
  private glowMaterial(color: string, opacity: number): THREE.MeshBasicMaterial {
    const key=this.session.hvhVisuals?'native':color;
    let m = this.glowMaterials.get(key);
    if (!m) {
      m = new THREE.MeshBasicMaterial({ color, transparent: true, depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending });
      this.glowMaterials.set(key, m);
    }
    m.color.set(color);
    m.opacity = 0.35 * opacity;
    return m;
  }

  private updateCollision(on: boolean): void {
    if (!on) {
      if (this.collision) this.collision.visible = false;
      return;
    }
    const now = performance.now();
    if (!this.collision || now - this.collisionBuiltAt > COLLISION_REFRESH_MS) {
      this.collisionBuiltAt = now;
      const positions: number[] = [];
      const edge = BOX_EDGES.getAttribute('position');
      for (const [, b] of this.session.collision.entries()) {
        const cx = (b.minX + b.maxX) / 2;
        const cy = (b.minY + b.maxY) / 2;
        const cz = (b.minZ + b.maxZ) / 2;
        for (let i = 0; i < edge.count; i++) {
          positions.push(cx + edge.getX(i) * (b.maxX - b.minX), cy + edge.getY(i) * (b.maxY - b.minY), cz + edge.getZ(i) * (b.maxZ - b.minZ));
        }
      }
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      if (this.collision) {
        this.collision.geometry.dispose();
        this.collision.geometry = geometry;
      } else {
        this.collision = new THREE.LineSegments(geometry, this.collisionMaterial);
        this.collision.renderOrder = 998;
        this.collision.frustumCulled = false;
        this.root.add(this.collision);
      }
    }
    this.collision.visible = true;
  }

  dispose(): void {
    this.ghost?.dispose();this.ghostMaterial.dispose();
    this.hvh?.dispose();
    this.authoritative?.dispose();
    this.root.removeFromParent();
    this.collision?.geometry.dispose();
    this.hitboxMaterial.dispose();
    this.headMaterial.dispose();
    this.collisionMaterial.dispose();
    for (const m of this.glowMaterials.values()) m.dispose();
  }
}
