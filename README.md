# Guardrail

A distributed rate limiter and traffic shaper for Node.js. Request admission is decided by atomic Redis Lua scripts, so counting stays correct under high concurrency and across horizontally-scaled service instances sharing a single Redis.

Built to sit in front of APIs and internal microservices to bound abuse: DDoS bursts, credential-stuffing, and resource exhaustion.

## Contents

- [Motivation](#motivation)
- [Features](#features)
- [Architecture](#architecture)
- [Algorithms](#algorithms)
- [Usage](#usage)
- [Benchmarks](#benchmarks)
- [Testing](#testing)
- [Design notes](#design-notes)
- [Deployment](#deployment)

## Motivation

The naive approach reads a counter, compares it to a limit, and writes the increment from application code:

```
GET count        -> 59
59 < 60 ? admit
SET count = 60
```

Under concurrency this is a read-modify-write race. Two requests both read `59`, both pass the check, both write `60`, and the limiter has admitted 61 against a limit of 60. The wider the fan-out, the more it over-admits — which is precisely when a limiter matters most.

Guardrail moves the entire read-modify-write into a single Lua script executed server-side by Redis. Redis runs Lua atomically on its single command thread, so no two requests interleave a check and an increment. The guarantee is verified by a test that fires 500 concurrent requests at a limit of 100 and asserts exactly 100 are admitted — for every algorithm.

## Features

- Four interchangeable algorithms, each an atomic Lua script, selectable per route or per tier.
- Dynamic per-tier limits resolved at request time from a Redis-backed tier store with an in-process cache. Limits change live without a redeploy.
- Express and Fastify middleware emitting `X-RateLimit-*`, the IETF draft `RateLimit-*` headers, and `Retry-After`.
- Prometheus metrics: allow/block counts labelled by tier and algorithm, plus check-latency histograms.
- Configurable fail-open / fail-closed behaviour when Redis is unreachable.
- TypeScript, strict mode, typed public API. No state in the Node process.

## Architecture

```
                 ┌──────────────────────────────────────────────┐
   HTTP request  │  Express / Fastify middleware                │
  ───────────────▶  • derive identity (API key or IP)           │
                 │  • TierStore.resolve(id) ── cached ──┐        │
                 │                                       ▼        │
                 │  • RateLimiter.consume(id, policy)            │
                 └───────────────────────┬──────────────────────┘
                                         │  EVALSHA (atomic)
                                         ▼
                            ┌─────────────────────────┐
                            │   Redis  +  Lua script   │
                            │  (count / refill / evict)│
                            └─────────────────────────┘
                                         │
                         { allowed, remaining, resetMs, retryAfterMs }
                                         │
                 ┌───────────────────────▼──────────────────────┐
                 │  set RateLimit headers · record metrics       │
                 │  allowed → next()   |   blocked → 429          │
                 └──────────────────────────────────────────────┘
```

All state lives in Redis and all mutation happens inside Lua, so the Node process is stateless. Run any number of gateway instances behind a load balancer; they share one consistent view of every client's usage.

## Algorithms

| Algorithm | Accuracy | Memory per key | Notes |
|---|---|---|---|
| `sliding-window-counter` | High (weighted approximation) | O(1) | Default. Two-window estimate; no boundary burst. |
| `token-bucket` | Smooth, with controlled bursts | O(1) | Lazy time-based refill; `burst` ceiling above the steady rate. |
| `sliding-window-log` | Exact | O(N) | Sorted set of timestamps. For low-volume, high-value endpoints. |
| `fixed-window` | Low (boundary bursts) | O(1) | Single counter per window. Baseline. |

`sliding-window-counter` keeps the request count for the current fixed window and the previous one, then estimates the rolling count as `current + previous × (overlap fraction of the previous window)`. This removes the fixed-window boundary-burst weakness — where a client can send up to twice the limit across a window edge — without the O(N) memory of a full request log.

`token-bucket` stores a token count and a last-touch timestamp. Tokens refill lazily as `elapsed × rate`, capped at `capacity`, so no background timer is needed and bursts up to `capacity` are permitted above the sustained rate.

## Usage

Run Redis, install, and start the demo:

```bash
npm run redis:up   # Redis via Docker
npm install
npm run demo       # gateway + dashboard at http://localhost:3000
```

The demo serves a single-page dashboard that drives traffic at a chosen tier and shows admitted vs. rejected requests, live rate-limit headers, and remaining capacity.

### Middleware

```ts
import { createRedis, RateLimiter, TierStore, DEFAULT_TIERS, expressRateLimit } from 'guardrail';

const redis = createRedis(process.env.REDIS_URL);
const limiter = new RateLimiter(redis, { onError: 'open' });
const tiers = new TierStore(redis, { seedTiers: DEFAULT_TIERS });

app.use(expressRateLimit({
  limiter,
  tierStore: tiers,
  keyGenerator: (req) => req.header('x-api-key') ?? `ip:${req.ip}`,
}));
```

### Core (any transport)

```ts
const result = await limiter.consume('user:42', {
  limit: 100,
  windowMs: 60_000,
  algorithm: 'token-bucket',
  burst: 150,
});

if (!result.allowed) {
  throw new TooManyRequests(result.retryAfterMs);
}
```

`consume` returns `{ allowed, limit, remaining, resetMs, retryAfterMs, algorithm }`. `peek` performs the same check without consuming; `reset` clears a client's usage (e.g. after a successful login resets a brute-force counter).

### Tiers

A tier maps an identifier to a policy through two Redis lookups, both cached in-process:

```
api key / user id  ──▶  tier name  ──▶  policy { limit, windowMs, algorithm, burst }
```

Reassigning a customer from `free` to `premium` is a single Redis write; every gateway instance observes it within the cache TTL.

## Benchmarks

Single Node process, concurrency 100, 1,000 distinct keys, Redis in Docker on `localhost` (`npm run bench`):

| Algorithm | Throughput | p50 | p95 | p99 |
|---|---|---|---|---|
| `fixed-window` | ~43,800 ops/s | 2.1 ms | 3.4 ms | 4.5 ms |
| `token-bucket` | ~34,800 ops/s | 2.8 ms | 3.6 ms | 4.4 ms |
| `sliding-window-counter` | ~32,800 ops/s | 2.9 ms | 4.3 ms | 5.8 ms |
| `sliding-window-log` | ~22,000 ops/s | 4.3 ms | 6.9 ms | 9.4 ms |

Numbers are localhost-relative and exist to compare algorithms and catch regressions. The ordering is the takeaway: the exact log algorithm is the most expensive, the O(1) windows the cheapest.

## Testing

```bash
npm test
```

22 tests run against a live Redis. Coverage includes the concurrency guarantee (500 simultaneous requests admit exactly the limit, per algorithm), window recovery and boundary-burst behaviour, token-bucket refill and burst ceilings, dynamic tier resolution, and cache-TTL propagation of policy changes.

## Design notes

- **Lua over `WATCH`/`MULTI`.** Optimistic transactions retry under contention; a Lua script is a single atomic execution with no retries, lower latency, and simpler reasoning.
- **`EVALSHA` with auto-fallback.** `ioredis.defineCommand` caches each script's SHA and re-loads on `NOSCRIPT` after a Redis restart or failover, giving script-cache efficiency without manual bookkeeping.
- **Two-window counter as the default.** O(1) memory with no boundary-burst weakness, the right default for high-volume traffic. The exact log is opt-in where its cost is justified.
- **Bounded staleness for tiers.** The in-process cache keeps the hot path at roughly zero extra round trips; policy changes propagate within `cacheTtlMs`.
- **Explicit failure mode.** Redis being a hard dependency, the limiter is configured to either fail open (availability-first) or fail closed (protection-first) rather than throwing into the request path.

## Deployment

A [`render.yaml`](render.yaml) blueprint provisions the gateway and a Redis instance together. From the Render dashboard: New → Blueprint → select the repository → Apply. `REDIS_URL` is wired automatically and the gateway seeds its tiers on boot, so no post-deploy configuration is required. A `Dockerfile` is included for any container platform.

## Stack

Node.js, TypeScript, Redis (Lua), Express, Fastify, prom-client, Vitest, Docker.

## License

MIT
