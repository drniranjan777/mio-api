import mongoose from 'mongoose';

import { logger } from './logger.js';

mongoose.set('strictQuery', true);

export async function connectDb(uri) {
  await mongoose.connect(uri, { autoIndex: true, serverSelectionTimeoutMS: 10_000 });
  await Promise.all(Object.values(mongoose.models).map((m) => m.syncIndexes()));
  logger.info({ db: mongoose.connection.name }, 'MongoDB connected');
}

export async function disconnectDb() {
  await mongoose.disconnect();
}
