import assert from 'node:assert/strict';
import { it } from 'node:test';
import { TokenBucket } from '../src/util';

it('refills a token bucket using the caller clock and caps its burst', () => {
  const bucket = new TokenBucket(2, 4);
  const now = Math.ceil(performance.now());
  assert.equal(bucket.take(2, now), true);
  assert.equal(bucket.take(1, now), false);
  assert.equal(bucket.take(1, now + 250), true);
  assert.equal(bucket.take(1, now + 250), false);
  assert.equal(bucket.take(2, now + 10_000), true);
  assert.equal(bucket.take(1, now + 10_000), false);
});
