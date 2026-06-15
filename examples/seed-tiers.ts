/**
 * Seed tier definitions and a couple of demo API-key -> tier assignments.
 * Run once before the example servers:  npm run seed
 */
import { createRedis } from '../src/core/redisClient';
import { TierStore, DEFAULT_TIERS } from '../src/core/tierStore';

async function main(): Promise<void> {
  const redis = createRedis();
  const tiers = new TierStore(redis);

  await tiers.seed(DEFAULT_TIERS);

  // Demo assignments — `keyGenerator` in the example server maps the
  // `x-api-key` header to these identifiers.
  await tiers.assign('key_free_demo', 'free');
  await tiers.assign('key_premium_demo', 'premium');
  await tiers.assign('key_enterprise_demo', 'enterprise');

  // eslint-disable-next-line no-console
  console.log('Seeded tiers:', DEFAULT_TIERS.map((t) => `${t.name}(${t.limit}/${t.windowMs}ms)`).join(', '));
  // eslint-disable-next-line no-console
  console.log('Assigned demo keys: key_free_demo, key_premium_demo, key_enterprise_demo');

  await redis.quit();
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
