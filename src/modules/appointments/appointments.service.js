import { ApiError } from '../../utils/ApiError.js';
import { paging } from '../../utils/http.js';
import { grantedDoctorIds, receptionistCan } from '../access/access.service.js';
import { ReceptionistAccess } from '../access/receptionistAccess.model.js';
import { audit } from '../audit/audit.js';
import { notify } from '../notifications/notifications.service.js';
import { DoctorProfile, MrProfile } from '../profiles/profile.models.js';
import { User } from '../users/user.model.js';
import { ACTIVE_STATUSES, Appointment } from './appointment.model.js';
import { assertBookableSlot, buildSlots, dayBounds, formatTime, formatWhen, localParts } from './schedule.js';

/**
 * Permission names map onto receptionist grants:
 *   view · book · reschedule (also approve/reject/complete) · cancel
 */
const STAFF_ACTION = { approve: 'reschedule', reject: 'reschedule', complete: 'reschedule', reschedule: 'reschedule', cancel: 'cancel' };

const TRANSITIONS = {
  approve: { from: ['pending'], to: 'approved' },
  reject: { from: ['pending'], to: 'cancelled' },
  complete: { from: ['approved'], to: 'completed' },
  cancel: { from: ['pending', 'approved'], to: 'cancelled' },
  reschedule: { from: ['pending', 'approved'] },
};

const PAST = { approve: 'approved', reject: 'rejected', complete: 'completed', cancel: 'cancelled', reschedule: 'rescheduled' };

const idOf = (v) => (v?._id ?? v)?.toString();

async function loadDoctor(doctorId) {
  const doctor = await User.findOne({ _id: doctorId, role: 'doctor', status: 'active' }).lean();
  if (!doctor) throw ApiError.notFound('Doctor not found', 'DOCTOR_NOT_FOUND');
  const profile = await DoctorProfile.findOne({ user: doctorId }).lean();
  return { doctor, profile };
}

/** Throws unless `actor` may perform `permission` on this appointment. */
async function assertCan(actor, appt, permission) {
  const doctorId = idOf(appt.doctor);
  switch (actor.role) {
    case 'admin':
      return;
    case 'doctor':
      if (doctorId === actor.id) return;
      break;
    case 'mr':
      if (idOf(appt.mr) === actor.id && ['view', 'cancel', 'reschedule'].includes(permission)) return;
      break;
    case 'receptionist':
      if (await receptionistCan(actor._id, doctorId, permission)) return;
      break;
    default:
      break;
  }
  throw ApiError.forbidden('You are not allowed to do this for this appointment', 'APPOINTMENT_FORBIDDEN');
}

/** What the current user may do with an appointment (drives app buttons). */
function capabilities(actor, appt, grantPerms) {
  const active = ACTIVE_STATUSES.includes(appt.status);
  const staff = actor.role === 'admin' || (actor.role === 'doctor' && idOf(appt.doctor) === actor.id);
  const perms = actor.role === 'receptionist' ? (grantPerms?.get(idOf(appt.doctor)) ?? []) : [];
  const own = actor.role === 'mr' && idOf(appt.mr) === actor.id;
  const has = (p) => staff || perms.includes(p);
  return {
    approve: appt.status === 'pending' && has('reschedule'),
    reject: appt.status === 'pending' && has('reschedule'),
    complete: appt.status === 'approved' && has('reschedule'),
    reschedule: active && (has('reschedule') || own),
    cancel: active && (has('cancel') || own),
  };
}

async function grantMapFor(actor) {
  if (actor.role !== 'receptionist') return undefined;
  const grants = await ReceptionistAccess.find({ receptionist: actor._id, status: 'active' }).lean();
  return new Map(grants.map((g) => [g.doctor.toString(), g.permissions]));
}

async function specialtiesFor(doctorIds) {
  const profiles = await DoctorProfile.find({ user: { $in: doctorIds } }).select('user specialty practice.clinicName practice.type').lean();
  return new Map(profiles.map((p) => [p.user.toString(), p]));
}

