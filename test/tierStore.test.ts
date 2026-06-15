import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { TierStore } from '../src/core/tierStore';
import { createRedis, type LimiterRedis } from '../src/core/redisClient';
import { uniqueId, sleep } from './setup';

describe('TierStore dynamic resolution', () => {
  let redis: LimiterRedis;

  beforeAll(async () => {
    redis = createRedis(process.env.REDIS_URL ?? 'redis://127.0.0.1:6379');
    await redis.ping();
  });
  afterAll(async () => {
    await redis.quit();
  });

  it('falls back to the default tier for unknown identifiers', async () => {
    const store = new TierStore(redis, { defaultTier: 'free' });
    await store.seed([{ name: 'free', limit: 60, windowMs: 60_000, algorithm: 'sliding-window-counter' }]);
    const tier = await store.resolve(uniqueId('anon'));
    expect(tier.name).toBe('free');
    expect(tier.limit).toBe(60);
  });

  it('resolves an assigned identifier to its tier policy', async () => {
    const store = new TierStore(redis);
    await store.upsertTier({ name: 'premium', limit: 600, windowMs: 60_000, algorithm: 'sliding-window-counter' });
    const id = uniqueId('user');
    await store.assign(id, 'premium');
    const tier = await store.resolve(id);
    expect(tier.name).toBe('premium');
    expect(tier.limit).toBe(600);
  });

  it('picks up a tier policy change after the cache TTL expires', async () => {
    const store = new TierStore(redis, { cacheTtlMs: 100 });
    const name = uniqueId('tier');
    await store.upsertTier({ name, limit: 10, windowMs: 60_000, algorithm: 'sliding-window-counter' });
    const id = uniqueId('cust');
    await store.assign(id, name);

    expect((await store.resolve(id)).limit).toBe(10);

    // Raise the limit (simulate an upgrade) and wait out the cache.
    await store.upsertTier({ name, limit: 999, windowMs: 60_000, algorithm: 'sliding-window-counter' });
    await sleep(150);
    expect((await store.resolve(id)).limit).toBe(999);
  });

  it('carries token-bucket burst through resolution', async () => {
    const store = new TierStore(redis);
    await store.upsertTier({ name: 'ent', limit: 6000, windowMs: 60_000, algorithm: 'token-bucket', burst: 9000 });
    const id = uniqueId('ent');
    await store.assign(id, 'ent');
    const tier = await store.resolve(id);
    expect(tier.algorithm).toBe('token-bucket');
    expect(tier.burst).toBe(9000);
  });
});
