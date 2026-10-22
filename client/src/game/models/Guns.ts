import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { WEAPONS, getItem, type WeaponId } from '@game/shared';

export interface GunModel {
  group: THREE.Group;
  /** Where bullets visually leave the barrel. */
  muzzle: THREE.Object3D;
  /** Spinning barrel cluster (minigun only). */
  spinner: THREE.Object3D | null;
  /** The part that comes out during a reload (magazine or rocket), or null. */
  magazine: THREE.Object3D | null;
  /** The second gun or dagger of a pair, in the left hand (first person only). */
  offhand: THREE.Object3D | null;
  /** Moving parts for the inspect (F): called with its progress 0..1, or -1 to rest. */
  animate: ((progress: number) => void) | null;
  /** The part that cycles when it fires (slide, bolt or charging handle, pump, revolver cylinder), or null. */
  action: GunAction | null;
  /** Where spent cases come out (the ejection port), or null if it keeps them (revolver, launchers). */
  ejection: THREE.Object3D | null;
}

/**
 * How a gun cycles. `slide` and `bolt`: snap back `travel` metres and return with every shot.
 * `pump`: racked back and forward after the shot. `boltAction`: lifted, drawn back and pushed home
 * after the shot. `cylinder`: turns `travel` radians per shot.
 */
export interface GunAction {
  part: THREE.Object3D;
  kind: 'slide' | 'bolt' | 'pump' | 'boltAction' | 'cylinder';
  travel: number;
  /** Where the part rests (it's put back there each frame). */
  rest: THREE.Vector3;
  restRotation: THREE.Euler;
}

// ---------------------------------------------------------------------------
// Materials (shared by every gun of the same kind)
// ---------------------------------------------------------------------------

const materials = new Map<string, THREE.MeshStandardMaterial>();
function material(key: string, make: () => THREE.MeshStandardMaterial): THREE.MeshStandardMaterial {
  let m = materials.get(key);
  if (!m) materials.set(key, (m = make()));
  return m;
}

/** Brushed metal: fine lengthwise streaks and a few scratches (colour and roughness). */
const metal = (color: number, roughness = 0.34) =>
  material(`metal:${color}:${roughness}`, () => worn(new THREE.MeshStandardMaterial({ color, metalness: 0.8, roughness, map: tex('brushed'), roughnessMap: tex('brushedRough'), normalMap: normalTex('brushedRough', 0.5) }), 0xb4b8be, 0.85, true));
/** Polymer: a fine stippled grain, slightly bumpy. */
const polymer = (color: number, roughness = 0.68) =>
  material(`poly:${color}:${roughness}`, () => worn(new THREE.MeshStandardMaterial({ color, metalness: 0.05, roughness, map: tex('stipple'), normalMap: normalTex('stippleBump', 1.6) }), new THREE.Color(color).lerp(new THREE.Color(0x9a9890), 0.45).getHex(), 0.55, false));
/** Grip panels and knife handles: diamond knurling you can see. */
const grippy = (color: number) =>
  material(`grip:${color}`, () => worn(new THREE.MeshStandardMaterial({ color, metalness: 0.05, roughness: 0.82, map: tex('knurl'), normalMap: normalTex('knurlBump', 3) }), 0x55575a, 0.4, false));
const GOLD = () => material('gold', () => worn(new THREE.MeshStandardMaterial({ color: 0xe8b93e, metalness: 1, roughness: 0.22, map: tex('brushed'), roughnessMap: tex('brushedRough'), normalMap: normalTex('brushedRough', 0.5) }), 0xfff0b8, 0.7, true));
const BRASS = () => metal(0xc9a33a, 0.3);
const STEEL = () => metal(0x2b2e33);
const DARK = () => metal(0x141619, 0.42);
const RUBBER = () => grippy(0x18191b);
const GLASS = () =>
  material('glass', () => new THREE.MeshStandardMaterial({ color: 0x0a2440, metalness: 0.9, roughness: 0.04, emissive: 0x0b3a66, emissiveIntensity: 0.55 }));
const WOOD = () => material('wood', () => worn(new THREE.MeshStandardMaterial({ map: woodTexture(), roughness: 0.58, metalness: 0, normalMap: normalTex('wood', 0.7) }), 0xa8774a, 0.6, false));

/**
 * Worn edges: where the surface bends sharply (bevels, corners, edges of slides and stocks) the
 * finish has rubbed through to `bare` (polished metal on a gun, paler on polymer and wood). The
 * bend is measured from the geometry's normals in the shader, so no geometry needs extra data,
 * and broken up by the colour map's own grain.
 */
