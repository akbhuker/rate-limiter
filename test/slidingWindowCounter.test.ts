import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { RateLimiter } from '../src/core/RateLimiter';
import type { LimiterRedis } from '../src/core/redisClient';
import type { Policy } from '../src/core/types';
import { getTestRedis, uniqueId, sleep } from './setup';

describe('sliding-window-counter', () => {
  let redis: LimiterRedis;
  let limiter: RateLimiter;
  const policy: Policy = { limit: 5, windowMs: 1_000, algorithm: 'sliding-window-counter' };

  beforeAll(async () => {
    redis = await getTestRedis();
    limiter = new RateLimiter(redis, { prefix: 'test-swc' });
  });
  afterAll(async () => {
    await redis.quit();
  });

  it('allows up to the limit then blocks', async () => {
    const id = uniqueId();
    for (let i = 0; i < 5; i++) {
      const r = await limiter.consume(id, policy);
      expect(r.allowed).toBe(true);
    }
    const blocked = await limiter.consume(id, policy);
    expect(blocked.allowed).toBe(false);
    expect(blocked.remaining).toBe(0);
    expect(blocked.retryAfterMs).toBeGreaterThan(0);
  });

  it('decrements remaining on each request', async () => {
    const id = uniqueId();
    const first = await limiter.consume(id, policy);
    expect(first.remaining).toBe(4);
    const second = await limiter.consume(id, policy);
    expect(second.remaining).toBe(3);
  });

  it('still blocks just past one window (boundary-burst protection)', async () => {
    const id = uniqueId();
    for (let i = 0; i < 5; i++) await limiter.consume(id, policy);
    expect((await limiter.consume(id, policy)).allowed).toBe(false);

    // 1.1s after a full burst, the previous window is still weighted ~90%
    // (≈4.5 effective), so a 6th request stays blocked. A naive fixed window
    // would wrongly allow it here — this is the whole point of the algorithm.
    await sleep(1_100);
    expect((await limiter.consume(id, policy)).allowed).toBe(false);
  });

  it('fully recovers capacity after two windows elapse', async () => {
    const id = uniqueId();
    for (let i = 0; i < 5; i++) await limiter.consume(id, policy);
    expect((await limiter.consume(id, policy)).allowed).toBe(false);

    // Past two full windows both stored counters are stale -> clean reset.
    await sleep(2_100);
    const r = await limiter.consume(id, policy);
    expect(r.allowed).toBe(true);
    expect(r.remaining).toBe(4);
  });

  it('peek does not consume', async () => {
    const id = uniqueId();
    await limiter.consume(id, policy);
    const before = await limiter.peek(id, policy);
    const after = await limiter.peek(id, policy);
    expect(before.remaining).toBe(after.remaining);
  });

  it('reset clears usage', async () => {
    const id = uniqueId();
    for (let i = 0; i < 5; i++) await limiter.consume(id, policy);
    await limiter.reset(id, 'sliding-window-counter');
    const r = await limiter.consume(id, policy);
    expect(r.allowed).toBe(true);
    expect(r.remaining).toBe(4);
  });
});
