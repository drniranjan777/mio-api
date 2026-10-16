import { createApp } from './app.js';
import { connectDb, disconnectDb } from './config/db.js';
import { env } from './config/env.js';
import { logger } from './config/logger.js';
import { closeRedis } from './config/redis.js';

async function main() {
  await connectDb(env.MONGODB_URI);
  const server = createApp().listen(env.PORT, env.HOST, () => {
    logger.info(
      { host: env.HOST, port: env.PORT, prefix: env.API_PREFIX, worker: process.env.NODE_APP_INSTANCE, rateLimitStore: env.REDIS_URL ? 'redis' : 'memory' },
      'MIO Doctors API listening',
    );
  });

  const shutdown = (signal) => {
    logger.info({ signal }, 'Shutting down');
    server.close(async () => {
      await Promise.allSettled([disconnectDb(), closeRedis()]);
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  logger.fatal({ err }, 'Failed to start');
  process.exit(1);
});
