import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { WEAPONS, clamp, damp, isSidearm, wrapAngle, type WeaponId } from '@game/shared';
import { buildGun, type GunModel } from './models/Guns';
import { BombView } from './BombView';
import { CYCLE } from './Casings';
import { buildProjectileMesh } from './Projectiles';
import type { HeldGrenade } from './weaponSlots';

/** Where the gun sits in front of the camera (metres), hip-fire and aiming down the sights. */
const HIP = new THREE.Vector3(0.24, -0.22, -0.45);
const ADS = new THREE.Vector3(0, -0.075, -0.34);
const SCALE = 0.55;
/** Per-weapon nudges so long guns don't fill the screen. */
const OFFSETS: Partial<Record<WeaponId, THREE.Vector3>> = {
  rocket: new THREE.Vector3(0.09, -0.02, -0.02),
  minigun: new THREE.Vector3(0.02, -0.05, 0.02),
  sniper: new THREE.Vector3(0, -0.01, 0.03),
  scar20: new THREE.Vector3(0, -0.01, 0.03),
  knife: new THREE.Vector3(0.02, -0.02, 0.04),
  goldknife: new THREE.Vector3(0.02, -0.02, 0.04),
  butterfly: new THREE.Vector3(0.02, -0.02, 0.04),
  karambit: new THREE.Vector3(0.02, -0.02, 0.05),
  m9: new THREE.Vector3(0.02, -0.03, 0.04),
  daggers: new THREE.Vector3(0.05, -0.03, 0.05),
  dualies: new THREE.Vector3(0.05, -0.01, 0.02),
  silenced: new THREE.Vector3(0, -0.005, 0.03),
  deagle: new THREE.Vector3(0, -0.01, 0.02),
  deserteagle: new THREE.Vector3(0, -0.01, 0.02),
  lmg: new THREE.Vector3(0.03, -0.04, 0.03),
  launcher: new THREE.Vector3(0.03, -0.03, 0.02),
  crossbow: new THREE.Vector3(0.02, -0.03, 0.02),
  pan: new THREE.Vector3(0.04, -0.04, 0.04),
  katana: new THREE.Vector3(0.07, -0.08, 0.06),
};
/** Melee weapons are held angled up rather than pointed like a gun (x pitch, y yaw, z roll). */
const HOLD_ANGLES: Partial<Record<WeaponId, THREE.Euler>> = {
  knife: new THREE.Euler(0.2, 0.08, -0.15),
  goldknife: new THREE.Euler(0.2, 0.08, -0.15),
  butterfly: new THREE.Euler(0.2, 0.08, -0.15),
  karambit: new THREE.Euler(0.1, 0.1, -0.25),
  m9: new THREE.Euler(0.2, 0.08, -0.15),
  daggers: new THREE.Euler(0.05, 0, 0),
  pan: new THREE.Euler(0.45, 0.1, -0.2),
  katana: new THREE.Euler(1.0, -0.15, -0.2),
};
/** Seconds one swing animation takes. */
const SWING_TIME: Partial<Record<WeaponId, number>> = { knife: 0.26, goldknife: 0.26, butterfly: 0.24, karambit: 0.24, m9: 0.27, daggers: 0.22, pan: 0.38, katana: 0.32 };

/** An offset added to the held pose (metres and radians). */
interface Pose {
  x: number;
  y: number;
  z: number;
  rx: number;
  ry: number;
  rz: number;
}
const REST: Pose = { x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0 };
const pose = (p: Partial<Pose>): Pose => ({ ...REST, ...p });
const ease = (t: number) => t * t * (3 - 2 * t);
function mixPose(a: Pose, b: Pose, t: number, out: Pose): Pose {
  for (const k of Object.keys(out) as (keyof Pose)[]) out[k] = a[k] + (b[k] - a[k]) * t;
  return out;
}
/** Keyframes as [progress 0..1, pose], eased between. */
type Keyframes = readonly (readonly [number, Pose])[];
function sample(frames: Keyframes, p: number, out: Pose): Pose {
  for (let i = 1; i < frames.length; i++) {
    const [t1, b] = frames[i]!;
    const [t0, a] = frames[i - 1]!;
    if (p <= t1) return mixPose(a, b, ease((p - t0) / (t1 - t0)), out);
  }
  return mixPose(REST, REST, 0, out);
}

/** Melee swing: wind up to the right, slash across to the left. */
const SWING: Keyframes = [
  [0, REST],
  [0.18, pose({ x: 0.07, y: 0.05, z: 0.04, rx: 0.45, ry: -0.6, rz: -0.45 })],
  [0.5, pose({ x: -0.22, y: -0.07, z: -0.1, rx: -0.4, ry: 0.95, rz: 0.55 })],
  [1, REST],
];
// ---------------------------------------------------------------------------
// Inspect (F): a different move for each kind of weapon
// ---------------------------------------------------------------------------

