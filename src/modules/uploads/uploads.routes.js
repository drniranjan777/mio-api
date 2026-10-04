import path from 'node:path';

import express, { Router } from 'express';
import { z } from 'zod';

import { env } from '../../config/env.js';
import { authenticate, requireRole } from '../../middlewares/auth.js';
import { validate } from '../../middlewares/validate.js';
import { audit } from '../audit/audit.js';
import { adminCan } from '../staff/adminAccess.js';
import { asyncHandler, created } from '../../utils/http.js';
import { IMAGE_RULES, saveImage } from './storage.service.js';

/** Admin image upload: raw image bytes in the body (no multipart needed). Mounted at /admin/uploads. */
export const adminUploadsRouter = Router();
adminUploadsRouter.use(authenticate, requireRole('admin'));

adminUploadsRouter.post(
  '/images',
  validate({ query: z.object({ purpose: z.enum(Object.keys(IMAGE_RULES)) }) }),
  // Section permission follows the purpose (only banners today).
  (req, res, next) => adminCan(`${req.query.purpose}s`)(req, res, next),
  express.raw({ type: ['image/jpeg', 'image/png', 'image/webp', 'application/octet-stream'], limit: '3mb' }),
  asyncHandler(async (req, res) => {
    const image = await saveImage(req.body, req.query.purpose);
    await audit({ actor: req.user, action: 'upload.image', module: 'uploads', entityType: 'Upload', entityId: image.key, after: { bytes: image.bytes, width: image.width, height: image.height }, req });
    return created(res, image);
  }),
);

/**
 * Public, cacheable image files at /uploads/<folder>/<random>.<ext>.
 * Random 128-bit names; no directory listing; served as images only.
 * Anything not found falls through to the normal JSON 404.
 */
export function uploadsStatic() {
  return express.static(path.resolve(env.UPLOADS_DIR), {
    index: false,
    dotfiles: 'deny',
    immutable: true,
    maxAge: '365d',
    setHeaders(res) {
      res.set('X-Content-Type-Options', 'nosniff');
      // Loaded by the admin panel and the Flutter web build from other origins.
      res.set('Cross-Origin-Resource-Policy', 'cross-origin');
      res.set('Access-Control-Allow-Origin', '*');
      res.set('Content-Security-Policy', "default-src 'none'; sandbox");
    },
  });
}
