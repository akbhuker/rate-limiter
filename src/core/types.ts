/** Supported limiting strategies, each backed by an atomic Lua script. */
export type Algorithm =
  | 'sliding-window-counter'
  | 'token-bucket'
  | 'sliding-window-log'
  | 'fixed-window';

/**
 * A rate-limit policy. `limit` requests per `windowMs`.
 *
 * For `token-bucket`, `limit` is the sustained capacity and `burst` (defaults
 * to `limit`) is the bucket ceiling, allowing short spikes above the steady
 * rate. The refill rate is derived as `limit / windowMs` tokens per ms.
 */
export interface Policy {
  limit: number;
  windowMs: number;
  algorithm?: Algorithm;
  /** Token-bucket only: max burst size. Defaults to `limit`. */
  burst?: number;
}

/** A named service tier (Free / Premium / Enterprise ...) and its policy. */
export interface Tier extends Policy {
  name: string;
}

/** Result of a single limiter check. */
export interface RateLimitResult {
  allowed: boolean;
  /** The effective request ceiling for this window/bucket. */
  limit: number;
  /** Estimated requests left before blocking. */
  remaining: number;
  /** ms until the window resets / the bucket refills to full. */
  resetMs: number;
  /** ms a blocked client should wait before retrying (0 when allowed). */
  retryAfterMs: number;
  /** Algorithm that produced this decision. */
  algorithm: Algorithm;
  /** Tier name, when resolved via the tier store. */
  tier?: string;
  /** The key that was checked (useful for logging/metrics). */
  key: string;
}

export interface RateLimiterOptions {
  /** Key namespace prefix, keeps limiter keys isolated in shared Redis. */
  prefix?: string;
  /** Default policy applied when a check doesn't specify one. */
  defaultPolicy?: Policy;
  /**
   * Fail-open vs fail-closed when Redis is unreachable.
   * `open` (default) admits traffic so a Redis blip can't take down the API;
   * `closed` rejects, prioritising protection over availability.
   */
  onError?: 'open' | 'closed';
}
