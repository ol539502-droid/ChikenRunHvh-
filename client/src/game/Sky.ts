import * as THREE from 'three';
import { mulberry32 } from '@game/shared';

/** Colour at the horizon; fog uses it too, so the ground fades seamlessly into the sky. */
export const HORIZON_COLOR = 0xf1debb;
const ZENITH_COLOR = 0x669fae;
const SUN_COLOR = 0xfff1d6;
/** Where the sunlight comes from (also used for the shadow-casting light). */
export const SUN_DIRECTION = new THREE.Vector3(28, 45, 18).normalize();
const DOME_RADIUS = 300;

const vertexShader = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = position;
    vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    // Push the dome to the far plane so it never hides anything.
    gl_Position = p.xyww;
  }
`;

const fragmentShader = /* glsl */ `
  uniform vec3 zenith;
  uniform vec3 horizon;
  uniform vec3 sunColor;
  uniform vec3 sunDir;
  uniform float time;
  uniform float clouds;
  uniform float grain;
  uniform float haze;
  varying vec3 vDir;

  float hash(vec2 p) {
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
  }

  float noise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
  }

  float fbm(vec2 p) {
    float v = 0.0;
    float a = 0.5;
    for (int i = 0; i < 4; i++) {
      v += a * noise(p);
      p = p * 2.03 + vec2(1.7, 9.2);
      a *= 0.5;
    }
    return v;
  }

  void main() {
    vec3 dir = normalize(vDir);
    float h = max(dir.y, 0.0);
    vec3 col = mix(horizon, zenith, pow(h, 0.5));

    // Soft clouds on a plane high above, thinning out towards the horizon.
    if (clouds > 0.0 && dir.y > 0.0) {
      vec2 uv = dir.xz / (dir.y + 0.12) * 0.9 + vec2(time * 0.006, time * 0.002);
      float n = fbm(uv);
      float cover = smoothstep(0.52, 0.78, n) * clouds * smoothstep(0.0, 0.25, dir.y);
      float shade = 0.82 + 0.18 * smoothstep(0.5, 0.9, fbm(uv * 1.7 + 3.1));
      col = mix(col, vec3(1.0, 0.98, 0.91) * shade * 1.05, cover * 0.9);
    }

    // Sun: a bright disc (bright enough to bloom) inside a warm glow.
    float s = max(dot(dir, sunDir), 0.0);
    col += sunColor * (pow(s, 12.0) * 0.18 + pow(s, 250.0) * 0.9);
    col += sunColor * smoothstep(0.9993, 0.9997, s) * 6.0;

    // Title screen: a soft warm haze along the horizon, and a fine painted grain.
    if (haze > 0.0) col = mix(col, horizon * vec3(1.03, 0.99, 0.94), haze * (1.0 - smoothstep(-0.02, 0.2, dir.y)) * 0.7);
    if (grain > 0.0) col += (hash(floor(gl_FragCoord.xy / 2.0)) - 0.5) * 0.035 * grain;

    gl_FragColor = vec4(col, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

function skyMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      zenith: { value: new THREE.Color(ZENITH_COLOR) },
      horizon: { value: new THREE.Color(HORIZON_COLOR) },
      sunColor: { value: new THREE.Color(SUN_COLOR) },
      sunDir: { value: SUN_DIRECTION.clone() },
      time: { value: 0 },
      clouds: { value: 1 },
      grain: { value: 0 },
      haze: { value: 0 },
    },
    vertexShader,
    fragmentShader,
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
  });
}

/**
 * Gradient sky with a sun and drifting clouds, plus a ring of hazy hills on the horizon.
 * The dome follows the camera; the hills stay put (they're far enough to barely move).
 */
export class Sky {
  readonly root = new THREE.Group();
  private readonly dome: THREE.Mesh;
  private readonly material = skyMaterial();
  private envMaterial: THREE.ShaderMaterial | null = null;
  private readonly disposables: { dispose(): void }[] = [];
  private title = false;
  private cloudAmount = 1;

  constructor(scene: THREE.Scene) {
    this.root.name = 'sky';
    const geometry = new THREE.SphereGeometry(DOME_RADIUS, 32, 16);
    this.dome = new THREE.Mesh(geometry, this.material);
    this.dome.frustumCulled = false;
    this.dome.renderOrder = -1;
    this.disposables.push(geometry, this.material);
    this.root.add(this.dome);
    this.addHills(260, 34, 0.62, 0x8da18d, 11);
    this.addHills(200, 22, 0.42, 0x657e50, 23);
    scene.add(this.root);
  }

