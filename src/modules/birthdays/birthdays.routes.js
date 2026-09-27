import { Router } from 'express';
import { z } from 'zod';

import { authenticate, requireRole } from '../../middlewares/auth.js';
import { validate } from '../../middlewares/validate.js';
import { asyncHandler, created, noContent, ok } from '../../utils/http.js';
import { idParam, objectId } from '../../utils/zod.js';
import * as birthdays from './birthdays.service.js';

const doctorParam = z.object({ doctorId: objectId });
const wishBody = z.object({ message: z.string().trim().min(1, 'Write a message').max(500) });
const bool = z.enum(['true', 'false']).transform((v) => v === 'true');

/** Mounted at /birthdays — MR (and admin) facing. */
export const birthdaysRouter = Router();
birthdaysRouter.use(authenticate, requireRole('mr', 'admin'));

birthdaysRouter.get(
  '/',
  validate({
    query: z.object({
      range: z.enum(['all', 'week', 'month']).default('all'),
      scope: z.enum(['all', 'mcl']).default('all'),
    }),
  }),
  asyncHandler(async (req, res) => ok(res, await birthdays.listBirthdays(req.user, req.query))),
);

birthdaysRouter.get(
  '/:doctorId/wishes',
  validate({ params: doctorParam }),
  asyncHandler(async (req, res) => ok(res, await birthdays.wishThread(req.user, req.params.doctorId))),
);

birthdaysRouter.post(
  '/:doctorId/wishes',
  requireRole('mr'),
  validate({ params: doctorParam, body: wishBody }),
  asyncHandler(async (req, res) => created(res, await birthdays.sendWish(req.user, req.params.doctorId, req.body, req))),
);

/** Mounted at /wishes */
export const wishesRouter = Router();
wishesRouter.use(authenticate);

wishesRouter.get(
  '/received',
  requireRole('doctor'),
  validate({ query: z.object({ includeHidden: bool.optional() }) }),
  asyncHandler(async (req, res) => ok(res, await birthdays.receivedWishes(req.user, req.query))),
);

for (const [path, hidden] of [
  ['hide', true],
  ['unhide', false],
]) {
  wishesRouter.post(
    `/:id/${path}`,
    requireRole('doctor'),
    validate({ params: idParam }),
    asyncHandler(async (req, res) => ok(res, await birthdays.setWishHidden(req.user, req.params.id, hidden, req))),
  );
}

wishesRouter.delete(
  '/:id',
  requireRole('mr'),
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    await birthdays.deleteWish(req.user, req.params.id, req);
    return noContent(res);
  }),
);
