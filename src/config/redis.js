import { Redis } from 'ioredis';

import { env } from './env.js';
import { logger } from './logger.js';

let client;

/**
 * Shared Redis connection (rate-limit counters), or null when REDIS_URL is unset.
 * Commands fail fast while Redis is down instead of queueing, so a Redis outage
 * degrades to "no rate limit" (see rateLimits.js) rather than hanging requests.
 */
export function getRedis() {
  if (!env.REDIS_URL) return null;
  if (!client) {
    client = new Redis(env.REDIS_URL, {
      connectionName: 'mio-api',
      maxRetriesPerRequest: 1,
      connectTimeout: 5_000,
      retryStrategy: (times) => Math.min(times * 200, 5_000),
    });
    let down = false;
    client.on('error', (err) => {
      if (!down) logger.error({ err: err.message }, 'Redis connection error');
      down = true;
    });
    client.on('ready', () => {
      if (down) logger.info('Redis connection restored');
      down = false;
    });
  }
  return client;
}

export async function closeRedis() {
  if (!client) return;
  const c = client;
  client = undefined;
  await c.quit().catch(() => c.disconnect());
}
