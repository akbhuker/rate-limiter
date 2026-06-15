import type Redis from 'ioredis';
import type { Algorithm, Policy, Tier } from './types';

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

export interface TierStoreOptions {
  /** ms a resolved tier/policy is cached in-process before re-reading Redis. */
  cacheTtlMs?: number;
  /** Tier used when an identifier has no mapping. */
  defaultTier?: string;
  /** Seed tiers loaded into Redis if missing (so a fresh deploy has sane limits). */
  seedTiers?: Tier[];
}

const DEFAULT_TIERS: Tier[] = [
  { name: 'free', limit: 60, windowMs: 60_000, algorithm: 'sliding-window-counter' },
  { name: 'premium', limit: 600, windowMs: 60_000, algorithm: 'sliding-window-counter' },
  { name: 'enterprise', limit: 6_000, windowMs: 60_000, algorithm: 'token-bucket', burst: 9_000 },
];

/**
 * Resolves *which* policy applies to a given client at request time.
 *
 * Two indirections, both backed by Redis and shielded by a short in-process
 * cache so the hot path costs ~0 network round-trips once warm:
 *
 *   identifier (api key / user id)  --[ rl:tier-of:<id> ]-->  tier name
 *   tier name                       --[ rl:tier:<name>  ]-->  policy (hash)
 *
 * This is what makes limits *dynamic*: flip a customer from free -> premium by
 * writing one Redis field, and every gateway instance picks it up within
 * `cacheTtlMs` — no redeploy, no config push.
 */
export class TierStore {
  private readonly redis: Redis;
  private readonly cacheTtlMs: number;
  private readonly defaultTier: string;

  private readonly tierCache = new Map<string, CacheEntry<Tier>>();
  private readonly assignmentCache = new Map<string, CacheEntry<string>>();

  constructor(redis: Redis, options: TierStoreOptions = {}) {
    this.redis = redis;
    this.cacheTtlMs = options.cacheTtlMs ?? 5_000;
    this.defaultTier = options.defaultTier ?? 'free';
    if (options.seedTiers) {
      void this.seed(options.seedTiers);
    }
  }

  /** Idempotently write tier definitions into Redis (skips ones already present). */
  async seed(tiers: Tier[]): Promise<void> {
    await Promise.all(
      tiers.map(async (tier) => {
        const key = this.tierKey(tier.name);
        const exists = await this.redis.exists(key);
        if (!exists) await this.writeTier(tier);
      }),
    );
  }

  /** Create or overwrite a tier definition. */
  async upsertTier(tier: Tier): Promise<void> {
    await this.writeTier(tier);
    this.tierCache.delete(tier.name);
  }

  /** Map an identifier (api key, user id) to a tier name. */
  async assign(identifier: string, tierName: string): Promise<void> {
    await this.redis.set(this.assignmentKey(identifier), tierName);
    this.assignmentCache.delete(identifier);
  }

  /** Resolve the effective policy for an identifier, following both indirections. */
  async resolve(identifier: string): Promise<Tier> {
    const tierName = await this.tierNameFor(identifier);
    return this.getTier(tierName);
  }

  private async tierNameFor(identifier: string): Promise<string> {
    const cached = this.fromCache(this.assignmentCache, identifier);
    if (cached !== undefined) return cached;

    const name = (await this.redis.get(this.assignmentKey(identifier))) ?? this.defaultTier;
    this.toCache(this.assignmentCache, identifier, name);
    return name;
  }

  private async getTier(name: string): Promise<Tier> {
    const cached = this.fromCache(this.tierCache, name);
    if (cached !== undefined) return cached;

    const raw = await this.redis.hgetall(this.tierKey(name));
    const tier = this.parseTier(name, raw);
    this.toCache(this.tierCache, name, tier);
    return tier;
  }

  private async writeTier(tier: Tier): Promise<void> {
    const fields: Record<string, string> = {
      limit: String(tier.limit),
      windowMs: String(tier.windowMs),
      algorithm: tier.algorithm ?? 'sliding-window-counter',
    };
    if (tier.burst !== undefined) fields.burst = String(tier.burst);
    await this.redis.hset(this.tierKey(tier.name), fields);
  }

  private parseTier(name: string, raw: Record<string, string>): Tier {
    if (!raw || Object.keys(raw).length === 0) {
      // Unknown tier in Redis -> fall back to a built-in default by that name,
      // else the most restrictive default tier. Never leave a client unlimited.
      const fallback =
        DEFAULT_TIERS.find((t) => t.name === name) ?? DEFAULT_TIERS[0];
      return { ...(fallback as Tier), name };
    }
    const policy: Policy = {
      limit: Number(raw.limit),
      windowMs: Number(raw.windowMs),
      algorithm: (raw.algorithm as Algorithm) ?? 'sliding-window-counter',
    };
    if (raw.burst !== undefined) policy.burst = Number(raw.burst);
    return { name, ...policy };
  }

  private fromCache<T>(cache: Map<string, CacheEntry<T>>, key: string): T | undefined {
    const entry = cache.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt < Date.now()) {
      cache.delete(key);
      return undefined;
    }
    return entry.value;
  }

  private toCache<T>(cache: Map<string, CacheEntry<T>>, key: string, value: T): void {
    cache.set(key, { value, expiresAt: Date.now() + this.cacheTtlMs });
  }

  private tierKey(name: string): string {
    return `rl:tier:${name}`;
  }

  private assignmentKey(identifier: string): string {
    return `rl:tier-of:${identifier}`;
  }
}

export { DEFAULT_TIERS };
