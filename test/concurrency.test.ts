import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { RateLimiter } from '../src/core/RateLimiter';
import type { LimiterRedis } from '../src/core/redisClient';
import type { Algorithm, Policy } from '../src/core/types';
import { getTestRedis, uniqueId } from './setup';

/**
 * The headline guarantee of this project: under heavy concurrency the limiter
 * admits EXACTLY `limit` requests — never more. If the read-modify-write were
 * not atomic (e.g. GET then SET from Node instead of one Lua script), parallel
 * requests would race and over-admit. We fire a burst far larger than the limit
 * all at once and assert the admitted count lands exactly on the cap.
 */
describe('atomicity under concurrency', () => {
  let redis: LimiterRedis;
  let limiter: RateLimiter;

  beforeAll(async () => {
    redis = await getTestRedis();
    limiter = new RateLimiter(redis, { prefix: 'test-conc' });
  });

  afterAll(async () => {
    await redis.quit();
  });

  const exactAlgorithms: Algorithm[] = [
    'sliding-window-counter',
    'sliding-window-log',
    'fixed-window',
    'token-bucket',
  ];

  for (const algorithm of exactAlgorithms) {
    it(`[${algorithm}] admits exactly the limit when 500 requests race`, async () => {
      const id = uniqueId(algorithm);
      const limit = 100;
      const policy: Policy = { limit, windowMs: 60_000, algorithm };

      // Fire 500 concurrent consumes against a fresh key.
      const burst = 500;
      const results = await Promise.all(
        Array.from({ length: burst }, () => limiter.consume(id, policy)),
      );

      const allowed = results.filter((r) => r.allowed).length;
      const blocked = burst - allowed;

      // token-bucket may refill a few tokens during the burst's wall-clock time,
      // so allow a tiny upward slack for it; the windowed algorithms must be exact.
      if (algorithm === 'token-bucket') {
        expect(allowed).toBeGreaterThanOrEqual(limit);
        expect(allowed).toBeLessThanOrEqual(limit + 5);
      } else {
        expect(allowed).toBe(limit);
      }
      expect(blocked).toBe(burst - allowed);
    });
  }

  it('never lets remaining go negative', async () => {
    const id = uniqueId('remaining');
    const policy: Policy = { limit: 50, windowMs: 60_000, algorithm: 'sliding-window-counter' };
    const results = await Promise.all(
      Array.from({ length: 200 }, () => limiter.consume(id, policy)),
    );
    for (const r of results) {
      expect(r.remaining).toBeGreaterThanOrEqual(0);
    }
  });
});