const TAU = Math.PI * 2;
/** Turned to show the gun's left side, and its right side. */
const SHOW_LEFT = pose({ x: -0.13, y: 0.05, z: 0.07, rx: 0.15, ry: 0.95, rz: 0.35 });
const SHOW_RIGHT = pose({ x: -0.1, y: 0.06, z: 0.06, rx: 0.3, ry: -0.85, rz: -0.55 });

/** Pistols: show the left side, a quick spin round the trigger finger, then the right side. */
const INSPECT_PISTOL: Keyframes = [
  [0, REST],
  [0.13, SHOW_LEFT],
  [0.36, { ...SHOW_LEFT, ry: 1.12, rz: 0.42 }],
  [0.42, pose({ x: -0.07, y: 0.08, z: 0.05, rx: 0.25, ry: 0.4 })],
  [0.58, pose({ x: -0.07, y: 0.08, z: 0.05, rx: 0.25 + TAU, ry: 0.4 })],
  [0.7, { ...SHOW_RIGHT, rx: 0.3 + TAU }],
  [0.88, { ...SHOW_RIGHT, rx: 0.25 + TAU, ry: -1.0, rz: -0.6 }],
  [1, pose({ rx: TAU })],
];
/** Rifles, SMGs, shotguns: left side, tipped over to check the magazine, then the right side. */
const MAG_LOOK = pose({ x: -0.1, y: 0.1, z: 0.06, rx: -0.5, ry: 0.6, rz: -0.4 });
const INSPECT_RIFLE: Keyframes = [
  [0, REST],
  [0.12, SHOW_LEFT],
  [0.36, { ...SHOW_LEFT, ry: 1.15, rz: 0.45 }],
  [0.46, MAG_LOOK],
  [0.62, { ...MAG_LOOK, rx: -0.45, rz: -0.45 }],
  [0.72, SHOW_RIGHT],
  [0.9, { ...SHOW_RIGHT, ry: -1.0, rz: -0.6 }],
  [1, REST],
];
/** Snipers: a heavy lift to show the side, then nose up to look along the scope. */
const INSPECT_SNIPER: Keyframes = [
  [0, REST],
  [0.15, pose({ x: -0.16, y: 0.08, z: 0.1, rx: 0.1, ry: 1.2, rz: 0.2 })],
  [0.42, pose({ x: -0.16, y: 0.08, z: 0.1, rx: 0.12, ry: 1.3, rz: 0.3 })],
  [0.56, pose({ x: -0.05, y: 0.11, z: 0.08, rx: -0.35, ry: 0.35, rz: -0.2 })],
  [0.7, pose({ x: -0.05, y: 0.11, z: 0.08, rx: -0.3, ry: 0.3, rz: -0.25 })],
  [0.8, { ...SHOW_RIGHT, ry: -0.8, rz: -0.4 }],
  [0.92, { ...SHOW_RIGHT, ry: -0.9, rz: -0.45 }],
  [1, REST],
];
/** Heavy weapons: slow, with a little bounce from the weight. */
const INSPECT_HEAVY: Keyframes = [
  [0, REST],
  [0.18, pose({ x: -0.1, y: 0.04, z: 0.06, rx: 0.1, ry: 0.8, rz: 0.25 })],
  [0.26, pose({ x: -0.1, y: 0.02, z: 0.06, rx: 0.14, ry: 0.82, rz: 0.3 })],
  [0.5, pose({ x: -0.1, y: 0.045, z: 0.06, rx: 0.1, ry: 0.95, rz: 0.3 })],
  [0.68, pose({ x: -0.06, y: 0.04, z: 0.05, rx: 0.2, ry: -0.6, rz: -0.35 })],
  [0.88, pose({ x: -0.06, y: 0.035, z: 0.05, rx: 0.22, ry: -0.68, rz: -0.38 })],
  [1, REST],
];
/** Knives without their own trick: show the flat, toss it up spinning, catch it, show the other side. */
const ACROSS = pose({ x: -0.15, y: 0.07, z: 0.03, rx: -0.1, ry: 1.35 });
const INSPECT_MELEE: Keyframes = [
  [0, REST],
  [0.12, ACROSS],
  [0.3, { ...ACROSS, ry: 1.45, rx: -0.05 }],
  [0.36, { ...ACROSS, y: 0.04, ry: 1.45 }],
  [0.5, { ...ACROSS, y: 0.22, ry: 1.45, rz: Math.PI }],
  [0.62, { ...ACROSS, y: 0.07, ry: 1.45, rz: TAU }],
  [0.84, { ...ACROSS, ry: 1.35, rx: -0.15, rz: TAU }],
  [1, pose({ rz: TAU })],
];
/** Knives with their own trick (butterfly fan, karambit spin...): held up in view while it plays. */
const SHOW = pose({ x: -0.12, y: 0.07, z: 0.04, rx: 0.25, ry: 0.55, rz: 0.1 });
const INSPECT_TRICK: Keyframes = [
  [0, REST],
  [0.12, SHOW],
  [0.88, { ...SHOW, ry: 0.65 }],
  [1, REST],
];
/** A pair (Dual Pistols, Shadow Daggers): lifted and rocked side to side, so both stay in view. */
const LIFT = pose({ x: -0.03, y: 0.06, z: 0.05, rx: 0.35 });
const INSPECT_PAIR: Keyframes = [
  [0, REST],
  [0.14, LIFT],
  [0.4, { ...LIFT, rz: 0.35 }],
  [0.64, { ...LIFT, rz: -0.35 }],
  [0.86, { ...LIFT, rx: 0.25 }],
  [1, REST],
];

