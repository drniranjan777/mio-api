import { Router } from 'express';
import { z } from 'zod';

import { authenticate } from '../../middlewares/auth.js';
import { validate } from '../../middlewares/validate.js';
import { asyncHandler, ok } from '../../utils/http.js';
import { idParam, pagination } from '../../utils/zod.js';
import * as notifications from './notifications.service.js';

export const notificationsRouter = Router();
notificationsRouter.use(authenticate);

notificationsRouter.get(
  '/',
  validate({ query: z.object({ ...pagination, unread: z.enum(['true', 'false']).transform((v) => v === 'true').optional() }) }),
  asyncHandler(async (req, res) => {
    const { items, meta } = await notifications.listNotifications(req.user, req.query);
    return ok(res, items, meta);
  }),
);

notificationsRouter.get('/unread-count', asyncHandler(async (req, res) => ok(res, await notifications.unreadCount(req.user))));

notificationsRouter.post('/read-all', asyncHandler(async (req, res) => ok(res, await notifications.markAllRead(req.user))));

notificationsRouter.post(
  '/:id/read',
  validate({ params: idParam }),
  asyncHandler(async (req, res) => ok(res, await notifications.markRead(req.user, req.params.id))),
);