function present(appt, actor, { profiles, grants, detail = false } = {}) {
  const doctor = appt.doctor ?? {};
  const profile = profiles?.get(idOf(doctor));
  const out = {
    id: appt._id.toString(),
    doctor: {
      id: idOf(doctor),
      name: doctor.name,
      photoUrl: doctor.photoUrl,
      specialty: profile?.specialty,
      clinicName: profile?.practice?.clinicName,
      placeType: profile?.practice?.type,
    },
    mr: appt.mr ? { id: idOf(appt.mr), name: appt.mr.name, photoUrl: appt.mr.photoUrl } : null,
    visitor: appt.visitor,
    startAt: appt.startAt,
    endAt: appt.endAt,
    date: localParts(appt.startAt).dateStr,
    timeLabel: `${formatTime(appt.startAt)} - ${formatTime(appt.endAt)}`,
    status: appt.status,
    purpose: appt.purpose,
    note: appt.note,
    createdBy: appt.createdBy?.role,
    cancel: appt.cancel?.at ? { role: appt.cancel.role, reason: appt.cancel.reason, at: appt.cancel.at } : undefined,
    can: capabilities(actor, appt, grants),
  };
  if (detail) out.history = appt.history?.map((h) => ({ action: h.action, role: h.role, at: h.at, from: h.from, to: h.to }));
  return out;
}

const populate = (q) => q.populate('doctor', 'name photoUrl').populate('mr', 'name photoUrl');

async function presentOne(actor, id) {
  const appt = await populate(Appointment.findById(id)).lean();
  const [profiles, grants] = await Promise.all([specialtiesFor([idOf(appt.doctor)]), grantMapFor(actor)]);
  return present(appt, actor, { profiles, grants, detail: true });
}

// ---- Notifications -------------------------------------------------------------

/** Doctor plus every receptionist currently allowed to see the doctor's diary. */
async function staffRecipients(doctorId) {
  const grants = await ReceptionistAccess.find({ doctor: doctorId, status: 'active', permissions: 'view' }).select('receptionist').lean();
  return [idOf(doctorId), ...grants.map((g) => g.receptionist.toString())];
}

const NOTICE = {
  approve: ['appointment.approved', 'Appointment Confirmed'],
  reject: ['appointment.rejected', 'Appointment Request Declined'],
  cancel: ['appointment.cancelled', 'Appointment Cancelled'],
  reschedule: ['appointment.rescheduled', 'Appointment Rescheduled'],
  complete: ['appointment.completed', 'Visit Completed'],
};

async function notifyChange(actor, appt, action, doctorName) {
  const [type, title] = NOTICE[action];
  const data = { appointmentId: appt._id.toString(), doctorId: idOf(appt.doctor) };
  if (actor.role === 'mr') {
    // MR changed their own visit → tell the doctor's side, minus the actor.
    const to = (await staffRecipients(appt.doctor)).filter((id) => id !== actor.id);
    return notify(to, { type, title, body: `${appt.visitor.name} · ${formatWhen(appt.startAt)}`, data });
  }
  const to = [idOf(appt.mr)];
  if (actor.role === 'receptionist') to.push(idOf(appt.doctor));
  return notify(
    to.filter((id) => id && id !== actor.id),
    { type, title, body: `${doctorName ?? 'Doctor'} · ${formatWhen(appt.startAt)}`, data },
  );
}

// ---- Queries -----------------------------------------------------------------

export async function listAppointments(actor, query) {
  const filter = {};
  if (actor.role === 'doctor') filter.doctor = actor._id;
  if (actor.role === 'mr') filter.mr = actor._id;
  if (actor.role === 'receptionist') {
    const allowed = await grantedDoctorIds(actor._id);
    if (query.doctorId && !allowed.includes(query.doctorId)) {
      throw ApiError.forbidden('You do not have access to this doctor', 'DOCTOR_FORBIDDEN');
    }
    filter.doctor = { $in: query.doctorId ? [query.doctorId] : allowed };
  } else if (query.doctorId && actor.role !== 'doctor') {
    filter.doctor = query.doctorId;
  }
  if (actor.role === 'admin' && query.mrId) filter.mr = query.mrId;
  if (query.status) filter.status = { $in: query.status };
  if (query.date) {
    const { start, end } = dayBounds(query.date);
    filter.startAt = { $gte: start, $lt: end };
  } else if (query.from || query.to) {
    filter.startAt = {};
    if (query.from) filter.startAt.$gte = dayBounds(query.from).start;
    if (query.to) filter.startAt.$lt = dayBounds(query.to).end;
  }

  const { skip, limit, meta } = paging(query);
  const sort = query.sort === 'latest' ? { startAt: -1 } : { startAt: 1 };
  const [items, total] = await Promise.all([
    populate(Appointment.find(filter).sort(sort).skip(skip).limit(limit)).lean(),
    Appointment.countDocuments(filter),
  ]);
  const [profiles, grants] = await Promise.all([
    specialtiesFor([...new Set(items.map((a) => idOf(a.doctor)))]),
    grantMapFor(actor),
  ]);
  return { items: items.map((a) => present(a, actor, { profiles, grants })), meta: meta(total) };
}