type InspectKind = 'pistol' | 'rifle' | 'sniper' | 'heavy' | 'melee' | 'trick' | 'pair';
interface InspectMove {
  frames: Keyframes;
  seconds: number;
  /** When (progress) the magazine slides out and back in, if it does. */
  magCheck?: readonly [number, number];
}
const INSPECTS: Record<InspectKind, InspectMove> = {
  pistol: { frames: INSPECT_PISTOL, seconds: 2.6 },
  rifle: { frames: INSPECT_RIFLE, seconds: 3.2, magCheck: [0.47, 0.61] },
  sniper: { frames: INSPECT_SNIPER, seconds: 3.4 },
  heavy: { frames: INSPECT_HEAVY, seconds: 3.6 },
  melee: { frames: INSPECT_MELEE, seconds: 2.8 },
  trick: { frames: INSPECT_TRICK, seconds: 2.6 },
  pair: { frames: INSPECT_PAIR, seconds: 2.8 },
};
const HEAVY = new Set<WeaponId>(['lmg', 'minigun', 'rocket', 'launcher', 'crossbow']);

/** Which inspect a weapon gets. */
export function inspectKind(id: WeaponId, gun: Pick<GunModel, 'offhand' | 'animate'> | null): InspectKind {
  const w = WEAPONS[id];
  if (gun?.offhand) return 'pair';
  if (gun?.animate) return 'trick';
  if (w.melee) return 'melee';
  if (w.scope) return 'sniper';
  if (HEAVY.has(id)) return 'heavy';
  if (isSidearm(id)) return 'pistol';
  return 'rifle';
}

/** Per-weapon size (big guns would cover the HUD). */
const SIZES: Partial<Record<WeaponId, number>> = { rocket: 0.72, minigun: 0.85, sniper: 0.95, lmg: 0.82, launcher: 0.85, crossbow: 0.9, scout: 0.95, battle: 0.95, ssg08: 0.95, scar20: 0.95 };
interface RecoilFeel {
  back: number;
  pitch: number;
  roll: number;
  recovery: number;
  flash: number;
  flashLife: number;
}
/** Cosmetic recoil only: the server and input controller still own aim and bullet spread. */
const RECOIL: Partial<Record<WeaponId, RecoilFeel>> = {
  pistol: { back: 0.07, pitch: 0.2, roll: 0.14, recovery: 17, flash: 0.75, flashLife: 0.045 },
  golden: { back: 0.085, pitch: 0.22, roll: 0.12, recovery: 16, flash: 0.9, flashLife: 0.045 },
  ak47: { back: 0.075, pitch: 0.16, roll: 0.11, recovery: 16, flash: 1, flashLife: 0.045 },
  m4a1: { back: 0.055, pitch: 0.11, roll: 0.08, recovery: 20, flash: 0.8, flashLife: 0.035 },
  rifle: { back: 0.055, pitch: 0.11, roll: 0.09, recovery: 19, flash: 0.9, flashLife: 0.04 },
  smg: { back: 0.035, pitch: 0.075, roll: 0.1, recovery: 24, flash: 0.6, flashLife: 0.035 },
  minigun: { back: 0.022, pitch: 0.045, roll: 0.065, recovery: 26, flash: 0.7, flashLife: 0.028 },
  shotgun: { back: 0.14, pitch: 0.25, roll: 0.18, recovery: 10, flash: 1.5, flashLife: 0.06 },
  sniper: { back: 0.13, pitch: 0.2, roll: 0.12, recovery: 9, flash: 1.4, flashLife: 0.055 },
  rocket: { back: 0.1, pitch: 0.13, roll: 0.14, recovery: 9, flash: 1.6, flashLife: 0.08 },
};
const DEFAULT_RECOIL = RECOIL.pistol!;

