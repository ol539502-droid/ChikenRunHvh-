import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CommandBuffer, CommandChoker, ExploitResource, NetworkSimulator, correctMovement, createAnimation, stepAnimation,
  maximumBodyDelta, observableRecord, ResolverSystem, buildHvhMatrix, matrixPoints, pointSafety, makeRay, normalize, rayHvhMatrix,
  auditShot, createCollisionWorld, MAPS, WEAPONS, scanRage, DEFAULT_RAGE, SIM_DT, stepPlayer, createMoveState,
  traceHvhCover, coverDamageScale, CollisionWorld, HvhExtensionHost, defaultHvhLoadout, hvhWeapon, hvhSpread, bodyScale, type ObservableRecord } from '../src/index';

const record = (t = 100): ObservableRecord => ({ pid: 2, tick: 6, t, origin: { x: 0, y: 0, z: -15 }, velocity: { x: 0, y: 0, z: 0 },
  eyeYaw: 0, lowerBodyYaw: 0, speed: 0, crouch: 0, grounded: true, turnWeight: 0, alive: true, hp: 100, armor: 0, fired: false, concealed: false, defensive: false });
const eye = { x: 0, y: 1.3, z: 10 };
const direction = (point: {x: number; y: number; z: number}) => normalize({x: point.x - eye.x, y: point.y - eye.y, z: point.z - eye.z});
describe('guide-driven simulation contracts', () => {
  it('uses immutable commands, preserves movement through anti-aim and never grants batch speed', () => {
    const f = { seq: 1, forward: 1, right: 0.25, yaw: 0.3, pitch: 0, jump: false };
    const choker = new CommandChoker(), [cmd] = choker.push(f, 0);
    assert.ok(Object.isFrozen(cmd));
    f.forward = 0;
    assert.equal(cmd!.forward, 1);
    f.forward = 1;
    const corrected = correctMovement(f, -2);
    const world = createCollisionWorld(MAPS.flat), a = createMoveState(20, 0, 20), b = { ...a };
    stepPlayer(a, f, SIM_DT, world); stepPlayer(b, corrected, SIM_DT, world);
    assert.ok(Math.hypot(a.x - b.x, a.z - b.z) < 1e-10);
    const queue = new CommandBuffer();
    for (let seq = 1; seq <= 13; seq++) assert.ok(queue.enqueue({ ...f, seq }));
    assert.equal(queue.enqueue(f), false); assert.equal(queue.next()!.seq, 1); assert.equal(queue.size, 12);
  });
  it('creates bounded real body matrices and an explicit observable allow-list', () => {
    const a = createAnimation();
    for (let tick = 0; tick < 30; tick++) stepAnimation(a, { eyeYaw: 0, desiredDelta: 10, speed: 0, crouch: 0, grounded: true, active: true }, tick);
    assert.ok(Math.abs(a.bodyYaw - maximumBodyDelta(0, 0, true)) < 1e-8);
    const observable = observableRecord(2, 30, 100, record().origin, record().velocity, a, 100, 0, true);
    assert.equal('bodyYaw' in observable, false); assert.equal('maxDelta' in observable, false);
    assert.ok(maximumBodyDelta(6, 0, true) < a.maxDelta); assert.ok(maximumBodyDelta(0, 1, false) < a.maxDelta);
  });
  it('never copies hidden properties into resolver records or extension observations', () => {
    const r = record();
    Object.defineProperty(r, 'bodyYaw', { enumerable: true, get() { throw Error('Private authority was accessed'); } });
    const resolver = new ResolverSystem(); resolver.observe(r);
    assert.equal('bodyYaw' in resolver.records(2, 100)[0]!, false);
    const hooks = new HvhExtensionHost(); let observed = false;
    hooks.register({ id: 'observable-test', onPlayerState(s) {
      observed = true; assert.equal('bodyYaw' in s, false); assert.ok(Object.isFrozen(s.origin));
    } });
    hooks.observe(r); assert.equal(observed, true); assert.equal(hooks.errors.length, 0);
  });
  it('bounds controller capabilities, freezes own configurations, and disables failing callbacks', () => {
    const hooks = new HvhExtensionHost();
    hooks.register({ id: 'bounded', onCommandBuild: () => ({ forward: 99, right: -99, seq: 999, yaw: 99 }),
      onAntiAim(loadout) {
        assert.ok(Object.isFrozen(loadout.antiAim));
        return { antiAim: { ...loadout.antiAim, desync: 999 }, core: { ...loadout.core!, fakeLag: 999 } };
      } });
    const command = hooks.command({seq: 1, forward: 0, right: 0, yaw: 0.5, pitch: 0, jump: false});
    assert.deepEqual([command.seq, command.yaw, command.forward, command.right], [1, 0.5, 1, -1]);
    const own = hooks.antiAim(defaultHvhLoadout()); assert.equal(own.antiAim.desync, 58); assert.equal(own.core?.fakeLag, 12);
    let calls = 0; hooks.register({id: 'broken', onRender() { calls++; throw Error('bad callback'); }});
    hooks.render(); hooks.render(); assert.equal(calls, 1); assert.equal(hooks.errors.length, 1);
  });
  it('transitions crouch over simulation ticks and applies velocity, air and firing heat to spread', () => {
    const world = new CollisionWorld(100), state = createMoveState(0, 0, 0);
    const command = {seq: 1, forward: 0, right: 0, yaw: 0, pitch: 0, jump: false, crouch: true};
    stepPlayer(state, command, SIM_DT, world, null, 0, 1, true);
    assert.ok(state.crouchAmount! > 0 && state.crouchAmount! < 1); assert.ok(bodyScale(state) > 0.7);
    for (let i = 0; i < 7; i++) stepPlayer(state, command, SIM_DT, world, null, 0, 1, true);
    assert.equal(state.crouchAmount, 1); assert.equal(bodyScale(state), 0.7);
    stepPlayer(state, {...command, crouch: false}, SIM_DT, world, null, 0, 1, true); assert.ok(state.crouchAmount! > 0);
    const w = hvhWeapon(WEAPONS.rifle), still = hvhSpread(w, 0, false, false, 0);
    assert.ok(hvhSpread(w, 2, false, false, 0) > still);
    assert.ok(hvhSpread(w, 6, false, false, 0) > hvhSpread(w, 2, false, false, 0));
    assert.ok(hvhSpread(w, 0, true, false, 0) > still); assert.ok(hvhSpread(w, 0, false, false, 1) > still);
  });
  it('makes wrong-side head shots miss and safe body geometry overlap all hypotheses', () => {
    const r = record(), d = maximumBodyDelta(0, 0, true), matrices = [-d, 0, d].map(y => buildHvhMatrix(r.origin, y));
    const rightHead = matrixPoints(matrices[2]!, ['head'], 0)[0]!.point;
    assert.equal(pointSafety(eye, rightHead, matrices, ['head']), 1 / 3);
    const body = matrixPoints(matrices[2]!, ['stomach'], 0)[0]!.point;
    assert.equal(pointSafety(eye, body, matrices, ['stomach']), 1);
    assert.equal(rayHvhMatrix(makeRay(eye, direction(rightHead)), matrices[0]!, 100, ['head']), null);
    assert.ok(rayHvhMatrix(makeRay(eye, direction(rightHead)), matrices[2]!, 100, ['head']));
  });
  it('learns from resolver misses and hits, ignores spread and rejection, and adapts after inversion', () => {
    const r = record(), resolver = new ResolverSystem(); resolver.observe(r);
    const initial = resolver.resolve(r).hypotheses[0]!;
    resolver.feedback(2, initial.source, 'SPREAD', 100); assert.equal(resolver.resolve(r).hypotheses[0]!.source, initial.source);
    resolver.feedback(2, initial.source, 'SERVER_REJECTED', 100); assert.equal(resolver.resolve(r).hypotheses[0]!.source, initial.source);
    resolver.feedback(2, initial.source, 'RESOLVER', 100);
    const alternate = resolver.resolve(r).hypotheses[0]!; assert.notEqual(alternate.source, initial.source);
    resolver.feedback(2, alternate.source, 'HIT', 100); assert.equal(resolver.resolve(r).hypotheses[0]!.source, alternate.source);
    resolver.feedback(2, alternate.source, 'RESOLVER', 100); assert.notEqual(resolver.resolve(r).hypotheses[0]!.source, alternate.source);
  });
  it('audits actual rays without giving the resolver hidden truth', () => {
    const r = record(), d = maximumBodyDelta(0, 0, true), auth = buildHvhMatrix(r.origin, d), wrong = buildHvhMatrix(r.origin, -d);
    const dir = direction(matrixPoints(wrong, ['head'], 0)[0]!.point), world = new CollisionWorld(100);
    const intent = { target: 2, source: 'LEFT' as const, recordT: 100, yaw: -d };
    assert.equal(auditShot(intent, eye, dir, [dir], auth, true, world, WEAPONS.rifle), 'RESOLVER');
    assert.equal(auditShot(intent, eye, dir, [dir], auth, false, world, WEAPONS.rifle), 'RECORD_INVALID');
    const accurate = direction(matrixPoints(auth, ['head'], 0)[0]!.point);
    assert.equal(auditShot({ ...intent, yaw: d }, eye, accurate, [{x: 1, y: 0, z: 0}], auth, true, world, WEAPONS.rifle), 'SPREAD');
  });
  it('force-safe selection chooses geometric overlap and rejects expired history', () => {
    const r = record(), resolver = new ResolverSystem(); resolver.observe(r);
    const input = { now: 150, eye, w: WEAPONS.rifle, speed: 0, airborne: false, ads: false, world: new CollisionWorld(100), records: [r], resolver,
      settings: { ...DEFAULT_RAGE, minDamage: 10, forceSafe: true, hitchance: 0.4 } };
    const candidate = scanRage(input); assert.ok(candidate); assert.equal(candidate.safety, 1); assert.notEqual(candidate.group, 'head');
    assert.equal(scanRage({ ...input, now: 450 }), null);
    const riskier = scanRage({...input, w: hvhWeapon(WEAPONS.sniper), settings: {...input.settings, forceSafe: false, groups: ['head'], preferSafe: false, hitchance: 0}});
    const safer = scanRage({...input, w: hvhWeapon(WEAPONS.sniper), settings: {...input.settings, hitchance: 0}});
    assert.ok(riskier && safer && riskier.damage > safer.damage, 'safe body overlap costs head damage');
  });
  it('gates shotgun candidates on whole-shot damage and verifies the sampled result', () => {
    for (const { id, group, minDamage, armor } of [
      { id: 'shotgun' as const, group: 'stomach' as const, minDamage: 20, armor: 0 },
      { id: 'autoshotgun' as const, group: 'stomach' as const, minDamage: 20, armor: 0 },
      { id: 'shotgun' as const, group: 'chest' as const, minDamage: 115, armor: 0 },
      { id: 'shotgun' as const, group: 'stomach' as const, minDamage: 105, armor: 10 },
    ]) {
      const r = { ...record(), origin: { x: 0, y: 0, z: 2 }, hp: 200, armor }, resolver = new ResolverSystem(); resolver.observe(r);
      const input = { now: 100, eye: { x: 0, y: 1.3, z: 0 }, w: hvhWeapon(WEAPONS[id]), speed: 0, airborne: false, ads: false,
        world: new CollisionWorld(100), records: [r], resolver,
        settings: { ...DEFAULT_RAGE, resolver: false, preferSafe: false, groups: [group], pointScale: 0, minDamage, hitchance: 1 } };
      const candidate = scanRage(input);
      assert.ok(candidate, `${id} ${group} must meet whole-shot minimum ${minDamage}`);
      assert.ok(candidate.damage >= minDamage); assert.equal(candidate.chance, 1);
      assert.equal(scanRage({ ...input, settings: { ...input.settings, minDamage: 150 } }), null,
        'an optimistic cheap bound cannot bypass sampled damage');
    }
  });
  it('keeps a qualifying head shot in the bounded shortlist when body damage is below the minimum', () => {
    const r = { ...record(), origin: { x: 0, y: 0, z: -10 } }, resolver = new ResolverSystem(); resolver.observe(r);
    const input = { now: 100, eye: { x: 0, y: 1.3, z: 0 }, w: hvhWeapon(WEAPONS.rifle), speed: 0, airborne: false, ads: false,
      world: new CollisionWorld(100), records: [r], resolver, settings: { ...DEFAULT_RAGE, minDamage: 70, hitchance: 0.5 } };
    const candidate = scanRage(input);
    assert.ok(candidate); assert.equal(candidate.group, 'head');
    assert.ok(candidate.damage >= 70); assert.ok(candidate.chance >= 0.5);
  });
  it('stores command time for Double Tap, shares it with Hide Shots, and never changes fire rate', () => {
    const resource = new ExploitResource();
    for (let i = 0; i < 256; i++) resource.step(i, false, false);
    assert.equal(resource.charge, 1);
    const shot = resource.fire(250, 'doubleTap', 256); assert.equal(shot.shots, 2); assert.equal(resource.ticks, 0);
    assert.equal(resource.fire(250, 'doubleTap', 256).shots, 0);
    for (let i = 0; i < 16; i++) resource.step(257 + i, true, false);
    assert.equal(resource.fire(250, 'hideShots', 273).hidden, false, 'DT emptied the shared resource');
    resource.ticks = 16; resource.playerTick = resource.nextAttackTick;
    const hidden = resource.fire(250, 'hideShots', 273); assert.equal(hidden.hidden, true); assert.equal(resource.ticks, 2);
    assert.ok(resource.protectedUntil > 273); assert.equal(resource.defend(273), false);
  });
  it('chokes real commands and delivers seeded simulated network batches in time order', () => {
    const choke = new CommandChoker(), network = new NetworkSimulator<readonly import('../src/index').InputFrame[]>({latencyMs: 50, jitterMs: 0, loss: 0}, 1);
    const f = {seq: 1, forward: 1, right: 0, yaw: 0, pitch: 0, jump: false};
    assert.equal(choke.push(f, 2).length, 0); assert.equal(choke.push({...f,seq: 2}, 2).length, 0);
    network.send(choke.push({...f,seq: 3}, 2), 100);
    assert.equal(network.receive(149).length, 0); assert.deepEqual(network.receive(150)[0]!.map(c => c.seq), [1,2,3]);
  });
  it('uses movement acceleration and thickness-based penetration rather than instantaneous stop or flat wall loss', () => {
    const world = createCollisionWorld(MAPS.flat), s = createMoveState(20, 0, 20), f = {seq: 1, forward: 1, right: 0, yaw: 0, pitch: 0, jump: false};
    stepPlayer(s, f, SIM_DT, world, null, 0, 1, true); assert.ok(s.horizontalSpeed > 0 && s.horizontalSpeed < 6);
    for (let i = 0; i < 12; i++) stepPlayer(s, f, SIM_DT, world, null, 0, 1, true);
    stepPlayer(s, {...f,forward: 0}, SIM_DT, world, null, 0, 1, true); assert.ok(s.horizontalSpeed > 0);
    const cover = new CollisionWorld(100); cover.add(1, {minX: -1,maxX: 1,minY: 0,maxY: 3,minZ: -2,maxZ: -1});
    const thin = coverDamageScale(traceHvhCover(makeRay(eye,{x: 0,y: 0,z: -1}),cover,100,()=>true),25);
    cover.remove(1); cover.add(1,{minX:-1,maxX:1,minY:0,maxY:3,minZ:-5,maxZ:-1});
    const thick = coverDamageScale(traceHvhCover(makeRay(eye,{x:0,y:0,z:-1}),cover,100,()=>true),25);
    assert.ok(thick < thin && thin < 1);
  });
});
