import { Router } from 'express';
import { z } from 'zod';

import { authenticate, requireRole } from '../../middlewares/auth.js';
import { validate } from '../../middlewares/validate.js';
import { asyncHandler, created, ok } from '../../utils/http.js';
import { idParam, objectId, pagination, text } from '../../utils/zod.js';
import { APPOINTMENT_STATUS } from './appointment.model.js';
import * as appointments from './appointments.service.js';
import { adminCan } from '../staff/adminAccess.js';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const startAt = z.string().datetime({ offset: true });

const listQuery = z.object({
  ...pagination,
  doctorId: objectId.optional(),
  mrId: objectId.optional(),
  status: z
    .union([z.enum(APPOINTMENT_STATUS), z.array(z.enum(APPOINTMENT_STATUS))])
    .transform((s) => (Array.isArray(s) ? s : [s]))
    .optional(),
  date: isoDate.optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  sort: z.enum(['upcoming', 'latest']).default('upcoming'),
});

const createBody = z.object({
  doctorId: objectId.optional(),
  startAt,
  purpose: text(200),
  note: text(500),
  visitor: z
    .object({ name: z.string().trim().min(1).max(120), company: text(120), division: text(120) })
    .optional(),
});

export const appointmentsRouter = Router();
appointmentsRouter.use(authenticate, requireRole('doctor', 'mr', 'receptionist', 'admin'), adminCan('appointments'));

appointmentsRouter.get(
  '/',
  validate({ query: listQuery }),
  asyncHandler(async (req, res) => {
    const { items, meta } = await appointments.listAppointments(req.user, req.query);
    return ok(res, items, meta);
  }),
);

appointmentsRouter.post(
  '/',
  validate({ body: createBody }),
  asyncHandler(async (req, res) => created(res, await appointments.createAppointment(req.user, req.body, req))),
);

appointmentsRouter.get(
  '/:id',
  validate({ params: idParam }),
  asyncHandler(async (req, res) => ok(res, await appointments.getAppointment(req.user, req.params.id))),
);

const action = (name, body = z.object({}).strict()) =>
  appointmentsRouter.post(
    `/:id/${name}`,
    validate({ params: idParam, body }),
    asyncHandler(async (req, res) => ok(res, await appointments.transition(req.user, req.params.id, name, req.body, req))),
  );

action('approve');
action('reject', z.object({ reason: text(200) }));
action('complete');
action('cancel', z.object({ reason: text(200) }));
action('reschedule', z.object({ startAt }));

export { isoDate };