/** Seconds a grenade throw takes, start to follow-through. */
const THROW_TIME = 0.38;

export interface ViewModelFrame {
  dt: number;
  camera: THREE.Camera;
  weapon: WeaponId;
  grenade?: HeldGrenade | null;
  /** The grenade's pin is pulled: the arm draws back, ready to throw. */
  grenadePin?: boolean;
  /** The bomb is out (slot 5): the C4 in your hands instead of the gun. */
  bomb?: boolean;
  visible: boolean;
  aiming: boolean;
  /** Horizontal speed, m/s (for the walk bob). */
  speed: number;
  onGround: boolean;
  /** 0..1 while reloading, otherwise null. */
  reload: number | null;
  yaw: number;
  pitch: number;
}

/**
 * The first-person gun. It lives in its own overlay scene (drawn after the world with a fresh
 * depth buffer) so it never pokes through walls, and it moves like a real held weapon: sway,
 * walk bob, landing dip, recoil kick, reload, weapon switch and a muzzle flash on the barrel.
 */
export class ViewModel {
  suppressRecoil = false;
  /** Follows the camera every frame. Lives in the overlay scene. */
  private readonly root = new THREE.Group();
  /** Animated offset in front of the camera. */
  private readonly holder = new THREE.Group();
  private gun: GunModel | null = null;
  private gunId: WeaponId | null = null;
  private readonly guns = new Map<WeaponId, GunModel>();
  private readonly grenades = new Map<HeldGrenade, THREE.Group>();
  private c4: THREE.Group | null = null;
  /** Your gun skin (set before the first gun is drawn). */
  skin = 'none';
  private tint: string | null = null;
  private tintStyle = 0;
  private tintAlpha = 1;
  private readonly tintClones = new Map<THREE.Material, THREE.Material>();
  private readonly tintSources = new Map<THREE.Material, THREE.Material>();
  private readonly reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  private readonly flash: THREE.Mesh;
  private flashLife = 0;
  private readonly magRest = new THREE.Vector3();

  private kick = 0;
  private roll = 0;
  private swayX = 0;
  private swayY = 0;
  private lastYaw: number | null = null;
  private lastPitch = 0;
  private bobPhase = 0;
  private bobAmount = 0;
  private ads = 0;
  private raise = 1;
  private landDip = 0;
  private wasOnGround = true;
  private reloadBlend = 0;
  /** Seconds into the current melee swing, or -1. */
  private swingT = -1;
  /** Seconds into an inspect (F), or -1. */
  private inspectT = -1;
  /** What was in hand last frame (gun, grenade, bomb), to raise the hand when it changes. */
  private inHand = '';
  /** Seconds since the last shot, while the gun's moving part is cycling, or -1. */
  private actionT = -1;
  /** This shot's case is out already. */
  private ejected = false;
  /** Revolver: where the cylinder should be turned to, and where it is. */
  private cylinderTurn = 0;
  private cylinderAngle = 0;
  private readonly ejectPos = new THREE.Vector3();
  private readonly ejectDir = new THREE.Vector3();
  /** A spent case leaves the ejection port (world position, and the way it's thrown, a unit vector). */
  onEject: ((at: THREE.Vector3, dir: THREE.Vector3) => void) | null = null;
  /** Seconds into a grenade throw, or -1; and how far the arm is drawn back. */
  private throwT = -1;
  private pinBlend = 0;
  /** Where the inspect's magazine check is, so each click plays once. */
  private magCue: 'out' | 'in' | null = null;
  /** Sound cues from the inspect: the magazine sliding out, and back in. */
  onInspectCue: ((cue: 'out' | 'in') => void) | null = null;
  private readonly swingPose: Pose = { ...REST };
  private readonly inspectPose: Pose = { ...REST };
  private readonly pose: Pose = { ...REST };
  private readonly tmp = new THREE.Vector3();

  constructor(scene: THREE.Scene) {
    this.holder.scale.setScalar(SCALE);
    this.root.add(this.holder);
    this.root.visible = false;
    this.flash = new THREE.Mesh(FLASH_GEOMETRY, flashMaterial());
    this.flash.visible = false;
    this.flash.renderOrder = 10;
    scene.add(this.root);
  }

  get visible(): boolean {
    return this.root.visible;
  }

