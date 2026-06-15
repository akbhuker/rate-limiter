import { randomBytes } from 'node:crypto';
import type { LimiterRedis } from './redisClient';
import type {
  Algorithm,
  Policy,
  RateLimitResult,
  RateLimiterOptions,
} from './types';

const DEFAULT_POLICY: Policy = {
  limit: 100,
  windowMs: 60_000,
  algorithm: 'sliding-window-counter',
};

/**
 * Distributed rate limiter. Stateless across instances — all coordination
 * happens inside atomic Redis Lua scripts, so you can run N copies of your API
 * behind a load balancer and they share one consistent view of every client's
 * usage.
 */
export class RateLimiter {
  private readonly redis: LimiterRedis;
  private readonly prefix: string;
  private readonly defaultPolicy: Policy;
  private readonly onError: 'open' | 'closed';

  constructor(redis: LimiterRedis, options: RateLimiterOptions = {}) {
    this.redis = redis;
    this.prefix = options.prefix ?? 'rl';
    this.defaultPolicy = { ...DEFAULT_POLICY, ...options.defaultPolicy };
    this.onError = options.onError ?? 'open';
  }

  /**
   * Consume `cost` units against `identifier` (an IP, API key, user id...).
   * Returns the decision plus the metadata needed to set rate-limit headers.
   */
  async consume(
    identifier: string,
    policy: Policy = this.defaultPolicy,
    cost = 1,
  ): Promise<RateLimitResult> {
    const algorithm: Algorithm = policy.algorithm ?? 'sliding-window-counter';
    const key = this.buildKey(identifier, algorithm);
    const now = Date.now();

    try {
      switch (algorithm) {
        case 'sliding-window-counter':
          return this.runSlidingWindowCounter(key, now, policy, cost);
        case 'token-bucket':
          return this.runTokenBucket(key, now, policy, cost);
        case 'sliding-window-log':
          return this.runSlidingWindowLog(key, now, policy, cost);
        case 'fixed-window':
          return this.runFixedWindow(key, policy, cost);
        default: {
          // Exhaustiveness guard — a new Algorithm member fails the build here.
          const never: never = algorithm;
          throw new Error(`Unknown algorithm: ${never as string}`);
        }
      }
    } catch (err) {
      return this.handleError(key, algorithm, policy, err);
    }
  }

  /** Read-only peek that never consumes — handy for dashboards / debugging. */
  async peek(identifier: string, policy: Policy = this.defaultPolicy): Promise<RateLimitResult> {
    // cost 0 = check-only across every algorithm (no slot is taken).
    return this.consume(identifier, policy, 0);
  }

  /** Clear a client's usage (e.g. after a successful login resets a brute-force counter). */
  async reset(identifier: string, algorithm?: Algorithm): Promise<void> {
    if (algorithm) {
      await this.redis.del(this.buildKey(identifier, algorithm));
      return;
    }
    const algos: Algorithm[] = [
      'sliding-window-counter',
      'token-bucket',
      'sliding-window-log',
      'fixed-window',
    ];
    await Promise.all(algos.map((a) => this.redis.del(this.buildKey(identifier, a))));
  }

  private buildKey(identifier: string, algorithm: Algorithm): string {
    return `${this.prefix}:${algorithm}:${identifier}`;
  }

  private async runSlidingWindowCounter(
    key: string,
    now: number,
    policy: Policy,
    cost: number,
  ): Promise<RateLimitResult> {
    const [allowed, remaining, reset, used] = await this.redis.slidingWindowCounter(
      key,
      now,
      policy.windowMs,
      policy.limit,
      cost,
    );
    void used;
    return {
      allowed: allowed === 1,
      limit: policy.limit,
      remaining,
      resetMs: reset,
      retryAfterMs: allowed === 1 ? 0 : reset,
      algorithm: 'sliding-window-counter',
      key,
    };
  }

  private async runTokenBucket(
    key: string,
    now: number,
    policy: Policy,
    cost: number,
  ): Promise<RateLimitResult> {
    const capacity = policy.burst ?? policy.limit;
    const ratePerMs = policy.limit / policy.windowMs;
    const [allowed, tokens, retryAfter, reset] = await this.redis.tokenBucket(
      key,
      now,
      ratePerMs,
      capacity,
      cost,
    );
    return {
      allowed: allowed === 1,
      limit: capacity,
      remaining: tokens,
      resetMs: reset,
      retryAfterMs: retryAfter,
      algorithm: 'token-bucket',
      key,
    };
  }

  private async runSlidingWindowLog(
    key: string,
    now: number,
    policy: Policy,
    cost: number,
  ): Promise<RateLimitResult> {
    // Unique member so concurrent same-ms requests don't collide in the ZSET.
    const member = `${now}-${randomBytes(6).toString('hex')}`;
    const [allowed, remaining, reset] = await this.redis.slidingWindowLog(
      key,
      now,
      policy.windowMs,
      policy.limit,
      cost,
      member,
    );
    return {
      allowed: allowed === 1,
      limit: policy.limit,
      remaining,
      resetMs: reset,
      retryAfterMs: allowed === 1 ? 0 : reset,
      algorithm: 'sliding-window-log',
      key,
    };
  }

  private async runFixedWindow(
    key: string,
    policy: Policy,
    cost: number,
  ): Promise<RateLimitResult> {
    // Bucket the key by window so each window gets its own counter + TTL.
    const bucket = Math.floor(Date.now() / policy.windowMs);
    const bucketedKey = `${key}:${bucket}`;
    const [allowed, remaining, reset] = await this.redis.fixedWindow(
      bucketedKey,
      policy.limit,
      policy.windowMs,
      cost,
    );
    return {
      allowed: allowed === 1,
      limit: policy.limit,
      remaining,
      resetMs: reset,
      retryAfterMs: allowed === 1 ? 0 : reset,
      algorithm: 'fixed-window',
      key: bucketedKey,
    };
  }

  private handleError(
    key: string,
    algorithm: Algorithm,
    policy: Policy,
    err: unknown,
  ): RateLimitResult {
    const failOpen = this.onError === 'open';
    // Surface the cause for logging but never throw into the request path.
    if (process.env.NODE_ENV !== 'test') {
      // eslint-disable-next-line no-console
      console.error(`[guardrail] limiter error (failing ${this.onError}):`, err);
    }
    return {
      allowed: failOpen,
      limit: policy.limit,
      remaining: failOpen ? policy.limit : 0,
      resetMs: 0,
      retryAfterMs: failOpen ? 0 : policy.windowMs,
      algorithm,
      key,
    };
  }
}
