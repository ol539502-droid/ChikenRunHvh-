import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CollisionWorld, LOOT, MAPS, MAP_IDS, MODES, PLAYER, SIM_DT, boxToAabb, createMoveState, stepPlayer, buildNavGraph, createCollisionWorld, findPath, isMapId, isSpaceFree, reachableCount, walkable } from '../src/index';

it('never links elevated routes across an unsupported gap', () => {
  const a = { x: -2, y: 3, z: 0 }, b = { x: 2, y: 3, z: 0 };
  const platform = { minX: -4, maxX: 4, minY: 0, maxY: 3, minZ: -2, maxZ: 2 };
  assert.equal(walkable(a, b, new CollisionWorld(10, [platform])), true);
  const gap = new CollisionWorld(10, [{ ...platform, maxX: -1 }, { ...platform, minX: 1 }]);
  assert.equal(walkable(a, b, gap), false);
  assert.deepEqual(buildNavGraph([a, b], gap).links, [[], []]);
});

it('keeps links checked when the map data was made as they are (no costly re-check at run time)', () => {
  const a = { x: -2, y: 3, z: 0 }, b = { x: 2, y: 3, z: 0 };
  const platform = { minX: -4, maxX: 4, minY: 0, maxY: 3, minZ: -2, maxZ: 2 };
  const gap = new CollisionWorld(10, [{ ...platform, maxX: -1 }, { ...platform, minX: 1 }]);
  assert.deepEqual(buildNavGraph([a, b], gap, [[1], [0]]).links, [[], []]);
  assert.deepEqual(buildNavGraph([a, b], gap, [[1], [0]], true).links, [[1], [0]]);
});

it('offers Mirage alongside the original maps and rejects inherited object keys', () => {
  assert.deepEqual(MAP_IDS, ['mirage', 'farm', 'town', 'sandstown', 'harbor', 'frostbite', 'factory', 'flat', 'night', 'lobby']);
  for (const id of MAP_IDS) assert.equal(isMapId(id), true);
  // Every mode but the zombie ones (one map each: the Graveyard) offers Mirage.
  for (const mode of Object.values(MODES)) assert.ok(mode.zombies || mode.maps.includes('mirage'), mode.id);
  assert.deepEqual(MODES.bomb.maps, ['mirage', 'sandstown', 'harbor']);
  assert.deepEqual(MODES.sandbox.maps, ['mirage', 'flat', 'farm', 'town']);
  assert.deepEqual(MODES.zombie.maps, ['night']);
  assert.deepEqual(MODES.backrooms.maps, ['night']);
  for (const invalid of ['constructor', '__proto__', 'toString', 'missing', null, 1]) assert.equal(isMapId(invalid), false);
});