function worn<T extends THREE.MeshStandardMaterial>(m: T, bare: number, amount: number, metallic: boolean): T {
  m.userData.wear = { bare, amount, metallic };
  m.onBeforeCompile = (shader) => {
    shader.uniforms.wearColor = { value: new THREE.Color(bare) };
    shader.uniforms.wearAmount = { value: amount };
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform vec3 wearColor;\nuniform float wearAmount;')
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        {
          vec3 bendN = normalize(vNormal);
          float bend = length(fwidth(bendN)) / max(length(fwidth(vViewPosition)), 1e-6);
          float grain = diffuseColor.g / max(diffuseColor.r + diffuseColor.g + diffuseColor.b, 1e-3) * 3.0;
          float edge = smoothstep(150.0, 420.0, bend) * wearAmount * clamp(grain * 1.4 - 0.2, 0.35, 1.0);
          diffuseColor.rgb = mix(diffuseColor.rgb, wearColor, edge);
          roughnessFactor = mix(roughnessFactor, 0.28, edge);
          ${metallic ? 'metalnessFactor = mix(metalnessFactor, 1.0, edge);' : ''}
        }`);
  };
  m.customProgramCacheKey = () => `gunwear:${metallic}`;
  return m;
}

/** A tangent-space normal map from a height texture (red channel), so stipple, knurling and grain catch the light. */
const normals = new Map<string, THREE.CanvasTexture>();
function normalTex(kind: TexKind | 'wood', strength: number): THREE.CanvasTexture {
  const key = `${kind}:${strength}`;
  let t = normals.get(key);
  if (t) return t;
  const source = (kind === 'wood' ? woodTexture() : tex(kind)).image as HTMLCanvasElement;
  const W = source.width, H = source.height;
  const src = source.getContext('2d')!.getImageData(0, 0, W, H).data;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d')!;
  const out = ctx.createImageData(W, H);
  const at = (x: number, y: number) => src[(((y + H) % H) * W + ((x + W) % W)) * 4]! / 255;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const nx = (at(x - 1, y) - at(x + 1, y)) * strength, ny = (at(x, y + 1) - at(x, y - 1)) * strength;
    const len = Math.hypot(nx, ny, 1);
    const i = (y * W + x) * 4;
    out.data[i] = (nx / len * 0.5 + 0.5) * 255;
    out.data[i + 1] = (ny / len * 0.5 + 0.5) * 255;
    out.data[i + 2] = (1 / len * 0.5 + 0.5) * 255;
    out.data[i + 3] = 255;
  }
  ctx.putImageData(out, 0, 0);
  t = new THREE.CanvasTexture(canvas);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  if (kind !== 'wood') t.repeat.set(2, 2);
  t.anisotropy = 4;
  normals.set(key, t);
  return t;
}

// ---------------------------------------------------------------------------
// Surface textures (small, drawn once on a canvas, shared by every gun)
// ---------------------------------------------------------------------------

type TexKind = 'brushed' | 'brushedRough' | 'stipple' | 'stippleBump' | 'knurl' | 'knurlBump' | 'blade' | 'bladeRough';
const textures = new Map<TexKind, THREE.CanvasTexture>();

/** A repeatable random generator, so every texture looks the same every time. */
function seeded(seed: number): () => number {
  return () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
}

function tex(kind: TexKind): THREE.CanvasTexture {
  let t = textures.get(kind);
  if (t) return t;
  const blade = kind === 'blade' || kind === 'bladeRough';
  const canvas = document.createElement('canvas');
  // (256 for the surfaces: twice the old detail, still tiny.)
  canvas.width = 256;
  canvas.height = blade ? 64 : 256;
  const ctx = canvas.getContext('2d')!;
  const W = canvas.width;
  const H = canvas.height;
  const rand = seeded(kind.length * 977 + 13);
  const gray = (v: number, a = 1) => `rgba(${v},${v},${v},${a})`;
  switch (kind) {
    case 'brushed':
    case 'brushedRough': {
      // Colour: near white (it tints the material colour). Roughness: mid grey, streaks vary it.
      const rough = kind === 'brushedRough';
      ctx.fillStyle = gray(rough ? 150 : 236);
      ctx.fillRect(0, 0, W, H);
      for (let y = 0; y < H; y++) {
        ctx.fillStyle = gray(rough ? 110 + rand() * 90 : 205 + rand() * 50, 0.55);
        ctx.fillRect(0, y, W, 1);
      }
      for (let i = 0; i < 60; i++) {
        ctx.strokeStyle = gray(rough ? 70 : 255, rough ? 0.8 : 0.6);
        ctx.lineWidth = 0.5 + rand() * 0.6;
        const x = rand() * W;
        const y = rand() * H;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x + 10 + rand() * 40, y + (rand() - 0.5) * 10);
        ctx.stroke();
      }
      // Wear: bright flecks where the finish has rubbed off (smoother there), and darker grime.
      for (let i = 0; i < 220; i++) {
        const r = 0.6 + rand() * 1.8;
        ctx.fillStyle = rand() < 0.7 ? gray(rough ? 60 : 255, 0.5) : gray(rough ? 200 : 150, 0.35);
        ctx.beginPath();
        ctx.arc(rand() * W, rand() * H, r, 0, Math.PI * 2);
        ctx.fill();
      }
      break;
    }
    case 'stipple':
    case 'stippleBump': {
      const bump = kind === 'stippleBump';
      ctx.fillStyle = gray(bump ? 128 : 232);
      ctx.fillRect(0, 0, W, H);
      // A mottled finish (Cerakote-like blotches), then the stipple, then light scuffs.
      if (!bump) for (let i = 0; i < 60; i++) {
        const x = rand() * W, y = rand() * H, r = 12 + rand() * 30;
        const blob = ctx.createRadialGradient(x, y, 0, x, y, r);
        blob.addColorStop(0, gray(rand() < 0.5 ? 205 : 255, 0.28));
        blob.addColorStop(1, gray(232, 0));
        ctx.fillStyle = blob;
        ctx.fillRect(x - r, y - r, r * 2, r * 2);
      }
      for (let i = 0; i < 10400; i++) {
        const v = rand() < 0.5 ? (bump ? 90 : 205) : bump ? 175 : 250;
        ctx.fillStyle = gray(v, 0.7);
        ctx.fillRect(rand() * W, rand() * H, 1.2, 1.2);
      }
      for (let i = 0; i < 24; i++) {
        ctx.strokeStyle = gray(bump ? 150 : 255, bump ? 0.6 : 0.45);
        ctx.lineWidth = 0.6;
        const x = rand() * W, y = rand() * H;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x + (rand() - 0.5) * 30, y + (rand() - 0.5) * 30);
        ctx.stroke();
      }
      break;
    }
    case 'knurl':
    case 'knurlBump': {
      // Diamond knurling: two sets of diagonal grooves.
      const bump = kind === 'knurlBump';
      ctx.fillStyle = gray(bump ? 200 : 236);
      ctx.fillRect(0, 0, W, H);
      ctx.strokeStyle = gray(bump ? 40 : 150, bump ? 1 : 0.8);
      ctx.lineWidth = 2;
      for (let i = -H; i < W + H; i += 10) {
        ctx.beginPath();
        ctx.moveTo(i, 0);
        ctx.lineTo(i + H, H);
        ctx.moveTo(i, H);
        ctx.lineTo(i + H, 0);
        ctx.stroke();
      }
      break;
    }
    case 'blade':
    case 'bladeRough': {
      // Across the blade (v 0 = the cutting edge, 1 = the spine): a mirror-polished edge bevel,
      // a sharp grind line, satin flats with a fuller groove, and a darker spine.
      const rough = kind === 'bladeRough';
      const bands: [number, number][] = rough
        ? [[0, 40], [0.3, 40], [0.31, 200], [0.32, 120], [0.58, 120], [0.6, 200], [0.68, 200], [0.7, 120], [0.92, 120], [1, 170]]
        : [[0, 255], [0.28, 238], [0.3, 120], [0.32, 205], [0.58, 200], [0.6, 150], [0.68, 165], [0.7, 210], [0.92, 196], [1, 140]];
      const g = ctx.createLinearGradient(0, H, 0, 0);
      for (const [at, v] of bands) g.addColorStop(at, gray(v));
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);
      // Brushed lengthwise.
      for (let y = 0; y < H; y++) {
        ctx.fillStyle = gray(rough ? 90 + rand() * 80 : 150 + rand() * 105, 0.18);
        ctx.fillRect(0, y, W, 1);
      }
      break;
    }
  }
  t = new THREE.CanvasTexture(canvas);
  // Colour maps are sRGB; roughness and bump maps are plain data.
  if (kind === 'brushed' || kind === 'stipple' || kind === 'knurl' || kind === 'blade') t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  if (!blade) t.repeat.set(2, 2);
  t.anisotropy = 4;
  textures.set(kind, t);
  return t;
}

/** Walnut with a long grain, drawn once. */
let walnut: THREE.CanvasTexture | null = null;
function woodTexture(): THREE.CanvasTexture {
  if (walnut) return walnut;
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 64;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#6e4122';
  ctx.fillRect(0, 0, 256, 64);
  for (let i = 0; i < 70; i++) {
    const y = (i * 37) % 64;
    ctx.strokeStyle = i % 3 === 0 ? 'rgba(40, 20, 8, 0.45)' : 'rgba(150, 95, 50, 0.35)';
    ctx.lineWidth = 0.6 + (i % 4) * 0.4;
    ctx.beginPath();
    ctx.moveTo(0, y);
    for (let x = 0; x <= 256; x += 16) ctx.lineTo(x, y + Math.sin(x * 0.03 + i) * 2.5);
    ctx.stroke();
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  return (walnut = texture);
}

// ---------------------------------------------------------------------------
// Geometry kit (cached, all guns point down -Z with the grip at the origin)
// ---------------------------------------------------------------------------

const geometries = new Map<string, THREE.BufferGeometry>();
function geometry(key: string, make: () => THREE.BufferGeometry): THREE.BufferGeometry {
  let g = geometries.get(key);
  if (!g) geometries.set(key, (g = make()));
  return g;
}

/** Box with softened edges. */
const rbox = (w: number, h: number, d: number, r = Math.min(w, h, d) * 0.22) => geometry(`rb:${w}:${h}:${d}:${r}`, () => new RoundedBoxGeometry(w, h, d, 2, r));
const box = (w: number, h: number, d: number) => geometry(`b:${w}:${h}:${d}`, () => new THREE.BoxGeometry(w, h, d));
/** Cylinder along Z. `back` and `front` radii may differ (tapers). */
const tube = (front: number, length: number, back = front, segments = 14) =>
  geometry(`t:${front}:${back}:${length}:${segments}`, () => new THREE.CylinderGeometry(back, front, length, segments).rotateX(Math.PI / 2));
/** Upright cylinder (turrets, knobs). */
const post = (r: number, h: number) => geometry(`p:${r}:${h}`, () => new THREE.CylinderGeometry(r, r, h, 10));
/** Flat disc facing +Z (lenses, bores). */
const disc = (r: number) => geometry(`d:${r}`, () => new THREE.CircleGeometry(r, 18));
/** Ring around Z, or an arc of one. */
const ring = (r: number, t: number, arc = Math.PI * 2) => geometry(`r:${r}:${t}:${arc}`, () => new THREE.TorusGeometry(r, t, 6, 18, arc));
const ball = (r: number) => geometry(`s:${r}`, () => new THREE.SphereGeometry(r, 10, 8));
/**
 * Removes zero-area triangles, which have no normal. Shaded, a zero normal gives NaN, and on High
 * quality the bloom blurs one NaN pixel over the whole screen (the Shadow Daggers' short, wide
 * bevelled tip made 14 of them: the screen flashed blue as they swung). They are invisible anyway.
 */
function dropFlatTriangles(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const normal = g.getAttribute('normal');
  if (g.index || !normal) return g;
  const keep: number[] = [];
  const ok = (i: number) => Math.hypot(normal.getX(i), normal.getY(i), normal.getZ(i)) > 1e-6;
  for (let t = 0; t < normal.count; t += 3) if (ok(t) && ok(t + 1) && ok(t + 2)) keep.push(t, t + 1, t + 2);
  if (keep.length === normal.count) return g;
  const out = new THREE.BufferGeometry();
  for (const [name, attr] of Object.entries(g.attributes)) {
    const size = attr.itemSize;
    const data = new Float32Array(keep.length * size);
    keep.forEach((v, i) => { for (let k = 0; k < size; k++) data[i * size + k] = attr.array[v * size + k]!; });
    out.setAttribute(name, new THREE.BufferAttribute(data, size));
  }
  g.dispose();
  return out;
}

/**
 * A flat blade pointing down -Z from z = 0 (the guard): edge below, spine above, sweeping up to
 * the tip. `curve` bends the whole blade upwards (a katana's curve). Thickness is along X.
 */
export const blade = (length: number, height: number, thickness: number, curve = 0) =>
  geometry(`bl:${length}:${height}:${thickness}:${curve}`, () => {
    const L = length;
    const h = height / 2;
    const c = curve;
    const shape = new THREE.Shape();
    shape.moveTo(0, -h);
    shape.quadraticCurveTo(L * 0.5, -h + c, L * 0.8, -h + c * 1.6);
    shape.quadraticCurveTo(L * 0.96, -h + c * 2 + height * 0.15, L, height * 0.3 + c * 2);
    shape.lineTo(L * 0.86, h + c * 1.8);
    shape.quadraticCurveTo(L * 0.5, h + c, 0, h);
    shape.closePath();
    const bevel = thickness * 0.35;
    const g = dropFlatTriangles(new THREE.ExtrudeGeometry(shape, { depth: thickness - bevel * 2, bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 1, curveSegments: 8 }));
    // u along the blade (0 at the guard), v across it (0 at the edge): the blade texture's polished
    // edge and fuller then sit in the same place on every blade.
    g.computeBoundingBox();
    const bb = g.boundingBox!;
    const pos = g.getAttribute('position');
    const uv = g.getAttribute('uv');
    for (let i = 0; i < pos.count; i++) uv.setXY(i, (pos.getX(i) - bb.min.x) / (bb.max.x - bb.min.x), (pos.getY(i) - bb.min.y) / (bb.max.y - bb.min.y));
    uv.needsUpdate = true;
    g.translate(0, 0, -(thickness - bevel * 2) / 2);
    return g.rotateY(Math.PI / 2);
  });

/**
 * Extruded shapes get texture coordinates in metres; box parts stretch a texture over each face.
 * This scales the first to match the second (about one texture per 25 cm), so the grain is the
 * same size on every part.
 */
function metresToUv(g: THREE.BufferGeometry): void {
  const uv = g.getAttribute('uv');
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * 4, uv.getY(i) * 4);
  uv.needsUpdate = true;
}

/**
 * A part cut from a side outline, like a gun drawn from the side: `points` are [forward, up]
 * in metres (forward is towards the muzzle, -Z), extruded `width` wide across X with softened
 * edges. Used for slides, receivers, stocks and grips, so guns have real outlines, not boxes.
 */
const profile = (key: string, points: readonly (readonly [number, number])[], width: number, soft = 0.004) =>
  geometry(`pf:${key}:${width}`, () => {
    const shape = new THREE.Shape();
    points.forEach(([x, y], i) => (i === 0 ? shape.moveTo(x, y) : shape.lineTo(x, y)));
    shape.closePath();
    const depth = Math.max(0.001, width - soft * 2);
    const g = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: true, bevelThickness: soft, bevelSize: soft, bevelSegments: 2, curveSegments: 4 });
    g.translate(0, 0, -depth / 2);
    metresToUv(g);
    // Extrusion depth becomes the width (X); the drawing's x becomes forward (-Z).
    return g.rotateY(Math.PI / 2);
  });

/** An assault-rifle magazine: one curved piece, 0.04 wide, hanging down and sweeping forward. */
const curvedMag = () =>
  geometry('curvedmag', () => {
    // Drawn side on: x = forward (towards -Z), y = up. Front and back edges both curve forward.
    const shape = new THREE.Shape();
    shape.moveTo(-0.032, 0);
    shape.quadraticCurveTo(-0.034, -0.1, 0.046, -0.17);
    shape.lineTo(0.112, -0.15);
    shape.quadraticCurveTo(0.04, -0.09, 0.032, 0);
    shape.closePath();
    const g = new THREE.ExtrudeGeometry(shape, { depth: 0.032, bevelEnabled: true, bevelThickness: 0.004, bevelSize: 0.004, bevelSegments: 2, curveSegments: 10 });
    g.translate(0, 0, -0.016);
    metresToUv(g);
    // Extrusion depth becomes the width (X); the drawing's x becomes forward (-Z).
    return g.rotateY(Math.PI / 2);
  });

function add(parent: THREE.Object3D, geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0): THREE.Mesh {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  m.rotation.set(rx, ry, rz);
  m.castShadow = true;
  parent.add(m);
  return m;
}

/** Trigger guard (a half ring under the receiver) and trigger. */
function trigger(g: THREE.Object3D, mat: THREE.Material, z: number, y = 0.012, r = 0.022): void {
  add(g, ring(r, 0.0035, Math.PI), mat, 0, y, z, 0, Math.PI / 2, Math.PI);
  add(g, box(0.006, 0.018, 0.006), DARK(), 0, y - 0.006, z + 0.004, 0.35);
}

/** Pistol grip, raked back like a real one. */
function grip(g: THREE.Object3D, mat: THREE.Material, z: number, h = 0.095, rake = 0.28): void {
  const t = h / 2;
  const outline: [number, number][] = [
    [-0.022, t], [0.022, t], [0.024, t * 0.62], [0.019, t * 0.42], [0.025, t * 0.18], [0.019, -t * 0.04],
    [0.025, -t * 0.28], [0.019, -t * 0.5], [0.023, -t * 0.78], [0.02, -t], [-0.024, -t], [-0.027, -t * 0.4], [-0.025, t * 0.5],
  ];
  add(g, profile(`grip:${h}`, outline, 0.034), mat, 0, -0.03, z, rake);
  // Rubbery side panels.
  add(g, rbox(0.037, h * 0.62, 0.032), RUBBER(), 0, -0.032, z + 0.002, rake);
}

// ---------------------------------------------------------------------------
// The guns
// ---------------------------------------------------------------------------

interface Build {
  muzzle: THREE.Vector3;
  spinner?: THREE.Object3D;
  magazine?: THREE.Object3D;
  /** Overall size multiplier, so third-person proportions stay as before. */
  scale?: number;
  offhand?: THREE.Object3D;
  animate?: (progress: number) => void;
  action?: { part: THREE.Object3D; kind: GunAction['kind']; travel: number };
  /** The ejection port, in the builder's coordinates. */
  ejection?: THREE.Vector3;
}

type Builder = (g: THREE.Group, id: WeaponId) => Build;


/** Assault-rifle family: Rifle and Golden Rifle. */
function rifleLike(body: THREE.Material, accent: THREE.Material, gold: boolean): Builder {
  return (g) => {
    add(g, profile('rifle:receiver', [[-0.07, 0.102], [0.27, 0.102], [0.27, 0.035], [0.19, 0.03], [0.182, -0.02], [0.082, -0.02], [0.074, 0.02], [0.0, 0.02], [-0.05, 0.028], [-0.07, 0.05]], 0.064), body, 0, 0, 0);
    // Picatinny rail with teeth.
    add(g, box(0.028, 0.012, 0.3), accent, 0, 0.108, -0.12);
    for (let i = 0; i < 10; i++) add(g, box(0.032, 0.006, 0.01), accent, 0, 0.116, -0.25 + i * 0.028);
    // Handguard with cooling slots.
    add(g, profile('rifle:handguard', [[0.27, 0.094], [0.53, 0.088], [0.535, 0.03], [0.27, 0.024]], 0.07, 0.006), body, 0, 0, 0);
    for (let i = 0; i < 4; i++) add(g, box(0.073, 0.012, 0.034), DARK(), 0, 0.06, -0.33 - i * 0.05);
    add(g, tube(0.011, 0.2), DARK(), 0, 0.064, -0.62);
    add(g, rbox(0.022, 0.03, 0.025), accent, 0, 0.07, -0.55);
    add(g, box(0.006, 0.05, 0.012), accent, 0, 0.1, -0.55);
    add(g, tube(0.017, 0.05), DARK(), 0, 0.064, -0.735);
    for (const s of [-1, 1]) add(g, box(0.008, 0.008, 0.03), polymer(0x050505), s * 0.015, 0.064, -0.735);
    add(g, rbox(0.03, 0.025, 0.03), accent, 0, 0.125, 0.03);
    add(g, box(0.02, 0.01, 0.03), accent, 0, 0.104, 0.05);
    // Ejection port.
    add(g, box(0.003, 0.022, 0.05), DARK(), 0.034, 0.07, -0.07);
    // Curved magazine.
    const mag = new THREE.Group();
    mag.position.set(0, -0.025, -0.135);
    // One smooth banana magazine, with a base plate.
    add(mag, curvedMag(), gold ? DARK() : accent, 0, 0.01, 0);
    add(mag, rbox(0.046, 0.014, 0.07), DARK(), 0, -0.168, -0.083, 0.42);
    g.add(mag);
    grip(g, gold ? DARK() : polymer(0x1c1d1f), 0.04);
    trigger(g, accent, -0.005, 0.01, 0.024);
    // Stock with cheek riser and rubber butt pad.
    add(g, profile('rifle:stock', [[-0.06, 0.09], [-0.27, 0.083], [-0.275, -0.025], [-0.2, -0.008], [-0.11, 0.02], [-0.06, 0.03]], 0.045), body, 0, 0, 0);
    add(g, rbox(0.05, 0.095, 0.022), RUBBER(), 0, 0.03, 0.28);
    if (gold) {
      // Engraved trim strips.
      for (const s of [-1, 1]) add(g, box(0.002, 0.008, 0.28), metal(0x8a6512, 0.4), s * 0.034, 0.075, -0.1);
    }
    return { muzzle: new THREE.Vector3(0, 0.064, -0.765), magazine: mag, scale: 0.84 };
  };
}






const minigun: Builder = (g, id) => {
  const body = metal(WEAPONS[id].model.color, 0.4);
  add(g, rbox(0.13, 0.13, 0.28), body, 0, 0.02, -0.02);
  add(g, tube(0.05, 0.08), DARK(), 0, 0.02, 0.15);
  const spinner = new THREE.Group();
  spinner.position.set(0, 0.02, -0.16);
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    add(spinner, tube(0.011, 0.55), DARK(), Math.cos(a) * 0.042, Math.sin(a) * 0.042, -0.275);
  }
  add(spinner, tube(0.012, 0.55), STEEL(), 0, 0, -0.275);
  for (const z of [-0.06, -0.3, -0.53]) add(spinner, tube(0.058, 0.012), STEEL(), 0, 0, z);
  g.add(spinner);
  // Carry handle, rear spade grips, ammo box with a feed chute.
  add(g, ring(0.06, 0.009, Math.PI), DARK(), 0, 0.08, -0.02, 0, Math.PI / 2, 0);
  for (const s of [-1, 1]) add(g, rbox(0.025, 0.08, 0.025), RUBBER(), s * 0.05, 0.0, 0.17);
  add(g, rbox(0.08, 0.1, 0.12), polymer(0x3b4030), -0.11, -0.02, 0.0);
  for (let k = 0; k < 3; k++) add(g, box(0.03, 0.012, 0.03), BRASS(), -0.085 + k * 0.012, 0.035 + k * 0.006, -0.03 - k * 0.025, 0, 0, 0.3);
  return { muzzle: new THREE.Vector3(0, 0.02, -0.72), spinner, scale: 1.0 };
};

const rocket: Builder = (g, id) => {
  const body = polymer(WEAPONS[id].model.color, 0.72);
  add(g, tube(0.06, 0.8), body, 0, 0.07, -0.2);
  add(g, tube(0.068, 0.04), DARK(), 0, 0.07, -0.6);
  add(g, tube(0.06, 0.1, 0.085), DARK(), 0, 0.07, 0.25);
  add(g, ring(0.062, 0.004), polymer(0xd9c97a), 0, 0.07, -0.45);
  // The rocket sitting in the tube.
  const warhead = new THREE.Group();
  warhead.position.set(0, 0.07, -0.62);
  add(warhead, tube(0.05, 0.06), polymer(0x56603f), 0, 0, 0);
  add(warhead, geometry('cone:rocket', () => new THREE.ConeGeometry(0.05, 0.13, 14).rotateX(-Math.PI / 2)), polymer(0xb33a2e, 0.5), 0, 0, -0.095);
  g.add(warhead);
  grip(g, polymer(0x1c1d1f), 0.0, 0.09, 0.2);
  trigger(g, DARK(), -0.04, 0.015);
  add(g, rbox(0.03, 0.07, 0.035), polymer(0x1c1d1f), 0, 0.0, -0.26);
  add(g, rbox(0.03, 0.04, 0.08), DARK(), -0.072, 0.12, -0.15);
  add(g, disc(0.012), GLASS(), -0.072, 0.12, -0.191, 0, Math.PI);
  add(g, rbox(0.04, 0.03, 0.12), RUBBER(), 0, 0.01, 0.12);
  return { muzzle: new THREE.Vector3(0, 0.07, -0.74), magazine: warhead, scale: 1.0 };
};

// ---------------------------------------------------------------------------
// Second wave
// ---------------------------------------------------------------------------








/** Crossbow: a wooden stock, metal rail, swept bow limbs with a string, and a bolt ready on the rail. */
const crossbow: Builder = (g) => {
  const wood = WOOD();
  add(g, rbox(0.05, 0.06, 0.5), wood, 0, 0.045, -0.12);
  add(g, box(0.022, 0.012, 0.46), STEEL(), 0, 0.08, -0.16);
  add(g, rbox(0.05, 0.08, 0.22), wood, 0, 0.025, 0.22, 0.12);
  add(g, rbox(0.054, 0.09, 0.02), RUBBER(), 0, 0.012, 0.33, 0.12);
  // Limbs swept back from the riser, and the string from their tips to the latch.
  add(g, rbox(0.05, 0.05, 0.05), DARK(), 0, 0.07, -0.38);
  const tips: [number, number][] = [];
  for (const side of [-1, 1]) {
    const limb = add(g, rbox(0.2, 0.018, 0.026), polymer(0x1c1d1f, 0.5), side * 0.1, 0.07, -0.35, 0, side * 0.32, 0);
    limb.castShadow = true;
    tips.push([side * 0.195, -0.35 + 0.064]);
  }
  for (const [x, z] of tips) {
    const dx = 0 - x;
    const dz = -0.08 - z;
    const len = Math.hypot(dx, dz);
    add(g, box(0.003, 0.003, len), polymer(0xe8e2d0, 0.9), x / 2, 0.08, (z - 0.08) / 2, 0, Math.atan2(dx, dz), 0);
  }
  // The bolt on the rail (it comes off for the reload).
  const bolt = new THREE.Group();
  bolt.position.set(0, 0.092, -0.22);
  add(bolt, tube(0.006, 0.34), WOOD(), 0, 0, 0);
  add(bolt, geometry('cone:bolt', () => new THREE.ConeGeometry(0.012, 0.04, 8).rotateX(-Math.PI / 2)), STEEL(), 0, 0, -0.19);
  for (const r of [0, Math.PI / 2]) add(bolt, box(0.002, 0.024, 0.04), polymer(0xd84343), 0, 0, 0.14, 0, 0, r);
  g.add(bolt);
  add(g, box(0.006, 0.02, 0.01), STEEL(), 0, 0.1, 0.02);
  add(g, ring(0.03, 0.005, Math.PI), STEEL(), 0, 0.04, -0.47, Math.PI, 0, 0);
  trigger(g, STEEL(), 0.05, 0.0);
  return { muzzle: new THREE.Vector3(0, 0.092, -0.43), magazine: bolt, scale: 1.0 };
};

/** Egg launcher: a fat barrel, a pump grip and a revolving drum with eggs in the chambers. */
const launcher: Builder = (g, id) => {
  const body = polymer(WEAPONS[id].model.color, 0.55);
  const dark = polymer(WEAPONS[id].model.accent, 0.6);
  add(g, tube(0.042, 0.32), dark, 0, 0.08, -0.3);
  add(g, tube(0.046, 0.03), body, 0, 0.08, -0.47);
  add(g, disc(0.034), polymer(0x050505), 0, 0.08, -0.486, 0, Math.PI);
  add(g, rbox(0.06, 0.05, 0.12), RUBBER(), 0, 0.02, -0.28);
  const drum = new THREE.Group();
  drum.position.set(0, 0.06, -0.06);
  add(drum, tube(0.075, 0.13), body, 0, 0, 0);
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    const egg = add(drum, ball(0.022), polymer(0xfff3d6, 0.4), Math.cos(a) * 0.05, Math.sin(a) * 0.05, -0.066);
    egg.scale.set(1, 1, 1.3);
  }
  add(drum, tube(0.02, 0.135), dark, 0, 0, 0);
  g.add(drum);
  add(g, rbox(0.04, 0.03, 0.08), dark, 0, 0.145, -0.1);
  add(g, box(0.006, 0.02, 0.006), dark, 0, 0.17, -0.13);
  grip(g, dark, 0.06);
  trigger(g, dark, 0.02, 0.0);
  add(g, rbox(0.05, 0.08, 0.2), body, 0, 0.04, 0.18);
  add(g, rbox(0.055, 0.09, 0.022), RUBBER(), 0, 0.04, 0.28);
  return { muzzle: new THREE.Vector3(0, 0.08, -0.49), magazine: drum, scale: 0.95 };
};

// ---------------------------------------------------------------------------
// Melee (held at the handle, pointing down -Z like the guns)
// ---------------------------------------------------------------------------

/** Blade steel: only half metallic, so it still reads as bright steel without reflections (Low quality). */
const POLISHED = () => material('blade', () => new THREE.MeshStandardMaterial({ color: 0xf2f5f8, metalness: 0.6, roughness: 0.32, map: tex('blade'), roughnessMap: tex('bladeRough') }));
const GOLD_BLADE = () => material('blade:gold', () => new THREE.MeshStandardMaterial({ color: 0xf0c04a, metalness: 0.95, roughness: 0.3, map: tex('blade'), roughnessMap: tex('bladeRough') }));

const knife: Builder = (g, id) => knifeWith(id === 'goldknife' ? GOLD_BLADE() : POLISHED())(g, id);

function knifeWith(bladeMaterial: THREE.Material): Builder {
  return (g, id) => {
  const handle = grippy(WEAPONS[id].model.color);
  add(g, profile('knife:handle', [[0.035, 0.017], [-0.07, 0.016], [-0.075, -0.016], [-0.06, -0.017], [-0.042, -0.012], [-0.024, -0.018], [-0.006, -0.012], [0.012, -0.018], [0.026, -0.011], [0.035, -0.017]], 0.026, 0.005), handle, 0, 0.03, 0);
  for (let i = 0; i < 3; i++) add(g, box(0.028, 0.005, 0.012), RUBBER(), 0, 0.0145, 0.05 - i * 0.028);
  add(g, rbox(0.03, 0.038, 0.012), DARK(), 0, 0.03, 0.08);
  add(g, ring(0.007, 0.0018), STEEL(), 0, 0.03, 0.093, 0, Math.PI / 2);
  add(g, rbox(0.012, 0.06, 0.012), STEEL(), 0, 0.03, -0.04);
  for (const s of [-1, 1]) add(g, ball(0.006), STEEL(), 0, 0.03 + s * 0.03, -0.04);
  add(g, blade(0.17, 0.032, 0.005), bladeMaterial, 0, 0.034, -0.046);
  if (id === 'goldknife') add(g, rbox(0.032, 0.04, 0.014), GOLD(), 0, 0.03, 0.08);
  return { muzzle: new THREE.Vector3(0, 0.04, -0.22), scale: 1.1 };
  };
}

const pan: Builder = (g) => {
  add(g, tube(0.012, 0.2, 0.015), WOOD(), 0, 0.03, -0.03);
  add(g, ring(0.013, 0.003), BRASS(), 0, 0.03, 0.07);
  add(g, tube(0.009, 0.06), metal(0x8d9097, 0.3), 0, 0.03, -0.15);
  // The pan stands on edge, so a swing lands with its flat face. Cast iron: only half metallic,
  // so it isn't a black silhouette without reflections (Low quality).
  const body = material('pan:iron', () => new THREE.MeshStandardMaterial({ color: 0x6a6d74, metalness: 0.45, roughness: 0.5 }));
  add(g, geometry('pan:shell', () => new THREE.CylinderGeometry(0.115, 0.1, 0.03, 30).rotateZ(-Math.PI / 2)), body, 0, 0.03, -0.29);
  add(g, ring(0.112, 0.006), POLISHED(), 0.016, 0.03, -0.29, 0, Math.PI / 2);
  add(g, disc(0.104), polymer(0x3c3d43, 0.36), 0.0152, 0.03, -0.29, 0, Math.PI / 2);
  add(g, ball(0.006), metal(0x8d9097, 0.3), 0.008, 0.045, -0.178);
  add(g, ball(0.006), metal(0x8d9097, 0.3), 0.008, 0.015, -0.178);
  return { muzzle: new THREE.Vector3(0, 0.03, -0.4), scale: 1.05 };
};

const katana: Builder = (g, id) => {
  const wrap = polymer(0x3b3566, 0.8);
  add(g, tube(0.0155, 0.24), polymer(WEAPONS[id].model.color, 0.7), 0, 0.03, 0.08);
  for (let i = 0; i < 7; i++) add(g, ring(0.0158, 0.0026), wrap, 0, 0.03, 0.18 - i * 0.033);
  add(g, tube(0.0168, 0.014), BRASS(), 0, 0.03, 0.205);
  add(g, tube(0.04, 0.008), DARK(), 0, 0.03, -0.044);
  add(g, ring(0.04, 0.0025), BRASS(), 0, 0.03, -0.044);
  add(g, rbox(0.012, 0.03, 0.022), BRASS(), 0, 0.031, -0.059);
  add(g, blade(0.72, 0.03, 0.006, 0.022), POLISHED(), 0, 0.031, -0.07);
  return { muzzle: new THREE.Vector3(0, 0.1, -0.79), scale: 1 };
};

// ---------------------------------------------------------------------------
// Third wave: pistols and CS2-style knives
// ---------------------------------------------------------------------------

/** Smooth 0→1 over [from, to] of the inspect (0 before, 1 after). */
const window01 = (p: number, from: number, to: number) => {
  const k = Math.min(1, Math.max(0, (p - from) / (to - from)));
  return k * k * (3 - 2 * k);
};

/** A pistol magazine that drops out of the grip on reload. */
function pistolMag(g: THREE.Object3D, body: THREE.Material, height = 0.085, z = 0.02): THREE.Group {
  const mag = new THREE.Group();
  mag.position.set(0, -0.078, z);
  add(mag, rbox(0.036, 0.012, 0.05), DARK(), 0, 0, 0);
  add(mag, rbox(0.026, height, 0.034), body, 0, height / 2 + 0.002, -0.008, 0.22);
  g.add(mag);
  return mag;
}






/**
 * Butterfly knife: two handles and the blade, each on its own pin. Inspect: the blade fans round
 * the pin three times while the free handle swings out and back.
 */
const butterfly: Builder = (g, id) => {
  const handleMat = metal(WEAPONS[id].model.color, 0.3);
  const pivotZ = -0.055;
  const handle = (parent: THREE.Object3D, x: number, z: number) => {
    add(parent, rbox(0.011, 0.028, 0.125), handleMat, x, 0, z);
    for (let i = 0; i < 3; i++) add(parent, box(0.0115, 0.012, 0.02), DARK(), x, 0, z - 0.035 + i * 0.035);
  };
  const held = new THREE.Group();
  held.position.set(0, 0.03, 0);
  handle(held, 0.0065, pivotZ + 0.0625);
  add(held, box(0.004, 0.006, 0.022), STEEL(), 0, -0.016, 0.06);
  g.add(held);
  const free = new THREE.Group();
  free.position.set(0, 0.03, pivotZ);
  handle(free, -0.0065, 0.0625);
  g.add(free);
  const swing = new THREE.Group();
  swing.position.set(0, 0.03, pivotZ);
  add(swing, blade(0.15, 0.03, 0.005), POLISHED(), 0, 0.004, -0.004);
  add(swing, post(0.0055, 0.032), STEEL(), 0, 0, 0, 0, 0, Math.PI / 2);
  g.add(swing);
  const animate = (p: number) => {
    const e = p < 0 ? 0 : window01(p, 0.14, 0.86);
    swing.rotation.x = -e * Math.PI * 6;
    free.rotation.x = -(1 - Math.cos(e * Math.PI * 6)) * 0.5 * Math.PI;
  };
  return { muzzle: new THREE.Vector3(0, 0.035, -0.21), scale: 1.1, animate };
};

/** Karambit: a curved claw blade and a finger ring. Inspect: it spins twice around your finger. */
const karambit: Builder = (g, id) => {
  const ringZ = 0.078;
  const spin = new THREE.Group();
  spin.position.set(0, 0.03, ringZ);
  const parts = new THREE.Group();
  parts.position.set(0, -0.03, -ringZ);
  spin.add(parts);
  const handle = polymer(WEAPONS[id].model.color, 0.6);
  add(parts, rbox(0.022, 0.03, 0.095), handle, 0, 0.03, 0.022, 0.16);
  for (let i = 0; i < 3; i++) add(parts, box(0.0225, 0.006, 0.01), RUBBER(), 0, 0.022, 0.0 + i * 0.025, 0.16);
  add(parts, ring(0.021, 0.0055), STEEL(), 0, 0.03, ringZ, 0, Math.PI / 2);
  add(parts, rbox(0.024, 0.034, 0.01), DARK(), 0, 0.034, -0.027);
  add(parts, blade(0.13, 0.03, 0.005, -0.048), POLISHED(), 0, 0.042, -0.03, 0.3);
  g.add(spin);
  const animate = (p: number) => {
    spin.rotation.x = p < 0 ? 0 : -window01(p, 0.2, 0.72) * Math.PI * 4;
  };
  return { muzzle: new THREE.Vector3(0, 0.03, -0.18), scale: 1.15, animate };
};

/** M9 Bayonet: a big clip-point blade with saw teeth, a muzzle ring on the guard. Inspect: a flip toss. */
const m9: Builder = (g, id) => {
  const spin = new THREE.Group();
  spin.position.set(0, 0.03, -0.05);
  const parts = new THREE.Group();
  parts.position.set(0, -0.03, 0.05);
  spin.add(parts);
  const handle = polymer(WEAPONS[id].model.color, 0.75);
  add(parts, rbox(0.026, 0.036, 0.12), handle, 0, 0.03, 0.025);
  for (let i = 0; i < 5; i++) add(parts, box(0.0275, 0.004, 0.008), RUBBER(), 0, 0.0125, 0.068 - i * 0.022);
  add(parts, rbox(0.03, 0.03, 0.022), STEEL(), 0, 0.03, 0.094);
  add(parts, rbox(0.012, 0.075, 0.012), STEEL(), 0, 0.034, -0.04);
  add(parts, ring(0.011, 0.0035), STEEL(), 0, 0.077, -0.04);
  add(parts, blade(0.2, 0.044, 0.006), POLISHED(), 0, 0.036, -0.047);
  for (let i = 0; i < 7; i++) add(parts, box(0.0045, 0.008, 0.008), POLISHED(), 0, 0.058, -0.072 - i * 0.012, Math.PI / 4);
  g.add(spin);
  const animate = (p: number) => {
    const k = p < 0 ? 0 : window01(p, 0.32, 0.6);
    spin.rotation.x = -k * Math.PI * 2;
    spin.position.y = 0.03 + Math.sin(k * Math.PI) * 0.16;
  };
  return { muzzle: new THREE.Vector3(0, 0.04, -0.26), scale: 1.05, animate };
};

/** One push dagger: a T-handle in the fist, the blade sticking out between the fingers. */
function pushDagger(g: THREE.Object3D, id: WeaponId): THREE.Group {
  const d = new THREE.Group();
  d.position.set(0, 0.03, 0);
  add(d, rbox(0.075, 0.024, 0.026), polymer(WEAPONS[id].model.color, 0.55), 0, 0, 0.02);
  add(d, rbox(0.012, 0.018, 0.03), STEEL(), 0, 0, -0.008);
  add(d, blade(0.11, 0.036, 0.005), POLISHED(), 0, 0.002, -0.022);
  g.add(d);
  return d;
}

/** Shadow Daggers: one in each hand. Inspect: both twirl. */
const daggers: Builder = (g, id) => {
  const right = pushDagger(g, id);
  const offhand = new THREE.Group();
  offhand.position.set(-0.62, 0, 0.02);
  const left = pushDagger(offhand, id);
  g.add(offhand);
  const animate = (p: number) => {
    const e = p < 0 ? 0 : window01(p, 0.18, 0.8);
    right.rotation.z = e * Math.PI * 4;
    left.rotation.z = -e * Math.PI * 4;
  };
  return { muzzle: new THREE.Vector3(0, 0.03, -0.14), offhand, scale: 1.1, animate };
};

// ---------------------------------------------------------------------------
// CS2-style guns (all made here, procedurally: outlines, rails, sights, magazines, stocks)
// ---------------------------------------------------------------------------

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

/** A Picatinny rail along Z, from `front` to `back`: a strip with its cross teeth. */
function rail(g: THREE.Object3D, mat: THREE.Material, y: number, front: number, back: number, w = 0.022): void {
  add(g, box(w, 0.006, back - front), mat, 0, y, (front + back) / 2);
  for (let z = front + 0.005; z < back - 0.003; z += 0.01) add(g, box(w + 0.003, 0.005, 0.005), mat, 0, y + 0.005, z);
}

/** Grooves cut across a part (slide serrations, grip ribs): `count` dark slots `step` apart going forward from `z`. */
function serrate(g: THREE.Object3D, width: number, y: number, h: number, z: number, count: number, step = 0.0048): void {
  for (let i = 0; i < count; i++) add(g, box(width + 0.0016, h, 0.0022), DARK(), 0, y, z - i * step);
}

/** A squared trigger guard (modern pistols): the bottom bar and a raked front. */
function squareGuard(g: THREE.Object3D, mat: THREE.Material, back: number, front: number, top: number, depth = 0.03): void {
  add(g, box(0.008, 0.005, back - front), mat, 0, top - depth, (back + front) / 2);
  add(g, box(0.008, depth, 0.006), mat, 0, top - depth / 2, front, 0.2);
  add(g, box(0.005, 0.017, 0.005), DARK(), 0, top - 0.013, front + (back - front) * 0.55, 0.3);
}

/** A telescopic sight from `front` to `back` at height `y`: tube, bells, glass, turrets and two rings on a base. */
function scope(g: THREE.Object3D, y: number, front: number, back: number, objective: number, tube_ = 0.017, base = 0.03): void {
  const s = DARK();
  const len = back - front;
  add(g, tube(tube_, len * 0.62), s, 0, y, front + len * 0.5);
  add(g, tube(objective, len * 0.2, tube_), s, 0, y, front + len * 0.1);
  add(g, tube(tube_ * 1.25, len * 0.16, tube_ * 1.05), s, 0, y, back - len * 0.08);
  add(g, disc(objective * 0.88), GLASS(), 0, y, front - 0.001, 0, Math.PI);
  add(g, disc(tube_ * 1.1), GLASS(), 0, y, back + 0.001);
  add(g, post(tube_ * 0.55, tube_ * 1.5), s, 0, y + tube_ * 1.1, front + len * 0.5);
  add(g, post(tube_ * 0.55, tube_ * 1.4), s, tube_ * 1.15, y, front + len * 0.5, 0, 0, Math.PI / 2);
  for (const z of [front + len * 0.32, front + len * 0.72]) {
    add(g, ring(tube_ * 1.12, 0.004), STEEL(), 0, y, z);
    add(g, box(0.014, y - base - tube_, 0.012), STEEL(), 0, base + (y - base - tube_) / 2, z);
  }
}

/**
 * A pistol slide in its own group (it slides back when firing): the side outline with a bevelled
 * nose, rear serrations, the ejection port on top and the sights. z = 0 is `back` metres in front
 * of the slide's rear face.
 */
function pistolSlide(slide: THREE.Group, o: { key: string; length: number; height: number; width: number; y: number; back: number; nose: number; mat: THREE.Material; rear: number; front?: number }): void {
  const { length: L, height: H, width: W, y, back, nose } = o;
  add(slide, profile(`slide:${o.key}`, [[-back, 0], [-back, H - 0.004], [-back + 0.004, H], [L - back - nose, H], [L - back, H - nose * 0.75], [L - back, 0.004], [L - back - 0.004, 0]], W), o.mat, 0, y, 0);
  serrate(slide, W, y + H * 0.52, H * 0.6, back - 0.006, o.rear);
  if (o.front) serrate(slide, W, y + H * 0.52, H * 0.6, back - L + 0.03, o.front);
  add(slide, box(W * 0.45, 0.003, L * 0.17), DARK(), W * 0.16, y + H + 0.0006, back - L * 0.36);
  for (const s of [-1, 1]) add(slide, box(0.006, 0.008, 0.006), DARK(), s * 0.0065, y + H + 0.004, back - 0.012);
  add(slide, box(0.004, 0.007, 0.005), DARK(), 0, y + H + 0.0035, back - L + 0.014);
}

/** Polymer pistol frame: the dust cover with an accessory rail, down into the grip. */
function pistolFrame(g: THREE.Object3D, key: string, mat: THREE.Material, front: number, width = 0.031, top = 0.052): void {
  add(g, profile(`frame:${key}`, [[-0.034, top], [front, top], [front + 0.003, top - 0.008], [front, 0.026], [front - 0.075, 0.024], [0.075, 0.016], [0.02, 0.016], [0.0, 0.03], [-0.034, 0.03]], width), mat, 0, 0, 0);
  for (let i = 0; i < 3; i++) add(g, box(width + 0.002, 0.004, 0.005), DARK(), 0, 0.026, -front + 0.06 - i * 0.016);
}

const muzzleCrown = (g: THREE.Object3D, r: number, y: number, z: number) => {
  add(g, tube(r, 0.006), DARK(), 0, y, z + 0.003);
  add(g, disc(r * 0.62), polymer(0x020202), 0, y, z - 0.0005, 0, Math.PI);
};

/** Glock-18: boxy black slide, polymer frame with a rail, squared guard, finger-groove grip. */
const glock: Builder = (g) => {
  const frame = polymer(0x1c1d20, 0.72);
  const slide = new THREE.Group();
  g.add(slide);
  pistolSlide(slide, { key: 'glock', length: 0.205, height: 0.037, width: 0.033, y: 0.052, back: 0.03, nose: 0.011, mat: metal(0x2a2c30, 0.48), rear: 7 });
  muzzleCrown(slide, 0.0068, 0.071, -0.175);
  pistolFrame(g, 'glock', frame, 0.165);
  squareGuard(g, frame, -0.012, -0.08, 0.03);
  grip(g, frame, 0.012, 0.1, 0.34);
  add(g, rbox(0.03, 0.012, 0.024), frame, 0, 0.04, 0.04);
  const mag = pistolMag(g, DARK(), 0.085, 0.026);
  return { muzzle: V(0, 0.071, -0.18), magazine: mag, scale: 1.05, action: { part: slide, kind: 'slide', travel: 0.03 }, ejection: V(0.02, 0.09, -0.04) };
};

/** USP-S: a rounded slide with a long suppressor screwed on the barrel (the can stays put). */
const usp: Builder = (g) => {
  const frame = polymer(0x1a1b1e, 0.68);
  const slideMat = metal(0x24262a, 0.42);
  const slide = new THREE.Group();
  g.add(slide);
  pistolSlide(slide, { key: 'usp', length: 0.205, height: 0.038, width: 0.032, y: 0.052, back: 0.03, nose: 0.014, mat: slideMat, rear: 6 });
  add(slide, rbox(0.028, 0.008, 0.16), slideMat, 0, 0.088, -0.07, 0, 0, 0);
  pistolFrame(g, 'usp', frame, 0.16);
  trigger(g, frame, -0.04, 0.02, 0.022);
  grip(g, frame, 0.01, 0.1, 0.26);
  const can = polymer(0x15161a, 0.42);
  add(g, tube(0.0068, 0.012), DARK(), 0, 0.071, -0.181);
  add(g, tube(0.0158, 0.012), metal(0x2c2e33, 0.32), 0, 0.071, -0.192);
  add(g, tube(0.0165, 0.155), can, 0, 0.071, -0.275);
  for (let i = 0; i < 3; i++) add(g, ring(0.0167, 0.0011), DARK(), 0, 0.071, -0.22 - i * 0.035);
  add(g, ring(0.0164, 0.002), STEEL(), 0, 0.071, -0.352);
  add(g, disc(0.005), polymer(0x020202), 0, 0.071, -0.3535, 0, Math.PI);
  const mag = pistolMag(g, DARK(), 0.085, 0.024);
  return { muzzle: V(0, 0.071, -0.356), magazine: mag, scale: 1.05, action: { part: slide, kind: 'slide', travel: 0.03 }, ejection: V(0.02, 0.09, -0.04) };
};

/** Five-SeveN: a long slim black slide over a tan polymer frame, squared guard, long grip. */
const fiveseven: Builder = (g, id) => {
  const frame = polymer(WEAPONS[id].model.color, 0.64);
  const slide = new THREE.Group();
  g.add(slide);
  pistolSlide(slide, { key: 'fiveseven', length: 0.215, height: 0.034, width: 0.031, y: 0.055, back: 0.03, nose: 0.016, mat: metal(WEAPONS[id].model.accent, 0.44), rear: 8, front: 4 });
  muzzleCrown(slide, 0.0062, 0.073, -0.185);
  pistolFrame(g, 'fiveseven', frame, 0.175, 0.03, 0.055);
  squareGuard(g, frame, -0.014, -0.085, 0.03, 0.034);
  grip(g, frame, 0.008, 0.118, 0.24);
  const mag = pistolMag(g, DARK(), 0.1, 0.022);
  return { muzzle: V(0, 0.073, -0.19), magazine: mag, scale: 1.05, action: { part: slide, kind: 'slide', travel: 0.03 }, ejection: V(0.02, 0.09, -0.04) };
};

/** One Beretta 92 (Dual Berettas): an open-top stainless slide with the barrel showing in front. */
function beretta(g: THREE.Object3D): THREE.Group {
  const steel = metal(0xb8bcc2, 0.24);
  const slide = new THREE.Group();
  g.add(slide);
  add(slide, profile('beretta:slide', [[-0.03, 0], [-0.03, 0.034], [-0.026, 0.038], [0.085, 0.038], [0.094, 0.024], [0.172, 0.024], [0.178, 0.018], [0.178, 0]], 0.032), steel, 0, 0.052, 0);
  serrate(slide, 0.032, 0.072, 0.02, 0.024, 7);
  add(slide, tube(0.0085, 0.088), steel, 0, 0.081, -0.12);
  muzzleCrown(slide, 0.0085, 0.081, -0.164);
  for (const s of [-1, 1]) add(slide, box(0.006, 0.008, 0.006), DARK(), s * 0.0065, 0.094, 0.018);
  add(slide, box(0.004, 0.007, 0.005), DARK(), 0, 0.091, -0.15);
  add(g, profile('beretta:frame', [[-0.034, 0.052], [0.16, 0.052], [0.16, 0.034], [0.09, 0.03], [0.075, 0.018], [0.02, 0.018], [0.0, 0.03], [-0.034, 0.03]], 0.03), steel, 0, 0, 0);
  trigger(g, steel, -0.04, 0.021, 0.023);
  grip(g, polymer(0x1a1a1c, 0.75), 0.01, 0.104, 0.22);
  return slide;
}
const dualies: Builder = (g) => {
  const slide = beretta(g);
  const mag = pistolMag(g, STEEL());
  const offhand = new THREE.Group();
  offhand.position.set(-0.62, 0.01, 0.02);
  offhand.rotation.y = -0.06;
  beretta(offhand);
  g.add(offhand);
  return { muzzle: V(0, 0.081, -0.168), magazine: mag, offhand, scale: 1, action: { part: slide, kind: 'slide', travel: 0.03 }, ejection: V(0.018, 0.092, -0.03) };
};

/** CZ75-Auto: a slim slide riding inside the frame rails, an extended magazine and a spare one up front as a grip. */
const cz75: Builder = (g, id) => {
  const steel = metal(WEAPONS[id].model.color, 0.4);
  const slide = new THREE.Group();
  g.add(slide);
  pistolSlide(slide, { key: 'cz75', length: 0.2, height: 0.026, width: 0.026, y: 0.066, back: 0.03, nose: 0.009, mat: steel, rear: 7 });
  muzzleCrown(slide, 0.0066, 0.078, -0.17);
  add(g, profile('cz75:frame', [[-0.036, 0.068], [0.168, 0.068], [0.172, 0.06], [0.168, 0.04], [0.1, 0.036], [0.08, 0.018], [0.02, 0.018], [0.0, 0.032], [-0.036, 0.034]], 0.031), steel, 0, 0, 0);
  trigger(g, steel, -0.042, 0.021, 0.022);
  grip(g, polymer(0x1c1d1f, 0.75), 0.012, 0.1, 0.24);
  // The spare magazine clipped under the barrel, upside down, as a foregrip.
  add(g, rbox(0.022, 0.07, 0.03), DARK(), 0, 0.004, -0.13, -0.06);
  add(g, rbox(0.03, 0.01, 0.036), polymer(0x1c1d1f), 0, -0.032, -0.128);
  const mag = new THREE.Group();
  mag.position.set(0, -0.03, 0.006);
  add(mag, rbox(0.024, 0.17, 0.032), DARK(), 0, -0.06, 0.012, -0.22);
  add(mag, rbox(0.03, 0.012, 0.036), polymer(0x1c1d1f), 0, -0.145, 0.032, -0.22);
  g.add(mag);
  return { muzzle: V(0, 0.078, -0.175), magazine: mag, scale: 1.05, action: { part: slide, kind: 'slide', travel: 0.026 }, ejection: V(0.018, 0.094, -0.04) };
};

/** R8 Revolver: heavy frame, full-length underlug with a top rail, fluted cylinder (it turns each shot), hammer, rubber grip. */
const r8: Builder = (g, id) => {
  const steel = metal(WEAPONS[id].model.color, 0.28);
  add(g, profile('r8:frame', [[-0.03, 0.098], [0.045, 0.104], [0.05, 0.032], [0.02, 0.026], [-0.01, 0.03], [-0.03, 0.06]], 0.034), steel, 0, 0, 0.02);
  add(g, profile('r8:barrel', [[0.0, 0.0], [0.0, 0.04], [0.19, 0.04], [0.2, 0.034], [0.2, 0.0]], 0.024), steel, 0, 0.058, -0.03);
  rail(g, DARK(), 0.1, -0.22, -0.05, 0.016);
  muzzleCrown(g, 0.007, 0.084, -0.229);
  const cylinder = new THREE.Group();
  cylinder.position.set(0, 0.072, -0.012);
  add(cylinder, tube(0.031, 0.062), DARK(), 0, 0, 0);
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    add(cylinder, box(0.005, 0.012, 0.064), steel, Math.cos(a) * 0.03, Math.sin(a) * 0.03, 0, 0, 0, a);
    add(cylinder, disc(0.0065), BRASS(), Math.cos(a + 0.52) * 0.018, Math.sin(a + 0.52) * 0.018, 0.032);
  }
  g.add(cylinder);
  add(g, box(0.01, 0.026, 0.014), steel, 0, 0.104, 0.048, -0.55);
  trigger(g, steel, 0.0, 0.024, 0.021);
  add(g, profile('r8:grip', [[-0.02, 0.03], [0.03, 0.03], [0.034, -0.02], [0.022, -0.075], [-0.018, -0.082], [-0.03, -0.02]], 0.034), RUBBER(), 0, 0, 0.05, 0.2);
  return { muzzle: V(0, 0.084, -0.234), magazine: cylinder, scale: 1.05, action: { part: cylinder, kind: 'cylinder', travel: Math.PI / 3 } };
};

/** Desert Eagle: the big slide, a triangular barrel with its top rail, angular guard, chunky grip. */
const deagle: Builder = (g, id) => {
  const steel = metal(WEAPONS[id].model.color, 0.24);
  const slide = new THREE.Group();
  g.add(slide);
  pistolSlide(slide, { key: 'deagle', length: 0.13, height: 0.046, width: 0.042, y: 0.054, back: 0.034, nose: 0.004, mat: steel, rear: 7, front: 0 });
  // The fixed barrel in front: a tall wedge with the polygonal top rib.
  add(g, profile('deagle:barrel', [[0.0, 0.0], [0.0, 0.046], [0.135, 0.046], [0.142, 0.034], [0.142, 0.006], [0.135, 0.0]], 0.036), steel, 0, 0.054, -0.096);
  add(g, box(0.014, 0.008, 0.13), steel, 0, 0.104, -0.16);
  muzzleCrown(g, 0.0105, 0.082, -0.238);
  add(g, box(0.034, 0.004, 0.12), DARK(), 0, 0.062, -0.16);
  add(g, profile('deagle:frame', [[-0.04, 0.056], [0.18, 0.056], [0.18, 0.034], [0.09, 0.03], [0.08, 0.018], [0.02, 0.018], [0.0, 0.034], [-0.04, 0.034]], 0.038), steel, 0, 0, 0);
  squareGuard(g, steel, -0.014, -0.086, 0.032, 0.034);
  add(g, box(0.012, 0.022, 0.014), steel, 0, 0.098, 0.05, -0.5);
  grip(g, polymer(WEAPONS[id].model.accent, 0.8), 0.016, 0.114, 0.24);
  const mag = pistolMag(g, steel, 0.09, 0.026);
  return { muzzle: V(0, 0.082, -0.244), magazine: mag, scale: 1.08, action: { part: slide, kind: 'slide', travel: 0.04 }, ejection: V(0.024, 0.1, 0.0) };
};

/** MAC-10: a stamped steel box, the magazine in the grip, short threaded barrel, front strap, wire stock. */
const mac10: Builder = (g, id) => {
  const body = metal(WEAPONS[id].model.color, 0.5);
  add(g, profile('mac10:body', [[-0.07, 0.098], [0.13, 0.098], [0.134, 0.094], [0.134, 0.034], [0.03, 0.034], [0.03, 0.01], [-0.04, 0.01], [-0.07, 0.034]], 0.052), body, 0, 0, 0);
  add(g, box(0.054, 0.006, 0.17), DARK(), 0, 0.066, -0.03);
  for (const s of [-1, 1]) add(g, box(0.004, 0.03, 0.06), DARK(), s * 0.027, 0.066, -0.08);
  add(g, tube(0.0085, 0.05), DARK(), 0, 0.066, -0.16);
  for (let i = 0; i < 4; i++) add(g, ring(0.0088, 0.0012), STEEL(), 0, 0.066, -0.145 - i * 0.008);
  muzzleCrown(g, 0.0085, 0.066, -0.185);
  // The nylon strap under the front for the other hand.
  add(g, ring(0.03, 0.004, Math.PI), polymer(0x111214, 0.9), 0, 0.03, -0.1, 0, Math.PI / 2, Math.PI);
  // Cocking knob on top (it runs back in its slot when firing).
  add(g, box(0.006, 0.004, 0.09), DARK(), 0, 0.1, -0.02);
  const knob = new THREE.Group();
  knob.position.set(0, 0.106, -0.07);
  add(knob, post(0.007, 0.012), STEEL(), 0, 0, 0);
  g.add(knob);
  add(g, profile('mac10:grip', [[-0.02, 0.012], [0.024, 0.012], [0.026, -0.09], [-0.022, -0.09]], 0.036), polymer(0x1a1b1d, 0.8), 0, 0, 0.0);
  squareGuard(g, body, -0.024, -0.06, 0.012, 0.028);
  // Folded wire stock.
  for (const s of [-1, 1]) add(g, tube(0.0045, 0.2), STEEL(), s * 0.02, 0.05, 0.18);
  add(g, rbox(0.046, 0.06, 0.008), STEEL(), 0, 0.046, 0.28);
  const mag = new THREE.Group();
  mag.position.set(0, -0.085, 0.0);
  add(mag, rbox(0.03, 0.13, 0.036), DARK(), 0, -0.05, 0);
  g.add(mag);
  return { muzzle: V(0, 0.066, -0.19), magazine: mag, scale: 1, action: { part: knob, kind: 'bolt', travel: 0.05 }, ejection: V(0.03, 0.07, -0.05) };
};

/** A rifle's charging handle in its own group (it runs back when firing). */
function chargingHandle(g: THREE.Object3D, mat: THREE.Material, x: number, y: number, z: number, length = 0.03): THREE.Group {
  const handle = new THREE.Group();
  handle.position.set(x, y, z);
  add(handle, box(0.016, 0.01, length), mat, 0, 0, 0);
  add(handle, box(0.008, 0.016, 0.01), mat, Math.sign(x) * 0.008, 0.004, -length / 2 + 0.006);
  g.add(handle);
  return handle;
}

/** Galil AR: an AK-style receiver, ribbed polymer handguard, steel curved magazine, folding skeleton stock. */
const galil: Builder = (g) => {
  const steel = metal(0x2a2d31, 0.44);
  const black = polymer(0x18191b, 0.7);
  add(g, profile('galil:receiver', [[-0.06, 0.094], [0.24, 0.094], [0.25, 0.042], [0.18, 0.032], [0.172, -0.012], [0.072, -0.012], [0.064, 0.022], [-0.06, 0.026]], 0.062), steel, 0, 0, 0);
  add(g, rbox(0.058, 0.012, 0.27), DARK(), 0, 0.099, -0.09);
  add(g, profile('galil:guard', [[0.25, 0.082], [0.46, 0.078], [0.47, 0.03], [0.25, 0.024]], 0.07, 0.008), black, 0, 0, 0);
  for (let i = 0; i < 6; i++) add(g, box(0.073, 0.008, 0.012), DARK(), 0, 0.05, -0.29 - i * 0.03);
  add(g, tube(0.0105, 0.3), DARK(), 0, 0.06, -0.62);
  add(g, tube(0.007, 0.14), steel, 0, 0.09, -0.54);
  add(g, rbox(0.024, 0.05, 0.03), steel, 0, 0.082, -0.66);
  add(g, ring(0.008, 0.002), STEEL(), 0, 0.114, -0.66);
  add(g, tube(0.014, 0.06), DARK(), 0, 0.06, -0.795);
  for (let i = 0; i < 3; i++) add(g, box(0.03, 0.004, 0.03), polymer(0x050505), 0, 0.06, -0.795, 0, 0, (i * Math.PI) / 3);
  add(g, rbox(0.03, 0.022, 0.05), steel, 0, 0.11, -0.25);
  const handle = new THREE.Group();
  handle.position.set(0.034, 0.08, -0.12);
  add(handle, box(0.01, 0.01, 0.03), steel, 0, 0, 0);
  add(handle, post(0.004, 0.035), STEEL(), 0.004, 0.018, -0.008);
  g.add(handle);
  const mag = new THREE.Group();
  mag.position.set(0, -0.012, -0.125);
  add(mag, curvedMag(), metal(0x34373b, 0.5), 0, 0.01, 0);
  for (let i = 0; i < 3; i++) add(mag, box(0.044, 0.005, 0.012), DARK(), 0, -0.04 - i * 0.04, -0.012 - i * 0.022, -0.35);
  g.add(mag);
  grip(g, black, 0.035);
  trigger(g, steel, -0.006, 0.01, 0.024);
  // Folding skeleton stock: a frame you can see through, with the butt plate.
  add(g, geometry('galil:stock', () => {
    const shape = new THREE.Shape();
    shape.moveTo(-0.06, 0.08); shape.lineTo(-0.3, 0.07); shape.lineTo(-0.31, -0.05); shape.lineTo(-0.24, -0.04); shape.lineTo(-0.06, 0.02);
    shape.closePath();
    const hole = new THREE.Path();
    hole.moveTo(-0.09, 0.064); hole.lineTo(-0.28, 0.056); hole.lineTo(-0.285, -0.03); hole.lineTo(-0.24, -0.024); hole.lineTo(-0.09, 0.034);
    hole.closePath();
    shape.holes.push(hole);
    const s = new THREE.ExtrudeGeometry(shape, { depth: 0.012, bevelEnabled: true, bevelThickness: 0.003, bevelSize: 0.003, bevelSegments: 1 });
    s.translate(0, 0, -0.006);
    metresToUv(s);
    return s.rotateY(Math.PI / 2);
  }), steel, 0, 0, 0);
  add(g, rbox(0.04, 0.12, 0.014), RUBBER(), 0, 0.012, 0.31);
  return { muzzle: V(0, 0.06, -0.83), magazine: mag, scale: 0.84, action: { part: handle, kind: 'bolt', travel: 0.06 }, ejection: V(0.034, 0.072, -0.07) };
};

/** FAMAS: a bullpup with the long carry handle on top, the magazine behind the grip, folded bipod legs. */
const famas: Builder = (g, id) => {
  void id;
  const body = polymer(0x2e3135, 0.62);
  const dark = polymer(0x1a1c1f, 0.7);
  add(g, profile('famas:body', [[0.31, 0.066], [0.29, 0.088], [0.05, 0.092], [-0.25, 0.088], [-0.255, -0.016], [-0.13, -0.016], [-0.07, 0.014], [0.12, 0.02], [0.3, 0.032]], 0.064), body, 0, 0, 0);
  add(g, profile('famas:handle', [[0.29, 0.088], [0.28, 0.104], [0.22, 0.155], [-0.15, 0.155], [-0.19, 0.138], [-0.19, 0.088], [-0.15, 0.118], [0.19, 0.118], [0.23, 0.098]], 0.024), dark, 0, 0, 0);
  for (let i = 0; i < 6; i++) add(g, box(0.07, 0.006, 0.014), DARK(), 0, 0.05, -0.2 - i * 0.02);
  add(g, tube(0.0105, 0.16), DARK(), 0, 0.06, -0.39);
  add(g, tube(0.014, 0.05), DARK(), 0, 0.06, -0.49);
  for (let i = 0; i < 4; i++) add(g, box(0.005, 0.03, 0.04), polymer(0x050505), Math.cos(i * 1.57) * 0.012, 0.06 + Math.sin(i * 1.57) * 0.012, -0.49, 0, 0, i * 1.57);
  for (const s of [-1, 1]) add(g, tube(0.004, 0.2), DARK(), s * 0.038, 0.04, -0.25);
  // The charging lever under the carry handle (runs back when firing).
  const lever = new THREE.Group();
  lever.position.set(0, 0.125, -0.05);
  add(lever, box(0.012, 0.012, 0.03), DARK(), 0, 0, 0);
  g.add(lever);
  grip(g, dark, -0.11, 0.09, 0.22);
  trigger(g, DARK(), -0.15, 0.014);
  add(g, rbox(0.07, 0.11, 0.022), RUBBER(), 0, 0.04, 0.255);
  add(g, rbox(0.04, 0.02, 0.1), dark, 0, 0.112, 0.17);
  const mag = new THREE.Group();
  mag.position.set(0, -0.012, 0.07);
  add(mag, rbox(0.036, 0.13, 0.06, 0.006), DARK(), 0, -0.055, 0, 0.12);
  g.add(mag);
  return { muzzle: V(0, 0.06, -0.515), magazine: mag, scale: 0.9, action: { part: lever, kind: 'bolt', travel: 0.05 }, ejection: V(0.036, 0.07, 0.06) };
};

/** SG 553: black receiver, tan polymer handguard, a scope on top, folding skeleton stock. */
const sg553: Builder = (g, id) => {
  const tan = polymer(WEAPONS[id].model.color, 0.7);
  const steel = metal(0x2b2e33, 0.46);
  add(g, profile('sg:receiver', [[-0.06, 0.1], [0.22, 0.1], [0.23, 0.04], [0.17, 0.032], [0.16, -0.014], [0.07, -0.014], [0.062, 0.022], [-0.06, 0.026]], 0.06), steel, 0, 0, 0);
  add(g, profile('sg:guard', [[0.23, 0.088], [0.46, 0.082], [0.47, 0.03], [0.23, 0.024]], 0.066, 0.008), tan, 0, 0, 0);
  for (let i = 0; i < 4; i++) add(g, rbox(0.068, 0.012, 0.034), DARK(), 0, 0.058, -0.29 - i * 0.045);
  add(g, tube(0.011, 0.24), DARK(), 0, 0.064, -0.59);
  add(g, rbox(0.03, 0.032, 0.05), DARK(), 0, 0.064, -0.73);
  for (const s of [-1, 1]) add(g, box(0.006, 0.014, 0.034), polymer(0x050505), s * 0.016, 0.064, -0.73);
  rail(g, DARK(), 0.104, -0.2, 0.03, 0.022);
  scope(g, 0.15, -0.17, 0.02, 0.026, 0.018, 0.11);
  const handle = chargingHandle(g, steel, 0.036, 0.08, -0.13);
  const mag = new THREE.Group();
  mag.position.set(0, -0.012, -0.11);
  add(mag, curvedMag(), polymer(0x6b5d40, 0.5), 0, 0.01, 0);
  g.add(mag);
  grip(g, polymer(0x1c1d1f), 0.035);
  trigger(g, DARK(), -0.006, 0.01, 0.024);
  add(g, profile('sg:stock', [[-0.06, 0.088], [-0.29, 0.08], [-0.3, -0.04], [-0.24, -0.035], [-0.12, 0.02], [-0.06, 0.03]], 0.03), tan, 0, 0, 0);
  add(g, rbox(0.044, 0.124, 0.016), RUBBER(), 0, 0.022, 0.302);
  return { muzzle: V(0, 0.064, -0.76), magazine: mag, scale: 0.9, action: { part: handle, kind: 'bolt', travel: 0.06 }, ejection: V(0.034, 0.072, -0.07) };
};

/** AK-47: stamped receiver, walnut furniture, gas tube over the barrel, slanted brake, bakelite magazine. */
const ak47: Builder = (g) => {
  const wood = WOOD();
  const steel = STEEL();
  add(g, profile('ak:receiver', [[-0.06, 0.092], [0.24, 0.092], [0.25, 0.04], [0.18, 0.032], [0.172, -0.012], [0.072, -0.012], [0.064, 0.022], [-0.06, 0.026]], 0.062), steel, 0, 0, 0);
  add(g, rbox(0.058, 0.014, 0.27), DARK(), 0, 0.097, -0.09);
  for (let i = 0; i < 5; i++) add(g, box(0.06, 0.004, 0.006), steel, 0, 0.105, 0.03 - i * 0.05);
  add(g, rbox(0.03, 0.022, 0.05), steel, 0, 0.108, -0.25);
  add(g, box(0.004, 0.012, 0.016), DARK(), 0, 0.124, -0.25);
  // The bolt carrier's handle on the right: it slams back with every shot.
  const handle = new THREE.Group();
  handle.position.set(0.034, 0.074, -0.135);
  add(handle, box(0.012, 0.01, 0.026), steel, 0, 0, 0);
  add(handle, ball(0.008), steel, 0.01, 0, -0.008);
  g.add(handle);
  add(g, profile('ak:handguard', [[0.25, 0.072], [0.47, 0.068], [0.47, 0.024], [0.25, 0.02]], 0.068, 0.008), wood, 0, 0, 0);
  add(g, tube(0.017, 0.2), wood, 0, 0.098, -0.36);
  add(g, tube(0.008, 0.07), steel, 0, 0.098, -0.5);
  add(g, tube(0.011, 0.3), DARK(), 0, 0.058, -0.6);
  add(g, rbox(0.026, 0.05, 0.03), steel, 0, 0.08, -0.66);
  add(g, box(0.004, 0.03, 0.006), DARK(), 0, 0.118, -0.66);
  add(g, ring(0.007, 0.0018), steel, 0, 0.12, -0.66);
  add(g, tube(0.015, 0.05), DARK(), 0, 0.058, -0.775);
  add(g, box(0.018, 0.012, 0.03), polymer(0x050505), 0, 0.07, -0.785, -0.4);
  add(g, ring(0.013, 0.003), steel, 0, 0.04, -0.62, 0, Math.PI / 2);
  const mag = new THREE.Group();
  mag.position.set(0, -0.012, -0.125);
  add(mag, curvedMag(), polymer(0x7a3f1d, 0.5), 0, 0.01, 0);
  for (let i = 0; i < 3; i++) add(mag, box(0.044, 0.006, 0.012), polymer(0x5c2e14, 0.5), 0, -0.04 - i * 0.04, -0.012 - i * 0.022, -0.35);
  g.add(mag);
  grip(g, wood, 0.035);
  trigger(g, steel, -0.006, 0.01, 0.024);
  add(g, profile('ak:stock', [[-0.055, 0.084], [-0.3, 0.064], [-0.31, -0.05], [-0.22, -0.03], [-0.11, 0.008], [-0.055, 0.03]], 0.044), wood, 0, 0, 0);
  add(g, rbox(0.046, 0.12, 0.012), steel, 0, 0.007, 0.312);
  add(g, ring(0.012, 0.003), steel, 0, -0.02, 0.2, 0, Math.PI / 2);
  return { muzzle: V(0, 0.058, -0.805), magazine: mag, scale: 0.84, action: { part: handle, kind: 'bolt', travel: 0.065 }, ejection: V(0.034, 0.074, -0.09) };
};

/** M4A4: flat-top rail, quad-rail handguard, A-frame front sight, straight magazine, collapsible stock, T charging handle. */
const m4a4: Builder = (g) => {
  const body = metal(0x232427, 0.5);
  const black = polymer(0x18191b);
  add(g, profile('m4:receiver', [[-0.07, 0.1], [0.24, 0.1], [0.24, 0.036], [0.185, 0.03], [0.178, -0.022], [0.084, -0.022], [0.076, 0.022], [0.0, 0.024], [-0.07, 0.05]], 0.062), body, 0, 0, 0);
  rail(g, DARK(), 0.106, -0.45, 0.05, 0.026);
  add(g, rbox(0.028, 0.026, 0.026), DARK(), 0, 0.125, 0.01);
  add(g, tube(0.008, 0.03), DARK(), 0.036, 0.08, 0.02);
  add(g, box(0.003, 0.024, 0.05), DARK(), 0.033, 0.072, -0.08);
  add(g, ring(0.009, 0.003, Math.PI), DARK(), 0.032, 0.09, -0.05, 0, Math.PI / 2, 0);
  add(g, rbox(0.066, 0.066, 0.26, 0.012), body, 0, 0.066, -0.37);
  for (const [x, y] of [[0, 0.1], [0.035, 0.066], [-0.035, 0.066], [0, 0.032]] as const) add(g, box(x ? 0.008 : 0.024, x ? 0.024 : 0.008, 0.24), DARK(), x, y, -0.37);
  add(g, tube(0.0105, 0.2), DARK(), 0, 0.066, -0.6);
  add(g, profile('m4:asight', [[0.0, 0.0], [0.03, 0.0], [0.022, 0.075], [0.008, 0.075]], 0.02), DARK(), 0, 0.06, -0.535);
  add(g, tube(0.015, 0.05), DARK(), 0, 0.066, -0.72);
  for (let i = 0; i < 4; i++) add(g, box(0.004, 0.03, 0.03), polymer(0x050505), Math.cos(i * 1.57) * 0.012, 0.066 + Math.sin(i * 1.57) * 0.012, -0.73, 0, 0, i * 1.57);
  // The T-shaped charging handle at the back of the upper.
  const handle = new THREE.Group();
  handle.position.set(0, 0.096, 0.065);
  add(handle, box(0.042, 0.008, 0.01), DARK(), 0, 0, 0);
  add(handle, box(0.012, 0.006, 0.03), DARK(), 0, -0.002, -0.014);
  g.add(handle);
  const mag = new THREE.Group();
  mag.position.set(0, -0.02, -0.12);
  add(mag, rbox(0.03, 0.15, 0.064, 0.006), DARK(), 0, -0.06, -0.01, 0.12);
  add(mag, rbox(0.036, 0.012, 0.07), black, 0, -0.14, -0.02, 0.12);
  g.add(mag);
  grip(g, black, 0.04);
  trigger(g, DARK(), -0.005, 0.01, 0.024);
  add(g, tube(0.016, 0.17), DARK(), 0, 0.07, 0.14);
  add(g, profile('m4:stock', [[-0.17, 0.1], [-0.31, 0.1], [-0.315, -0.04], [-0.27, -0.035], [-0.2, 0.035], [-0.17, 0.045]], 0.046), black, 0, 0, 0);
  add(g, rbox(0.048, 0.14, 0.02), RUBBER(), 0, 0.03, 0.32);
  return { muzzle: V(0, 0.066, -0.75), magazine: mag, scale: 0.84, action: { part: handle, kind: 'bolt', travel: 0.06 }, ejection: V(0.034, 0.072, -0.07) };
};

/** A bolt-action handle on the right of the receiver, in its own group: it lifts and draws back between shots. */
function boltHandle(g: THREE.Object3D, y: number, z: number, length = 0.05): THREE.Group {
  const bolt = new THREE.Group();
  bolt.position.set(0.028, y, z);
  add(bolt, tube(0.01, 0.07), STEEL(), -0.028, 0, -0.01);
  add(bolt, post(0.0045, length), STEEL(), length / 2, -0.006, 0, 0, 0, Math.PI / 2 - 0.25);
  add(bolt, ball(0.011), DARK(), length, -0.018, 0);
  g.add(bolt);
  return bolt;
}

/** SSG 08: a slim fluted barrel, a skeleton stock with cheek rest, compact scope, bolt action. */
const ssg08: Builder = (g, id) => {
  const body = polymer(WEAPONS[id].model.color, 0.62);
  const black = polymer(0x18191b, 0.7);
  add(g, profile('ssg:chassis', [[-0.04, 0.084], [0.2, 0.084], [0.46, 0.074], [0.47, 0.036], [0.2, 0.03], [0.16, 0.0], [0.08, 0.0], [0.06, 0.02], [-0.04, 0.03]], 0.05), body, 0, 0, 0);
  add(g, tube(0.0095, 0.44), DARK(), 0, 0.064, -0.68);
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2;
    add(g, box(0.0022, 0.0022, 0.24), STEEL(), Math.cos(a) * 0.0094, 0.064 + Math.sin(a) * 0.0094, -0.6);
  }
  add(g, rbox(0.022, 0.022, 0.05), DARK(), 0, 0.064, -0.92);
  scope(g, 0.126, -0.17, 0.08, 0.024, 0.016, 0.09);
  const bolt = boltHandle(g, 0.07, 0.04);
  grip(g, black, 0.06, 0.085, 0.3);
  trigger(g, DARK(), 0.02, 0.012);
  add(g, profile('ssg:stock', [[-0.04, 0.09], [-0.32, 0.1], [-0.33, -0.04], [-0.27, -0.04], [-0.24, 0.0], [-0.12, 0.02], [-0.06, 0.0], [-0.04, 0.03]], 0.036), body, 0, 0, 0);
  add(g, rbox(0.03, 0.02, 0.12), black, 0, 0.1, 0.19);
  add(g, rbox(0.044, 0.15, 0.018), RUBBER(), 0, 0.028, 0.335);
  const mag = new THREE.Group();
  mag.position.set(0, 0.0, -0.07);
  add(mag, rbox(0.034, 0.04, 0.06), DARK(), 0, -0.005, 0);
  g.add(mag);
  return { muzzle: V(0, 0.064, -0.95), magazine: mag, scale: 0.8, action: { part: bolt, kind: 'boltAction', travel: 0.07 }, ejection: V(0.03, 0.08, -0.02) };
};

/** AWP: the big olive chassis with a thumbhole stock, heavy barrel and brake, a long scope, folded bipod, bolt action. */
const awp: Builder = (g, id) => {
  const body = polymer(WEAPONS[id].model.color, 0.62);
  add(g, profile('awp:chassis', [[-0.04, 0.098], [0.22, 0.098], [0.5, 0.086], [0.51, 0.026], [0.2, 0.02], [0.16, -0.01], [0.08, -0.01], [0.06, 0.02], [-0.04, 0.03]], 0.064), body, 0, 0, 0);
  add(g, tube(0.0135, 0.5), DARK(), 0, 0.066, -0.72);
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    add(g, box(0.003, 0.003, 0.28), STEEL(), Math.cos(a) * 0.0132, 0.066 + Math.sin(a) * 0.0132, -0.66);
  }
  add(g, rbox(0.034, 0.03, 0.07), DARK(), 0, 0.066, -0.99);
  for (const s of [-1, 1]) for (let k = 0; k < 2; k++) add(g, box(0.006, 0.01, 0.012), polymer(0x050505), s * 0.017, 0.066, -0.98 - k * 0.022);
  add(g, geometry('awp:stock', () => {
    const shape = new THREE.Shape();
    for (const [i, [x, y]] of ([[-0.03, 0.098], [-0.38, 0.104], [-0.39, -0.04], [-0.29, -0.045], [-0.16, -0.005], [-0.06, 0.0], [-0.03, 0.02]] as const).entries()) (i === 0 ? shape.moveTo(x, y) : shape.lineTo(x, y));
    shape.closePath();
    const hole = new THREE.Path();
    hole.absellipse(-0.115, 0.047, 0.04, 0.024, 0, Math.PI * 2, false, 0);
    shape.holes.push(hole);
    const s = new THREE.ExtrudeGeometry(shape, { depth: 0.044, bevelEnabled: true, bevelThickness: 0.005, bevelSize: 0.005, bevelSegments: 2, curveSegments: 12 });
    s.translate(0, 0, -0.022);
    metresToUv(s);
    return s.rotateY(Math.PI / 2);
  }), body, 0, 0, 0);
  add(g, rbox(0.054, 0.15, 0.022), RUBBER(), 0, 0.03, 0.395);
  grip(g, polymer(0x1c1d1f), 0.05, 0.085, 0.3);
  trigger(g, DARK(), 0.005, 0.012);
  scope(g, 0.142, -0.25, 0.12, 0.036, 0.022, 0.1);
  const bolt = boltHandle(g, 0.074, 0.04, 0.055);
  for (const s of [-1, 1]) {
    add(g, tube(0.0048, 0.24), DARK(), s * 0.016, 0.018, -0.62);
    add(g, ball(0.008), RUBBER(), s * 0.016, 0.018, -0.745);
  }
  const mag = new THREE.Group();
  mag.position.set(0, 0.0, -0.06);
  add(mag, rbox(0.04, 0.05, 0.08), DARK(), 0, -0.01, 0);
  g.add(mag);
  return { muzzle: V(0, 0.066, -1.03), magazine: mag, scale: 0.78, action: { part: bolt, kind: 'boltAction', travel: 0.085 }, ejection: V(0.034, 0.084, -0.02) };
};

/** Nova: one-piece black polymer receiver and stock, a ribbed pump (it racks after every shot), tube magazine, bead sight. */
const nova: Builder = (g) => {
  const black = polymer(0x1b1c1e, 0.72);
  add(g, profile('nova:body', [[0.16, 0.1], [0.16, 0.03], [0.08, 0.026], [0.06, 0.012], [0.03, 0.012], [0.015, -0.07], [-0.03, -0.085], [-0.05, -0.06], [-0.07, -0.02], [-0.2, -0.04], [-0.335, -0.065], [-0.345, -0.06], [-0.345, 0.07], [-0.33, 0.076], [-0.08, 0.086], [-0.02, 0.1]], 0.05), black, 0, 0, 0);
  add(g, tube(0.0125, 0.5), DARK(), 0, 0.084, -0.41);
  add(g, ball(0.0035), BRASS(), 0, 0.099, -0.655);
  muzzleCrown(g, 0.0125, 0.084, -0.66);
  add(g, tube(0.011, 0.36), DARK(), 0, 0.054, -0.34);
  add(g, tube(0.0125, 0.02), STEEL(), 0, 0.054, -0.53);
  const pump = new THREE.Group();
  pump.position.set(0, 0.054, -0.3);
  add(pump, rbox(0.05, 0.044, 0.16, 0.01), black, 0, 0, 0);
  for (let i = 0; i < 6; i++) add(pump, box(0.052, 0.006, 0.006), DARK(), 0, -0.012, -0.06 + i * 0.024);
  g.add(pump);
  add(g, box(0.003, 0.016, 0.05), DARK(), 0.029, 0.07, -0.05);
  trigger(g, DARK(), 0.04, 0.012);
  add(g, rbox(0.058, 0.13, 0.02), RUBBER(), 0, 0.0, 0.345, 0.12);
  return { muzzle: V(0, 0.084, -0.665), scale: 0.95, action: { part: pump, kind: 'pump', travel: 0.08 }, ejection: V(0.03, 0.074, -0.05) };
};

/** XM1014: black semi-auto receiver, tube magazine, ghost-ring sights, telescoping stock; the charging handle cycles each shot. */
const xm1014: Builder = (g) => {
  const black = polymer(0x1b1c1e, 0.7);
  const steel = metal(0x2a2c30, 0.46);
  add(g, profile('xm:receiver', [[0.18, 0.1], [0.18, 0.04], [0.09, 0.034], [0.075, 0.012], [0.02, 0.012], [-0.03, 0.03], [-0.06, 0.04], [-0.06, 0.1]], 0.056), steel, 0, 0, 0);
  add(g, tube(0.0125, 0.42), DARK(), 0, 0.084, -0.39);
  add(g, tube(0.011, 0.38), DARK(), 0, 0.054, -0.37);
  add(g, rbox(0.054, 0.05, 0.2, 0.01), black, 0, 0.06, -0.3);
  for (let i = 0; i < 5; i++) add(g, box(0.056, 0.012, 0.012), DARK(), 0, 0.074, -0.23 - i * 0.034);
  add(g, rbox(0.03, 0.03, 0.03), DARK(), 0, 0.07, -0.57);
  add(g, ring(0.008, 0.002), STEEL(), 0, 0.118, -0.58);
  add(g, box(0.004, 0.022, 0.006), DARK(), 0, 0.104, -0.58);
  add(g, ring(0.008, 0.0022), STEEL(), 0, 0.122, 0.03);
  muzzleCrown(g, 0.0125, 0.084, -0.6);
  const handle = chargingHandle(g, STEEL(), 0.031, 0.074, -0.06);
  grip(g, black, 0.04);
  trigger(g, DARK(), 0.0, 0.012);
  add(g, tube(0.015, 0.2), DARK(), 0, 0.07, 0.15);
  add(g, profile('xm:stock', [[-0.12, 0.1], [-0.3, 0.1], [-0.305, -0.045], [-0.26, -0.04], [-0.17, 0.035], [-0.12, 0.05]], 0.046), black, 0, 0, 0);
  add(g, rbox(0.05, 0.15, 0.02), RUBBER(), 0, 0.028, 0.31);
  return { muzzle: V(0, 0.084, -0.605), scale: 0.95, action: { part: handle, kind: 'bolt', travel: 0.05 }, ejection: V(0.03, 0.08, -0.04) };
};

/** M249: bulky receiver, feed cover, carry handle over a slotted barrel, the box magazine underneath, bipod, skeleton stock. */
const m249: Builder = (g, id) => {
  const body = polymer(WEAPONS[id].model.color, 0.62);
  const steel = metal(0x2d3033, 0.48);
  add(g, profile('m249:receiver', [[-0.08, 0.1], [0.26, 0.1], [0.27, 0.03], [0.17, 0.024], [0.16, -0.01], [0.06, -0.01], [0.05, 0.022], [-0.08, 0.03]], 0.072), steel, 0, 0, 0);
  add(g, profile('m249:cover', [[-0.06, 0.13], [0.18, 0.13], [0.2, 0.1], [-0.08, 0.1]], 0.064), steel, 0, 0, 0);
  rail(g, DARK(), 0.133, -0.17, 0.05, 0.022);
  add(g, rbox(0.07, 0.06, 0.22), body, 0, 0.064, -0.38);
  for (let i = 0; i < 5; i++) add(g, box(0.072, 0.012, 0.02), DARK(), 0, 0.074, -0.3 - i * 0.035);
  add(g, tube(0.0155, 0.3), DARK(), 0, 0.072, -0.6);
  add(g, rbox(0.032, 0.032, 0.06), DARK(), 0, 0.072, -0.78);
  add(g, ring(0.034, 0.006, Math.PI), STEEL(), 0, 0.105, -0.46, 0, Math.PI / 2, 0);
  for (const s of [-1, 1]) {
    add(g, tube(0.0055, 0.24), DARK(), s * 0.02, 0.04, -0.62);
    add(g, ball(0.008), RUBBER(), s * 0.02, 0.04, -0.745);
  }
  const handle = chargingHandle(g, steel, 0.04, 0.07, -0.16);
  const box_ = new THREE.Group();
  box_.position.set(-0.012, -0.03, -0.1);
  add(box_, rbox(0.1, 0.1, 0.13), polymer(WEAPONS[id].model.accent, 0.82), 0, -0.045, 0);
  add(box_, box(0.102, 0.012, 0.06), DARK(), 0, -0.02, 0);
  for (let k = 0; k < 4; k++) add(box_, box(0.026, 0.01, 0.012), BRASS(), 0.04 + k * 0.006, 0.02 + k * 0.012, -0.02 + k * 0.004, 0, 0, 0.5);
  g.add(box_);
  grip(g, polymer(0x1c1d1f), 0.08);
  trigger(g, DARK(), 0.035, 0.012);
  for (const y of [0.09, -0.02]) add(g, tube(0.009, 0.24), steel, 0, y, 0.24);
  add(g, rbox(0.055, 0.15, 0.022), RUBBER(), 0, 0.035, 0.37);
  return { muzzle: V(0, 0.072, -0.81), magazine: box_, scale: 0.88, action: { part: handle, kind: 'bolt', travel: 0.06 }, ejection: V(0.04, 0.074, -0.08) };
};

const BUILDERS: Record<WeaponId, Builder> = {
  pistol: glock,
  rifle: galil,
  shotgun: nova,
  sniper: awp,
  smg: mac10,
  minigun,
  rocket,
  golden: (g, id) => rifleLike(GOLD(), DARK(), true)(g, id),
  knife,
  pan,
  katana,
  mpistol: cz75,
  revolver: r8,
  burst: famas,
  battle: sg553,
  autoshotgun: xm1014,
  lmg: m249,
  scout: ssg08,
  crossbow,
  launcher,
  goldknife: knife,
  deagle,
  fiveseven,
  dualies,
  silenced: usp,
  butterfly,
  karambit,
  m9,
  daggers,
  ak47,
  m4a1: m4a4,
  ssg08,
  scar20: awp,
  deserteagle: deagle,
  r8,
};

/** Baked geometry per weapon, group and material: made the first time, shared by every copy after. */
const baked = new Map<string, THREE.BufferGeometry>();

/**
 * A gun is dozens of small parts, each its own draw call (and again for shadows). Every group's own
 * meshes are merged into one mesh per material, so a gun draws in a handful of calls. Groups that
 * move (magazine, minigun barrels, knife-trick parts) stay groups, merged inside, and other objects
 * (the muzzle) are kept as they are. The builders are deterministic, so the key is the group's path.
 */
function bake(group: THREE.Object3D, key: string): void {
  const byMaterial = new Map<THREE.Material, THREE.Mesh[]>();
  [...group.children].forEach((child, i) => {
    const mesh = child as THREE.Mesh;
    if (mesh.isMesh && child.children.length === 0 && !Array.isArray(mesh.material)) {
      const list = byMaterial.get(mesh.material) ?? [];
      list.push(mesh);
      byMaterial.set(mesh.material, list);
    } else bake(child, `${key}/${i}`);
  });
  for (const [mat, meshes] of byMaterial) {
    if (meshes.length < 2) continue;
    const k = `${key}|${mat.uuid}`;
    let geo = baked.get(k);
    if (!geo) {
      const parts = meshes.map((m) => {
        m.updateMatrix();
        const g = m.geometry.index ? m.geometry.toNonIndexed() : m.geometry.clone();
        for (const name of Object.keys(g.attributes)) if (name !== 'position' && name !== 'normal' && name !== 'uv') g.deleteAttribute(name);
        g.clearGroups();
        return g.applyMatrix4(m.matrix);
      });
      const merged = mergeGeometries(parts, false);
      for (const p of parts) p.dispose();
      if (!merged) continue;
      baked.set(k, (geo = merged));
    }
    for (const m of meshes) group.remove(m);
    const one = new THREE.Mesh(geo, mat);
    one.castShadow = true;
    group.add(one);
  }
}

/** Gun skins: the body's material in the skin's colour (and finish), one per material and skin. */
const skinned = new Map<string, THREE.Material>();
function applySkin(parts: THREE.Object3D, id: WeaponId, skin: string): void {
  const finish = getItem('gun', skin);
  if (finish?.color === undefined || WEAPONS[id].melee) return;
  const body = new THREE.Color(WEAPONS[id].model.color);
  parts.traverse((o) => {
    const mesh = o as THREE.Mesh;
    const m = mesh.material as THREE.MeshStandardMaterial | undefined;
    if (!mesh.isMesh || Array.isArray(m) || !m?.color?.equals(body)) return;
    const key = `${m.uuid}:${skin}`;
    let s = skinned.get(key);
    if (!s) {
      const c = m.clone();
      const w = m.userData.wear as { bare: number; amount: number; metallic: boolean } | undefined;
      if (w) worn(c, w.bare, w.amount, w.metallic || finish.metal === true);
      c.color.setHex(finish.color!);
      if (finish.metal) {
        c.metalness = 0.85;
        c.roughness = 0.24;
      }
      skinned.set(key, (s = c));
    }
    mesh.material = s;
  });
}

/** A detailed procedural gun pointing down -Z, held at the origin (the grip), in gun skin `skin`. */
export function buildGun(id: WeaponId, skin?: string): GunModel {
  const group = new THREE.Group();
  const parts = new THREE.Group();
  const built = BUILDERS[id](parts, id);
  bake(parts, id);
  if (skin && skin !== 'none') applySkin(parts, id, skin);
  parts.scale.setScalar(built.scale ?? 1);
  group.add(parts);
  const muzzle = new THREE.Object3D();
  muzzle.position.copy(built.muzzle);
  parts.add(muzzle);
  let ejection: THREE.Object3D | null = null;
  if (built.ejection) {
    ejection = new THREE.Object3D();
    ejection.position.copy(built.ejection);
    parts.add(ejection);
  }
  const a = built.action;
  const action = a ? { ...a, rest: a.part.position.clone(), restRotation: a.part.rotation.clone() } : null;
  return { group, muzzle, spinner: built.spinner ?? null, magazine: built.magazine ?? null, offhand: built.offhand ?? null, animate: built.animate ?? null, action, ejection };
}
