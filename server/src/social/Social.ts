import {
  MODES,
  SOCIAL,
  levelFor,
  type FriendsState,
  type JoinResponse,
  type ModeId,
  type PartyState,
  type SocialResult,
} from '@game/shared';
import type { FriendRow, GameDatabase } from '../db/Database';
import type { GameRoom } from '../rooms/GameRoom';
import type { RoomManager } from '../rooms/RoomManager';
import type { GameSocket } from '../types';
import { TokenBucket, isRecord, randomString } from '../util';

interface Party {
  id: string;
  leader: number;
  /** In the order they joined. */
  members: number[];
  /** Invited user → when the invite runs out. */
  invites: Map<number, number>;
}

const ok: SocialResult = { ok: true };
const fail = (error: string): SocialResult => ({ ok: false, error });

/**
 * Friends, online status and parties.
 *
 * - Online status comes from live sockets (an account can have several tabs); "what they're
 *   playing" from the room manager. Friends hear about changes as they happen.
 * - Friends live in the database (registered accounts only).
 * - Parties live in memory: a leader and up to SOCIAL.partySize friends. When the leader starts a
 *   match everyone in the menu goes with them, on one team. Dropping offline for a while (or
 *   leaving) takes you out; an empty-ish party (one member) disbands.
 *
 * Everything a client asks for is checked here: who's friends with whom, who leads, who was
 * invited, limits and a rate limit per socket.
 */
export class Social {
  private readonly sockets = new Map<number, Set<GameSocket>>();
  private readonly parties = new Map<string, Party>();
  private readonly partyOf = new Map<number, Party>();
  private readonly offlineTimers = new Map<number, NodeJS.Timeout>();

  constructor(
    private readonly db: GameDatabase,
    private readonly rooms: RoomManager,
  ) {
    rooms.onActivity = (userId) => this.presenceChanged(userId);
  }

  /** A socket connected: track it and listen to its friend/party requests. */
  attach(socket: GameSocket): void {
    const userId = socket.data.userId;
    const set = this.sockets.get(userId) ?? new Set<GameSocket>();
    const cameOnline = set.size === 0;
    set.add(socket);
    this.sockets.set(userId, set);
    const timer = this.offlineTimers.get(userId);
    if (timer) {
      clearTimeout(timer);
      this.offlineTimers.delete(userId);
    }
    if (cameOnline) this.presenceChanged(userId);
    socket.on('disconnect', () => this.detach(socket));

    const limiter = new TokenBucket(20, 3);
    const guard =
      <A extends unknown[]>(fn: (...args: A) => SocialResult) =>
      (...args: [...A, (res: SocialResult) => void]) => {
        const ack = args.pop() as unknown;
        if (typeof ack !== 'function') return;
        (ack as (res: SocialResult) => void)(limiter.take() ? fn(...(args as unknown as A)) : fail('Slow down a little.'));
      };

    socket.on('friendsList', (ack) => {
      if (typeof ack === 'function') ack(this.friendsState(userId));
    });
    socket.on('partyState', (ack) => {
      if (typeof ack === 'function') ack(this.partyState(this.partyOf.get(userId) ?? null));
    });
    socket.on('friendRequest', guard((username: unknown) => this.request(userId, username)));
    socket.on('friendRespond', guard((req: unknown) => this.respond(userId, req)));
    socket.on('friendRemove', guard((other: unknown) => this.remove(userId, other)));
    socket.on('partyInvite', guard((other: unknown) => this.invite(userId, other)));
    socket.on('partyAnswer', guard((req: unknown) => this.answer(userId, req)));
    socket.on('partyLeave', guard(() => this.leave(userId)));
    socket.on('partyKick', guard((other: unknown) => this.kick(userId, other)));
  }

  private detach(socket: GameSocket): void {
    const userId = socket.data.userId;
    const set = this.sockets.get(userId);
    if (!set) return;
    set.delete(socket);
    if (set.size > 0) return;
    this.sockets.delete(userId);
    this.presenceChanged(userId);
    // Gone for good (not just a reload)? Then out of the party.
    if (this.partyOf.has(userId)) {
      const timer = setTimeout(() => {
        this.offlineTimers.delete(userId);
        if (!this.isOnline(userId)) this.leave(userId);
      }, SOCIAL.offlineGraceMs);
      timer.unref();
      this.offlineTimers.set(userId, timer);
    }
  }

