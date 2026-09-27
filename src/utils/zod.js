import mongoose from 'mongoose';
import { z } from 'zod';

/** Indian mobile number without country code. */
export const mobile = z
  .string()
  .trim()
  .regex(/^[6-9]\d{9}$/, 'Enter a valid 10-digit mobile number');

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
