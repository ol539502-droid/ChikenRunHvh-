import type { GameServer } from '../types';
import { ArmsRoom } from './ArmsRoom';
import { BombRoom } from './BombRoom';
import { CtfRoom } from './CtfRoom';
import { HvhRoom } from './HvhRoom';
import { GameRoom, type RoomHooks, type RoomOptions } from './GameRoom';
import { SandboxRoom } from './SandboxRoom';
import { TrainingRoom } from './TrainingRoom';
import { ZombieRoom } from './ZombieRoom';

/** Picks the room implementation for a mode. */
export function createRoom(io: GameServer, options: RoomOptions, hooks: RoomHooks): GameRoom {
  switch (options.mode) {
    case 'arms':
      return new ArmsRoom(io, options, hooks);
    case 'bomb':
    case 'face':
      return new BombRoom(io, options, hooks);
    case 'ctf':
      return new CtfRoom(io, options, hooks);
    case 'sandbox':
      return new SandboxRoom(io, options, hooks);
    case 'zombie':
    case 'backrooms':
      return new ZombieRoom(io, options, hooks);
    case 'hvh':
      return new HvhRoom(io, options, hooks);
    case 'training':
      return new TrainingRoom(io, options, hooks);
    default:
      return new GameRoom(io, options, hooks);
  }
}
