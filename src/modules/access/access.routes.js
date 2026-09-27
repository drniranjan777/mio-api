import { Router } from 'express';
import { z } from 'zod';

import { authenticate, requireRole } from '../../middlewares/auth.js';
import { validate } from '../../middlewares/validate.js';
import { asyncHandler, created, noContent, ok } from '../../utils/http.js';
import { mobile, objectId } from '../../utils/zod.js';
import * as access from './access.service.js';
import { PERMISSIONS } from './receptionistAccess.model.js';

const permissions = z.array(z.enum(PERMISSIONS)).max(PERMISSIONS.length);
const receptionistParam = z.object({ receptionistId: objectId });

/** Doctor-owned receptionist management: /doctors/me/receptionists */
export const accessRouter = Router();
accessRouter.use(authenticate, requireRole('doctor'));

accessRouter.get(
  '/',
  asyncHandler(async (req, res) => ok(res, await access.listForDoctor(req.user._id))),
);

accessRouter.post(
  '/',
  validate({ body: z.object({ name: z.string().trim().min(1).max(120), mobile, permissions: permissions.default(['view']) }) }),
  asyncHandler(async (req, res) => created(res, await access.giveAccess(req.user, req.body, req))),
);

accessRouter.patch(
  '/:receptionistId',
  validate({
    params: receptionistParam,
    body: z
      .object({ status: z.enum(['active', 'inactive']).optional(), permissions: permissions.optional() })
      .refine((b) => b.status || b.permissions, 'Provide status and/or permissions'),
  }),
  asyncHandler(async (req, res) => ok(res, await access.updateAccess(req.user, req.params.receptionistId, req.body, req))),
);

accessRouter.delete(
  '/:receptionistId',
  validate({ params: receptionistParam }),
  asyncHandler(async (req, res) => {
    await access.removeAccess(req.user, req.params.receptionistId, req);
    return noContent(res);
  }),
);
