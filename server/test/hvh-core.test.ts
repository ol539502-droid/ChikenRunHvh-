import assert from 'node:assert/strict';
import { it } from 'node:test';
import { SIM_DT, PLAYER, LOOT, normalize, unpackPlayer, buildHvhMatrix, maximumBodyDelta, observableRecord, rayHvhChicken, makeRay, type ShotEvent } from '@game/shared';
import { History } from '../src/rooms/History';
import { GameRoom } from '../src/rooms/GameRoom';
import { addPlayer, fakeIo, makeRoom, place, stepRoom } from './helpers';

it('ordinary and Manual HvH players receive authoritative slow walk through validated input', t => {
  for (const mode of ['ffa','hvh'] as const) {
    const {room}=makeRoom(mode,'flat');t.after(()=>room.close());
    const p=addPlayer(room,'Manual walker');room.startNow();place(p,20,20);
    assert.equal(p.hvhEnabled,false);
    let now=performance.now();
    for(let seq=1;seq<=12;seq++) {
      room.handleInput(p,{seq,forward:1,right:1,yaw:0,pitch:0,jump:false,slowWalk:true});
      stepRoom(room,now+=SIM_DT*1000);
    }
    assert.equal(p.lastInput?.slowWalk,true);
    assert.ok(p.state.horizontalSpeed > 0 && p.state.horizontalSpeed <= PLAYER.speed*PLAYER.slowWalkSpeed);
    const slow=p.state.horizontalSpeed;
    room.handleInput(p,{seq:13,forward:1,right:1,yaw:0,pitch:0,jump:false,slowWalk:1 as never});
    stepRoom(room,now+=SIM_DT*1000);
    assert.equal(p.lastInput?.slowWalk,false,'the server accepts only a boolean slow-walk request');
    assert.ok(p.state.horizontalSpeed>slow);
  }
});

it('batched inputs advance once per server tick and choked remote snapshots keep their historical time', t => {
  const {room} = makeRoom('hvh', 'flat'); t.after(() => room.close());
  const a = addPlayer(room, 'A'), b = addPlayer(room, 'B'); room.startNow(); place(a, 20, 20); place(b, 20, 10);
  let now = performance.now() + 100; // Expire the initial join snapshot before measuring the new choke policy.
  a.hvh.core!.fakeLag = 4;
  a.hvhEnabled = true;
  for (let seq = 1; seq <= 13; seq++) room.handleInput(a, {seq, forward: 1, right: 0, yaw: 0, pitch: 0, jump: false});
  assert.equal(a.state.z, 20); stepRoom(room, now);
  assert.equal(a.lastSeq, 1); assert.equal(a.commands.size, 12);
  assert.ok(20 - a.state.z < PLAYER.speed * SIM_DT);
  const first = unpackPlayer(room.snapshot(now, b.pid).p.find(s => s[0] === a.pid)!);
  now += SIM_DT * 1000; stepRoom(room, now);
  const held = unpackPlayer(room.snapshot(now, b.pid).p.find(s => s[0] === a.pid)!);
  const own = unpackPlayer(room.snapshot(now, a.pid).p.find(s => s[0] === a.pid)!);
  assert.equal(held.simulationTime, first.simulationTime); assert.equal(held.z, first.z);
  assert.ok(own.simulationTime! > held.simulationTime!); assert.ok(own.z < held.z);
});

it('a gap in HvH commands preserves held-jump state without inventing landing jumps; a held key hops again once commands resume', t => {
  for (const autoHop of [false, true]) {
    const {room} = makeRoom('hvh','flat'); t.after(() => room.close());
    const p=addPlayer(room,'Jumper'); room.startNow(); place(p,20,20);
    p.hvhEnabled = true;
    let now=performance.now();
    room.handleInput(p,{seq:1,forward:0,right:0,yaw:0,pitch:0,jump:true,autoHop});
    stepRoom(room,now+=SIM_DT*1000);
    for(let tick=0;tick<80;tick++) stepRoom(room,now+=SIM_DT*1000);
    assert.equal(p.state.onGround,true,'idle simulation lands without replaying the helper');
    assert.equal(p.state.jumpHeld,true,'no command means no observed button release');
    room.handleInput(p,{seq:2,forward:0,right:0,yaw:0,pitch:0,jump:true,autoHop});
    stepRoom(room,now+=SIM_DT*1000);
    assert.equal(p.state.onGround,false,'holding Space is a real command: it hops again on landing');
  }
});

it('rejects historical records from an earlier life or across a teleport', () => {
  const history = new History(), sample = {x: 0, y: 0, z: 0, yaw: 0, alive: true, scale: 1};
  history.push({...sample, t: 100}); history.push({...sample, x: 20, t: 200});
  assert.equal(history.atValid(150, 200), null); assert.equal(history.atValid(200, 200), null);
  history.push({...sample, x: 20, t: 216}); assert.ok(history.atValid(216, 216));
  history.clear(); history.push({...sample, t: 300});
  assert.equal(history.atValid(250, 310), null); assert.equal(history.atValid(300, 601), null);
  assert.equal(history.atValid(350, 310), null);
});