export async function getAppointment(actor, id) {
  const appt = await Appointment.findById(id).lean();
  if (!appt) throw ApiError.notFound('Appointment not found', 'APPOINTMENT_NOT_FOUND');
  await assertCan(actor, appt, 'view');
  return presentOne(actor, id);
}

/** Slot grid for a day with availability flags. */
export async function daySlots(actor, doctorId, dateStr) {
  const { profile } = await loadDoctor(doctorId);
  if (actor.role === 'doctor' && actor.id !== doctorId) throw ApiError.forbidden();
  if (actor.role === 'receptionist' && !(await receptionistCan(actor._id, doctorId, 'view'))) {
    throw ApiError.forbidden('You do not have access to this doctor', 'DOCTOR_FORBIDDEN');
  }
  const { start, end } = dayBounds(dateStr);
  const taken = await Appointment.find({ doctor: doctorId, status: { $in: ACTIVE_STATUSES }, startAt: { $gte: start, $lt: end } })
    .select('startAt')
    .lean();
  const takenSet = new Set(taken.map((a) => a.startAt.getTime()));
  const now = Date.now();
  const slots = buildSlots(profile, dateStr).map((s, i) => ({
    number: i + 1,
    startAt: s.startAt,
    label: s.label,
    available: !takenSet.has(s.startAt.getTime()) && s.startAt.getTime() > now,
  }));
  const maxPerDay = profile?.mrCall?.maxPerDay ?? null;
  const dayFull = maxPerDay !== null && taken.length >= maxPerDay;
  return {
    date: dateStr,
    doctorAvailability: profile?.availability ?? 'manual',
    maxPerDay,
    booked: taken.length,
    available: dayFull ? 0 : slots.filter((s) => s.available).length,
    slots: dayFull ? slots.map((s) => ({ ...s, available: false })) : slots,
  };
}

// ---- Commands ----------------------------------------------------------------

async function assertCapacity(profile, doctorId, startAt, excludeId) {
  const maxPerDay = profile?.mrCall?.maxPerDay;
  if (!maxPerDay) return;
  const { start, end } = dayBounds(localParts(startAt).dateStr);
  const filter = { doctor: doctorId, status: { $in: ACTIVE_STATUSES }, startAt: { $gte: start, $lt: end } };
  if (excludeId) filter._id = { $ne: excludeId };
  if ((await Appointment.countDocuments(filter)) >= maxPerDay) {
    throw ApiError.unprocessable('No more MR appointments are available on this day', 'DAY_FULL');
  }
}

async function saveOrConflict(doc) {
  try {
    return await doc.save();
  } catch (err) {
    if (err?.code === 11000) throw ApiError.conflict('This time slot was just booked. Please pick another.', 'SLOT_TAKEN');
    throw err;
  }
}

