import { Router } from 'express';
import { z } from 'zod';

import { loginLimiter, authLimiter } from '../../middlewares/rateLimits.js';
import { authenticate, requireRole } from '../../middlewares/auth.js';
import { validate } from '../../middlewares/validate.js';
import { asyncHandler, noContent, ok } from '../../utils/http.js';
import { mobile } from '../../utils/zod.js';
import * as auth from './auth.service.js';

const appRole = z.enum(['doctor', 'mr', 'receptionist']);
const refreshBody = z.object({ refreshToken: z.string().min(20).max(200) });

export const authRouter = Router();

authRouter.post(
  '/otp/request',
  authLimiter,
  validate({ body: z.object({ mobile, role: appRole }) }),
  asyncHandler(async (req, res) => ok(res, await auth.requestOtp(req.body))),
);

authRouter.post(
  '/otp/verify',
  authLimiter,
  validate({ body: z.object({ mobile, role: appRole, otp: z.string().regex(/^\d{4}$/, 'Enter the 4 digit PIN') }) }),
  asyncHandler(async (req, res) => ok(res, await auth.verifyLogin(req.body, req))),
);

authRouter.post(
  '/receptionist/request',
  authLimiter,
  validate({ body: z.object({ mobile }) }),
  asyncHandler(async (req, res) => ok(res, await auth.receptionistRequest(req.body, req))),
);

authRouter.post(
  '/admin/login',
  loginLimiter,
  validate({ body: z.object({ email: z.string().trim().toLowerCase().email(), password: z.string().min(8).max(128) }) }),
  asyncHandler(async (req, res) => ok(res, await auth.adminLogin(req.body, req))),
);

authRouter.post(
  '/admin/change-password',
  loginLimiter,
  authenticate,
  requireRole('admin'),
  validate({ body: z.object({ currentPassword: z.string().min(1).max(128), newPassword: z.string().min(1).max(128) }) }),
  asyncHandler(async (req, res) => ok(res, await auth.changeAdminPassword(req.user, req.body, req))),
);

authRouter.post(
  '/refresh',
  authLimiter,
  validate({ body: refreshBody }),
  asyncHandler(async (req, res) => ok(res, await auth.refresh(req.body, req))),
);

authRouter.post(
  '/logout',
  validate({ body: refreshBody }),
  asyncHandler(async (req, res) => {
    await auth.logout(req.body);
    return noContent(res);
  }),
);