it('reports actor obstruction and weapon rejection without teaching a false resolver hit', t => {
  const {room} = makeRoom('hvh', 'flat'); t.after(() => room.close());
  const a = addPlayer(room, 'Shooter'), target = addPlayer(room, 'Far target'), blocker = addPlayer(room, 'Near target');
  a.info.team = 1; target.info.team = blocker.info.team = 2; room.startNow();
  place(a, 20, 20); place(target, 20, 12); place(blocker, 20, 16);
  a.shieldUntil = target.shieldUntil = blocker.shieldUntil = 0;
  const shots: ShotEvent[] = [];
  Object.defineProperty(a, 'socket', {value: {emit(event: string, data: ShotEvent) {if (event === 'shot') shots.push(data);}, to() {return {emit() {}};}, leave() {}, volatile: {emit() {}}}});
  let now = performance.now() + 1;
  const d = normalize({x: 0, y: 0.65 - PLAYER.eyeHeight, z: -8});
  const request = (shot: number) => ({shot, weapon: a.weapon, dx: d.x, dy: d.y, dz: d.z, t: now, aiming: true,
    intent: {target: target.pid, source: 'CENTER' as const, recordT: now, yaw: 0}});
  room.handleFire(a, request(1)); stepRoom(room, now);
  assert.ok(blocker.hp < 100); assert.equal(target.hp, 100);
  assert.equal(shots.at(-1)?.audit?.reason, 'OCCLUSION'); assert.equal(shots.at(-1)?.audit?.damage, 0);
  now += SIM_DT * 1000; a.reloadUntil = now + 100;
  room.handleFire(a, request(2)); stepRoom(room, now);
  assert.equal(shots.at(-1)?.audit?.reason, 'SERVER_REJECTED'); assert.equal(a.lastShotSeq, 1);
});

it('HvH bots fire through the normal queue, damage opponents and ignore teammates', t => {
  const {io, events} = fakeIo();
  const room = new GameRoom(io, {id: 'hvh-bots', code: 'BOT01', name: 'HvH bot test', mode: 'hvh', map: 'flat', private: true, bots: 1}, {});
  t.after(() => room.close());
  const human = addPlayer(room, 'Opponent'); room.bots.add();
  const bot = [...room.players.values()].find(p => p.info.bot)!;
  human.info.team = 1; bot.info.team = 2; room.startNow(); place(human, 20, 12); place(bot, 20, 20);
  human.shieldUntil = bot.shieldUntil = 0;
  let now = performance.now() + 1;
  for (let tick = 0; tick < 64; tick++) {
    // The fixture advances simulation without waiting for wall-clock token refills.
    bot.takeInputToken = () => true;
    stepRoom(room, now); now += SIM_DT * 1000;
  }
  assert.ok(events.some(e => e.event === 'shot' && (e.args[0] as ShotEvent).pid === bot.pid));
  assert.ok(human.hp < 100 || !human.alive, 'public-state controller must land actual damage');
  human.info.team = bot.info.team; human.respawn(20, 12, 0, now, 0);
  bot.fireQueue.length = 0; bot.resolver.clear();
  const accepted = bot.lastShotSeq;
  for (let tick = 0; tick < 32; tick++) {
    bot.takeInputToken = () => true;
    stepRoom(room, now); now += SIM_DT * 1000;
  }
  assert.equal(bot.lastShotSeq, accepted, 'no enemy observations means no assisted friendly fire');
});

