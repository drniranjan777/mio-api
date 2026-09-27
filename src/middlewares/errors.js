import mongoose from 'mongoose';

import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { ApiError } from '../utils/ApiError.js';

export function notFound(req, _res, next) {
  next(ApiError.notFound(`Route ${req.method} ${req.path} not found`, 'ROUTE_NOT_FOUND'));
}

export function errorHandler(err, req, res, _next) {
  let error = err;

  if (err?.code === 11000) {
    const field = Object.keys(err.keyPattern ?? {})[0] ?? 'value';
    error = ApiError.conflict(`Duplicate ${field}`, 'DUPLICATE');
  } else if (err instanceof mongoose.Error.CastError) {
    error = ApiError.badRequest(`Invalid ${err.path}`, undefined, 'INVALID_ID');
  } else if (err instanceof mongoose.Error.ValidationError) {
    const details = Object.values(err.errors).map((e) => ({ path: e.path, message: e.message }));
    error = ApiError.badRequest('Validation failed', details, 'VALIDATION_ERROR');
  } else if (err?.type === 'entity.parse.failed') {
    error = ApiError.badRequest('Malformed JSON body', undefined, 'INVALID_JSON');
  } else if (err?.type === 'entity.too.large') {
    error = new ApiError(413, 'PAYLOAD_TOO_LARGE', 'Request body is too large');
  }

  if (!(error instanceof ApiError)) {
    logger.error({ err, path: req.path, method: req.method }, 'Unhandled error');
    error = new ApiError(500, 'INTERNAL_ERROR', 'Something went wrong. Please try again.');
  } else if (error.status >= 500) {
    logger.error({ err, path: req.path }, error.message);
  }

  const body = { success: false, error: { code: error.code, message: error.message } };
  if (error.details) body.error.details = error.details;
  if (!env.isProduction && error.status === 500 && err?.message) body.error.debug = err.message;
  res.status(error.status).json(body);
}