  /** A shot: kick the gun back and flash the muzzle. With a melee weapon: a swing. */
  fire(): void {
    this.inspectT = -1;
    if (this.gunId && WEAPONS[this.gunId].melee) {
      this.swingT = 0;
      return;
    }
    const feel = (this.gunId && RECOIL[this.gunId]) || DEFAULT_RECOIL;
    this.actionT = 0;
    this.ejected = false;
    if (this.gun?.action?.kind === 'cylinder') this.cylinderTurn += this.gun.action.travel;
    this.kick = this.suppressRecoil ? 0 : Math.min(1.35, this.kick + 1);
    this.roll = this.suppressRecoil ? 0 : (Math.random() - 0.5) * feel.roll;
    this.flashLife = feel.flashLife;
    this.flash.rotation.z = Math.random() * Math.PI;
    this.flash.scale.setScalar(feel.flash * (0.85 + Math.random() * 0.3) * (this.reducedMotion.matches ? 0.7 : 1));
  }

  /** A grenade leaves the hand: the arm swings forward, then the next one (or the gun) comes up. */
  throwGrenade(): void {
    this.inspectT = -1;
    this.throwT = 0;
  }

  /** Inspect the weapon (F): turn it over to look at it. Shooting, aiming or reloading stops it. */
  inspect(): void {
    if (this.swingT < 0) this.inspectT = 0;
  }

  /** World position of the muzzle (for tracers and the world-space flash). */
  muzzleWorld(out: THREE.Vector3): THREE.Vector3 | null {
    if (!this.root.visible || !this.gun) return null;
    this.root.updateMatrixWorld(true);
    return this.gun.muzzle.getWorldPosition(out);
  }

