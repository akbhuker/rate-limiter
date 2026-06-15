import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { RateLimiter } from '../src/core/RateLimiter';
import type { LimiterRedis } from '../src/core/redisClient';
import type { Policy } from '../src/core/types';
import { getTestRedis, uniqueId, sleep } from './setup';

describe('token-bucket', () => {
  let redis: LimiterRedis;
  let limiter: RateLimiter;

  beforeAll(async () => {
    redis = await getTestRedis();
    limiter = new RateLimiter(redis, { prefix: 'test-tb' });
  });
  afterAll(async () => {
    await redis.quit();
  });

  it('allows an initial burst up to capacity', async () => {
    const id = uniqueId();
    // 10 tokens/sec sustained, burst ceiling of 10.
    const policy: Policy = { limit: 10, windowMs: 1_000, algorithm: 'token-bucket', burst: 10 };
    let allowed = 0;
    for (let i = 0; i < 10; i++) {
      if ((await limiter.consume(id, policy)).allowed) allowed++;
    }
    expect(allowed).toBe(10);
    expect((await limiter.consume(id, policy)).allowed).toBe(false);
  });

  it('refills over time at the configured rate', async () => {
    const id = uniqueId();
    const policy: Policy = { limit: 10, windowMs: 1_000, algorithm: 'token-bucket', burst: 10 };
    // Drain the bucket.
    for (let i = 0; i < 10; i++) await limiter.consume(id, policy);
    expect((await limiter.consume(id, policy)).allowed).toBe(false);

    // ~10 tokens/sec => after 300ms about 3 tokens should be available.
    await sleep(320);
    let refilled = 0;
    for (let i = 0; i < 5; i++) {
      if ((await limiter.consume(id, policy)).allowed) refilled++;
    }
    expect(refilled).toBeGreaterThanOrEqual(2);
    expect(refilled).toBeLessThanOrEqual(4);
  });

  it('reports retryAfter when empty', async () => {
    const id = uniqueId();
    const policy: Policy = { limit: 5, windowMs: 1_000, algorithm: 'token-bucket', burst: 5 };
    for (let i = 0; i < 5; i++) await limiter.consume(id, policy);
    const blocked = await limiter.consume(id, policy);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterMs).toBeGreaterThan(0);
    expect(blocked.retryAfterMs).toBeLessThanOrEqual(1_000);
  });

  it('burst can exceed sustained limit', async () => {
    const id = uniqueId();
    // Sustained 10/s but allow bursts up to 20.
    const policy: Policy = { limit: 10, windowMs: 1_000, algorithm: 'token-bucket', burst: 20 };
    let allowed = 0;
    for (let i = 0; i < 20; i++) {
      if ((await limiter.consume(id, policy)).allowed) allowed++;
    }
    expect(allowed).toBe(20);
  });
});
