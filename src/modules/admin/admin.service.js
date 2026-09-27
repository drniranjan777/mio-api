import mongoose from 'mongoose';

import { env } from '../../config/env.js';
import { ApiError } from '../../utils/ApiError.js';
import { paging } from '../../utils/http.js';
import { PERMISSIONS, ReceptionistAccess } from '../access/receptionistAccess.model.js';
import { Appointment } from '../appointments/appointment.model.js';
import { dayBounds, localParts } from '../appointments/schedule.js';
import { AuditLog, audit } from '../audit/audit.js';
import { revokeAllSessions } from '../auth/token.service.js';
import { PaymentOrder, Plan, Subscription } from '../billing/billing.models.js';
import { currentSubscription } from '../billing/billing.service.js';
import { profileModelFor } from '../profiles/profile.models.js';
import { AppSetting, Faq, HelpTicket } from '../support/support.models.js';
import { DEFAULT_SUPPORT } from '../support/support.service.js';
import { nextCode } from '../users/counter.model.js';
import { User } from '../users/user.model.js';

const { ObjectId } = mongoose.Types;
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const DAY_MS = 86_400_000;

// ---- Dashboard ------------------------------------------------------------------

export async function dashboard() {
  const today = localParts(new Date()).dateStr;
  const { start: todayStart, end: todayEnd } = dayBounds(today);
  const weekEnd = new Date(todayStart.getTime() + 7 * DAY_MS);
  const monthStart = new Date(Date.now() - 30 * DAY_MS);

  const [usersByRole, todayByStatus, upcomingWeek, openTickets, activeSubs, revenue, newUsers, pendingAccess, trend] = await Promise.all([
    User.aggregate([{ $match: { role: { $ne: 'admin' } } }, { $group: { _id: { role: '$role', status: '$status' }, n: { $sum: 1 } } }]),
    Appointment.aggregate([{ $match: { startAt: { $gte: todayStart, $lt: todayEnd } } }, { $group: { _id: '$status', n: { $sum: 1 } } }]),
    Appointment.countDocuments({ startAt: { $gte: todayStart, $lt: weekEnd }, status: { $in: ['pending', 'approved'] } }),
    HelpTicket.countDocuments({ status: { $in: ['open', 'in_progress'] } }),
    Subscription.countDocuments({ status: 'active', $or: [{ endsAt: null }, { endsAt: { $gt: new Date() } }] }),
    PaymentOrder.aggregate([{ $match: { status: 'paid', paidAt: { $gte: monthStart } } }, { $group: { _id: null, paise: { $sum: '$amountPaise' }, n: { $sum: 1 } } }]),
    User.countDocuments({ role: { $ne: 'admin' }, createdAt: { $gte: new Date(Date.now() - 7 * DAY_MS) } }),
    ReceptionistAccess.countDocuments({ status: 'pending' }),
    Appointment.aggregate([
      { $match: { startAt: { $gte: new Date(todayStart.getTime() - 13 * DAY_MS), $lt: todayEnd } } },
      { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$startAt', timezone: tzString() } }, n: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ]),
  ]);

  const users = { doctor: 0, mr: 0, receptionist: 0, inactive: 0, deleted: 0 };
  for (const { _id, n } of usersByRole) {
    if (_id.status === 'active') users[_id.role] += n;
    else users[_id.status] += n;
  }
  // 14-day series with zero days filled in.
  const byDay = new Map(trend.map((t) => [t._id, t.n]));
  const series = Array.from({ length: 14 }, (_, i) => {
    const date = localParts(new Date(todayStart.getTime() - (13 - i) * DAY_MS + 12 * 3600_000)).dateStr;
    return { date, appointments: byDay.get(date) ?? 0 };
  });

  return {
    users,
    newUsersLast7Days: newUsers,
    appointmentsToday: Object.fromEntries(todayByStatus.map((s) => [s._id, s.n])),
    upcomingNext7Days: upcomingWeek,
    openTickets,
    pendingAccessRequests: pendingAccess,
    activeSubscriptions: activeSubs,
    revenueLast30Days: { paise: revenue[0]?.paise ?? 0, orders: revenue[0]?.n ?? 0 },
    appointmentTrend: series,
  };
}

function tzString() {
  const off = env.TZ_OFFSET_MINUTES;
  const abs = Math.abs(off);
  return `${off < 0 ? '-' : '+'}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}

// ---- Users ----------------------------------------------------------------------

export async function listUsers(query) {
  const filter = { role: query.role ?? { $in: ['doctor', 'mr', 'receptionist'] } };
  if (query.status) filter.status = query.status;
  else filter.status = { $ne: 'deleted' };
  if (query.q) {
    const rx = new RegExp(escapeRegex(query.q), 'i');
    filter.$or = [{ name: rx }, { mobile: rx }, { email: rx }];
  }
  const { skip, limit, meta } = paging(query);
  const [items, total] = await Promise.all([
    User.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    User.countDocuments(filter),
  ]);
  const byRole = {};
  for (const u of items) (byRole[u.role] ??= []).push(u._id);
  const codes = new Map();
  await Promise.all(
    Object.entries(byRole).map(async ([role, ids]) => {
      const rows = await profileModelFor(role).find({ user: { $in: ids } }).select('user code specialty practice.city company.name').lean();
      for (const r of rows) codes.set(r.user.toString(), r);
    }),
  );
  return {
    items: items.map((u) => {
      const p = codes.get(u._id.toString());
      return {
        id: u._id.toString(),
        role: u.role,
        name: u.name,
        mobile: u.mobile,
        email: u.email,
        status: u.status,
        code: p?.code,
        detail: p?.specialty ?? p?.company?.name ?? p?.practice?.city ?? null,
        onboarded: Boolean(u.onboarding?.profile && (u.role === 'mr' || u.onboarding?.final)),
        lastLoginAt: u.lastLoginAt,
        createdAt: u.createdAt,
      };
    }),
    meta: meta(total),
  };
}

export async function getUser(id) {
  const user = await User.findOne({ _id: id, role: { $ne: 'admin' } });
  if (!user) throw ApiError.notFound('User not found', 'USER_NOT_FOUND');
  const [profile, subscription, grants, appointments] = await Promise.all([
    profileModelFor(user.role)?.findOne({ user: user._id }).select('-__v').lean(),
    currentSubscription(user._id),
    ReceptionistAccess.find(user.role === 'doctor' ? { doctor: user._id } : { receptionist: user._id })
      .populate(user.role === 'doctor' ? 'receptionist' : 'doctor', 'name mobile')
      .lean(),
    Appointment.aggregate([
      { $match: { [user.role === 'mr' ? 'mr' : 'doctor']: user._id } },
      { $group: { _id: '$status', n: { $sum: 1 } } },
    ]),
  ]);
  return {
    user: { ...user.toPublic(), lastLoginAt: user.lastLoginAt },
    profile,
    subscription: subscription ? { plan: subscription.planSnapshot, endsAt: subscription.endsAt ?? null } : null,
    access: grants.map((g) => {
      const other = user.role === 'doctor' ? g.receptionist : g.doctor;
      return { id: g._id.toString(), status: g.status, permissions: g.permissions, with: other && { id: other._id.toString(), name: other.name, mobile: other.mobile } };
    }),
    appointments: Object.fromEntries(appointments.map((a) => [a._id, a.n])),
  };
}

/** Activate / deactivate. Deactivation signs the user out everywhere at once. */
export async function setUserStatus(admin, id, status, req) {
  const user = await User.findOne({ _id: id, role: { $ne: 'admin' } });
  if (!user) throw ApiError.notFound('User not found', 'USER_NOT_FOUND');
  if (user.status === 'deleted') throw ApiError.unprocessable('Deleted accounts cannot be changed', 'USER_DELETED');
  const before = user.status;
  if (before === status) return getUser(id);
  user.status = status;
  await user.save();
  if (status === 'inactive') await revokeAllSessions(user._id);
  await audit({ actor: admin, action: `user.${status === 'active' ? 'activated' : 'deactivated'}`, module: 'admin', entityType: 'User', entityId: user._id, before: { status: before }, after: { status }, req });
  return getUser(id);
}

// ---- Receptionist access -----------------------------------------------------------

export async function listAccess(query) {
  const filter = {};
  if (query.status) filter.status = query.status;
  if (query.doctorId) filter.doctor = query.doctorId;
  if (query.receptionistId) filter.receptionist = query.receptionistId;
  const { skip, limit, meta } = paging(query);
  const [items, total] = await Promise.all([
    ReceptionistAccess.find(filter).sort({ updatedAt: -1 }).skip(skip).limit(limit).populate('doctor', 'name mobile').populate('receptionist', 'name mobile').lean(),
    ReceptionistAccess.countDocuments(filter),
  ]);
  const person = (u) => u && { id: u._id.toString(), name: u.name, mobile: u.mobile };
  return {
    items: items.map((g) => ({
      id: g._id.toString(),
      doctor: person(g.doctor),
      receptionist: person(g.receptionist),
      status: g.status,
      permissions: g.permissions,
      requestedAt: g.requestedAt,
      grantedAt: g.grantedAt,
      updatedAt: g.updatedAt,
    })),
    meta: meta(total),
  };
}

export async function updateAccess(admin, id, { status, permissions }, req) {
  const grant = await ReceptionistAccess.findById(id);
  if (!grant) throw ApiError.notFound('Access record not found', 'ACCESS_NOT_FOUND');
  const before = { status: grant.status, permissions: [...grant.permissions] };
  if (status) {
    if (status === 'active' && grant.status !== 'active') {
      grant.grantedBy = admin._id;
      grant.grantedAt = new Date();
    }
    if (status === 'inactive') grant.revokedAt = new Date();
    grant.status = status;
  }
  if (permissions) grant.permissions = [...new Set(['view', ...permissions])].filter((p) => PERMISSIONS.includes(p));
  await grant.save();
  await audit({ actor: admin, action: 'receptionist_access.admin_updated', module: 'admin', entityType: 'ReceptionistAccess', entityId: grant._id, before, after: { status: grant.status, permissions: grant.permissions }, req });
  return (await listAccess({ page: 1, limit: 1, doctorId: grant.doctor, receptionistId: grant.receptionist })).items[0];
}

// ---- Billing ------------------------------------------------------------------------

export async function listAllPlans() {
  const plans = await Plan.find().sort({ role: 1, sort: 1 }).lean();
  const counts = await Subscription.aggregate([
    { $match: { status: 'active', $or: [{ endsAt: null }, { endsAt: { $gt: new Date() } }] } },
    { $group: { _id: '$plan', n: { $sum: 1 } } },
  ]);
  const byPlan = new Map(counts.map((c) => [c._id.toString(), c.n]));
  return plans.map((p) => ({
    id: p._id.toString(),
    code: p.code,
    role: p.role,
    name: p.name,
    period: p.period,
    pricePaise: p.pricePaise,
    mrpPaise: p.mrpPaise ?? null,
    taxPercent: p.taxPercent,
    features: p.features,
    active: p.active,
    sort: p.sort,
    activeSubscribers: byPlan.get(p._id.toString()) ?? 0,
  }));
}

export async function listOrders(query) {
  const filter = {};
  if (query.status) filter.status = query.status;
  const { skip, limit, meta } = paging(query);
  const [items, total] = await Promise.all([
    PaymentOrder.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).populate('user', 'name mobile role').populate('plan', 'code name').lean(),
    PaymentOrder.countDocuments(filter),
  ]);
  return {
    items: items.map((o) => ({
      id: o._id.toString(),
      number: o.number,
      user: o.user && { id: o.user._id.toString(), name: o.user.name, mobile: o.user.mobile, role: o.user.role },
      plan: o.plan && { code: o.plan.code, name: o.plan.name },
      amountPaise: o.amountPaise,
      method: o.method,
      provider: o.provider,
      status: o.status,
      failureReason: o.failureReason,
      paidAt: o.paidAt,
      createdAt: o.createdAt,
    })),
    meta: meta(total),
  };
}

export async function listSubscriptions(query) {
  const now = new Date();
  const filter = {};
  if (query.state === 'active') Object.assign(filter, { status: 'active', $or: [{ endsAt: null }, { endsAt: { $gt: now } }] });
  if (query.state === 'expired') Object.assign(filter, { endsAt: { $lte: now } });
  const { skip, limit, meta } = paging(query);
  const [items, total] = await Promise.all([
    Subscription.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).populate('user', 'name mobile role').lean(),
    Subscription.countDocuments(filter),
  ]);
  return {
    items: items.map((s) => ({
      id: s._id.toString(),
      user: s.user && { id: s.user._id.toString(), name: s.user.name, mobile: s.user.mobile, role: s.user.role },
      plan: s.planSnapshot,
      startsAt: s.startsAt,
      endsAt: s.endsAt ?? null,
      active: s.status === 'active' && (!s.endsAt || s.endsAt > now),
    })),
    meta: meta(total),
  };
}

// ---- Support settings & FAQs (admin views include inactive rows) ---------------------

export async function supportSettings() {
  const row = await AppSetting.findOne({ key: 'support' }).lean();
  return { ...DEFAULT_SUPPORT, ...(row?.value ?? {}) };
}

export async function listAllFaqs() {
  const faqs = await Faq.find().sort({ sort: 1, createdAt: 1 }).lean();
  return faqs.map((f) => ({ id: f._id.toString(), audience: f.audience, question: f.question, answer: f.answer, sort: f.sort, active: f.active }));
}

// ---- Audit log ------------------------------------------------------------------------

export async function listAudit(query) {
  const filter = {};
  if (query.module) filter.module = query.module;
  if (query.action) filter.action = new RegExp(`^${escapeRegex(query.action)}`);
  if (query.actorId) filter['actor.user'] = new ObjectId(query.actorId);
  if (query.entityId) filter.entityId = query.entityId;
  if (query.from || query.to) {
    filter.createdAt = {};
    if (query.from) filter.createdAt.$gte = dayBounds(query.from).start;
    if (query.to) filter.createdAt.$lt = dayBounds(query.to).end;
  }
  const { skip, limit, meta } = paging(query);
  const [items, total, modules] = await Promise.all([
    AuditLog.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).populate('actor.user', 'name mobile email role').lean(),
    AuditLog.countDocuments(filter),
    AuditLog.distinct('module'),
  ]);
  return {
    items: items.map((a) => ({
      id: a._id.toString(),
      at: a.createdAt,
      actor: a.actor?.user ? { id: a.actor.user._id.toString(), name: a.actor.user.name, role: a.actor.role, contact: a.actor.user.email ?? a.actor.user.mobile } : { role: a.actor?.role },
      action: a.action,
      module: a.module,
      entityType: a.entityType,
      entityId: a.entityId,
      before: a.before,
      after: a.after,
      ip: a.ip,
    })),
    meta: { ...meta(total), modules: modules.sort() },
  };
}

// ---- Creating app users ------------------------------------------------------------------

/**
 * Pre-registers a doctor / MR / receptionist. They sign in with OTP on their
 * mobile and complete registration in the app. A receptionist is linked to one
 * or more doctors straight away with the chosen permissions.
 */
export async function createAppUser(admin, { role, name, mobile, doctorIds = [], permissions = [] }, req) {
  if (await User.exists({ mobile })) throw ApiError.conflict('This mobile number is already registered', 'MOBILE_IN_USE');
  let doctors = [];
  if (role === 'receptionist') {
    const ids = [...new Set(doctorIds)];
    if (!ids.length) {
      throw ApiError.badRequest('Pick at least one doctor for the receptionist', [{ path: 'doctorIds', message: 'Required' }], 'VALIDATION_ERROR');
    }
    doctors = await User.find({ _id: { $in: ids }, role: 'doctor', status: 'active' }).select('_id').lean();
    if (doctors.length !== ids.length) {
      throw ApiError.badRequest('One or more doctors were not found or are inactive', [{ path: 'doctorIds', message: 'Invalid doctor' }], 'VALIDATION_ERROR');
    }
  }

  const user = await User.create({ role, name, mobile, createdBy: admin._id });
  try {
    await profileModelFor(role).create({ user: user._id, code: await nextCode(role) });
    if (doctors.length) {
      const perms = [...new Set(['view', ...permissions])];
      await ReceptionistAccess.insertMany(
        doctors.map((d) => ({ doctor: d._id, receptionist: user._id, status: 'active', permissions: perms, grantedBy: admin._id, grantedAt: new Date() })),
      );
    }
  } catch (err) {
    // Keep the database consistent if a later step fails.
    await Promise.all([User.deleteOne({ _id: user._id }), profileModelFor(role).deleteOne({ user: user._id }), ReceptionistAccess.deleteMany({ receptionist: user._id })]);
    throw err;
  }
  await audit({
    actor: admin,
    action: 'user.created_by_admin',
    module: 'admin',
    entityType: 'User',
    entityId: user._id,
    after: { role, name, doctors: doctors.map((d) => d._id.toString()), permissions },
    req,
  });
  return getUser(user._id);
}
