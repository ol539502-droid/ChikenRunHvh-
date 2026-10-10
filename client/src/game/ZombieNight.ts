import * as THREE from 'three';
import type { AudioEngine } from './Audio';
import type { RemotePlayers } from './RemotePlayers';

/** Zombie sounds are heard this far (the fog hides them sooner: you hear them first). */
const GROAN_RANGE = 42;
const STEP_RANGE = 20;
/** A zombie screeches when it first gets this close (it has seen you). */
const SPOT_RANGE = 18;
/** Never two screeches or groans on top of each other (no sudden loud stacks). */
const SCREECH_GAP = 2.5;
const GROAN_GAP = 0.6;

interface Heard {
  nextGroan: number;
  nextStep: number;
  screeched: boolean;
  last: THREE.Vector3;
}

/**
 * The Zombie Apocalypse night, on this computer only: your flashlight (T), and the sounds of
 * the dark: groans that get louder as zombies come closer, their footsteps, a screech when one
 * spots you, wind, distant clucks and creaking wood. All of it is quiet next to the guns.
 */
export class ZombieNight {
  private readonly light = new THREE.SpotLight(0xfff1d6, 0, 34, 0.46, 0.55, 1.5);
  private on = true;
  private time = 0;
  private readonly heard = new Map<number, Heard>();
  private lastScreech = -Infinity;
  private lastGroan = -Infinity;
  private nextWind = 0;
  private nextCluck = 6;
  private nextCreak = 4;
  private readonly ahead = new THREE.Vector3();

  constructor(
    private readonly scene: THREE.Scene,
    private readonly camera: THREE.Camera,
    private readonly audio: AudioEngine,
  ) {
    // The light is always in the scene (switching it off only dims it), so turning it on and
    // off never makes the graphics card rebuild its shaders.
    scene.add(this.light, this.light.target);
  }

  get flashlightOn(): boolean {
    return this.on;
  }

  toggleFlashlight(): void {
    this.on = !this.on;
    this.audio.play('click', undefined, 0.5);
  }

  update(dt: number, remotes: RemotePlayers): void {
    this.time += dt;
    const cam = this.camera;
    // The flashlight: at your eyes, a little to the right, pointing where you look.
    this.ahead.set(0.25, -0.2, 0).applyQuaternion(cam.quaternion);
    this.light.position.copy(cam.position).add(this.ahead);
    cam.getWorldDirection(this.ahead);
    this.light.target.position.copy(cam.position).addScaledVector(this.ahead, 10);
    this.light.intensity = THREE.MathUtils.damp(this.light.intensity, this.on ? 22 : 0, 18, dt);

    this.zombieSounds(remotes);
    this.ambience();
  }

  private zombieSounds(remotes: RemotePlayers): void {
    const t = this.time;
    const ear = this.camera.position;
    for (const [pid, r] of remotes.players) {
      const kind = r.info.undead;
      if (!kind) continue;
      let h = this.heard.get(pid);
      if (!h) this.heard.set(pid, (h = { nextGroan: t + Math.random() * 3, nextStep: 0, screeched: false, last: r.position.clone() }));
      if (!r.alive || r.culled) {
        h.screeched = false;
        continue;
      }
      const at = r.position;
      const dist = at.distanceTo(ear);
      const moved = Math.hypot(at.x - h.last.x, at.z - h.last.z);
      h.last.copy(at);
      const big = kind === 'brute' || kind === 'boss';
      if (dist < SPOT_RANGE && !h.screeched) {
        h.screeched = true;
        if (t - this.lastScreech > SCREECH_GAP) {
          this.lastScreech = t;
          this.audio.play(big ? 'groan' : 'screech', at, big ? 1.1 : 0.7);
        }
      } else if (dist > SPOT_RANGE * 1.8) h.screeched = false;
      if (dist < GROAN_RANGE && t >= h.nextGroan && t - this.lastGroan > GROAN_GAP) {
        h.nextGroan = t + 3.5 + Math.random() * 5;
        this.lastGroan = t;
        this.audio.play('groan', at, big ? 0.9 : 0.6);
      }
      if (dist < STEP_RANGE && moved > 0.01 && t >= h.nextStep) {
        h.nextStep = t + (kind === 'sprinter' || kind === 'runner' ? 0.26 : big ? 0.62 : 0.48);
        this.audio.play('zstep', at, big ? 0.7 : 0.45);
      }
    }
    for (const pid of this.heard.keys()) if (!remotes.players.has(pid)) this.heard.delete(pid);
  }

  /** Wind all the time; now and then a cluck far away or wood creaking somewhere near. */
  private ambience(): void {
    const t = this.time;
    const ear = this.camera.position;
    const around = (min: number, max: number) => {
      const a = Math.random() * Math.PI * 2;
      const d = min + Math.random() * (max - min);
      return { x: ear.x + Math.cos(a) * d, y: 1, z: ear.z + Math.sin(a) * d };
    };
    if (t >= this.nextWind) {
      this.nextWind = t + 3 + Math.random() * 1.5;
      this.audio.play('wind', undefined, 0.22);
    }
    if (t >= this.nextCluck) {
      this.nextCluck = t + 10 + Math.random() * 14;
      this.audio.play('cluck', around(35, 55), 0.9);
    }
    if (t >= this.nextCreak) {
      this.nextCreak = t + 7 + Math.random() * 10;
      this.audio.play('creak', around(12, 28), 0.8);
    }
  }

  dispose(): void {
    this.scene.remove(this.light, this.light.target);
    this.light.dispose();
  }
}
