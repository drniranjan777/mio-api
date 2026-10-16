import mongoose from 'mongoose';

import { env } from './env.js';
import { logger } from './logger.js';

mongoose.set('strictQuery', true);

export async function connectDb(uri) {
  await mongoose.connect(uri, { autoIndex: true, serverSelectionTimeoutMS: 10_000 });
  // syncIndexes also drops stale indexes: with several PM2 workers only worker 0
  // does it, so they don't race each other (autoIndex still creates new ones).
  if (env.isPrimaryWorker) await Promise.all(Object.values(mongoose.models).map((m) => m.syncIndexes()));
  logger.info({ db: mongoose.connection.name }, 'MongoDB connected');
}

export async function disconnectDb() {
  await mongoose.disconnect();
}
