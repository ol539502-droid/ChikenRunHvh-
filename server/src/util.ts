import { randomInt } from 'node:crypto';

/** Strips control/format characters, collapses whitespace and cuts to `maxLength` code points. */
export function sanitizeText(raw: unknown, maxLength: number): string {
  if (typeof raw !== 'string') return '';
  const cleaned = raw.replace(/\p{C}/gu, '').replace(/\s+/g, ' ').trim();
  // Array.from splits by code point so we never cut an emoji in half.
  return Array.from(cleaned).slice(0, maxLength).join('').trim();
}

const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
/** No 0/O/1/I so codes are easy to read out loud. */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function randomString(length: number, alphabet = ID_ALPHABET): string {
  let out = '';
  for (let i = 0; i < length; i++) out += alphabet[randomInt(alphabet.length)];
  return out;
}

export function randomRoomCode(): string {
  return randomString(5, CODE_ALPHABET);
}

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Classic token bucket: `capacity` burst, refilled at `perSecond`. */
export class TokenBucket {
  private tokens: number;
  private last = performance.now();
  private readonly capacity: number;
  private readonly perSecond: number;

  constructor(capacity: number, perSecond: number) {
    this.capacity = capacity;
    this.perSecond = perSecond;
    this.tokens = capacity;
  }

  take(cost = 1, now = performance.now()): boolean {
    this.tokens = Math.min(this.capacity, this.tokens + ((now - this.last) / 1000) * this.perSecond);
    this.last = now;
    if (this.tokens < cost) return false;
    this.tokens -= cost;
    return true;
  }
}

/** One token bucket per key (IP address, user id...), forgotten after a while of inactivity. */
export class KeyedRateLimiter {
  private readonly buckets = new Map<string, { bucket: TokenBucket; seen: number }>();
  private readonly capacity: number;
  private readonly perSecond: number;

  constructor(capacity: number, perSecond: number) {
    this.capacity = capacity;
    this.perSecond = perSecond;
  }

  take(key: string): boolean {
    const now = Date.now();
    let entry = this.buckets.get(key);
    if (!entry) {
      if (this.buckets.size > 10_000) this.prune(now);
      entry = { bucket: new TokenBucket(this.capacity, this.perSecond), seen: now };
      this.buckets.set(key, entry);
    }
    entry.seen = now;
    return entry.bucket.take();
  }

  private prune(now: number): void {
    for (const [key, entry] of this.buckets) if (now - entry.seen > 10 * 60_000) this.buckets.delete(key);
  }
}
