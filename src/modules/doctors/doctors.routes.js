import { Router } from 'express';
import { z } from 'zod';

import { authenticate, requireRole } from '../../middlewares/auth.js';
import { validate } from '../../middlewares/validate.js';
import { asyncHandler, ok } from '../../utils/http.js';
import { objectId, pagination } from '../../utils/zod.js';
import { isoDate } from '../appointments/appointments.routes.js';
import { daySlots } from '../appointments/appointments.service.js';
import * as doctors from './doctors.service.js';
import { adminCan } from '../staff/adminAccess.js';

const doctorParam = z.object({ id: objectId });

/** `?specialty=A&specialty=B` (or a single value): any of them matches. */
const anyOf = z
  .union([z.string(), z.array(z.string())])
  .transform((v) => (Array.isArray(v) ? v : [v]).map((s) => s.trim()).filter(Boolean))
  .pipe(z.array(z.string().max(120)).max(50))
  .optional();

export const doctorsRouter = Router();
doctorsRouter.use(authenticate, adminCan('users'));

doctorsRouter.get(
  '/',
  requireRole('mr', 'admin'),
  validate({
    query: z.object({
      ...pagination,
      q: z.string().trim().max(80).optional(),
      specialty: anyOf,
      placeType: z.enum(['hospital', 'clinic', 'both']).optional(),
      city: anyOf,
      clinicName: anyOf,
      /** Date of appointment: `slotsLeft` is counted for this day (default today). */
      date: isoDate.optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const { items, meta } = await doctors.listDoctors(req.query, req.user);
    return ok(res, items, meta);
  }),
);

/** Choices for the Master MCL filters: specialties, cities, hospital/clinic names. */
doctorsRouter.get(
  '/filters',
  requireRole('mr', 'admin'),
  asyncHandler(async (_req, res) => ok(res, await doctors.directoryFilters())),
);

doctorsRouter.get(
  '/:id',
  validate({ params: doctorParam }),
  asyncHandler(async (req, res) => ok(res, await doctors.getDoctor(req.user, req.params.id))),
);

doctorsRouter.get(
  '/:id/slots',
  validate({ params: doctorParam, query: z.object({ date: isoDate }) }),
  asyncHandler(async (req, res) => ok(res, await daySlots(req.user, req.params.id, req.query.date))),
);