  update(f: ViewModelFrame): void {
    this.root.visible = f.visible;
    if (!f.visible) {
      this.lastYaw = null;
      return;
    }
    const dt = f.dt;
    if (f.weapon !== this.gunId) this.swap(f.weapon);
    // Taking out a grenade or the bomb (or putting it away) brings the hand up like a weapon switch.
    const inHand = `${f.weapon}|${f.grenade ?? ''}|${f.bomb ? 1 : 0}`;
    if (inHand !== this.inHand) {
      if (this.inHand !== '') this.raise = 0;
      this.inHand = inHand;
    }
    this.gun!.group.visible = !f.grenade && !f.bomb;
    // Halfway into a throw the grenade has left the hand.
    const thrown = this.throwT >= THROW_TIME * 0.3;
    for (const [kind, model] of this.grenades) model.visible = !f.bomb && kind === f.grenade && !thrown;
    if (f.bomb && !this.c4) {
      const view = new BombView(new THREE.Scene());
      view.update(new THREE.Vector3(), 0, 'carried', 0, 0, 0, 0);
      this.c4 = view.root;
      this.c4.removeFromParent();
      this.c4.position.set(0.02, -0.06, -0.1);
      this.c4.rotation.set(0.55, -0.35, 0.1);
      this.c4.scale.setScalar(0.55);
      this.holder.add(this.c4);
    }
    if (this.c4) this.c4.visible = f.bomb === true;
    if (f.grenade && !this.grenades.has(f.grenade)) {
      const model = buildProjectileMesh(f.grenade === 'egg' ? 'he' : f.grenade);
      // In the hand: the egg is big for a grenade, so it's held smaller and lower.
      model.scale.setScalar(f.grenade === 'egg' ? 1.2 : 1.7);
      model.position.set(0.01, f.grenade === 'egg' ? -0.025 : 0, -0.15);
      this.holder.add(model);
      this.grenades.set(f.grenade, model);
    }
    const feel = RECOIL[f.weapon] ?? DEFAULT_RECOIL;
    const motion = this.reducedMotion.matches ? 0.25 : 1;

    // Follow the camera exactly.
    f.camera.updateMatrixWorld();
    f.camera.matrixWorld.decompose(this.root.position, this.root.quaternion, this.root.scale);
    this.root.scale.set(1, 1, 1);

    // Sway: the gun lags behind the look direction a little (less while aiming).
    const dYaw = this.lastYaw === null ? 0 : wrapAngle(f.yaw - this.lastYaw);
    const dPitch = this.lastYaw === null ? 0 : f.pitch - this.lastPitch;
    this.lastYaw = f.yaw;
    this.lastPitch = f.pitch;
    const steady = 1 - this.ads * 0.8;
    const rate = dt > 0 ? 1 / dt : 0;
    this.swayX = damp(this.swayX, clamp(dYaw * rate * 0.006, -0.04, 0.04) * steady * motion, 10, dt);
    this.swayY = damp(this.swayY, clamp(-dPitch * rate * 0.006, -0.04, 0.04) * steady * motion, 10, dt);

    // Walk bob, and a dip when landing.
    const walking = f.onGround ? clamp(f.speed / 6, 0, 1.4) : 0;
    this.bobAmount = damp(this.bobAmount, walking * steady * motion, 8, dt);
    this.bobPhase += dt * (4 + f.speed * 1.4);
    if (f.onGround && !this.wasOnGround) this.landDip = 1;
    this.wasOnGround = f.onGround;
    this.landDip = damp(this.landDip, 0, 7, dt);

    this.ads = damp(this.ads, f.aiming ? 1 : 0, 14, dt);
    this.kick = damp(this.kick, 0, feel.recovery, dt);
    if(this.suppressRecoil)this.kick=this.roll=0;
    this.roll = damp(this.roll, 0, 10, dt);
    this.raise = Math.min(1, this.raise + dt * 3.5);
    const raise = 1 - (1 - this.raise) ** 3;
    this.reloadBlend = damp(this.reloadBlend, f.reload !== null ? 1 : 0, 10, dt);
    const reloadCurve = f.reload !== null ? Math.sin(f.reload * Math.PI) : 0;
    const seating = f.reload !== null && f.reload > 0.85 ? Math.sin(((f.reload - 0.85) / 0.15) * Math.PI) * 0.018 : 0;
    const breath = Math.sin(this.bobPhase * 0.18) * 0.0015 * steady * motion;

    // Melee swing: rest → wind-up → slash → back to rest.
    const swing = mixPose(REST, REST, 0, this.swingPose);
    if (this.swingT >= 0) {
      this.swingT += dt;
      const p = this.swingT / (SWING_TIME[f.weapon] ?? 0.3);
      if (p >= 1) this.swingT = -1;
      else sample(SWING, p, swing);
    }
    // Inspect (F), stopped by aiming or reloading.
    const look = mixPose(REST, REST, 0, this.inspectPose);
    if (this.inspectT >= 0 && (f.aiming || f.reload !== null)) this.inspectT = -1;
    const move = INSPECTS[inspectKind(f.weapon, this.gun)];
    let inspectP = -1;
    if (this.inspectT >= 0) {
      this.inspectT += dt;
      inspectP = this.inspectT / move.seconds;
      if (inspectP >= 1) {
        this.inspectT = -1;
        inspectP = -1;
      } else {
        sample(move.frames, inspectP, look);
        // The hand isn't a machine: a slow, small wobble on top.
        const live = Math.sin(inspectP * Math.PI) * motion;
        look.rx += Math.sin(this.inspectT * 5.3) * 0.02 * live;
        look.rz += Math.sin(this.inspectT * 3.7 + 1) * 0.025 * live;
        look.y += Math.sin(this.inspectT * 4.1) * 0.003 * live;
      }
    }
    this.gun?.animate?.(inspectP);
    this.animateAction(dt, f.reload);
    // Magazine check: out a little, then slapped back in (with a click each way).
    let magCheck = 0;
    if (inspectP >= 0 && move.magCheck) {
      const [from, to] = move.magCheck;
      const k = (inspectP - from) / (to - from);
      if (k > 0 && k < 1) magCheck = k < 0.35 ? k / 0.35 : k < 0.75 ? 1 : 1 - (k - 0.75) / 0.25;
      // Each click once: out as the check starts, in when the magazine is slapped home.
      if (k > 0 && k < 1) {
        const cue = k > 0.75 ? 'in' : 'out';
        if (cue !== this.magCue) {
          this.magCue = cue;
          this.onInspectCue?.(cue);
        }
      }
    } else if (inspectP < 0) this.magCue = null;
    const pose = this.pose;
    for (const k of Object.keys(pose) as (keyof Pose)[]) pose[k] = swing[k] + look[k];
    // Grenade: drawn back over the shoulder while the pin is pulled, then thrown forward.
    this.pinBlend = damp(this.pinBlend, f.grenadePin ? 1 : 0, 12, dt);
    if (this.throwT >= 0) {
      this.throwT += dt;
      if (this.throwT >= THROW_TIME) {
        this.throwT = -1;
        this.raise = 0;
      }
    }
    const fling = this.throwT >= 0 ? Math.sin((this.throwT / THROW_TIME) * Math.PI) : 0;
    pose.x += this.pinBlend * 0.035;
    pose.y += this.pinBlend * 0.035 - fling * 0.1;
    pose.z += this.pinBlend * 0.015 - fling * 0.16;
    pose.rx += -this.pinBlend * 0.45 + fling * 1.1;
    pose.rz += -this.pinBlend * 0.2;
    const hold = HOLD_ANGLES[f.weapon];

    const base = this.tmp.copy(HIP).lerp(ADS, this.ads).add(OFFSETS[f.weapon] ?? ZERO);
    base.x += pose.x;
    base.y += pose.y;
    base.z += pose.z;
    this.holder.position.set(
      base.x + this.swayX + Math.sin(this.bobPhase) * 0.012 * this.bobAmount,
      base.y + this.swayY + breath - Math.abs(Math.cos(this.bobPhase)) * 0.012 * this.bobAmount - this.landDip * 0.035 * motion - (1 - raise) * 0.25 - reloadCurve * 0.07,
      base.z + this.kick * feel.back * (1 - this.ads * 0.5) * motion + seating,
    );
    this.holder.rotation.set(
      this.kick * feel.pitch * motion + (1 - raise) * 0.7 - reloadCurve * 0.35 + this.swayY * 1.5 + (hold?.x ?? 0) + pose.rx,
      -this.swayX * 1.5 + (hold?.y ?? 0) + pose.ry,
      this.roll * this.kick * motion + reloadCurve * 0.45 * this.reloadBlend + (hold?.z ?? 0) + pose.rz,
    );

    // Reload: the magazine drops out, then a fresh one goes back in.
    if (this.gun?.magazine) {
      const p = f.reload;
      let drop = 0;
      if (p !== null) drop = p < 0.25 ? 0 : p < 0.45 ? (p - 0.25) / 0.2 : p < 0.6 ? 1 : p < 0.85 ? 1 - (p - 0.6) / 0.25 : 0;
      const mag = this.gun.magazine;
      mag.position.copy(this.magRest);
      mag.position.y -= drop * 0.22 + magCheck * 0.05;
      mag.position.z += drop * 0.03 + magCheck * 0.006;
    }

    // The minigun's barrels spin up while you look at it.
    if (this.gun?.spinner) this.gun.spinner.rotation.z += dt * (4 + this.kick * 30 + (inspectP >= 0 ? Math.sin(inspectP * Math.PI) * 14 : 0));

    this.flashLife = Math.max(0, this.flashLife - dt);
    this.flash.visible = this.flashLife > 0;
  }

