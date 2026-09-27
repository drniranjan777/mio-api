import { Router } from 'express';
import { z } from 'zod';

import { authenticate, requireRole } from '../../middlewares/auth.js';
import { validate } from '../../middlewares/validate.js';
import { asyncHandler, created, ok } from '../../utils/http.js';
import { idParam, pagination, text } from '../../utils/zod.js';
import { isoDate } from '../appointments/appointments.routes.js';
import { CONFERENCE_STATUS, PARTICIPATION } from './conference.models.js';
import * as conferences from './conferences.service.js';
import { adminCan } from '../staff/adminAccess.js';

const httpsUrl = z
  .string()
  .trim()
  .url()
  .max(500)
  .refine((v) => v.startsWith('https://'), 'Use an https:// link');

const conferenceFields = {
  title: z.string().trim().min(3).max(160),
  organizer: text(160),
  startDate: isoDate,
  endDate: isoDate,
  venue: text(200),
  city: text(80),
  specialty: text(80),
  logoUrl: httpsUrl.optional(),
  website: httpsUrl.optional(),
  description: text(2000),
  status: z.enum(CONFERENCE_STATUS).default('published'),
};
const createBody = z.object(conferenceFields);
const updateBody = z
  .object(conferenceFields)
  .partial()
  .refine((b) => Object.keys(b).length > 0, 'Nothing to update');

const listQuery = z.object({
  ...pagination,
  when: z.enum(['upcoming', 'past', 'all']).default('upcoming'),
  specialty: text(80),
  q: text(80),
  status: z.enum(CONFERENCE_STATUS).optional(),
});

export const conferencesRouter = Router();
conferencesRouter.use(authenticate, adminCan('conferences'));

conferencesRouter.get(
  '/',
  validate({ query: listQuery }),
  asyncHandler(async (req, res) => {
    const { items, meta } = await conferences.listConferences(req.user, req.query);
    return ok(res, items, meta);
  }),
);

conferencesRouter.get(
  '/:id',
  validate({ params: idParam }),
  asyncHandler(async (req, res) => ok(res, await conferences.getConference(req.user, req.params.id))),
);

conferencesRouter.put(
  '/:id/participation',
  requireRole('doctor'),
  validate({ params: idParam, body: z.object({ status: z.enum(PARTICIPATION) }) }),
  asyncHandler(async (req, res) => ok(res, await conferences.setParticipation(req.user, req.params.id, req.body.status, req))),
);

conferencesRouter.delete(
  '/:id/participation',
  requireRole('doctor'),
  validate({ params: idParam }),
  asyncHandler(async (req, res) => ok(res, await conferences.clearParticipation(req.user, req.params.id, req))),
);

conferencesRouter.post(
  '/',
  requireRole('admin'),
  validate({ body: createBody }),
  asyncHandler(async (req, res) => created(res, await conferences.createConference(req.user, req.body, req))),
);

conferencesRouter.patch(
  '/:id',
  requireRole('admin'),
  validate({ params: idParam, body: updateBody }),
  asyncHandler(async (req, res) => ok(res, await conferences.updateConference(req.user, req.params.id, req.body, req))),
);
