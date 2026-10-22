import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { stepProjectile, type CollisionWorld, type ProjectileDef, type Vec3, type WeaponId } from '@game/shared';
import type { Quality } from '../settings';

/** The case textures in client/public/textures/casings (colour, normal and ORM maps, 256 px). */
export type CasingKind = 'ak47' | 'awp' | 'deagle' | 'glock' | 'xm1014' | 'nova' | 'mag7';

/**
 * Which case each gun throws out. Guns without a texture of their own use the closest one: rifles
 * the AK's, the Scout the AWP's, pistols and SMGs the Glock's, other shotguns the XM1014's. The
 * revolver keeps its cases, and launchers and the crossbow have none.
 */
export const CASING_FOR: Partial<Record<WeaponId, CasingKind>> = {
  ak47: 'ak47', m4a1: 'ak47', rifle: 'ak47', burst: 'ak47', battle: 'ak47', golden: 'ak47', lmg: 'ak47', minigun: 'ak47',
  sniper: 'awp', scout: 'awp', ssg08: 'awp', scar20: 'awp',
  deagle: 'deagle', deserteagle: 'deagle',
  pistol: 'glock', silenced: 'glock', dualies: 'glock', fiveseven: 'glock', mpistol: 'glock', smg: 'glock',
  autoshotgun: 'xm1014',
  shotgun: 'nova',
};

/**
 * When the case comes out after the shot (ms). Self-loading guns throw it at once; the pump is
 * racked a moment later, and a bolt action is worked after the shot.
 */
export const CYCLE = {
  pump: { delayMs: 180, ms: 360 },
  boltAction: { delayMs: 300, ms: 700 },
} as const;
/** Guns worked by hand between shots (the rest cycle themselves; the revolver keeps its cases). */
export const CYCLE_OF: Partial<Record<WeaponId, 'pump' | 'boltAction'>> = { shotgun: 'pump', sniper: 'boltAction', scout: 'boltAction', ssg08: 'boltAction' };
export function ejectDelayMs(cycle: 'slide' | 'bolt' | 'pump' | 'boltAction' | 'cylinder' | undefined): number {
  return cycle === 'pump' ? CYCLE.pump.delayMs + CYCLE.pump.ms / 2 : cycle === 'boltAction' ? CYCLE.boltAction.delayMs + CYCLE.boltAction.ms * 0.5 : 0;
}

type Rect = readonly [u0: number, v0: number, u1: number, v1: number];
/**
 * Where each part sits on its texture, in image fractions (0,0 top left), as laid out in the files:
 * the body strip (`along`: whether its length runs down the image or across it, base end first),
 * the round base with the primer, and for shells the brass head strip.
 */
interface Layout {
  body: Rect;
  along: 'down' | 'across';
  /** Base end of the body strip is at the rect's far side (bottom, or right). */
  baseFar: boolean;
  cap: readonly [cu: number, cv: number, r: number];
  head?: Rect;
  crimp?: readonly [cu: number, cv: number, r: number];
}
const LAYOUTS: Record<CasingKind, Layout> = {
  ak47: { body: [0.03, 0.02, 0.97, 0.64], along: 'across', baseFar: false, cap: [0.42, 0.8, 0.11] },
  awp: { body: [0.03, 0.05, 0.6, 0.98], along: 'down', baseFar: true, cap: [0.75, 0.13, 0.11] },
  deagle: { body: [0.0, 0.33, 0.7, 0.97], along: 'down', baseFar: true, cap: [0.855, 0.47, 0.12] },
  glock: { body: [0.0, 0.35, 1.0, 0.98], along: 'down', baseFar: true, cap: [0.81, 0.17, 0.15] },
  xm1014: { body: [0.0, 0.36, 0.5, 0.86], along: 'down', baseFar: true, cap: [0.17, 0.17, 0.15], head: [0.0, 0.88, 0.78, 0.98], crimp: [0.84, 0.93, 0.05] },
  nova: { body: [0.0, 0.36, 0.5, 0.86], along: 'down', baseFar: true, cap: [0.17, 0.17, 0.15], head: [0.0, 0.88, 0.78, 0.98], crimp: [0.84, 0.93, 0.05] },
  mag7: { body: [0.0, 0.36, 0.5, 0.86], along: 'down', baseFar: true, cap: [0.17, 0.17, 0.15], head: [0.0, 0.88, 0.78, 0.98], crimp: [0.84, 0.93, 0.05] },
};

