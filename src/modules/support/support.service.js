import { ApiError } from '../../utils/ApiError.js';
import { paging } from '../../utils/http.js';
import { audit } from '../audit/audit.js';
import { notify } from '../notifications/notifications.service.js';
import { adminAccessFor } from '../staff/adminAccess.js';
import { nextCode } from '../users/counter.model.js';
import { User } from '../users/user.model.js';
import { AppSetting, ContentPage, Faq, HelpTicket, OPEN_TICKET_STATUS } from './support.models.js';

/** Used until an admin saves the `support` setting. */
export const DEFAULT_SUPPORT = Object.freeze({
  topics: [
    'Doctor appointment Details need to be Updated',
    'Doctor details are wrongly Updated',
    'Mobile App is not working',
    'App is getting Hanged/crashed',
    'Subscription or payment issue',
    'Other',
  ],
  whatsapp: null,
  emails: { mr: 'mr@miodoctors.com', doctor: 'doctor@miodoctors.com', receptionist: 'support@miodoctors.com' },
});

export const MAX_OPEN_TICKETS = 5;
export const MAX_TICKETS_PER_DAY = 10;

async function supportConfig() {
  const row = await AppSetting.findOne({ key: 'support' }).lean();
  return { ...DEFAULT_SUPPORT, ...(row?.value ?? {}) };
}

/** Help Desk screen: issue categories + the contact channels for this role. */
export async function supportInfo(user) {
  const cfg = await supportConfig();
  return {
    topics: cfg.topics,
    whatsapp: user.role === 'receptionist' ? null : cfg.whatsapp,
    email: cfg.emails?.[user.role] ?? cfg.emails?.mr ?? null,
  };
}

export async function updateSupportConfig(admin, value, req) {
  const before = await supportConfig();
  const next = { ...before, ...value };
  await AppSetting.updateOne({ key: 'support' }, { $set: { value: next, updatedBy: admin._id } }, { upsert: true });
  await audit({ actor: admin, action: 'settings.support_updated', module: 'support', entityType: 'AppSetting', entityId: 'support', before, after: next, req });
  return next;
}

// ---- Tickets -------------------------------------------------------------------

const presentTicket = (t, { withReplies = false, forAdmin = false } = {}) => ({
  id: t._id.toString(),
  number: t.number,
  category: t.category,
  message: t.message,
  status: t.status,
  replyCount: t.replies?.length ?? 0,
  ...(forAdmin && {
    assignedTo: t.assignedTo?._id ? { id: t.assignedTo._id.toString(), name: t.assignedTo.name || t.assignedTo.email } : null,
  }),
  lastReplyAt: t.replies?.at(-1)?.at ?? null,
  createdAt: t.createdAt,
  updatedAt: t.updatedAt,
  ...(withReplies && {
    replies: t.replies.map((r) => ({ role: r.role, message: r.message, at: r.at, fromSupport: r.role === 'admin' })),
  }),
});

export async function createTicket(user, { category, message }, req) {
  const cfg = await supportConfig();
  if (!cfg.topics.includes(category)) {
    throw ApiError.badRequest('Choose one of the listed issue categories', [{ path: 'category', message: 'Unknown category' }], 'VALIDATION_ERROR');
  }
  const [open, today] = await Promise.all([
    HelpTicket.countDocuments({ user: user._id, status: { $in: OPEN_TICKET_STATUS } }),
    HelpTicket.countDocuments({ user: user._id, createdAt: { $gte: new Date(Date.now() - 86_400_000) } }),
  ]);
  if (open >= MAX_OPEN_TICKETS) {
    throw ApiError.unprocessable(`You already have ${MAX_OPEN_TICKETS} open requests. We will get back to you soon.`, 'TOO_MANY_OPEN_TICKETS');
  }
  if (today >= MAX_TICKETS_PER_DAY) throw ApiError.tooMany('Too many requests today. Please try again tomorrow.', 'TICKET_LIMIT');

  const ticket = await HelpTicket.create({ number: await nextCode('ticket'), user: user._id, role: user.role, category, message });
  await audit({ actor: user, action: 'ticket.created', module: 'support', entityType: 'HelpTicket', entityId: ticket._id, after: { number: ticket.number, category }, req });
  return presentTicket(ticket, { withReplies: true });
}

