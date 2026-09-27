import { Router } from 'express';
import { z } from 'zod';

import { authenticate, requireRole } from '../../middlewares/auth.js';
import { validate } from '../../middlewares/validate.js';
import { asyncHandler, created, ok } from '../../utils/http.js';
import { idParam } from '../../utils/zod.js';
import { PAYMENT_METHODS, PLAN_PERIODS } from './billing.models.js';
import * as billing from './billing.service.js';
import { adminCan } from '../staff/adminAccess.js';

const planCode = z.string().trim().toLowerCase().regex(/^[a-z0-9-]{2,40}$/, 'Invalid plan code');

export const plansRouter = Router();
plansRouter.use(authenticate, adminCan('billing'));
plansRouter.get('/', asyncHandler(async (req, res) => ok(res, await billing.listPlans(req.user))));
plansRouter.put(
  '/',
  requireRole('admin'),
  validate({
    body: z.object({
      code: planCode,
      role: z.enum(['doctor', 'mr', 'receptionist']),
      name: z.string().trim().min(2).max(80),
      period: z.enum(PLAN_PERIODS),
      pricePaise: z.number().int().min(0).max(10_000_000),
      mrpPaise: z.number().int().min(0).max(10_000_000).optional(),
      taxPercent: z.number().min(0).max(50).default(18),
      features: z.array(z.string().trim().min(1).max(120)).max(20).default([]),
      active: z.boolean().default(true),
      sort: z.number().int().default(0),
    }),
  }),
  asyncHandler(async (req, res) => ok(res, await billing.upsertPlan(req.user, req.body, req))),
);

/** Mounted at /subscriptions — app users only (admins do not subscribe). */
export const subscriptionsRouter = Router();
subscriptionsRouter.use(authenticate, requireRole('doctor', 'mr', 'receptionist'));

subscriptionsRouter.get('/me', asyncHandler(async (req, res) => ok(res, await billing.mySubscription(req.user))));

subscriptionsRouter.post(
  '/checkout',
  validate({ body: z.object({ planCode, method: z.enum(PAYMENT_METHODS) }) }),
  asyncHandler(async (req, res) => created(res, await billing.checkout(req.user, req.body, req))),
);

subscriptionsRouter.post(
  '/orders/:id/confirm',
  validate({
    params: idParam,
    // Real gateways send their signed payload here; the mock only understands `simulate`.
    body: z.object({ simulate: z.enum(['success', 'failure']).optional() }),
  }),
  asyncHandler(async (req, res) => ok(res, await billing.confirm(req.user, req.params.id, req.body, req))),
);

subscriptionsRouter.post(
  '/claim-free',
  validate({ body: z.object({ planCode }) }),
  asyncHandler(async (req, res) => ok(res, await billing.claimFree(req.user, req.body, req))),
);
