/**
 * Example API gateway: Express + dynamic per-tier limits + Prometheus metrics.
 *
 *   npm run redis:up        # start Redis
 *   npm run seed            # load tiers + demo api keys
 *   npm run example:express # start this server
 *
 * Then:
 *   curl -i -H 'x-api-key: key_free_demo'    http://localhost:3000/api/resource
 *   curl -i -H 'x-api-key: key_premium_demo' http://localhost:3000/api/resource
 *   curl -s http://localhost:3000/metrics | grep ratelimit
 */
import express from 'express';
import { join } from 'node:path';
import { createRedis } from '../src/core/redisClient';
import { RateLimiter } from '../src/core/RateLimiter';
import { TierStore, DEFAULT_TIERS } from '../src/core/tierStore';
import { LimiterMetrics } from '../src/metrics';
import { expressRateLimit } from '../src/middleware/express';
import { config } from '../src/config';

async function main(): Promise<void> {
  const redis = createRedis(config.redisUrl);
  const limiter = new RateLimiter(redis, { onError: 'open' });
  const tierStore = new TierStore(redis, { cacheTtlMs: 5_000 });
  const metrics = new LimiterMetrics();

  // Self-seed tiers + demo API-key assignments so a fresh deploy works with no
  // manual seed step (the dashboard relies on these three keys existing).
  await tierStore.seed(DEFAULT_TIERS);
  await tierStore.assign('key_free_demo', 'free');
  await tierStore.assign('key_premium_demo', 'premium');
  await tierStore.assign('key_enterprise_demo', 'enterprise');

  const app = express();
  app.set('trust proxy', true);
  app.use(express.json());

  // Serve the live demo dashboard (static, never rate-limited).
  app.use(express.static(join(__dirname, 'public')));

  // Identify clients by API key when present, else by IP. Anonymous traffic
  // shares the `free` tier via the default assignment.
  const keyGenerator = (req: express.Request): string => {
    const apiKey = req.header('x-api-key');
    return apiKey ?? `ip:${req.ip}`;
  };

  // Health check bypasses limiting.
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  app.get('/metrics', async (_req, res) => {
    res.setHeader('Content-Type', metrics.contentType);
    res.send(await metrics.expose());
  });

  // Demo helper: clear a key's usage so the dashboard can be replayed.
  app.post('/admin/reset', async (req, res) => {
    const key = String(req.body?.key ?? '');
    if (!key) {
      res.status(400).json({ error: 'key required' });
      return;
    }
    await limiter.reset(key);
    res.json({ ok: true, reset: key });
  });

  // Only /api/* is rate limited; the dashboard, health, metrics and admin are exempt.
  app.use(
    expressRateLimit({
      limiter,
      tierStore,
      metrics,
      keyGenerator,
      skip: (req) => !req.path.startsWith('/api/'),
    }),
  );

  app.get('/api/resource', (_req, res) => {
    res.json({ data: 'protected resource', servedAt: new Date().toISOString() });
  });

  app.listen(config.port, () => {
    // eslint-disable-next-line no-console
    console.log(`\n  Guardrail demo → open  http://localhost:${config.port}\n`);
    // eslint-disable-next-line no-console
    console.log(`  API:     curl -i -H "x-api-key: key_free_demo" http://localhost:${config.port}/api/resource`);
    // eslint-disable-next-line no-console
    console.log(`  Metrics: http://localhost:${config.port}/metrics\n`);
  });
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
