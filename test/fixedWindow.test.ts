import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { RateLimiter } from '../src/core/RateLimiter';
import type { LimiterRedis } from '../src/core/redisClient';
import type { Policy } from '../src/core/types';
import { getTestRedis, uniqueId } from './setup';

describe('fixed-window & sliding-window-log', () => {
  let redis: LimiterRedis;
  let limiter: RateLimiter;

  beforeAll(async () => {
    redis = await getTestRedis();
    limiter = new RateLimiter(redis, { prefix: 'test-fw' });
  });
  afterAll(async () => {
    await redis.quit();
  });

  it('fixed-window admits exactly the limit', async () => {
    const id = uniqueId();
    const policy: Policy = { limit: 3, windowMs: 5_000, algorithm: 'fixed-window' };
    const outcomes = [];
    for (let i = 0; i < 5; i++) outcomes.push((await limiter.consume(id, policy)).allowed);
    expect(outcomes).toEqual([true, true, true, false, false]);
  });

  it('sliding-window-log admits exactly the limit', async () => {
    const id = uniqueId();
    const policy: Policy = { limit: 3, windowMs: 5_000, algorithm: 'sliding-window-log' };
    const outcomes = [];
    for (let i = 0; i < 5; i++) outcomes.push((await limiter.consume(id, policy)).allowed);
    expect(outcomes).toEqual([true, true, true, false, false]);
  });

  it('cost > 1 consumes multiple slots', async () => {
    const id = uniqueId();
    const policy: Policy = { limit: 10, windowMs: 5_000, algorithm: 'sliding-window-log' };
    const r = await limiter.consume(id, policy, 4);
    expect(r.allowed).toBe(true);
    expect(r.remaining).toBe(6);
  });
});