/**
 * Sizes in metres, a little bigger than the real cases so they read on screen: the AWP's long
 * .338 case, the Glock's short 9 mm, the Deagle's wide .50, the AK's bottlenecked 7.62, 12 gauge shells.
 */
const SIZE: Record<CasingKind, { length: number; radius: number; neck?: number; head?: number }> = {
  ak47: { length: 0.052, radius: 0.0075, neck: 0.0058 },
  awp: { length: 0.09, radius: 0.0098, neck: 0.0072 },
  deagle: { length: 0.042, radius: 0.0092 },
  glock: { length: 0.025, radius: 0.0066 },
  xm1014: { length: 0.09, radius: 0.0135, head: 0.016 },
  nova: { length: 0.09, radius: 0.0135, head: 0.016 },
  mag7: { length: 0.09, radius: 0.0135, head: 0.016 },
};

/** UVs of a lathe or cylinder (u around, v along it from the base) moved into `rect` on the texture. */
function mapStrip(g: THREE.BufferGeometry, rect: Rect, along: 'down' | 'across', baseFar: boolean): void {
  const uv = g.getAttribute('uv') as THREE.BufferAttribute;
  const [u0, v0, u1, v1] = rect;
  for (let i = 0; i < uv.count; i++) {
    const around = uv.getX(i), len = baseFar ? 1 - uv.getY(i) : uv.getY(i);
    // Image fractions, then flipped to texture space (images load with the top row at v = 1).
    const x = along === 'down' ? u0 + around * (u1 - u0) : u0 + len * (u1 - u0);
    const y = along === 'down' ? v0 + len * (v1 - v0) : v0 + around * (v1 - v0);
    uv.setXY(i, x, 1 - y);
  }
}

/** A disc's UVs moved onto a circle of the texture (centre `cu, cv`, radius `r`, image fractions). */
function mapDisc(g: THREE.BufferGeometry, [cu, cv, r]: readonly [number, number, number]): void {
  const uv = g.getAttribute('uv') as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, cu + (uv.getX(i) - 0.5) * 2 * r, 1 - (cv - (uv.getY(i) - 0.5) * 2 * r));
}

/** One case: body (bottlenecked for rifles), the base with its primer, and for shells the brass head and the crimp. Along +Y, base at 0. */
function casingGeometry(kind: CasingKind): THREE.BufferGeometry {
  const L = LAYOUTS[kind], S = SIZE[kind];
  const parts: THREE.BufferGeometry[] = [];
  const headLen = S.head ?? 0;
  let body: THREE.BufferGeometry;
  if (S.neck) {
    const r = S.radius, n = S.neck, h = S.length;
    body = new THREE.LatheGeometry([new THREE.Vector2(r * 1.04, 0), new THREE.Vector2(r * 0.9, h * 0.06), new THREE.Vector2(r, h * 0.1), new THREE.Vector2(r * 0.96, h * 0.72), new THREE.Vector2(n, h * 0.84), new THREE.Vector2(n, h)], 12);
  } else {
    body = new THREE.CylinderGeometry(S.radius, S.radius, S.length - headLen, 12, 1, true).translate(0, (S.length - headLen) / 2 + headLen, 0);
  }
  mapStrip(body, L.body, L.along, L.baseFar);
  parts.push(body.index ? body.toNonIndexed() : body);
  if (L.head && headLen) {
    const head = new THREE.CylinderGeometry(S.radius * 1.03, S.radius * 1.03, headLen, 12, 1, true).translate(0, headLen / 2, 0);
    mapStrip(head, L.head, 'across', false);
    parts.push(head.toNonIndexed());
  }
  const cap = new THREE.CircleGeometry(S.radius * (S.neck ? 1.04 : 1.03), 14).rotateX(Math.PI / 2);
  mapDisc(cap, L.cap);
  parts.push(cap.toNonIndexed());
  if (L.crimp) {
    const crimp = new THREE.CircleGeometry(S.radius, 10).rotateX(-Math.PI / 2).translate(0, S.length, 0);
    mapDisc(crimp, L.crimp);
    parts.push(crimp.toNonIndexed());
  }
  const merged = mergeGeometries(parts, false)!;
  for (const p of parts) p.dispose();
  // Centred on its middle, so it tumbles about it.
  merged.translate(0, -S.length / 2, 0);
  merged.computeBoundingSphere();
  return merged;
}

