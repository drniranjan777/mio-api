/**
 * One "API worker" for tests/rateLimits.test.js: the real limiters on a shared
 * Redis (TEST_REDIS_URL, keys under TEST_RL_PREFIX), behind a tiny Express app.
 * Prints its port on stdout once listening.
 */
import express from 'express';
import { Redis } from 'ioredis';

const { createLimiters } = await import('../../src/middlewares/rateLimits.js');

const redis = new Redis(process.env.TEST_REDIS_URL, { maxRetriesPerRequest: 1 });
const { loginLimiter, apiLimiter } = createLimiters({ redis, enabled: true, prefix: process.env.TEST_RL_PREFIX });

const app = express();
app.post('/login', loginLimiter, (_req, res) => res.json({ pid: process.pid }));
app.get('/api', apiLimiter, (_req, res) => res.json({ pid: process.pid }));
const server = app.listen(0, '127.0.0.1', () => process.stdout.write(`${server.address().port}\n`));

process.on('SIGTERM', () => {
  server.close();
  redis.disconnect();
});