  /** A sky-only scene for baking the environment lighting (reflections, ambient light). */
  environmentScene(): THREE.Scene {
    const scene = new THREE.Scene();
    const material = skyMaterial();
    material.uniforms.clouds!.value = 0.6;
    this.envMaterial = material;
    const geometry = new THREE.SphereGeometry(50, 32, 16);
    this.disposables.push(material, geometry);
    scene.add(new THREE.Mesh(geometry, material));
    // A dark-green ground disc, so things are lit a little from below like on real grass.
    const groundGeometry = new THREE.CircleGeometry(49, 24);
    const ground = new THREE.Mesh(groundGeometry, new THREE.MeshBasicMaterial({ color: 0x647044 }));
    this.disposables.push(groundGeometry, ground.material as THREE.Material);
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -2;
    scene.add(ground);
    return scene;
  }

  /** The camera only draws `far` metres: the dome shrinks inside that, and the hills past it hide. */
  setReach(far: number): void {
    this.dome.scale.setScalar(Math.min(1, (far * 0.9) / DOME_RADIUS));
    for (const o of this.root.children) if (o !== this.dome) o.visible = far > DOME_RADIUS;
  }

  /** The title screen's sky: grain and horizon haze on (it has painted clouds of its own). */
  setTitle(on: boolean): void {
    this.title = on;
    this.material.uniforms.grain!.value = on ? 1 : 0;
    this.material.uniforms.haze!.value = on ? 1 : 0;
    this.setClouds(this.cloudAmount);
  }

  setClouds(amount: number): void {
    this.cloudAmount = amount;
    // The title screen paints its own clouds: the noise clouds are hidden there, but stay in the
    // baked lighting, so everything (the chicken too) is lit exactly as before.
    this.material.uniforms.clouds!.value = this.title ? 0 : amount;
    if (this.envMaterial) this.envMaterial.uniforms.clouds!.value = amount * 0.6;
  }

  /** Sky gradient colours (the environment lighting needs re-baking afterwards). */
  setColors(zenith: string, horizon: string): void {
    for (const m of [this.material, this.envMaterial]) {
      if (!m) continue;
      (m.uniforms.zenith!.value as THREE.Color).set(zenith);
      (m.uniforms.horizon!.value as THREE.Color).set(horizon);
    }
  }

  update(camera: THREE.Camera, dt: number): void {
    this.dome.position.copy(camera.position);
    this.material.uniforms.time!.value += dt;
  }

  dispose(): void {
    this.root.removeFromParent();
    for (const d of this.disposables) d.dispose();
  }

  /**
   * A closed ring of rolling hills at `radius`. They ignore the fog (they're far past it) and
   * instead get their haze baked into the vertex colours: bluer and paler near the base.
   */
  private addHills(radius: number, maxHeight: number, haze: number, color: number, seed: number): void {
    const rand = mulberry32(seed);
    const segments = 96;
    // Smooth random heights: a few random sine waves around the circle.
    const waves = Array.from({ length: 4 }, (_, i) => ({ freq: 2 + i * 3 + Math.floor(rand() * 3), phase: rand() * Math.PI * 2, amp: (0.6 / (i + 1)) * (0.7 + rand() * 0.6) }));
    const positions: number[] = [];
    const colors: number[] = [];
    const base = new THREE.Color(color);
    const horizon = new THREE.Color(HORIZON_COLOR);
    const top = base.clone().lerp(horizon, haze);
    const bottom = base.clone().lerp(horizon, Math.min(1, haze + 0.3));
    for (let i = 0; i <= segments; i++) {
      const a = (i / segments) * Math.PI * 2;
      let hgt = 0.45;
      for (const w of waves) hgt += Math.sin(a * w.freq + w.phase) * w.amp * 0.5;
      hgt = Math.max(0.12, hgt) * maxHeight;
      const x = Math.cos(a) * radius;
      const z = Math.sin(a) * radius;
      positions.push(x, -4, z, x, hgt, z);
      colors.push(bottom.r, bottom.g, bottom.b, top.r, top.g, top.b);
    }
    const index: number[] = [];
    for (let i = 0; i < segments; i++) {
      const a = i * 2;
      index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    geometry.setIndex(index);
    const material = new THREE.MeshBasicMaterial({ vertexColors: true, fog: false, side: THREE.DoubleSide });
    this.disposables.push(geometry, material);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.renderOrder = -0.5;
    this.root.add(mesh);
  }
}
