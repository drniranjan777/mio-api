import rateLimit from 'express-rate-limit';

import { env } from '../config/env.js';

const handler = (_req, res) =>
  res.status(429).json({
    success: false,
    error: { code: 'RATE_LIMITED', message: 'Too many requests. Please wait and try again.' },
  });

const make = (windowMs, limit) =>
  rateLimit({ windowMs, limit, standardHeaders: 'draft-7', legacyHeaders: false, handler, skip: () => env.isTest });

/** OTP request / verify / receptionist request: per IP. */
export const authLimiter = make(15 * 60 * 1000, 30);

/** Admin password login. */
export const loginLimiter = make(15 * 60 * 1000, 10);

/** Everything else. */
export const apiLimiter = make(60 * 1000, 300);
