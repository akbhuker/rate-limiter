import type { Request, Response, NextFunction, RequestHandler } from 'express';
import type { RateLimiter } from '../core/RateLimiter';
import type { TierStore } from '../core/tierStore';
import type { LimiterMetrics } from '../metrics';
import type { Policy, RateLimitResult } from '../core/types';

export interface ExpressLimiterOptions {
  limiter: RateLimiter;
  /** Optional dynamic per-tier resolution. Takes precedence over `policy`. */
  tierStore?: TierStore;
  /** Static policy used when no tierStore is provided. */
  policy?: Policy;
  /** Optional Prometheus recorder. */
  metrics?: LimiterMetrics;
  /** Derive the limiter identity from the request. Defaults to client IP. */
  keyGenerator?: (req: Request) => string;
  /** Skip limiting for a request entirely (health checks, internal calls). */
  skip?: (req: Request) => boolean;
  /** Override the 429 response. */
  onBlocked?: (req: Request, res: Response, result: RateLimitResult) => void;
}

function defaultKey(req: Request): string {
  // Honour the first hop of X-Forwarded-For when behind a trusted proxy,
  // otherwise fall back to the socket address.
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length > 0) {
    return fwd.split(',')[0]!.trim();
  }
  return req.ip ?? req.socket.remoteAddress ?? 'unknown';
}

/**
 * Write the de-facto-standard rate-limit headers plus the IETF draft
 * `RateLimit-*` set, so clients on either convention can self-throttle.
 */
function setHeaders(res: Response, result: RateLimitResult): void {
  const resetSec = Math.ceil(result.resetMs / 1000);
  res.setHeader('X-RateLimit-Limit', result.limit);
  res.setHeader('X-RateLimit-Remaining', Math.max(0, result.remaining));
  res.setHeader('X-RateLimit-Reset', resetSec);
  // IETF draft-ietf-httpapi-ratelimit-headers
  res.setHeader('RateLimit-Limit', result.limit);
  res.setHeader('RateLimit-Remaining', Math.max(0, result.remaining));
  res.setHeader('RateLimit-Reset', resetSec);
  if (result.tier) res.setHeader('X-RateLimit-Tier', result.tier);
}

/** Build an Express middleware that enforces the limiter on every request. */
export function expressRateLimit(options: ExpressLimiterOptions): RequestHandler {
  const { limiter, tierStore, metrics, onBlocked } = options;
  const keyGenerator = options.keyGenerator ?? defaultKey;
  const skip = options.skip;

  return async function rateLimitMiddleware(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    if (skip?.(req)) {
      next();
      return;
    }

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

    setHeaders(res, result);

    if (result.allowed) {
      next();
      return;
    }

    res.setHeader('Retry-After', Math.ceil(result.retryAfterMs / 1000));
    if (onBlocked) {
      onBlocked(req, res, result);
      return;
    }
    res.status(429).json({
      error: 'Too Many Requests',
      message: `Rate limit exceeded. Retry in ${Math.ceil(result.retryAfterMs / 1000)}s.`,
      retryAfterMs: result.retryAfterMs,
    });
  };
}
