import { createApp } from './app.js';
import { connectDb, disconnectDb } from './config/db.js';
import { env } from './config/env.js';
import { logger } from './config/logger.js';

async function main() {
  await connectDb(env.MONGODB_URI);
  const server = createApp().listen(env.PORT, env.HOST, () => {
    logger.info({ host: env.HOST, port: env.PORT, prefix: env.API_PREFIX }, 'MIO Doctors API listening');
  });

  const shutdown = (signal) => {
    logger.info({ signal }, 'Shutting down');
    server.close(async () => {
      await disconnectDb();
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
