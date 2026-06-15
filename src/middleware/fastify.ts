import type { FastifyReply, FastifyRequest, HookHandlerDoneFunction } from 'fastify';
import type { RateLimiter } from '../core/RateLimiter';
import type { TierStore } from '../core/tierStore';
import type { LimiterMetrics } from '../metrics';
import type { Policy, RateLimitResult } from '../core/types';

export interface FastifyLimiterOptions {
  limiter: RateLimiter;
  tierStore?: TierStore;
  policy?: Policy;
  metrics?: LimiterMetrics;
  keyGenerator?: (req: FastifyRequest) => string;
  skip?: (req: FastifyRequest) => boolean;
}

function defaultKey(req: FastifyRequest): string {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length > 0) {
    return fwd.split(',')[0]!.trim();
  }
  return req.ip ?? 'unknown';
}

function setHeaders(reply: FastifyReply, result: RateLimitResult): void {
  const resetSec = Math.ceil(result.resetMs / 1000);
  reply.header('X-RateLimit-Limit', result.limit);
  reply.header('X-RateLimit-Remaining', Math.max(0, result.remaining));
  reply.header('X-RateLimit-Reset', resetSec);
  reply.header('RateLimit-Limit', result.limit);
  reply.header('RateLimit-Remaining', Math.max(0, result.remaining));
  reply.header('RateLimit-Reset', resetSec);
  if (result.tier) reply.header('X-RateLimit-Tier', result.tier);
}

/**
 * Fastify `onRequest` hook. Register with:
 *   app.addHook('onRequest', fastifyRateLimit({ limiter, tierStore }))
 */
export function fastifyRateLimit(options: FastifyLimiterOptions) {
  const { limiter, tierStore, metrics } = options;
  const keyGenerator = options.keyGenerator ?? defaultKey;
  const skip = options.skip;

  return async function rateLimitHook(
    req: FastifyRequest,
    reply: FastifyReply,
    // `done` is accepted for API symmetry but the async form is used.
    _done?: HookHandlerDoneFunction,
  ): Promise<void> {
    if (skip?.(req)) return;

    const identifier = keyGenerator(req);
    const started = process.hrtime.bigint();

    let policy = options.policy;
    let tierName: string | undefined;
    if (tierStore) {
      const tier = await tierStore.resolve(identifier);
      policy = tier;
      tierName = tier.name;
    }

    const result = await limiter.consume(identifier, policy);
    result.tier = tierName;

    const durationSec = Number(process.hrtime.bigint() - started) / 1e9;
    metrics?.record(result, durationSec);

    setHeaders(reply, result);

    if (result.allowed) return;

    reply.header('Retry-After', Math.ceil(result.retryAfterMs / 1000));
    await reply.code(429).send({
      error: 'Too Many Requests',
      message: `Rate limit exceeded. Retry in ${Math.ceil(result.retryAfterMs / 1000)}s.`,
      retryAfterMs: result.retryAfterMs,
    });
  };
}
