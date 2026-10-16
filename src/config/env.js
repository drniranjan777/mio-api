import { z } from 'zod';

const bool = z
  .enum(['true', 'false'])
  .transform((v) => v === 'true');

/**
 * True when this process is one of several workers: PM2 cluster mode exports
 * `exec_mode=cluster_mode`; `npm run loadtest -- --workers N` sets API_WORKERS.
 */
export function isClustered(e = process.env) {
  return e.exec_mode === 'cluster_mode' || Number(e.instances) > 1 || Number(e.API_WORKERS) > 1;
}

const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(4000),
    /** 127.0.0.1 on a server behind Nginx, so the API is never reachable directly. */
    HOST: z.string().default('0.0.0.0'),
    API_PREFIX: z.string().default('/api/v1'),
    /** Public origin of this API, used to build image URLs (e.g. https://api.miodoctors.com). */
    PUBLIC_BASE_URL: z.string().url().optional(),
    /** Where uploaded images are stored (keep outside the code folder on servers). */
    UPLOADS_DIR: z.string().default('uploads'),
    MONGODB_URI: z.string().min(1),
    JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 characters'),
    JWT_ACCESS_TTL: z.string().default('15m'),
    REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),
    OTP_PEPPER: z.string().min(16, 'OTP_PEPPER must be at least 16 characters'),
    OTP_DEV_MODE: bool.default('false'),
    OTP_TTL_SECONDS: z.coerce.number().int().positive().default(300),
    OTP_RESEND_SECONDS: z.coerce.number().int().nonnegative().default(45),
    OTP_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
    CORS_ORIGINS: z.string().default(''),
    TZ_OFFSET_MINUTES: z.coerce.number().int().default(330),
    /** Only the mock provider exists today; a real gateway plugs in behind PaymentProvider. */
    PAYMENT_PROVIDER: z.enum(['mock']).default('mock'),
    /** false = checkout answers "payments not available yet" (free plans still work). */
    PAYMENTS_ENABLED: bool.default('true'),
    PAYMENT_ORDER_TTL_MINUTES: z.coerce.number().int().positive().default(30),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
    /** false only for local load tests (`npm run loadtest`); refused in production. */
    RATE_LIMITS_ENABLED: bool.default('true'),
    /**
     * Shared store for rate-limit counters (e.g. redis://127.0.0.1:6379/0). Required
     * when PM2 runs several workers; unset = in-memory counters (one process only).
     */
    REDIS_URL: z.preprocess((v) => (v === '' ? undefined : v), z.string().regex(/^rediss?:\/\//, 'REDIS_URL must start with redis:// or rediss://').optional()),
  })
  .refine((e) => !(e.NODE_ENV === 'production' && e.OTP_DEV_MODE), {
    message: 'OTP_DEV_MODE must be false in production',
    path: ['OTP_DEV_MODE'],
  })
  .refine((e) => !(e.NODE_ENV === 'production' && !e.RATE_LIMITS_ENABLED), {
    message: 'Rate limits cannot be disabled in production',
    path: ['RATE_LIMITS_ENABLED'],
  })
  .refine((e) => !(e.NODE_ENV === 'production' && isClustered() && !e.REDIS_URL), {
    message: 'Cluster mode needs REDIS_URL so rate limits are shared by all workers (or run a single fork-mode process)',
    path: ['REDIS_URL'],
  })
  .refine((e) => !(e.NODE_ENV === 'production' && e.PAYMENT_PROVIDER === 'mock' && e.PAYMENTS_ENABLED), {
    message: 'The mock payment provider cannot be used in production (set PAYMENTS_ENABLED=false until a real gateway is added)',
    path: ['PAYMENT_PROVIDER'],
  });

function load() {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n  ');
    throw new Error(`Invalid environment configuration:\n  ${issues}`);
  }
  const env = parsed.data;
  return Object.freeze({
    ...env,
    isProduction: env.NODE_ENV === 'production',
    isTest: env.NODE_ENV === 'test',
    isClustered: isClustered(),
    /** PM2 numbers workers 0..n-1; one-off jobs (worker 0 only) check this. */
    isPrimaryWorker: (process.env.NODE_APP_INSTANCE ?? '0') === '0',
    corsOrigins: env.CORS_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean),
    publicBaseUrl: (env.PUBLIC_BASE_URL ?? `http://localhost:${env.PORT}`).replace(/\/+$/, ''),
  });
}

export const env = load();
