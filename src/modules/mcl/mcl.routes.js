import { Router } from 'express';
import { z } from 'zod';

import { authenticate, requireRole } from '../../middlewares/auth.js';
import { validate } from '../../middlewares/validate.js';
import { asyncHandler, ok } from '../../utils/http.js';
import { objectId } from '../../utils/zod.js';
import * as mcl from './mcl.service.js';

const doctorParam = z.object({ doctorId: objectId });

/** Mounted at /mrs/me/mcl */
export const mclRouter = Router();
mclRouter.use(authenticate, requireRole('mr'));

mclRouter.get('/', asyncHandler(async (req, res) => ok(res, await mcl.listMcl(req.user))));

mclRouter.put(
  '/:doctorId',
  validate({ params: doctorParam }),
  asyncHandler(async (req, res) => ok(res, await mcl.addToMcl(req.user, req.params.doctorId, req))),
);

mclRouter.delete(
  '/:doctorId',
  validate({ params: doctorParam }),
  asyncHandler(async (req, res) => ok(res, await mcl.removeFromMcl(req.user, req.params.doctorId, req))),
);
