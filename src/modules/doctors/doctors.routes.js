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

export const doctorsRouter = Router();
doctorsRouter.use(authenticate, adminCan('users'));

doctorsRouter.get(
  '/',
  requireRole('mr', 'admin'),
  validate({
    query: z.object({
      ...pagination,
      q: z.string().trim().max(80).optional(),
      specialty: z.string().trim().max(80).optional(),
      placeType: z.enum(['hospital', 'clinic']).optional(),
      city: z.string().trim().max(80).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const { items, meta } = await doctors.listDoctors(req.query, req.user);
    return ok(res, items, meta);
  }),
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