export async function myTickets(user, query) {
  const { skip, limit, meta } = paging(query);
  const filter = { user: user._id };
  const [items, total] = await Promise.all([
    HelpTicket.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    HelpTicket.countDocuments(filter),
  ]);
  return { items: items.map((t) => presentTicket(t)), meta: meta(total) };
}

async function loadTicket(user, id) {
  const ticket = await HelpTicket.findById(id);
  // Someone else's ticket looks exactly like a missing one.
  if (!ticket || (user.role !== 'admin' && !ticket.user.equals(user._id))) {
    throw ApiError.notFound('Request not found', 'TICKET_NOT_FOUND');
  }
  return ticket;
}

export async function getTicket(user, id) {
  const ticket = await loadTicket(user, id);
  const forAdmin = user.role === 'admin';
  if (forAdmin) await ticket.populate('assignedTo', 'name email');
  return presentTicket(ticket, { withReplies: true, forAdmin });
}

export async function replyToTicket(user, id, { message }, req) {
  const ticket = await loadTicket(user, id);
  if (ticket.status === 'closed') throw ApiError.unprocessable('This request is closed', 'TICKET_CLOSED');
  ticket.replies.push({ by: user._id, role: user.role, message });
  if (user.role === 'admin' && ticket.status === 'open') ticket.status = 'in_progress';
  if (user.role !== 'admin' && ticket.status === 'resolved') ticket.status = 'open'; // user follows up
  await ticket.save();
  await audit({ actor: user, action: 'ticket.replied', module: 'support', entityType: 'HelpTicket', entityId: ticket._id, req });
  if (user.role === 'admin') {
    await notify([ticket.user], {
      type: 'ticket.updated',
      title: `Help Desk · ${ticket.number}`,
      body: 'Support replied to your request',
      data: { ticketId: ticket._id.toString() },
    });
  }
  return presentTicket(ticket, { withReplies: true });
}

/** Assignee must be an active admin whose role includes the Help Desk. */
async function loadAssignee(assignedTo) {
  if (assignedTo === null) return null;
  const user = await User.findOne({ _id: assignedTo, role: 'admin', status: 'active' });
  if (!user || !(await adminAccessFor(user)).permissions.includes('tickets')) {
    throw ApiError.badRequest('Choose a team member who works on the Help Desk', [{ path: 'assignedTo', message: 'Not a Help Desk member' }], 'VALIDATION_ERROR');
  }
  return user;
}

export async function updateTicket(admin, id, { status, assignedTo }, req) {
  const ticket = await loadTicket(admin, id);
  const before = { status: ticket.status, assignedTo: ticket.assignedTo?.toString() ?? null };
  if (assignedTo !== undefined) ticket.assignedTo = (await loadAssignee(assignedTo))?._id ?? undefined;
  if (status && status !== ticket.status) {
    ticket.status = status;
    if (status === 'resolved') ticket.resolvedAt = new Date();
  }
  await ticket.save();
  await audit({
    actor: admin,
    action: 'ticket.updated',
    module: 'support',
    entityType: 'HelpTicket',
    entityId: ticket._id,
    before,
    after: { status: ticket.status, assignedTo: ticket.assignedTo?.toString() ?? null },
    req,
  });
  if (status && status !== before.status) {
    await notify([ticket.user], {
      type: 'ticket.updated',
      title: `Help Desk · ${ticket.number}`,
      body: `Your request is now ${status.replace('_', ' ')}`,
      data: { ticketId: ticket._id.toString() },
    });
  }
  return getTicket(admin, id);
}

/** Assign (or unassign) many requests to one team member at once. */
export async function assignTickets(admin, { ticketIds, assignedTo }, req) {
  const assignee = await loadAssignee(assignedTo);
  const res = await HelpTicket.updateMany(
    { _id: { $in: ticketIds } },
    assignee ? { $set: { assignedTo: assignee._id } } : { $unset: { assignedTo: 1 } },
  );
  await audit({
    actor: admin,
    action: 'ticket.bulk_assigned',
    module: 'support',
    entityType: 'HelpTicket',
    after: { ticketIds, assignedTo: assignee?._id.toString() ?? null },
    req,
  });
  return { updated: res.modifiedCount, matched: res.matchedCount };
}

