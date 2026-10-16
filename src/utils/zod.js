import mongoose from 'mongoose';
import { z } from 'zod';

/**
 * Indian mobile number without country code. The 5-series is accepted too:
 * real subscribers register with numbers starting 5 (client report 11 Oct 2026).
 */
export const MOBILE_RE = /^[5-9]\d{9}$/;
export const mobile = z.string().trim().regex(MOBILE_RE, 'Enter a valid 10-digit mobile number');

export const objectId = z
  .string()
  .refine((v) => mongoose.isValidObjectId(v), 'Invalid id');

export const idParam = z.object({ id: objectId });

export const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:mm (24h)');

export const day = z.enum(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']);

export const pagination = {
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
};

/** Optional trimmed string with a max length (empty string → undefined). */
export const text = (max = 200) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => (v === '' ? undefined : v))
    .optional();

/** Display text: HTML tags and control characters removed, whitespace collapsed. */
export const plainText = (min, max) =>
  z
    .string()
    .transform((v) =>
      v
        .replace(/<[^>]*>/g, ' ')
        .replace(/\p{Cc}/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim(),
    )
    .pipe(z.string().min(min).max(max));

/** Public https link (no javascript:, data:, http: or credentials). */
export const httpsUrl = z
  .string()
  .trim()
  .max(500)
  .url()
  .refine((v) => {
    try {
      const u = new URL(v);
      return u.protocol === 'https:' && !u.username && !u.password;
    } catch {
      return false;
    }
  }, 'Use a full https:// link');
