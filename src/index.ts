/**
 * Guardrail — distributed rate limiter & traffic shaper.
 *
 * Public API surface. Typical usage:
 *
 *   import { createRedis, RateLimiter, TierStore, expressRateLimit } from 'guardrail';
 *
 *   const redis = createRedis();
 *   const limiter = new RateLimiter(redis);
 *   const tiers = new TierStore(redis, { seedTiers: DEFAULT_TIERS });
 *   app.use(expressRateLimit({ limiter, tierStore: tiers }));
 */
export { RateLimiter } from './core/RateLimiter';
export { TierStore, DEFAULT_TIERS } from './core/tierStore';
export { createRedis, attachScripts } from './core/redisClient';
export type { LimiterRedis } from './core/redisClient';
export { LimiterMetrics } from './metrics';
export { expressRateLimit } from './middleware/express';
export type { ExpressLimiterOptions } from './middleware/express';
export { fastifyRateLimit } from './middleware/fastify';
export type { FastifyLimiterOptions } from './middleware/fastify';
export type {
  Algorithm,
  Policy,
  Tier,
  RateLimitResult,
  RateLimiterOptions,
} from './core/types';
export type { TierStoreOptions } from './core/tierStore';
