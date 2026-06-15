import type { Algorithm } from './core/types';

/** Central env-driven config used by the example servers and benchmark. */
export const config = {
  redisUrl: process.env.REDIS_URL ?? 'redis://127.0.0.1:6379',
  port: Number(process.env.PORT ?? 3000),
  algorithm: (process.env.RATE_LIMIT_ALGORITHM ?? 'sliding-window-counter') as Algorithm,
};
