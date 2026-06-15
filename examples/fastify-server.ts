/**
 * Example API gateway on Fastify, same limiter + tier store as the Express one.
 *
 *   npm run redis:up && npm run seed && npm run example:fastify
 *   curl -i -H 'x-api-key: key_premium_demo' http://localhost:3000/api/resource
 */
import Fastify from 'fastify';
import { createRedis } from '../src/core/redisClient';
import { RateLimiter } from '../src/core/RateLimiter';
import { TierStore, DEFAULT_TIERS } from '../src/core/tierStore';
import { LimiterMetrics } from '../src/metrics';
import { fastifyRateLimit } from '../src/middleware/fastify';
import { config } from '../src/config';

async function main(): Promise<void> {
  const redis = createRedis(config.redisUrl);
  const limiter = new RateLimiter(redis, { onError: 'open' });
  const tierStore = new TierStore(redis, { seedTiers: DEFAULT_TIERS });
  const metrics = new LimiterMetrics();

  const app = Fastify({ logger: false });

  const keyGenerator = (req: { headers: Record<string, unknown>; ip: string }): string => {
    const apiKey = req.headers['x-api-key'];
    return typeof apiKey === 'string' ? apiKey : `ip:${req.ip}`;
  };

  app.addHook(
    'onRequest',
    fastifyRateLimit({
      limiter,
      tierStore,
      metrics,
      keyGenerator,
      skip: (req) => req.url === '/health' || req.url === '/metrics',
    }),
  );

  app.get('/health', async () => ({ status: 'ok' }));

  app.get('/metrics', async (_req, reply) => {
    reply.header('Content-Type', metrics.contentType);
    return metrics.expose();
  });

  app.get('/api/resource', async () => ({
    data: 'protected resource',
    servedAt: new Date().toISOString(),
  }));

  await app.listen({ port: config.port, host: '0.0.0.0' });
  // eslint-disable-next-line no-console
  console.log(`fastify gateway listening on http://localhost:${config.port}`);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