export async function listAllTickets(admin, query) {
  const { skip, limit, meta } = paging(query);
  const filter = {};
  if (query.status) filter.status = query.status;
  if (query.role) filter.role = query.role;
  if (query.assigned === 'me') filter.assignedTo = admin._id;
  else if (query.assigned === 'none') filter.assignedTo = null;
  else if (query.assigned) filter.assignedTo = query.assigned;
  const [items, total] = await Promise.all([
    HelpTicket.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate('user', 'name mobile')
      .populate('assignedTo', 'name email')
      .lean(),
    HelpTicket.countDocuments(filter),
  ]);
  return {
    items: items.map((t) => ({ ...presentTicket(t, { forAdmin: true }), role: t.role, user: t.user && { id: t.user._id.toString(), name: t.user.name, mobile: t.user.mobile } })),
    meta: meta(total),
  };
}

/** Team members a request can be assigned to. */
export async function ticketAssignees() {
  const admins = await User.find({ role: 'admin', status: 'active' }).select('name email adminRole role').lean();
  const out = [];
  for (const a of admins) {
    if ((await adminAccessFor(a)).permissions.includes('tickets')) out.push({ id: a._id.toString(), name: a.name || a.email });
  }
  return out;
}

// ---- FAQs ------------------------------------------------------------------------

const presentFaq = (f) => ({ id: f._id.toString(), audience: f.audience, question: f.question, answer: f.answer, sort: f.sort, active: f.active });

/** Public: FAQs for a role (plus the "all" ones). */
export async function listFaqs(role) {
  const audience = role && role !== 'admin' ? { $in: ['all', role] } : undefined;
  const faqs = await Faq.find({ active: true, ...(audience && { audience }) }).sort({ sort: 1, createdAt: 1 }).lean();
  return faqs.map(presentFaq);
}

export async function createFaq(admin, body, req) {
  const faq = await Faq.create(body);
  await audit({ actor: admin, action: 'faq.created', module: 'support', entityType: 'Faq', entityId: faq._id, after: body, req });
  return presentFaq(faq);
}

export async function updateFaq(admin, id, body, req) {
  const faq = await Faq.findByIdAndUpdate(id, { $set: body }, { new: true, runValidators: true }).lean();
  if (!faq) throw ApiError.notFound('FAQ not found', 'FAQ_NOT_FOUND');
  await audit({ actor: admin, action: 'faq.updated', module: 'support', entityType: 'Faq', entityId: id, after: body, req });
  return presentFaq(faq);
}

export async function deleteFaq(admin, id, req) {
  const faq = await Faq.findByIdAndDelete(id).lean();
  if (!faq) throw ApiError.notFound('FAQ not found', 'FAQ_NOT_FOUND');
  await audit({ actor: admin, action: 'faq.deleted', module: 'support', entityType: 'Faq', entityId: id, before: { question: faq.question }, req });
}

// ---- Content pages ---------------------------------------------------------------

const presentPage = (p) => ({
  key: p.key,
  title: p.title,
  effectiveDate: p.effectiveDate,
  intro: p.intro,
  sections: p.sections.map((s) => ({ title: s.title, body: s.body, points: s.points ?? [] })),
  version: p.version,
  updatedAt: p.updatedAt,
});

export async function getPage(key) {
  const page = await ContentPage.findOne({ key }).lean();
  if (!page) throw ApiError.notFound('Page not found', 'PAGE_NOT_FOUND');
  return presentPage(page);
}

/** Every save bumps the version so acceptance can be tied to a version later. */
export async function savePage(admin, key, body, req) {
  const before = await ContentPage.findOne({ key }).lean();
  const page = await ContentPage.findOneAndUpdate(
    { key },
    { $set: { ...body, updatedBy: admin._id }, $inc: { version: before ? 1 : 0 } },
    { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true },
  ).lean();
  await audit({
    actor: admin,
    action: 'content.saved',
    module: 'support',
    entityType: 'ContentPage',
    entityId: key,
    before: before && { version: before.version, effectiveDate: before.effectiveDate },
    after: { version: page.version, effectiveDate: page.effectiveDate },
    req,
  });
  return presentPage(page);
}
