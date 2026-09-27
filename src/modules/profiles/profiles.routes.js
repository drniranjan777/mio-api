import { Router } from 'express';

import { authenticate, requireRole } from '../../middlewares/auth.js';
import { validate } from '../../middlewares/validate.js';
import { asyncHandler, noContent, ok } from '../../utils/http.js';
import { doctorsForReceptionist } from '../access/access.service.js';
import * as v from './profile.validators.js';
import * as profiles from './profiles.service.js';

const handle = (fn) => asyncHandler(async (req, res) => ok(res, await fn(req)));

// /me — any signed-in user
export const meRouter = Router();
meRouter.use(authenticate);
meRouter.get('/', handle((req) => profiles.getMe(req.user)));
meRouter.patch('/', validate({ body: v.updateMeBody }), handle((req) => profiles.updateMe(req.user, req.body, req)));
meRouter.patch('/settings', validate({ body: v.settingsBody }), handle((req) => profiles.updateSettings(req.user, req.body, req)));
meRouter.delete(
  '/',
  requireRole('doctor', 'mr', 'receptionist'),
  validate({ body: v.deleteMeBody }),
  asyncHandler(async (req, res) => {
    await profiles.deleteAccount(req.user, req.body, req);
    return noContent(res);
  }),
);

// Registration / onboarding per role
export const doctorMeRouter = Router();
doctorMeRouter.use(authenticate, requireRole('doctor'));
doctorMeRouter.put('/profile', validate({ body: v.doctorProfileBody }), handle((req) => profiles.saveDoctorProfile(req.user, req.body, req)));
doctorMeRouter.put('/final', validate({ body: v.doctorFinalBody }), handle((req) => profiles.saveDoctorFinal(req.user, req.body, req)));
doctorMeRouter.patch(
  '/availability',
  validate({ body: v.availabilityBody }),
  handle((req) => profiles.setAvailability(req.user, req.body.availability, req)),
);

export const mrMeRouter = Router();
mrMeRouter.use(authenticate, requireRole('mr'));
mrMeRouter.put('/profile', validate({ body: v.mrProfileBody }), handle((req) => profiles.saveMrProfile(req.user, req.body, req)));

export const receptionistMeRouter = Router();
receptionistMeRouter.use(authenticate, requireRole('receptionist'));
receptionistMeRouter.put(
  '/profile',
  validate({ body: v.receptionistProfileBody }),
  handle((req) => profiles.saveReceptionistProfile(req.user, req.body, req)),
);
receptionistMeRouter.put(
  '/final',
  validate({ body: v.receptionistFinalBody }),
  handle((req) => profiles.saveReceptionistFinal(req.user, req.body, req)),
);
receptionistMeRouter.get('/doctors', handle((req) => doctorsForReceptionist(req.user._id)));