export async function createAppointment(actor, body, req) {
  const doctorId = actor.role === 'doctor' ? actor.id : body.doctorId;
  if (!doctorId) throw ApiError.badRequest('doctorId is required', undefined, 'VALIDATION_ERROR');
  if (actor.role === 'doctor' && body.doctorId && body.doctorId !== actor.id) throw ApiError.forbidden();
  if (actor.role === 'receptionist' && !(await receptionistCan(actor._id, doctorId, 'book'))) {
    throw ApiError.forbidden('You are not allowed to book for this doctor', 'BOOK_FORBIDDEN');
  }

  const { profile } = await loadDoctor(doctorId);
  if (profile?.availability === 'unavailable' && actor.role !== 'admin') {
    throw ApiError.unprocessable('The doctor is currently not available for MR appointments', 'DOCTOR_UNAVAILABLE');
  }
  const startAt = new Date(body.startAt);
  const endAt = assertBookableSlot(profile, startAt);
  await assertCapacity(profile, doctorId, startAt);

  let visitor = body.visitor;
  let mr;
  if (actor.role === 'mr') {
    const mrProfile = await MrProfile.findOne({ user: actor._id }).lean();
    mr = actor._id;
    visitor = {
      name: actor.name || 'Medical Representative',
      company: mrProfile?.company?.name,
      division: mrProfile?.division,
    };
  } else if (!visitor?.name) {
    throw ApiError.badRequest('MR name is required', [{ path: 'visitor.name', message: 'Required' }], 'VALIDATION_ERROR');
  }

  const status = actor.role === 'mr' && profile?.availability !== 'auto' ? 'pending' : 'approved';
  const appt = await saveOrConflict(
    new Appointment({
      doctor: doctorId,
      mr,
      visitor,
      startAt,
      endAt,
      status,
      purpose: body.purpose,
      note: body.note,
      createdBy: { user: actor._id, role: actor.role },
      history: [{ action: 'created', by: actor._id, role: actor.role, to: { status, startAt } }],
    }),
  );
  await audit({
    actor,
    action: 'appointment.created',
    module: 'appointments',
    entityType: 'Appointment',
    entityId: appt._id,
    after: { doctor: doctorId, startAt, status },
    req,
  });
  const to = (await staffRecipients(doctorId)).filter((id) => id !== actor.id);
  await notify(to, {
    type: status === 'pending' ? 'appointment.requested' : 'appointment.booked',
    title: status === 'pending' ? 'New Appointment Request' : 'Appointment Booked',
    body: `${visitor.name}${visitor.company ? ` (${visitor.company})` : ''} · ${formatWhen(startAt)}`,
    data: { appointmentId: appt._id.toString(), doctorId },
  });
  return presentOne(actor, appt._id);
}

export async function transition(actor, id, action, body = {}, req) {
  const appt = await Appointment.findById(id);
  if (!appt) throw ApiError.notFound('Appointment not found', 'APPOINTMENT_NOT_FOUND');
  if (actor.role === 'mr' && ['approve', 'reject', 'complete'].includes(action)) throw ApiError.forbidden();
  await assertCan(actor, appt, STAFF_ACTION[action]);

  const rule = TRANSITIONS[action];
  if (!rule.from.includes(appt.status)) {
    throw ApiError.unprocessable(`A ${appt.status} appointment cannot be ${PAST[action]}`, 'INVALID_TRANSITION');
  }

  const before = { status: appt.status, startAt: appt.startAt };
  if (action === 'reschedule') {
    const { profile } = await loadDoctor(appt.doctor);
    const startAt = new Date(body.startAt);
    appt.endAt = assertBookableSlot(profile, startAt);
    await assertCapacity(profile, appt.doctor, startAt, appt._id);
    appt.startAt = startAt;
    appt.status = actor.role === 'mr' && profile?.availability !== 'auto' ? 'pending' : 'approved';
  } else {
    appt.status = rule.to;
  }
  if (action === 'cancel' || action === 'reject') {
    appt.cancel = { by: actor._id, role: actor.role, reason: body.reason ?? (action === 'reject' ? 'Rejected' : undefined), at: new Date() };
  }
  appt.history.push({ action, by: actor._id, role: actor.role, from: before, to: { status: appt.status, startAt: appt.startAt } });
  await saveOrConflict(appt);

  await audit({
    actor,
    action: `appointment.${PAST[action]}`,
    module: 'appointments',
    entityType: 'Appointment',
    entityId: appt._id,
    before,
    after: { status: appt.status, startAt: appt.startAt, reason: appt.cancel?.reason },
    req,
  });
  const doctor = await User.findById(appt.doctor).select('name').lean();
  await notifyChange(actor, appt, action, doctor?.name);
  return presentOne(actor, appt._id);
}

/** Used by account deletion: cancels the user's upcoming appointments. */
export async function cancelUpcomingFor(user, field, reason) {
  await Appointment.updateMany(
    { [field]: user._id, status: { $in: ACTIVE_STATUSES }, startAt: { $gte: new Date() } },
    {
      $set: { status: 'cancelled', cancel: { by: user._id, role: user.role, reason, at: new Date() } },
      $push: { history: { action: 'cancel', by: user._id, role: user.role, at: new Date(), to: { status: 'cancelled' } } },
    },
  );
}
