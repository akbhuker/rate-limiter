import {
  Counter,
  Histogram,
  Registry,
  collectDefaultMetrics,
} from 'prom-client';
import type { RateLimitResult } from '../core/types';

/**
 * Prometheus instrumentation for the limiter. Expose `registry` at /metrics and
 * scrape it to chart allow/block rates per tier and algorithm, and to alert on
 * a sudden spike in blocks (a likely abuse / DDoS signal).
 */
export class LimiterMetrics {
  readonly registry: Registry;
  private readonly decisions: Counter<'algorithm' | 'tier' | 'decision'>;
  private readonly latency: Histogram<'algorithm'>;

  constructor(registry = new Registry(), collectDefaults = true) {
    this.registry = registry;
    if (collectDefaults) collectDefaultMetrics({ register: registry });

    this.decisions = new Counter({
      name: 'ratelimit_decisions_total',
      help: 'Rate-limit decisions partitioned by outcome',
      labelNames: ['algorithm', 'tier', 'decision'],
      registers: [registry],
    });

    this.latency = new Histogram({
      name: 'ratelimit_check_duration_seconds',
      help: 'Wall-clock time of a limiter check (incl. Redis round-trip)',
      labelNames: ['algorithm'],
      // Sub-millisecond to ~50ms — Redis Lua checks should sit at the low end.
      buckets: [0.0005, 0.001, 0.0025, 0.005, 0.01, 0.025, 0.05],
      registers: [registry],
    });
  }

  record(result: RateLimitResult, durationSeconds: number): void {
    this.decisions.inc({
      algorithm: result.algorithm,
      tier: result.tier ?? 'none',
      decision: result.allowed ? 'allowed' : 'blocked',
    });
    this.latency.observe({ algorithm: result.algorithm }, durationSeconds);
  }

  async expose(): Promise<string> {
    return this.registry.metrics();
  }

  get contentType(): string {
    return this.registry.contentType;
  }
}