for (const id of MAP_IDS) {
  const map = MAPS[id];
  const world = createCollisionWorld(map);

  describe(`map: ${map.name}`, () => {
    it('has valid collision boxes', () => {
      const boxes = map.boxes.map(boxToAabb);
      for (const b of boxes) {
        assert.ok(Object.values(b).every(Number.isFinite));
        assert.ok(b.maxX > b.minX && b.maxY > b.minY && b.maxZ > b.minZ);
      }
      // Source brushes and prop collision deliberately overlap at joins.
      if (map.mesh) return;
      const bad: string[] = [];
      const e = 1e-6;
      boxes.forEach((a, i) =>
        boxes.forEach((b, j) => {
          if (j <= i) return;
          if (a.minX < b.maxX - e && a.maxX > b.minX + e && a.minY < b.maxY - e && a.maxY > b.minY + e && a.minZ < b.maxZ - e && a.maxZ > b.minZ + e) {
            bad.push(`#${i} ${map.boxes[i]!.kind} & #${j} ${map.boxes[j]!.kind}`);
          }
        }),
      );
      assert.deepEqual(bad, []);
    });

    it('keeps every box inside the fence', () => {
      for (const b of map.boxes.map(boxToAabb)) {
        assert.ok(b.minX >= -map.halfSize && b.maxX <= map.halfSize && b.minZ >= -map.halfSize && b.maxZ <= map.halfSize);
      }
    });

    it('has spawn points with room to stand', () => {
      assert.ok(map.spawns.length >= 4);
      for (const s of map.spawns) {
        assert.ok(isSpaceFree(s.x, s.y ?? 0, s.z, world), `spawn ${s.x},${s.z} is blocked`);
        if (map.mesh) {
          const state = createMoveState(s.x, s.y ?? 0, s.z);
          stepPlayer(state, { seq: 0, forward: 0, right: 0, jump: false, yaw: 0, pitch: 0 }, SIM_DT, world);
          assert.ok(state.onGround && Math.abs(state.y - (s.y ?? 0)) < 1e-5, 'imported spawns start on the floor');
        }
      }
    });

    it('has enough team spawns for the team modes it supports', () => {
      const teamModes = Object.values(MODES).filter((m) => m.teams && m.maps.includes(id));
      if (teamModes.length === 0) return;
      for (const team of [1, 2] as const) {
        assert.ok(map.spawns.filter((s) => s.team === team).length >= 4, `team ${team} needs spawns`);
      }
    });

    it('puts loot boxes in open air', () => {
      for (const spot of map.loot) {
        const y = (spot.y ?? 0) + LOOT.hover;
        const half = LOOT.boxSize / 2;
        const inside = [...world.all()].some(
          (b) => spot.x + half > b.minX && spot.x - half < b.maxX && y + half > b.minY && y - half < b.maxY && spot.z + half > b.minZ && spot.z - half < b.maxZ,
        );
        assert.ok(!inside, `loot ${spot.x},${spot.z} is inside a box`);
      }
    });

    it('has free vehicle and flag spots', () => {
      for (const v of map.vehicles) assert.ok(isSpaceFree(v.x, 0, v.z, world), `vehicle ${v.x},${v.z}`);
      for (const f of map.flags) assert.ok(isSpaceFree(f.x, f.y ?? 0, f.z, world), `flag ${f.x},${f.z}`);
    });

    it('bot waypoints are open, all linked up, and reach every spawn and bomb site', () => {
      if (!map.nav) return;
      for (const p of map.nav) assert.ok(isSpaceFree(p.x, p.y ?? 0, p.z, world), `waypoint ${p.x},${p.z} is blocked`);
      const graph = buildNavGraph(map.nav, world, map.navLinks);
      // Links marked checked skip this check at run time, so they must all still pass it.
      if (map.navLinksChecked) assert.deepEqual(graph.links, map.navLinks, 'every checked link is walkable');
      // Sealed event levels (zones) are their own little worlds: every waypoint reaches every
      // other in the same area.
      const area = (p: { x: number; z: number }) => map.zones?.find((z) => p.x > z.minX && p.x < z.maxX && p.z > z.minZ && p.z < z.maxZ)?.id ?? 'main';
      for (const name of new Set(map.nav.map(area))) {
        const members: number[] = map.nav.map((p, i) => (area(p) === name ? i : -1)).filter((i) => i >= 0);
        assert.equal(reachableCount(graph, members[0]), members.length, `every waypoint reaches every other (${name})`);
      }
      for (const spot of [...map.spawns, ...(map.bombSites ?? [])]) {
        const settled = createMoveState(spot.x, spot.y ?? 0, spot.z);
        for (let i = 0; i < 64; i++) stepPlayer(settled, { seq: i, forward: 0, right: 0, jump: false, yaw: 0, pitch: 0 }, SIM_DT, world);
        assert.ok(map.nav.some((p) => walkable(settled, p, world)), `${spot.x},${spot.z} can't walk to any waypoint`);
      }
      // A route from chikenT spawn to each site, every leg walkable.
      const spawn = map.spawns.find((s) => s.team === 1)!;
      const tSpawn = createMoveState(spawn.x, spawn.y ?? 0, spawn.z);
      for (let i = 0; i < 64; i++) stepPlayer(tSpawn, { seq: i, forward: 0, right: 0, jump: false, yaw: 0, pitch: 0 }, SIM_DT, world);
      for (const site of map.bombSites ?? []) {
        const route = [tSpawn, ...findPath(graph, tSpawn, site, world)];
        for (let i = 1; i < route.length; i++) assert.ok(walkable(route[i - 1]!, route[i]!, world), `route to ${site.id}, leg ${i}`);
      }
    });

    it('has free bomb sites', () => {
      for (const site of map.bombSites ?? []) assert.ok(isSpaceFree(site.x, site.y ?? 0, site.z, world), `site ${site.id}`);
    });

    it('is within the player radius margin', () => {
      assert.ok(map.halfSize > PLAYER.radius * 10);
    });
  });
}

describe('Factory catwalks', () => {
  it('a chicken can climb the steps and walk onto each catwalk', () => {
    const map = MAPS.factory;
    const world = createCollisionWorld(map);
    // From the floor by the steps: each step is a jump up, and the catwalk continues from the top one.
    for (const [x0, dir, z] of [[-24, 1, -26], [24, -1, 26]] as const) {
      const s = createMoveState(x0 - dir * 2, 0, z);
      const yaw = dir === 1 ? -Math.PI / 2 : Math.PI / 2;
      for (let i = 0; i < 64 * 12; i++) {
        stepPlayer(s, { seq: i, forward: 1, right: 0, jump: s.onGround && s.y < 3.8, yaw, pitch: 0 }, SIM_DT, world, null, 0.1, 1, true);
        if (s.onGround && s.y >= 3.8) break;
      }
      assert.ok(s.y > 3.6, `on the catwalk (y ${s.y.toFixed(2)}, x ${s.x.toFixed(1)})`);
    }
  });
});