const PHYSICS: ProjectileDef = {
  speed: 0, upBoost: 0, gravity: 9.8, radius: 0.012, fuseMs: Infinity, explodeOnImpact: false, bounce: 0.35,
  damage: 0, splashRadius: 0, knockback: 0, selfDamageScale: 0, rollFriction: 3,
};
/** Seconds a case lies about, the last part shrinking away. */
const LIFE = 3.5;
const FADE = 0.5;
/** How many can be out at once, by graphics quality. */
const CAP: Record<Quality, number> = { low: 10, medium: 24, high: 40 };

interface Casing {
  mesh: THREE.Mesh;
  kind: CasingKind;
  body: { x: number; y: number; z: number; vx: number; vy: number; vz: number; landed?: boolean };
  spin: THREE.Vector3;
  age: number;
  clinks: number;
  active: boolean;
}

/**
 * Spent cases: thrown out of the ejection port, tumbling, bouncing and rolling on the level with the
 * grenades' physics, clinking when they land, gone after a few seconds. A fixed pool of meshes
 * (the oldest is reused when it's full), one geometry and one material per kind, shared.
 */
export class Casings {
  private readonly root = new THREE.Group();
  private readonly pool: Casing[] = [];
  private readonly pending: { at: number; kind: CasingKind; pos: Vec3; vel: Vec3 }[] = [];
  private readonly geometries = new Map<CasingKind, THREE.BufferGeometry>();
  private readonly materials = new Map<CasingKind, THREE.MeshStandardMaterial>();
  private readonly textures: THREE.Texture[] = [];
  private readonly loader = new THREE.TextureLoader();
  private next = 0;
  private cap: number;
  private clock = 0;

  constructor(scene: THREE.Scene, private readonly world: CollisionWorld, quality: Quality, private readonly clink: (kind: CasingKind, at: Vec3, loud: number) => void) {
    this.cap = CAP[quality];
    scene.add(this.root);
  }

  setQuality(quality: Quality): void {
    this.cap = CAP[quality];
    for (let i = this.cap; i < this.pool.length; i++) this.pool[i]!.mesh.visible = this.pool[i]!.active = false;
  }

  /** A case of `kind` leaving `pos` at `vel` (world, m/s), `delayMs` from now (pump and bolt actions). */
  eject(kind: CasingKind, pos: Vec3, vel: Vec3, delayMs = 0): void {
    if (delayMs > 0) {
      this.pending.push({ at: this.clock + delayMs / 1000, kind, pos: { ...pos }, vel: { ...vel } });
      return;
    }
    let c = this.pool[this.next % this.cap];
    if (!c) {
      c = { mesh: new THREE.Mesh(this.geometry(kind), this.material(kind)), kind, body: { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0 }, spin: new THREE.Vector3(), age: 0, clinks: 0, active: false };
      c.mesh.castShadow = false;
      c.mesh.frustumCulled = true;
      this.pool[this.next % this.cap] = c;
      this.root.add(c.mesh);
    }
    this.next = (this.next + 1) % this.cap;
    if (c.kind !== kind) {
      c.kind = kind;
      c.mesh.geometry = this.geometry(kind);
      c.mesh.material = this.material(kind);
    }
    c.body = { x: pos.x, y: pos.y, z: pos.z, vx: vel.x, vy: vel.y, vz: vel.z };
    c.spin.set((Math.random() - 0.5) * 30, (Math.random() - 0.5) * 12, 18 + Math.random() * 14);
    c.mesh.position.set(pos.x, pos.y, pos.z);
    c.mesh.rotation.set(0, Math.atan2(vel.x, vel.z), Math.PI / 2);
    c.mesh.scale.setScalar(1);
    c.mesh.visible = true;
    c.age = 0;
    c.clinks = 0;
    c.active = true;
  }

