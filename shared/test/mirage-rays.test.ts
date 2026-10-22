import assert from 'node:assert/strict';
import { it } from 'node:test';
import { MAPS, createCollisionWorld, makeRay, mulberry32, rayAabb, raycastWorld, type RayHit } from '../src/index';

it('grid rays match every-box hits across Mirage, including skipped boxes and vertical rays', () => {
  const world = createCollisionWorld(MAPS.mirage);
  const random = mulberry32(42);
  for (let i = 0; i < 160; i++) {
    const p = MAPS.mirage.nav![Math.floor(random() * 755)]!;
    const yaw = random() * Math.PI * 2, pitch = (random() - .5) * Math.PI;
    const ray = makeRay({ x:p.x, y:(p.y??0)+1.3, z:p.z }, i === 0 ? {x:0,y:-1,z:0} : { x:Math.cos(yaw)*Math.cos(pitch), y:Math.sin(pitch), z:Math.sin(yaw)*Math.cos(pitch) });
    const range = i % 2 ? 200 : 15;
    const skip = new Set(i % 3 ? [] : [Math.floor(random() * world.size)]);
    let expected: RayHit | null = ray.dy < 0 && -ray.oy / ray.dy <= range ? {t:-ray.oy/ray.dy,nx:0,ny:1,nz:0,id:-1} : null;
    const hit: RayHit = {t:0,nx:0,ny:0,nz:0};
    for (const [id, box] of world.entries()) {
      if (skip.has(id)) continue;
      const t = rayAabb(ray, box, expected?.t ?? range, hit);
      if (t >= 0 && (!expected || t < expected.t)) expected = {...hit,id};
    }
    assert.deepEqual(raycastWorld(ray, world, range, skip), expected, `ray ${i}`);
  }
});

it('grid rays match every-box hits for many rays: long, short, axis-aligned, on cell edges, from inside boxes', () => {
  const world = createCollisionWorld(MAPS.mirage);
  const random = mulberry32(1234);
  const nav = MAPS.mirage.nav!;
  const boxes = [...world.entries()];
  const brute = (ray: ReturnType<typeof makeRay>, range: number, skip: ReadonlySet<number>): RayHit | null => {
    let expected: RayHit | null = ray.dy < 0 && ray.oy >= 0 && -ray.oy / ray.dy <= range ? {t:-ray.oy/ray.dy,nx:0,ny:1,nz:0,id:-1} : null;
    const hit: RayHit = {t:0,nx:0,ny:0,nz:0};
    for (const [id, box] of boxes) {
      if (skip.has(id)) continue;
      const t = rayAabb(ray, box, expected?.t ?? range, hit);
      if (t >= 0 && (!expected || t < expected.t)) expected = {...hit,id};
    }
    return expected;
  };
  for (let i = 0; i < 1500; i++) {
    const p = nav[Math.floor(random() * nav.length)]!;
    let origin = { x:p.x, y:(p.y??0)+0.2+random()*1.6, z:p.z };
    if (i % 7 === 0) origin = { x: Math.round(origin.x / 4) * 4, y: origin.y, z: Math.round(origin.z / 4) * 4 }; // on cell corners
    if (i % 11 === 0) { const [, b] = boxes[Math.floor(random() * boxes.length)]!; origin = { x:(b.minX+b.maxX)/2, y:(b.minY+b.maxY)/2, z:(b.minZ+b.maxZ)/2 }; } // inside a box
    let dir: { x: number; y: number; z: number };
    if (i % 5 === 0) dir = [{x:1,y:0,z:0},{x:-1,y:0,z:0},{x:0,y:0,z:1},{x:0,y:0,z:-1},{x:0,y:1,z:0}][i % 25 / 5]!; // axis-aligned
    else { const yaw = random() * Math.PI * 2, pitch = (random() - .5) * 0.6; dir = { x:Math.cos(yaw)*Math.cos(pitch), y:Math.sin(pitch), z:Math.sin(yaw)*Math.cos(pitch) }; }
    const ray = makeRay(origin, dir);
    const range = [3, 15, 80, 250][i % 4]!;
    const skip = new Set(i % 3 ? [] : [Math.floor(random() * world.size)]);
    assert.deepEqual(raycastWorld(ray, world, range, skip), brute(ray, range, skip), `ray ${i}`);
  }
});

it('a ray with a non-finite origin or direction returns at once instead of walking forever', () => {
  const world = createCollisionWorld(MAPS.mirage);
  for (const bad of [{ox:0,oy:1,oz:0,dx:NaN,dy:0,dz:1}, {ox:NaN,oy:1,oz:0,dx:1,dy:0,dz:0}, {ox:0,oy:1,oz:Infinity,dx:0,dy:0,dz:1}, {ox:0,oy:1,oz:0,dx:0,dy:0,dz:NaN}])
    assert.equal(raycastWorld(bad, world, 50), null);
  // A NaN or negative range hits nothing, as before.
  for (const maxT of [NaN, -1]) assert.equal(raycastWorld({ox:0,oy:1,oz:0,dx:1,dy:0,dz:0}, world, maxT), null);
});