  dispose(): void {
    this.root.removeFromParent();
    this.flash.removeFromParent();
    (this.flash.material as THREE.Material).dispose();
    this.guns.clear();
    for (const material of this.tintClones.values()) material.dispose();
    this.tintClones.clear(); this.tintSources.clear();
  }

  /** Local finishes clone materials; shared gun models and other players are never recolored. */
  setTint(color: string | null, style = 0, alpha = 1): void {
    if (this.tint === color && this.tintStyle === style && this.tintAlpha === alpha) return;
    this.tint = color; this.tintStyle=style; this.tintAlpha=alpha;
    for (const gun of this.guns.values()) this.tintGun(gun);
  }
  private tintGun(gun: GunModel): void {
    const tint = this.tint ? new THREE.Color(this.tint) : null;
    gun.group.traverse(node => {
      if (!(node instanceof THREE.Mesh) || node === this.flash) return;
      const paint = (material: THREE.Material) => {
        const source = this.tintSources.get(material) ?? material;
        if (!tint || !(source instanceof THREE.MeshStandardMaterial)) return source;
        let clone = this.tintClones.get(source) as THREE.MeshStandardMaterial | undefined;
        if (!clone) { clone = source.clone(); this.tintClones.set(source, clone); this.tintSources.set(clone, source); }
        clone.color.copy(source.color).multiply(tint);
        clone.roughness=this.tintStyle===3?.15:source.roughness;clone.metalness=this.tintStyle===3?1:source.metalness;
        clone.emissive.copy(this.tintStyle===1||this.tintStyle===4 ? tint : source.emissive);
        clone.emissiveIntensity=this.tintStyle===1||this.tintStyle===4 ? 1 : source.emissiveIntensity;
        clone.wireframe=this.tintStyle===5;clone.opacity=this.tintAlpha;clone.transparent=this.tintAlpha<1||this.tintStyle===4;clone.depthWrite=!clone.transparent;clone.blending=this.tintStyle===4?THREE.AdditiveBlending:THREE.NormalBlending;clone.needsUpdate=true;
        return clone;
      };
      node.material = Array.isArray(node.material) ? node.material.map(paint) : paint(node.material);
    });
  }

