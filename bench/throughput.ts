/**
 * Throughput / latency micro-benchmark for the limiter core (no HTTP layer).
 * Measures end-to-end consume() ops/sec and latency percentiles against a live
 * Redis, for each algorithm.
 *
 *   npm run redis:up && npm run bench
 *
 * Numbers depend heavily on where Redis runs (localhost vs network) — this
 * exists to compare algorithms relative to each other and to catch regressions.
 */
import { createRedis } from '../src/core/redisClient';
import { RateLimiter } from '../src/core/RateLimiter';
import type { Algorithm } from '../src/core/types';

const TOTAL = Number(process.env.BENCH_OPS ?? 50_000);
const CONCURRENCY = Number(process.env.BENCH_CONCURRENCY ?? 100);
const DISTINCT_KEYS = Number(process.env.BENCH_KEYS ?? 1_000);

function percentile(sorted: number[], p: number): number {
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx]!;
}

async function runOne(limiter: RateLimiter, algorithm: Algorithm): Promise<void> {
  const policy = { limit: 1_000_000, windowMs: 60_000, algorithm, burst: 1_000_000 };
  const latencies: number[] = new Array(TOTAL);
  let done = 0;
  let next = 0;

  const start = process.hrtime.bigint();

  async function worker(): Promise<void> {
    while (next < TOTAL) {
      const i = next++;
      const key = `bench-${algorithm}-${i % DISTINCT_KEYS}`;
      const t0 = process.hrtime.bigint();
      await limiter.consume(key, policy);
      latencies[i] = Number(process.hrtime.bigint() - t0) / 1e6; // ms
      done++;
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

  const elapsedSec = Number(process.hrtime.bigint() - start) / 1e9;
  latencies.sort((a, b) => a - b);
  const ops = Math.round(done / elapsedSec);

  // eslint-disable-next-line no-console
  console.log(
    `${algorithm.padEnd(24)} ${ops.toLocaleString().padStart(9)} ops/s  ` +
      `p50=${percentile(latencies, 50).toFixed(3)}ms  ` +
      `p95=${percentile(latencies, 95).toFixed(3)}ms  ` +
      `p99=${percentile(latencies, 99).toFixed(3)}ms`,
  );
}

async function main(): Promise<void> {
  const redis = createRedis();
  await redis.ping();
  const limiter = new RateLimiter(redis);

  // eslint-disable-next-line no-console
  console.log(
    `\nBenchmark: ${TOTAL.toLocaleString()} ops, concurrency=${CONCURRENCY}, ` +
      `${DISTINCT_KEYS} distinct keys\n`,
  );

  const algorithms: Algorithm[] = [
    'fixed-window',
    'sliding-window-counter',
    'token-bucket',
    'sliding-window-log',
  ];

  for (const algorithm of algorithms) {
    // Warm the script cache / connection before measuring.
    await limiter.consume('warmup', { limit: 10, windowMs: 1_000, algorithm });
    await runOne(limiter, algorithm);
  }

  await redis.quit();
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