  isOnline(userId: number): boolean {
    return (this.sockets.get(userId)?.size ?? 0) > 0;
  }

  /** What they're playing (the room one of their sockets is in), or null in the menu. */
  activity(userId: number): { mode: ModeId; room: GameRoom } | null {
    for (const socket of this.sockets.get(userId) ?? []) {
      const room = this.rooms.roomOf(socket.id);
      if (room) return { mode: room.info.mode, room };
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // Friends
  // ---------------------------------------------------------------------------

  friendsState(userId: number): FriendsState {
    const registered = this.db.profile(userId)?.username != null;
    if (!registered) return { registered, friends: [], incoming: [], outgoing: [] };
    const party = this.partyOf.get(userId);
    const requests = this.db.friendRequests(userId);
    const brief = (r: FriendRow) => ({ userId: r.userId, username: r.username, name: r.name });
    return {
      registered,
      friends: this.db.friendsOf(userId).map((r) => {
        const online = this.isOnline(r.userId);
        return {
          userId: r.userId,
          username: r.username,
          name: r.name,
          rank: levelFor(r.xp),
          ...(r.developer ? { dev: true } : {}),
          online,
          mode: online ? (this.activity(r.userId)?.mode ?? null) : null,
          inParty: party?.members.includes(r.userId) ?? false,
        };
      }),
      incoming: requests.incoming.map(brief),
      outgoing: requests.outgoing.map(brief),
    };
  }

  private request(from: number, rawUsername: unknown): SocialResult {
    const me = this.db.profile(from);
    if (!me?.username) return fail('Register first (Save progress): friends need a username.');
    if (typeof rawUsername !== 'string' || !/^[A-Za-z0-9_]{3,16}$/.test(rawUsername.trim())) return fail('Usernames are 3–16 letters, numbers or underscores.');
    const to = this.db.findUserId(rawUsername.trim());
    if (to === undefined) return fail(`Nobody is called "${rawUsername.trim()}".`);
    if (to === from) return fail("That's you!");
    const link = this.db.friendLink(from, to);
    if (link === 'friends') return fail("You're already friends.");
    if (link === 'sent') return fail('You already asked them.');
    const counts = this.db.friendCounts(from);
    if (counts.friends >= SOCIAL.maxFriends) return fail(`You have ${SOCIAL.maxFriends} friends already.`);
    if (link === 'received') {
      // They asked first: that's a yes from both.
      if (this.db.friendCounts(to).friends >= SOCIAL.maxFriends) return fail('Their friends list is full.');
      this.db.acceptFriend(from, to);
      this.notice(to, `${me.name} accepted your friend request.`);
    } else {
      if (counts.pending >= SOCIAL.maxPending) return fail('Too many requests waiting: wait for some answers first.');
      this.db.addFriendRequest(from, to);
      this.notice(to, `${me.name} (@${me.username}) wants to be friends.`);
    }
    this.pushFriends(from);
    this.pushFriends(to);
    return ok;
  }

  private respond(by: number, raw: unknown): SocialResult {
    if (!isRecord(raw) || !Number.isSafeInteger(raw.userId) || typeof raw.accept !== 'boolean') return fail('Invalid request.');
    const requester = raw.userId as number;
    if (this.db.friendLink(by, requester) !== 'received') return fail('That request is gone.');
    if (raw.accept) {
      if (this.db.friendCounts(by).friends >= SOCIAL.maxFriends) return fail(`You have ${SOCIAL.maxFriends} friends already.`);
      if (this.db.friendCounts(requester).friends >= SOCIAL.maxFriends) return fail('Their friends list is full.');
      this.db.acceptFriend(by, requester);
      const me = this.db.profile(by);
      if (me) this.notice(requester, `${me.name} accepted your friend request.`);
    } else {
      this.db.removeFriendship(by, requester);
    }
    this.pushFriends(by);
    this.pushFriends(requester);
    return ok;
  }

  private remove(by: number, raw: unknown): SocialResult {
    if (!Number.isSafeInteger(raw)) return fail('Invalid request.');
    const other = raw as number;
    if (this.db.friendLink(by, other) === 'none') return fail('Not on your list.');
    this.db.removeFriendship(by, other);
    this.pushFriends(by);
    this.pushFriends(other);
    return ok;
  }

  // ---------------------------------------------------------------------------
  // Parties
  // ---------------------------------------------------------------------------

  private partyState(party: Party | null): PartyState | null {
    if (!party) return null;
    const now = Date.now();
    const name = (id: number) => this.db.profile(id)?.name ?? 'Chicken';
    return {
      id: party.id,
      leader: party.leader,
      members: party.members.map((id) => ({ userId: id, name: name(id), online: this.isOnline(id), mode: this.activity(id)?.mode ?? null })),
      invited: [...party.invites].filter(([, until]) => until > now).map(([id]) => ({ userId: id, name: name(id) })),
    };
  }

  private invite(from: number, raw: unknown): SocialResult {
    if (!Number.isSafeInteger(raw)) return fail('Invalid request.');
    const to = raw as number;
    if (to === from) return fail("That's you!");
    if (this.db.friendLink(from, to) !== 'friends') return fail('You can only invite friends.');
    if (!this.isOnline(to)) return fail("They're offline.");
    let party = this.partyOf.get(from);
    if (party && party.leader !== from) return fail('Only the party leader can invite.');
    if (party?.members.includes(to)) return fail("They're already in your party.");
    if (party && party.members.length >= SOCIAL.partySize) return fail(`Your party is full (${SOCIAL.partySize}).`);
    if (!party) {
      party = { id: randomString(10), leader: from, members: [from], invites: new Map() };
      this.parties.set(party.id, party);
      this.partyOf.set(from, party);
    }
    party.invites.set(to, Date.now() + SOCIAL.inviteMs);
    const me = this.db.profile(from);
    for (const s of this.sockets.get(to) ?? []) s.emit('partyInvited', { partyId: party.id, from: { userId: from, name: me?.name ?? 'Chicken' }, size: party.members.length });
    this.pushParty(party);
    return ok;
  }

  private answer(userId: number, raw: unknown): SocialResult {
    if (!isRecord(raw) || typeof raw.partyId !== 'string' || typeof raw.accept !== 'boolean') return fail('Invalid request.');
    const party = this.parties.get(raw.partyId);
    const until = party?.invites.get(userId) ?? 0;
    if (!party || until < Date.now()) return fail('That invite ran out.');
    party.invites.delete(userId);
    if (!raw.accept) {
      this.pushParty(party);
      return ok;
    }
    if (party.members.length >= SOCIAL.partySize) {
      this.pushParty(party);
      return fail('That party is full now.');
    }
    // Into the new party, out of the old one.
    if (this.partyOf.get(userId) !== party) this.leave(userId);
    party.members.push(userId);
    this.partyOf.set(userId, party);
    const me = this.db.profile(userId);
    for (const id of party.members) if (id !== userId) this.notice(id, `${me?.name ?? 'A friend'} joined your party.`);
    this.pushParty(party);
    this.refreshFriendsOfParty(party);
    return ok;
  }

  /** Leaves your party (the next member leads; one left means it's over). */
  leave(userId: number): SocialResult {
    const party = this.partyOf.get(userId);
    if (!party) return fail("You're not in a party.");
    this.partyOf.delete(userId);
    party.members = party.members.filter((id) => id !== userId);
    for (const s of this.sockets.get(userId) ?? []) s.emit('party', null);
    if (party.leader === userId && party.members.length > 0) party.leader = party.members[0]!;
    if (party.members.length <= 1) {
      // Nobody left to play with.
      for (const id of party.members) {
        this.partyOf.delete(id);
        for (const s of this.sockets.get(id) ?? []) s.emit('party', null);
        this.pushFriends(id);
      }
      this.parties.delete(party.id);
    } else {
      this.pushParty(party);
      this.refreshFriendsOfParty(party);
    }
    this.pushFriends(userId);
    return ok;
  }

  private kick(by: number, raw: unknown): SocialResult {
    if (!Number.isSafeInteger(raw)) return fail('Invalid request.');
    const party = this.partyOf.get(by);
    if (!party || party.leader !== by) return fail('Only the party leader can do that.');
    const other = raw as number;
    if (other === by || !party.members.includes(other)) return fail("They're not in your party.");
    this.notice(other, 'You were removed from the party.');
    return this.leave(other);
  }

  /**
   * The leader starts a match: everyone in the party goes in together, on one team. `pick`
   * finds (or makes) a room with space for `size`. Members in another match hold everyone up.
   */
  joinWithParty(leader: GameSocket, pick: (size: number) => GameRoom | null): JoinResponse {
    const leaderId = leader.data.userId;
    const party = this.partyOf.get(leaderId);
    if (!party) return this.rooms.join(leader, pick(1));
    if (party.leader !== leaderId) return { ok: false, error: 'Your party leader picks the match. Leave the party to play on your own.' };
    // Who's coming: the leader, and everyone online who isn't busy elsewhere.
    const others: { userId: number; socket: GameSocket }[] = [];
    for (const id of party.members) {
      if (id === leaderId || !this.isOnline(id)) continue;
      const busy = this.activity(id);
      if (busy) return { ok: false, error: `Waiting for ${this.db.profile(id)?.name ?? 'a party member'} to finish their ${MODES[busy.mode].name} match.` };
      const sockets = [...(this.sockets.get(id) ?? [])];
      others.push({ userId: id, socket: sockets[sockets.length - 1]! });
    }
    const size = others.length + 1;
    const room = pick(size);
    if (!room) return { ok: false, error: 'The server is busy, try again soon.' };
    for (const id of [leaderId, ...others.map((o) => o.userId)]) {
      const blocked = this.rooms.blockedFrom(id, room.info.mode);
      if (blocked) {
        if (room.humanCount === 0) this.rooms.close(room);
        return { ok: false, error: id === leaderId ? blocked : `${this.db.profile(id)?.name ?? 'A party member'} can't play ${MODES[room.info.mode].name}: ${blocked}` };
      }
    }
    const team = room.teamForParty(size);
    if (team === null) {
      if (room.humanCount === 0) this.rooms.close(room);
      return { ok: false, error: 'Not enough space for your whole party in that room.' };
    }
    const res = this.rooms.join(leader, room, team || undefined);
    if (!res.ok) return res;
    for (const o of others) {
      const joined = this.rooms.join(o.socket, room, team || undefined);
      if (joined.ok) o.socket.emit('partyJoined', joined);
      else this.notice(o.userId, `Couldn't join your party's match: ${joined.error}`);
    }
    return res;
  }

  // ---------------------------------------------------------------------------
  // Telling people
  // ---------------------------------------------------------------------------

  /** Online or offline, or into / out of a match: their friends and party see it. */
  private presenceChanged(userId: number): void {
    for (const friend of this.db.friendsOf(userId)) if (this.isOnline(friend.userId)) this.pushFriends(friend.userId);
    const party = this.partyOf.get(userId);
    if (party) this.pushParty(party);
  }

  private pushFriends(userId: number): void {
    const sockets = this.sockets.get(userId);
    if (!sockets?.size) return;
    const state = this.friendsState(userId);
    for (const s of sockets) s.emit('friends', state);
  }

  private pushParty(party: Party): void {
    const state = this.partyState(party);
    for (const id of party.members) for (const s of this.sockets.get(id) ?? []) s.emit('party', state);
  }

  /** "In your party" marks on each member's friends list. */
  private refreshFriendsOfParty(party: Party): void {
    for (const id of party.members) this.pushFriends(id);
  }

  private notice(userId: number, text: string): void {
    for (const s of this.sockets.get(userId) ?? []) s.emit('notice', text);
  }
}
