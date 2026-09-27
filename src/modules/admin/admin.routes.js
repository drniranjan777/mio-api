import express, { Router } from 'express';
import { z } from 'zod';

import { authenticate, requireRole } from '../../middlewares/auth.js';
import { validate } from '../../middlewares/validate.js';
import { ApiError } from '../../utils/ApiError.js';
import { asyncHandler, created, ok } from '../../utils/http.js';
import { idParam, mobile, objectId, pagination, text } from '../../utils/zod.js';
import { GRANT_STATUS, PERMISSIONS } from '../access/receptionistAccess.model.js';
import { ORDER_STATUS } from '../billing/billing.models.js';
import * as admin from './admin.service.js';
import * as doctorImport from './doctorImport.js';
import { adminCan } from '../staff/adminAccess.js';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const list = (fn) =>
  asyncHandler(async (req, res) => {
    const { items, meta } = await fn(req.query);
    return ok(res, items, meta);
  });

/** Everything under /admin is admin-only; the role comes from the DB, never the client. */
export const adminRouter = Router();
adminRouter.use(authenticate, requireRole('admin'));

adminRouter.get('/dashboard', adminCan('dashboard'), asyncHandler(async (_req, res) => ok(res, await admin.dashboard())));

adminRouter.get(
  '/users',
  adminCan('users'),
  validate({
    query: z.object({
      ...pagination,
      role: z.enum(['doctor', 'mr', 'receptionist']).optional(),
      status: z.enum(['active', 'inactive', 'deleted']).optional(),
      q: text(80),
    }),
  }),
  list(admin.listUsers),
);
adminRouter.post(
  '/users',
  adminCan('users'),
  validate({
    body: z
      .object({
        role: z.enum(['doctor', 'mr', 'receptionist']),
        name: z.string().trim().min(2).max(120),
        mobile,
        doctorIds: z.array(objectId).max(20).optional(),
        permissions: z.array(z.enum(PERMISSIONS)).max(4).optional(),
      })
      .strict(),
  }),
  asyncHandler(async (req, res) => created(res, await admin.createAppUser(req.user, req.body, req))),
);
// ---- Doctor CSV import (preview first, then commit) --------------------------------
adminRouter.get(
  '/users/import/doctors/template',
  adminCan('users'),
  asyncHandler(async (_req, res) => {
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', 'attachment; filename="doctors_import_template.csv"');
    res.set('Cache-Control', 'no-store');
    return res.send(doctorImport.templateCsv());
  }),
);
adminRouter.get('/users/import/doctors/columns', adminCan('users'), (_req, res) =>
  ok(res, { columns: doctorImport.DOCTOR_COLUMNS.map(([key, hint]) => ({ key, hint })), maxRows: doctorImport.MAX_IMPORT_ROWS }),
);
adminRouter.post(
  '/users/import/doctors',
  adminCan('users'),
  express.text({ type: ['text/csv', 'text/plain', 'application/vnd.ms-excel'], limit: '2mb' }),
  validate({ query: z.object({ commit: z.enum(['true', 'false']).default('false').transform((v) => v === 'true') }) }),
  asyncHandler(async (req, res) => {
    if (typeof req.body !== 'string') {
      throw ApiError.badRequest('Send the CSV file as text/csv', undefined, 'CSV_INVALID');
    }
    return ok(res, await doctorImport.importDoctors(req.user, req.body, { commit: req.query.commit }, req));
  }),
);

adminRouter.get('/users/:id', adminCan('users'), validate({ params: idParam }), asyncHandler(async (req, res) => ok(res, await admin.getUser(req.params.id))));
adminRouter.patch(
  '/users/:id/status',
  adminCan('users'),
  validate({ params: idParam, body: z.object({ status: z.enum(['active', 'inactive']) }) }),
  asyncHandler(async (req, res) => ok(res, await admin.setUserStatus(req.user, req.params.id, req.body.status, req))),
);

adminRouter.get(
  '/receptionist-access',
  adminCan('access'),
  validate({
    query: z.object({
      ...pagination,
      status: z.enum(GRANT_STATUS).optional(),
      doctorId: objectId.optional(),
      receptionistId: objectId.optional(),
    }),
  }),
  list(admin.listAccess),
);
adminRouter.patch(
  '/receptionist-access/:id',
  adminCan('access'),
  validate({
    params: idParam,
    body: z
      .object({ status: z.enum(['active', 'inactive']), permissions: z.array(z.enum(PERMISSIONS)).max(4) })
      .partial()
      .refine((b) => Object.keys(b).length > 0, 'Nothing to update'),
  }),
  asyncHandler(async (req, res) => ok(res, await admin.updateAccess(req.user, req.params.id, req.body, req))),
);

adminRouter.get('/plans', adminCan('billing'), asyncHandler(async (_req, res) => ok(res, await admin.listAllPlans())));
adminRouter.get('/orders', adminCan('billing'), validate({ query: z.object({ ...pagination, status: z.enum(ORDER_STATUS).optional() }) }), list(admin.listOrders));
adminRouter.get(
  '/subscriptions',
  adminCan('billing'),
  validate({ query: z.object({ ...pagination, state: z.enum(['active', 'expired', 'all']).default('all') }) }),
  list(admin.listSubscriptions),
);

adminRouter.get('/faqs', adminCan('faqs'), asyncHandler(async (_req, res) => ok(res, await admin.listAllFaqs())));
adminRouter.get('/settings/support', adminCan('settings'), asyncHandler(async (_req, res) => ok(res, await admin.supportSettings())));

adminRouter.get(
  '/audit-logs',
  adminCan('audit'),
  validate({
    query: z.object({
      ...pagination,
      module: text(40),
      action: text(60),
      actorId: objectId.optional(),
      entityId: text(60),
      from: isoDate.optional(),
      to: isoDate.optional(),
    }),
  }),
  list(admin.listAudit),
);