  /**
   * The gun's moving part: a slide or bolt snaps back and returns with each shot (the case flies
   * out then); a pump or bolt action is worked just after the shot (the case flies out as it opens);
   * a revolver's cylinder turns a chamber. At the end of a reload it's racked once more.
   */
  private animateAction(dt: number, reload: number | null): void {
    const a = this.gun?.action;
    if (!a) return;
    if (a.kind === 'cylinder') {
      this.cylinderAngle = damp(this.cylinderAngle, this.cylinderTurn, 18, dt);
      a.part.rotation.z = a.restRotation.z + this.cylinderAngle;
      return;
    }
    let back = 0, lift = 0;
    if (this.actionT >= 0) {
      this.actionT += dt;
      if (a.kind === 'slide' || a.kind === 'bolt') {
        const p = this.actionT / 0.075;
        back = p < 0.3 ? p / 0.3 : Math.max(0, 1 - (p - 0.3) / 0.7);
        if (!this.ejected) this.eject();
        if (p >= 1) this.actionT = -1;
      } else {
        const c = CYCLE[a.kind];
        const p = (this.actionT - c.delayMs / 1000) / (c.ms / 1000);
        if (p >= 0) {
          if (a.kind === 'pump') back = p < 0.5 ? p / 0.5 : Math.max(0, 1 - (p - 0.5) / 0.5);
          else {
            // Lift the handle, draw the bolt back, push it home, lower the handle.
            lift = p < 0.2 ? p / 0.2 : p < 0.8 ? 1 : Math.max(0, 1 - (p - 0.8) / 0.2);
            back = p < 0.2 ? 0 : p < 0.5 ? (p - 0.2) / 0.3 : p < 0.8 ? 1 - (p - 0.5) / 0.3 : 0;
          }
          if (p >= 0.5 && !this.ejected) this.eject();
          if (p >= 1) this.actionT = -1;
        }
      }
    }
    if (reload !== null && reload > 0.78 && reload < 0.98) {
      const p = (reload - 0.78) / 0.2;
      back = Math.max(back, p < 0.45 ? p / 0.45 : 1 - (p - 0.45) / 0.55);
      if (a.kind === 'boltAction') lift = Math.max(lift, Math.min(1, back * 2));
    }
    a.part.position.set(a.rest.x, a.rest.y, a.rest.z + back * a.travel);
    a.part.rotation.set(a.restRotation.x, a.restRotation.y, a.restRotation.z + lift * 1.1);
  }

  /** The case leaves the port: out to the right, a little up and back, in the camera's frame. */
  private eject(): void {
    this.ejected = true;
    const port = this.gun?.ejection;
    if (!port || !this.onEject || !this.root.visible) return;
    this.root.updateMatrixWorld(true);
    port.getWorldPosition(this.ejectPos);
    this.ejectDir.set(1, 0.75, 0.3).normalize().applyQuaternion(this.root.quaternion);
    this.onEject(this.ejectPos, this.ejectDir);
  }

  private swap(id: WeaponId): void {
    if (this.gun?.magazine) this.gun.magazine.position.copy(this.magRest);
    this.actionT = -1;
    this.cylinderTurn = this.cylinderAngle = 0;
    this.gun?.group.removeFromParent();
    let gun = this.guns.get(id);
    if (!gun) this.guns.set(id, (gun = buildGun(id, this.skin)));
    this.gun = gun;
    this.gunId = id;
    this.holder.add(this.gun.group);
    this.holder.scale.setScalar(SCALE * (SIZES[id] ?? 1));
    this.gun.muzzle.add(this.flash);
    if (this.gun.magazine) this.magRest.copy(this.gun.magazine.position);
    this.raise = 0;
    this.kick = 0;
    this.roll = 0;
    this.flashLife = 0;
    this.flash.visible = false;
    this.swingT = -1;
    this.inspectT = -1;
    if (this.tint) this.tintGun(this.gun);
  }
}

const ZERO = new THREE.Vector3();

/** Three crossed quads with a star texture: reads as a flash from any angle. */
const FLASH_GEOMETRY = mergeGeometries([
  new THREE.PlaneGeometry(0.22, 0.22).rotateY(Math.PI / 2),
  new THREE.PlaneGeometry(0.22, 0.22).rotateY(Math.PI / 2).rotateZ(Math.PI / 2),
  new THREE.PlaneGeometry(0.16, 0.16),
])!.translate(0, 0, -0.06);

let flashTexture: THREE.CanvasTexture | null = null;
function flashMaterial(): THREE.MeshBasicMaterial {
  if (!flashTexture) {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 64;
    const ctx = canvas.getContext('2d')!;
    const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0, 'rgba(255,255,240,1)');
    g.addColorStop(0.25, 'rgba(255,214,120,0.9)');
    g.addColorStop(1, 'rgba(255,140,40,0)');
    ctx.fillStyle = g;
    // A rough star: a soft core plus pointed rays.
    ctx.beginPath();
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * Math.PI * 2;
      const r = i % 2 === 0 ? 32 : 11;
      ctx.lineTo(32 + Math.cos(a) * r, 32 + Math.sin(a) * r);
    }
    ctx.closePath();
    ctx.fill();
    flashTexture = new THREE.CanvasTexture(canvas);
    flashTexture.colorSpace = THREE.SRGBColorSpace;
  }
  return new THREE.MeshBasicMaterial({
    map: flashTexture,
    color: new THREE.Color(3, 2.4, 1.4),
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    toneMapped: false,
  });
}
