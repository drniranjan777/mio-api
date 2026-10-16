import { Router } from 'express';
import { z } from 'zod';

import { authenticate, requireRole } from '../../middlewares/auth.js';
import { authLimiter } from '../../middlewares/rateLimits.js';
import { validate } from '../../middlewares/validate.js';
import { asyncHandler, created, ok } from '../../utils/http.js';
import { idParam, mobile, pagination, text } from '../../utils/zod.js';
import { adminCan } from '../staff/adminAccess.js';
import { RECOVERY_STATUS } from './recovery.model.js';
import * as recovery from './recovery.service.js';

const appRole = z.enum(['doctor', 'mr', 'receptionist']);
const code = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^(DR|MR|RC)\d{5}$/, 'Use your Mio code, e.g. DR00012')
  .optional();

/** Public: "Changed your mobile number?" — mounted at /auth/recovery. */
export const recoveryRouter = Router();
recoveryRouter.use(authLimiter);

recoveryRouter.post(
  '/otp',
  validate({ body: z.object({ role: appRole, newMobile: mobile }).strict() }),
  asyncHandler(async (req, res) => ok(res, await recovery.requestRecoveryOtp(req.body))),
);

recoveryRouter.post(
  '/',
  validate({
    body: z
      .object({
        role: appRole,
        oldMobile: mobile,
        newMobile: mobile,
        code,
        name: text(120),
        note: text(300),
        otp: z.string().regex(/^\d{4}$/, 'Enter the 4 digit PIN'),
      })
      .strict(),
  }),
  asyncHandler(async (req, res) => created(res, await recovery.submitRecovery(req.body, req))),
);

/** Admin review — mounted at /admin/recovery-requests. */
export const adminRecoveryRouter = Router();
adminRecoveryRouter.use(authenticate, requireRole('admin'), adminCan('users'));

adminRecoveryRouter.get(
  '/',
  validate({ query: z.object({ ...pagination, status: z.enum(RECOVERY_STATUS).optional() }) }),
  asyncHandler(async (req, res) => {
    const { items, meta } = await recovery.listRecoveryRequests(req.query);
    return ok(res, items, meta);
  }),
);

adminRecoveryRouter.patch(
  '/:id',
  validate({ params: idParam, body: z.object({ decision: z.enum(['approve', 'reject']), note: text(300) }).strict() }),
  asyncHandler(async (req, res) => ok(res, await recovery.reviewRecovery(req.user, req.params.id, req.body, req))),
);
