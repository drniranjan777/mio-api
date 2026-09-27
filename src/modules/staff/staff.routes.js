import { Router } from 'express';
import { z } from 'zod';

import { authenticate } from '../../middlewares/auth.js';
import { validate } from '../../middlewares/validate.js';
import { asyncHandler, created, noContent, ok } from '../../utils/http.js';
import { idParam, objectId, text } from '../../utils/zod.js';
import { requireSuperAdmin } from './adminAccess.js';
import { ADMIN_PERMISSIONS } from './adminRole.model.js';
import * as staff from './staff.service.js';

const roleBody = z.object({
  name: z.string().trim().min(2).max(60),
  description: text(200),
  permissions: z.array(z.enum(ADMIN_PERMISSIONS)).min(1, 'Pick at least one section').max(ADMIN_PERMISSIONS.length),
});

/** Mounted at /admin/roles — Super Admins only. */
export const rolesRouter = Router();
rolesRouter.use(authenticate, requireSuperAdmin);
rolesRouter.get('/', asyncHandler(async (_req, res) => ok(res, { roles: await staff.listRoles(), permissions: ADMIN_PERMISSIONS })));
rolesRouter.post('/', validate({ body: roleBody }), asyncHandler(async (req, res) => created(res, await staff.createRole(req.user, req.body, req))));
rolesRouter.patch(
  '/:id',
  validate({ params: idParam, body: roleBody.partial().refine((b) => Object.keys(b).length > 0, 'Nothing to update') }),
  asyncHandler(async (req, res) => ok(res, await staff.updateRole(req.user, req.params.id, req.body, req))),
);
rolesRouter.delete(
  '/:id',
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    await staff.deleteRole(req.user, req.params.id, req);
    return noContent(res);
  }),
);

/** Mounted at /admin/staff — Super Admins only. */
export const staffRouter = Router();
staffRouter.use(authenticate, requireSuperAdmin);
staffRouter.get('/', asyncHandler(async (req, res) => ok(res, await staff.listStaff(req.user))));
staffRouter.post(
  '/',
  validate({ body: z.object({ name: z.string().trim().min(2).max(120), email: z.string().trim().toLowerCase().email().max(160), roleId: objectId }) }),
  asyncHandler(async (req, res) => created(res, await staff.createStaff(req.user, req.body, req))),
);
staffRouter.patch(
  '/:id',
  validate({
    params: idParam,
    body: z
      .object({ name: z.string().trim().min(2).max(120), roleId: objectId, status: z.enum(['active', 'inactive']) })
      .partial()
      .refine((b) => Object.keys(b).length > 0, 'Nothing to update'),
  }),
  asyncHandler(async (req, res) => ok(res, await staff.updateStaff(req.user, req.params.id, req.body, req))),
);
staffRouter.post(
  '/:id/reset-password',
  validate({ params: idParam }),
  asyncHandler(async (req, res) => ok(res, await staff.resetStaffPassword(req.user, req.params.id, req))),
);
