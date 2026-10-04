import { Router } from 'express';
import { z } from 'zod';

import { authenticate, requireRole } from '../../middlewares/auth.js';
import { validate } from '../../middlewares/validate.js';
import { asyncHandler, created, noContent, ok } from '../../utils/http.js';
import { httpsUrl, idParam, objectId, pagination, plainText, text } from '../../utils/zod.js';
import { isoDate } from '../appointments/appointments.routes.js';
import { adminCan } from '../staff/adminAccess.js';
import { BANNER_STATUS, REDIRECT_TYPES, TARGETING } from './banner.model.js';
import * as banners from './banners.service.js';

const imageKey = z.string().regex(/^banners\/[a-f0-9]{32}\.(png|jpg|webp)$/, 'Upload the image first');
const dateOrNull = isoDate.nullable();

const fields = {
  title: plainText(3, 120),
  description: plainText(0, 300).optional(),
  imageKey,
  mobileImageKey: imageKey.nullable().optional(),
  showText: z.boolean().default(false),
  redirectType: z.enum(REDIRECT_TYPES).default('none'),
  redirectTarget: z.string().trim().max(500).nullable().optional(),
  targeting: z.enum(TARGETING),
  locationIds: z.array(objectId).max(100).default([]),
  status: z.enum(BANNER_STATUS).default('draft'),
  startDate: dateOrNull.optional(),
  endDate: dateOrNull.optional(),
  priority: z.coerce.number().int().min(1).max(999).default(10),
};

/** External links must be https; internal targets are checked against the catalogue in the service. */
const redirectRule = (b, ctx) => {
  if (b.redirectType === 'external' && !httpsUrl.safeParse(b.redirectTarget ?? '').success) {
    ctx.addIssue({ code: 'custom', path: ['redirectTarget'], message: 'Use a full https:// link' });
  }
  if (b.redirectType === 'internal' && !b.redirectTarget) {
    ctx.addIssue({ code: 'custom', path: ['redirectTarget'], message: 'Choose an app screen' });
  }
};

const createBody = z.object(fields).strict().superRefine(redirectRule);
const updateBody = z
  .object(Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, k === 'description' ? v : v.optional()])))
  .strict()
  .superRefine((b, ctx) => {
    if (b.redirectType !== undefined) redirectRule(b, ctx);
    if (!Object.keys(b).length) ctx.addIssue({ code: 'custom', message: 'Nothing to update' });
  });

const listQuery = z.object({
  ...pagination,
  q: text(80),
  status: z.enum(['draft', 'active', 'inactive', 'scheduled', 'expired']).optional(),
  locationId: z.union([z.literal('all'), objectId]).optional(),
  sort: z.enum(['priority', 'newest', 'start', 'title']).default('priority'),
});

/** Mounted at /admin/banners. */
export const adminBannersRouter = Router();
adminBannersRouter.use(authenticate, requireRole('admin'), adminCan('banners'));

adminBannersRouter.get('/options', asyncHandler(async (_req, res) => ok(res, await banners.bannerOptions())));
adminBannersRouter.get(
  '/',
  validate({ query: listQuery }),
  asyncHandler(async (req, res) => {
    const { items, meta } = await banners.listBanners(req.query);
    return ok(res, items, meta);
  }),
);
adminBannersRouter.post('/', validate({ body: createBody }), asyncHandler(async (req, res) => created(res, await banners.createBanner(req.user, req.body, req))));
adminBannersRouter.get('/:id', validate({ params: idParam }), asyncHandler(async (req, res) => ok(res, await banners.getBanner(req.params.id))));
adminBannersRouter.put(
  '/:id',
  validate({ params: idParam, body: updateBody }),
  asyncHandler(async (req, res) => ok(res, await banners.updateBanner(req.user, req.params.id, req.body, req))),
);
adminBannersRouter.patch(
  '/:id/status',
  validate({ params: idParam, body: z.object({ status: z.enum(BANNER_STATUS) }).strict() }),
  asyncHandler(async (req, res) => ok(res, await banners.setBannerStatus(req.user, req.params.id, req.body.status, req))),
);
adminBannersRouter.delete(
  '/:id',
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    await banners.deleteBanner(req.user, req.params.id, req);
    return noContent(res);
  }),
);

/** Mounted at /doctors/me/banners — location comes from the doctor's profile, never the query. */
export const doctorBannersRouter = Router();
doctorBannersRouter.use(authenticate, requireRole('doctor'));
doctorBannersRouter.get('/', asyncHandler(async (req, res) => ok(res, await banners.bannersForDoctor(req.user))));
