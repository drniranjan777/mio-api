import cors from 'cors';
import express from 'express';
import mongoSanitize from 'express-mongo-sanitize';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';

import { env } from './config/env.js';
import { logger } from './config/logger.js';
import { errorHandler, notFound } from './middlewares/errors.js';
import { apiLimiter } from './middlewares/rateLimits.js';
import { UPLOAD_ROUTE } from './modules/uploads/storage.service.js';
import { uploadsStatic } from './modules/uploads/uploads.routes.js';
import { apiRouter } from './routes.js';

export function createApp() {
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', 1);

  app.use(helmet());
  app.use(
    cors({
      origin(origin, cb) {
        // Mobile apps send no Origin header; browsers must be on the allow-list.
        if (!origin || env.corsOrigins.includes(origin)) return cb(null, true);
        return cb(null, false);
      },
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
      allowedHeaders: ['Content-Type', 'Authorization'],
      maxAge: 600,
    }),
  );
  app.use(express.json({ limit: '100kb' }));
  app.use(mongoSanitize());
  if (!env.isTest) {
    app.use(pinoHttp({ logger, autoLogging: { ignore: (req) => req.url.endsWith('/health') } }));
  }

  app.use(UPLOAD_ROUTE, uploadsStatic());
  app.use(env.API_PREFIX, apiLimiter, apiRouter);

  app.use(notFound);
  app.use(errorHandler);
  return app;
}
