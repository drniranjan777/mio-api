import { Router } from 'express';
import { z } from 'zod';

import { authenticate, requireRole } from '../../middlewares/auth.js';
import { validate } from '../../middlewares/validate.js';
import { asyncHandler, ok } from '../../utils/http.js';
import { objectId, text } from '../../utils/zod.js';
import { isoDate } from '../appointments/appointments.routes.js';
import { REPORTS } from './reports.service.js';
import * as reports from './reports.service.js';
import { adminCan } from '../staff/adminAccess.js';

const filters = {
  from: isoDate.optional(),
  to: isoDate.optional(),
  company: text(120),
  doctorId: objectId.optional(),
  mrId: objectId.optional(),
  specialty: text(80),
  city: text(80),
};

export const reportsRouter = Router();
reportsRouter.use(authenticate, requireRole('mr', 'doctor', 'receptionist', 'admin'), adminCan('reports'));

reportsRouter.get('/filters', asyncHandler(async (req, res) => ok(res, await reports.filterOptions(req.user))));

reportsRouter.get(
  '/summary',
  validate({ query: z.object(filters) }),
  asyncHandler(async (req, res) => ok(res, await reports.summary(req.user, req.query))),
);

reportsRouter.get(
  '/:type',
  validate({
    params: z.object({ type: z.enum(Object.keys(REPORTS)) }),
    query: z.object({ ...filters, format: z.enum(['json', 'csv', 'xlsx']).default('json') }),
  }),
  asyncHandler(async (req, res) => {
    const report = await reports.runReport(req.user, req.params.type, req.query);
    if (req.query.format === 'json') return ok(res, report);
    const base = `${report.type}_${report.from}_${report.to}`;
    res.set('Cache-Control', 'no-store');
    if (req.query.format === 'xlsx') {
      res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.set('Content-Disposition', `attachment; filename="${base}.xlsx"`);
      return res.send(await reports.toXlsx(report));
    }
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="${base}.csv"`);
    return res.send(reports.toCsv(report));
  }),
);
