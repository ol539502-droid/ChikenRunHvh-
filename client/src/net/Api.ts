import type { Appearance, DailyStatus, LeaderboardRow, MatchHistoryRow, ModeId, Profile, WeaponId } from '@game/shared';
import { storage } from '../ui/dom';

/** Where older versions kept the session token. Moved into an HttpOnly cookie on first load. */
const LEGACY_TOKEN_KEY = 'chikengun:token';

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/**
 * REST calls for accounts, profile and shop, and the latest profile.
 *
 * The session lives in an HttpOnly, SameSite=Strict cookie set by the server: page scripts (and
 * so any injected script) can never read the token, and other sites can't use it. Nothing
 * secret is stored in the browser's JavaScript-visible storage.
 */
export class Api {
  profile: Profile | null = null;
  private readonly listeners = new Set<(profile: Profile) => void>();

  onProfile(fn: (profile: Profile) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Signs in with the session cookie, or creates a guest account if there is none (or it expired). */
  async ensureSession(): Promise<Profile> {
    await this.migrateLegacyToken();
    return this.setProfile((await this.request<{ profile: Profile }>('POST', '/api/auth/start')).profile);
  }

  async startGuest(): Promise<Profile> {
    return this.setProfile((await this.request<{ profile: Profile }>('POST', '/api/auth/guest')).profile);
  }

  async register(username: string, password: string): Promise<Profile> {
    return this.setProfile((await this.request<{ profile: Profile }>('POST', '/api/auth/register', { username, password })).profile);
  }

  async login(username: string, password: string): Promise<Profile> {
    return this.setProfile((await this.request<{ profile: Profile }>('POST', '/api/auth/login', { username, password })).profile);
  }

  /** Signs out and continues as a fresh guest. */
  async logout(): Promise<Profile> {
    try {
      await this.request('POST', '/api/auth/logout');
    } catch {
      // The session is gone either way.
    }
    return this.startGuest();
  }

  /** Signs this account out on every device, then continues here as a fresh guest. */
  async logoutEverywhere(): Promise<Profile> {
    await this.request('POST', '/api/auth/logout-all');
    return this.startGuest();
  }

  /** Changes the password; every other device is signed out. */
  async changePassword(current: string, next: string): Promise<Profile> {
    return this.setProfile((await this.request<{ profile: Profile }>('POST', '/api/auth/password', { current, next })).profile);
  }

  /** Permanently deletes the account and its data, then continues as a fresh guest. */
  async deleteAccount(password?: string): Promise<Profile> {
    await this.request('DELETE', '/api/me', password === undefined ? {} : { password });
    return this.startGuest();
  }

  async update(changes: { name?: string; appearance?: Appearance; loadout?: WeaponId[] }): Promise<Profile> {
    return this.setProfile((await this.request<{ profile: Profile }>('PATCH', '/api/me', changes)).profile);
  }

  async buy(itemId: string): Promise<Profile> {
    return this.setProfile((await this.request<{ profile: Profile }>('POST', '/api/shop/buy', { itemId })).profile);
  }

  async refresh(): Promise<Profile> {
    return this.setProfile((await this.request<{ profile: Profile }>('GET', '/api/me')).profile);
  }

  async history(): Promise<MatchHistoryRow[]> {
    return (await this.request<{ matches: MatchHistoryRow[] }>('GET', '/api/history')).matches;
  }

  /** How many people are playing right now (people, not bots). */
  async online(): Promise<number> {
    return (await this.request<{ players: number }>('GET', '/api/health')).players;
  }

  async daily(): Promise<DailyStatus> {
    return this.request<DailyStatus>('GET', '/api/daily');
  }

  /** Overall, or for one game mode. */
  async leaderboard(mode?: ModeId): Promise<LeaderboardRow[]> {
    return (await this.request<{ rows: LeaderboardRow[] }>('GET', mode ? `/api/leaderboard?mode=${mode}` : '/api/leaderboard')).rows;
  }


  /** After a match: the new coin and XP totals the server sent. */
  setRewards(coins: number, xp: number): void {
    if (this.profile) this.setProfile({ ...this.profile, coins, xp });
  }

  /** Older versions stored the token in localStorage; swap it for the cookie and forget it. */
  private async migrateLegacyToken(): Promise<void> {
    const legacy = storage.get(LEGACY_TOKEN_KEY);
    if (!legacy) return;
    try {
      await this.request('POST', '/api/auth/session', undefined, legacy);
    } catch {
      // Expired or invalid: a new guest session will be made instead.
    }
    storage.remove(LEGACY_TOKEN_KEY);
  }

  private setProfile(profile: Profile): Profile {
    this.profile = profile;
    for (const fn of this.listeners) fn(profile);
    return profile;
  }

  private async request<T>(method: string, path: string, body?: unknown, bearer?: string): Promise<T> {
    const res = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: {
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) throw new ApiError(res.status, data.error ?? `Request failed (${res.status})`);
    return data as T;
  }
}