it('only an unobstructed wrong-side shot teaches a resolver miss', t => {
  for (const blockerZ of [12.5, -12.5, null, 'loot'] as const) {
    const {room} = makeRoom('hvh', 'flat'); t.after(() => room.close());
    const a = addPlayer(room, 'Shooter'), target = addPlayer(room, 'Target'), blocker = addPlayer(room, 'Blocker');
    a.info.team = 1; target.info.team = blocker.info.team = 2; room.startNow();
    place(a, 20, 25); place(target, 20, 0);
    for (const p of [a, target, blocker]) { p.shieldUntil = 0; p.armor = 0; }
    const delta = maximumBodyDelta(0, 0, true), eye = {x: 20, y: PLAYER.eyeHeight, z: 25};
    const point = buildHvhMatrix(target.state, -delta).boxes[0]!.center;
    const dir = normalize({x: point.x - eye.x, y: point.y - eye.y, z: point.z - eye.z});
    if (blockerZ === null || blockerZ === 'loot') blocker.alive = false;
    else place(blocker, eye.x + (point.x - eye.x) * (blockerZ - eye.z) / (point.z - eye.z), blockerZ);
    if (blockerZ === 'loot') Object.assign(room.loot, {boxes: [{id: 0, phase: 0, pickup: null, until: 0, floor: 0,
      x: (eye.x + point.x) / 2, y: (eye.y + point.y) / 2, z: (eye.z + point.z) / 2}]});
    const now = performance.now();
    for (const [p, yaw] of [[target, delta], [blocker, 0]] as const) {
      p.history.clear(); p.history.push({t: now, ...p.state, yaw, pitch: 0, alive: p.alive, scale: 1});
    }
    const record = observableRecord(target.pid, 0, now, target.state, {x: 0, y: 0, z: 0}, target.animation, 100, 0, true);
    a.resolver.observe(record);
    const shots: ShotEvent[] = [];
    Object.defineProperty(a, 'socket', {value: {emit(event: string, data: ShotEvent) {if (event === 'shot') shots.push(data);}, to() {return {emit() {}};}, leave() {}}});
    room.handleFire(a, {shot: 1, weapon: a.weapon, dx: dir.x, dy: dir.y, dz: dir.z, t: now, aiming: true,
      intent: {target: target.pid, recordT: now, source: 'LEFT', yaw: -delta}});
    stepRoom(room, now + SIM_DT * 1000);
    const blocked = blockerZ === 12.5 || blockerZ === 'loot';
    assert.equal(target.hp, 100);
    if (blockerZ === 12.5) assert.ok(blocker.hp < 100);
    if (blockerZ === 'loot') assert.equal(room.loot.states()[0]?.phase, 1, 'audit retains the box obstruction after the pellet smashes it');
    assert.equal(shots.at(-1)?.audit?.reason, blocked ? 'OCCLUSION' : 'RESOLVER');
    assert.equal(a.resolver.resolve(record).misses, blocked ? 0 : 1);
  }
});

it('recharge follows effective choke rather than an inactive fake-lag setting', t => {
  for (const [enabled, mode, expected] of [[true, 'velocity', 1], [true, 'static', 0], [false, 'static', 1]] as const) {
    const {room} = makeRoom('hvh', 'flat'); t.after(() => room.close());
    const p = addPlayer(room, 'Charging'); room.startNow(); place(p, 20, 20);
    p.hvhEnabled = enabled; p.hvh.core!.fakeLag = 8; p.hvh.core!.fakeLagMode = mode;
    let now = performance.now();
    for (let tick = 0; tick < 256; tick++) stepRoom(room, now += SIM_DT * 1000);
    assert.equal(p.resource.charge, expected, `${enabled ? 'assisted' : 'Manual'} ${mode}`);
  }
});

it('loot behind the authoritative target does not turn a spread miss into obstruction', t => {
  const {room} = makeRoom('hvh', 'flat'); t.after(() => room.close());
  const a = addPlayer(room, 'Shooter'), target = addPlayer(room, 'Target');
  a.info.team = 1; target.info.team = 2; room.startNow(); place(a, 20, 25); place(target, 20, 0);
  a.shieldUntil = target.shieldUntil = target.armor = 0; a.state.horizontalSpeed = 6;
  const now = performance.now(), eye = {x: 20, y: PLAYER.eyeHeight, z: 25};
  const predictedYaw = -10 * Math.PI / 180, actualYaw = -58 * Math.PI / 180;
  const dir = normalize({x: 0.215598676717902, y: 1.25 - eye.y, z: -0.28692065209303036 - eye.z});
  const ray = makeRay(eye, dir), lootEntry = 25.02;
  assert.ok(rayHvhChicken(ray, 20, 0, 0, actualYaw, 100)!.t < lootEntry);
  assert.ok(rayHvhChicken(ray, 20, 0, 0, predictedYaw, 100)!.t > lootEntry);
  const centerT = lootEntry + LOOT.boxSize / 2 / Math.abs(dir.z);
  Object.assign(room.loot, {boxes: [{id: 0, phase: 0, pickup: null, until: 0, floor: 0,
    x: eye.x + dir.x * centerT, y: eye.y + dir.y * centerT, z: eye.z + dir.z * centerT}]});
  target.history.clear(); target.history.push({t: now, ...target.state, yaw: actualYaw, pitch: 0, alive: true, scale: 1});
  const shots: ShotEvent[] = [];
  Object.defineProperty(a, 'socket', {value: {emit(event: string, data: ShotEvent) {if (event === 'shot') shots.push(data);}, to() {return {emit() {}};}, leave() {}}});
  room.handleFire(a, {shot: 2, weapon: a.weapon, dx: dir.x, dy: dir.y, dz: dir.z, t: now, aiming: true,
    intent: {target: target.pid, recordT: now, source: 'CENTER', yaw: predictedYaw}});
  stepRoom(room, now + SIM_DT * 1000);
  assert.equal(shots.at(-1)?.audit?.reason, 'SPREAD');
});
