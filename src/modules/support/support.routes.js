import { Router } from 'express';
import { z } from 'zod';

import { authenticate, requireRole } from '../../middlewares/auth.js';
import { validate } from '../../middlewares/validate.js';
import { asyncHandler, created, noContent, ok } from '../../utils/http.js';
import { idParam, objectId, pagination } from '../../utils/zod.js';
import { AUDIENCES, CONTENT_KEYS, TICKET_STATUS } from './support.models.js';
import * as support from './support.service.js';
import { adminCan } from '../staff/adminAccess.js';

const message = z.string().trim().min(10, 'Please describe the issue (at least 10 characters)').max(1000);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');

// ---- /support (signed-in app users) ----------------------------------------------
export const supportRouter = Router();
supportRouter.use(authenticate, adminCan('settings'));

supportRouter.get('/', asyncHandler(async (req, res) => ok(res, await support.supportInfo(req.user))));

supportRouter.put(
  '/',
  requireRole('admin'),
  validate({
    body: z
      .object({
        topics: z.array(z.string().trim().min(3).max(120)).min(1).max(20),
        whatsapp: z
          .string()
          .regex(/^\+?\d{10,15}$/, 'Digits only, with country code')
          .nullable(),
        emails: z.object({
          mr: z.string().email(),
          doctor: z.string().email(),
          receptionist: z.string().email(),
        }),
      })
      .partial(),
  }),
  asyncHandler(async (req, res) => ok(res, await support.updateSupportConfig(req.user, req.body, req))),
);

// ---- /help-tickets ----------------------------------------------------------------
export const ticketsRouter = Router();
ticketsRouter.use(authenticate, adminCan('tickets'));

ticketsRouter.post(
  '/',
  requireRole('doctor', 'mr', 'receptionist'),
  validate({ body: z.object({ category: z.string().trim().min(1).max(120), message }) }),
  asyncHandler(async (req, res) => created(res, await support.createTicket(req.user, req.body, req))),
);

ticketsRouter.get(
  '/',
  validate({
    query: z.object({
      ...pagination,
      status: z.enum(TICKET_STATUS).optional(),
      role: z.enum(['doctor', 'mr', 'receptionist']).optional(),
      assigned: z.union([z.enum(['me', 'none']), objectId]).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const { items, meta } = req.user.role === 'admin' ? await support.listAllTickets(req.user, req.query) : await support.myTickets(req.user, req.query);
    return ok(res, items, meta);
  }),
);

ticketsRouter.get('/assignees', requireRole('admin'), asyncHandler(async (_req, res) => ok(res, await support.ticketAssignees())));

ticketsRouter.post(
  '/assign',
  requireRole('admin'),
  validate({ body: z.object({ ticketIds: z.array(objectId).min(1).max(100), assignedTo: objectId.nullable() }) }),
  asyncHandler(async (req, res) => ok(res, await support.assignTickets(req.user, req.body, req))),
);

ticketsRouter.get(
  '/:id',
  validate({ params: idParam }),
  asyncHandler(async (req, res) => ok(res, await support.getTicket(req.user, req.params.id))),
);

ticketsRouter.post(
  '/:id/replies',
  validate({ params: idParam, body: z.object({ message: z.string().trim().min(1).max(1000) }) }),
  asyncHandler(async (req, res) => ok(res, await support.replyToTicket(req.user, req.params.id, req.body, req))),
);

ticketsRouter.patch(
  '/:id',
  requireRole('admin'),
  validate({
    params: idParam,
    body: z
      .object({ status: z.enum(TICKET_STATUS), assignedTo: objectId.nullable() })
      .partial()
      .refine((b) => Object.keys(b).length > 0, 'Nothing to update'),
  }),
  asyncHandler(async (req, res) => ok(res, await support.updateTicket(req.user, req.params.id, req.body, req))),
);

// ---- /faqs (read is public: shown before sign-in too) ------------------------------
const faqBody = z.object({
  audience: z.enum(AUDIENCES).default('all'),
  question: z.string().trim().min(5).max(200),
  answer: z.string().trim().min(2).max(2000),
  sort: z.number().int().default(0),
  active: z.boolean().default(true),
});

export const faqsRouter = Router();
faqsRouter.get(
  '/',
  validate({ query: z.object({ role: z.enum(['doctor', 'mr', 'receptionist']).optional() }) }),
  asyncHandler(async (req, res) => ok(res, await support.listFaqs(req.query.role))),
);
faqsRouter.post(
  '/',
  authenticate,
  requireRole('admin'),
  adminCan('faqs'),
  validate({ body: faqBody }),
  asyncHandler(async (req, res) => created(res, await support.createFaq(req.user, req.body, req))),
);
faqsRouter.patch(
  '/:id',
  authenticate,
  requireRole('admin'),
  adminCan('faqs'),
  validate({ params: idParam, body: faqBody.partial() }),
  asyncHandler(async (req, res) => ok(res, await support.updateFaq(req.user, req.params.id, req.body, req))),
);
faqsRouter.delete(
  '/:id',
  authenticate,
  requireRole('admin'),
  adminCan('faqs'),
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    await support.deleteFaq(req.user, req.params.id, req);
    return noContent(res);
  }),
);

// ---- /content/:key (read is public: Terms open from the login screen) ---------------
const keyParam = z.object({ key: z.enum(CONTENT_KEYS) });

export const contentRouter = Router();
contentRouter.get(
  '/:key',
  validate({ params: keyParam }),
  asyncHandler(async (req, res) => ok(res, await support.getPage(req.params.key))),
);
contentRouter.put(
  '/:key',
  authenticate,
  requireRole('admin'),
  adminCan('content'),
  validate({
    params: keyParam,
    body: z.object({
      title: z.string().trim().min(2).max(120),
      effectiveDate: isoDate,
      intro: z.string().trim().max(2000).optional(),
      sections: z
        .array(
          z.object({
            title: z.string().trim().min(1).max(160),
            body: z.string().trim().max(4000).optional(),
            points: z.array(z.string().trim().min(1).max(600)).max(30).default([]),
          }),
        )
        .max(40),
    }),
  }),
  asyncHandler(async (req, res) => ok(res, await support.savePage(req.user, req.params.key, req.body, req))),
);
