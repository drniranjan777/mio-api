import { Router } from 'express';
import { z } from 'zod';

import { authenticate, requireRole } from '../../middlewares/auth.js';
import { validate } from '../../middlewares/validate.js';
import { asyncHandler, created, noContent, ok } from '../../utils/http.js';
import { idParam, objectId, pagination, plainText, text } from '../../utils/zod.js';
import { adminCan } from '../staff/adminAccess.js';
import { LOCATION_STATUS, LOCATION_TYPES } from './location.model.js';
import * as locations from './locations.service.js';

const fields = {
  name: plainText(2, 80),
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9-]{1,20}$/, 'Letters, digits and "-" only').optional().or(z.literal('')),
  aliases: z.array(plainText(2, 80)).max(10).optional(),
  status: z.enum(LOCATION_STATUS).optional(),
};

/** Mounted at /admin/locations — managed with the Banners section. */
export const adminLocationsRouter = Router();
adminLocationsRouter.use(authenticate, requireRole('admin'), adminCan('banners'));

adminLocationsRouter.get(
  '/',
  validate({
    query: z.object({
      ...pagination,
      limit: z.coerce.number().int().min(1).max(500).default(100),
      type: z.enum(LOCATION_TYPES).optional(),
      status: z.enum(LOCATION_STATUS).optional(),
      parentId: objectId.optional(),
      q: text(80),
    }),
  }),
  asyncHandler(async (req, res) => {
    const { items, meta } = await locations.listLocations(req.query);
    return ok(res, items, meta);
  }),
);
adminLocationsRouter.post(
  '/',
  validate({ body: z.object({ ...fields, type: z.enum(LOCATION_TYPES), parentId: objectId.nullable().optional() }).strict() }),
  asyncHandler(async (req, res) => created(res, await locations.createLocation(req.user, req.body, req))),
);
adminLocationsRouter.patch(
  '/:id',
  validate({ params: idParam, body: z.object(fields).partial().strict().refine((b) => Object.keys(b).length > 0, 'Nothing to update') }),
  asyncHandler(async (req, res) => ok(res, await locations.updateLocation(req.user, req.params.id, req.body, req))),
);
adminLocationsRouter.delete(
  '/:id',
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    await locations.deleteLocation(req.user, req.params.id, req);
    return noContent(res);
  }),
);
