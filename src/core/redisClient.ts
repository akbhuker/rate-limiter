import Redis, { type RedisOptions } from 'ioredis';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const LUA_DIR = join(__dirname, 'lua');

function load(file: string): string {
  return readFileSync(join(LUA_DIR, file), 'utf8');
}

/**
 * ioredis lets us register Lua scripts as first-class commands. Under the hood
 * it caches each script's SHA and uses EVALSHA, automatically falling back to
 * EVAL + re-cache on NOSCRIPT (e.g. after a Redis restart or failover). That
 * gives us the network efficiency of script caching with none of the
 * bookkeeping.
 */
export interface LimiterRedis extends Redis {
  slidingWindowCounter(
    key: string,
    now: number,
    windowMs: number,
    limit: number,
    cost: number,
  ): Promise<[number, number, number, number]>;

  tokenBucket(
    key: string,
    now: number,
    ratePerMs: number,
    capacity: number,
    cost: number,
  ): Promise<[number, number, number, number]>;

  slidingWindowLog(
    key: string,
    now: number,
    windowMs: number,
    limit: number,
    cost: number,
    member: string,
  ): Promise<[number, number, number]>;

  fixedWindow(
    key: string,
    limit: number,
    windowMs: number,
    cost: number,
  ): Promise<[number, number, number]>;
}

function defineCommands(redis: Redis): LimiterRedis {
  redis.defineCommand('slidingWindowCounter', {
    numberOfKeys: 1,
    lua: load('sliding_window_counter.lua'),
  });
  redis.defineCommand('tokenBucket', {
    numberOfKeys: 1,
    lua: load('token_bucket.lua'),
  });
  redis.defineCommand('slidingWindowLog', {
    numberOfKeys: 1,
    lua: load('sliding_window_log.lua'),
  });
  redis.defineCommand('fixedWindow', {
    numberOfKeys: 1,
    lua: load('fixed_window.lua'),
  });
  return redis as LimiterRedis;
}

/** Create a Redis connection from a URL with the limiter scripts attached. */
export function createRedis(url = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379'): LimiterRedis {
  const redis = new Redis(url, {
    // Keep request latency bounded: don't queue forever if Redis is down.
    maxRetriesPerRequest: 2,
    enableReadyCheck: true,
  });
  return defineCommands(redis);
}

/** Attach the limiter scripts to an existing ioredis instance you already own. */
export function attachScripts(redis: Redis): LimiterRedis {
  return defineCommands(redis);
}

export type { RedisOptions };