  update(dt: number): void {
    this.clock += dt;
    for (let i = this.pending.length - 1; i >= 0; i--) {
      const p = this.pending[i]!;
      if (p.at > this.clock) continue;
      this.pending.splice(i, 1);
      this.eject(p.kind, p.pos, p.vel);
    }
    const step = Math.min(dt, 1 / 30);
    for (const c of this.pool) {
      if (!c?.active) continue;
      c.age += dt;
      if (c.age >= LIFE) {
        c.active = c.mesh.visible = false;
        continue;
      }
      const b = c.body;
      const vy = b.vy;
      const speed = Math.hypot(b.vx, b.vy, b.vz);
      if (speed > 0.02 || !b.landed) {
        stepProjectile(b, PHYSICS, step, this.world);
        // It hit something this frame: its fall reversed or stopped. Clink, quieter each time.
        if (vy < -0.6 && b.vy > vy * 0.5 && c.clinks < 3) {
          this.clink(c.kind, b, Math.min(1, -vy / 4) * (c.clinks === 0 ? 1 : 0.45));
          c.clinks++;
          c.spin.multiplyScalar(0.45);
        }
      }
      c.mesh.position.set(b.x, b.y, b.z);
      if (b.landed && speed < 0.4) {
        // Lying on its side, rolling to a stop.
        c.mesh.rotation.z = THREE.MathUtils.lerp(c.mesh.rotation.z, Math.PI / 2, 0.2);
        c.mesh.rotation.x += Math.hypot(b.vx, b.vz) * step * 40;
      } else {
        c.mesh.rotation.x += c.spin.x * step;
        c.mesh.rotation.y += c.spin.y * step;
        c.mesh.rotation.z += c.spin.z * step;
      }
      if (c.age > LIFE - FADE) c.mesh.scale.setScalar(Math.max(0.01, (LIFE - c.age) / FADE));
    }
  }

  dispose(): void {
    this.root.removeFromParent();
    for (const g of this.geometries.values()) g.dispose();
    for (const m of this.materials.values()) m.dispose();
    for (const t of this.textures) t.dispose();
  }

  private geometry(kind: CasingKind): THREE.BufferGeometry {
    let g = this.geometries.get(kind);
    if (!g) this.geometries.set(kind, (g = casingGeometry(kind)));
    return g;
  }

  /** Colour, normal and ORM (occlusion R, roughness G, metalness B, as glTF) maps; nova and mag7 have colour only. */
  private material(kind: CasingKind): THREE.MeshStandardMaterial {
    let m = this.materials.get(kind);
    if (m) return m;
    const load = (map: string, color: boolean) => {
      const t = this.loader.load(`/textures/casings/${kind}_${map}.webp`);
      if (color) t.colorSpace = THREE.SRGBColorSpace;
      t.anisotropy = 2;
      this.textures.push(t);
      return t;
    };
    const full = kind !== 'nova' && kind !== 'mag7';
    if (full) {
      const orm = load('orm', false);
      m = new THREE.MeshStandardMaterial({ map: load('color', true), normalMap: load('normal', false), aoMap: orm, roughnessMap: orm, metalnessMap: orm, roughness: 1, metalness: 1, side: THREE.DoubleSide });
    } else {
      // Plastic hull with a brass head, painted on one colour map: one flat finish between the two.
      m = new THREE.MeshStandardMaterial({ map: load('color', true), roughness: 0.55, metalness: 0.25, side: THREE.DoubleSide });
    }
    this.materials.set(kind, m);
    return m;
  }
}
