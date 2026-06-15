import { createRedis, type LimiterRedis } from '../src/core/redisClient';

/** Unique key suffix per test so files/cases never collide on shared Redis. */
export function uniqueId(label = 'id'): string {
  return `${label}-${process.hrtime.bigint().toString(36)}`;
}

/** A connected Redis client for tests, or skip the suite if Redis is absent. */
export async function getTestRedis(): Promise<LimiterRedis> {
  const redis = createRedis(process.env.REDIS_URL ?? 'redis://127.0.0.1:6379');
  await redis.ping();
  return redis;
}

/** Sleep helper for time-dependent algorithm tests. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
