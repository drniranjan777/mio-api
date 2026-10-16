import rateLimit from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';

import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { getRedis } from '../config/redis.js';

const handler = (_req, res) =>
  res.status(429).json({
    success: false,
    error: { code: 'RATE_LIMITED', message: 'Too many requests. Please wait and try again.' },
  });

/**
 * Counters live in Redis when a client is given (shared by every PM2 worker),
 * otherwise in this process's memory (dev, tests, a single fork-mode process).
 * Each limiter gets its own key prefix so their counts never mix.
 */
function redisStore(redis, prefix) {
  const store = new RedisStore({
    prefix,
    sendCommand: (command, ...args) => redis.call(command, ...args),
  });
  // The store loads its Lua scripts eagerly and reloads them on first use if that
  // failed (Redis not up yet); don't let the eager attempt crash the process.
  store.incrementScriptSha.catch(() => {});
  store.getScriptSha.catch(() => {});
  return store;
}

/**
 * Builds the three limiters. Exported for tests (`redis` = a shared client,
 * `enabled` overrides the test/env switch, `prefix` namespaces the Redis keys).
 */
export function createLimiters({ redis = getRedis(), enabled = !env.isTest && env.RATE_LIMITS_ENABLED, prefix = 'mio:rl:' } = {}) {
  const make = (name, windowMs, limit) =>
    rateLimit({
      windowMs,
      limit,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      handler,
      skip: () => !enabled,
      ...(redis && {
        store: redisStore(redis, `${prefix}${name}:`),
        // Redis down → let requests through (logged) rather than fail every call.
        passOnStoreError: true,
      }),
    });
  return {
    /** OTP request / verify / receptionist request / recovery: per IP. */
    authLimiter: make('auth', 15 * 60 * 1000, 30),
    /** Admin password login. */
    loginLimiter: make('login', 15 * 60 * 1000, 10),
    /** Everything else. */
    apiLimiter: make('api', 60 * 1000, 300),
  };
}

const limiters = createLimiters();
if (env.isClustered && !getRedis() && !env.isTest) {
  logger.warn('Several API workers but no REDIS_URL: each worker keeps its own rate-limit counters');
}

export const { authLimiter, loginLimiter, apiLimiter } = limiters;
