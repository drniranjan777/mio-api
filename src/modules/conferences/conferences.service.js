import { ApiError } from '../../utils/ApiError.js';
import { paging } from '../../utils/http.js';
import { localParts } from '../appointments/schedule.js';
import { audit } from '../audit/audit.js';
import { notify } from '../notifications/notifications.service.js';
import { DoctorProfile } from '../profiles/profile.models.js';
import { User } from '../users/user.model.js';
import { Conference, ConferenceParticipation, PARTICIPATION } from './conference.models.js';

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const today = () => localParts(new Date()).dateStr;

const present = (c, myStatus, counts) => ({
  id: c._id.toString(),
  title: c.title,
  organizer: c.organizer,
  startDate: c.startDate,
  endDate: c.endDate,
  venue: c.venue,
  city: c.city,
  specialty: c.specialty,
  logoUrl: c.logoUrl,
  website: c.website,
  description: c.description,
  status: c.status,
  ...(myStatus !== undefined && { myStatus }),
  ...(counts && { participants: counts }),
});

/**
 * Upcoming (or past) published conferences. Doctors also get their own
 * participation status per conference and a summary of their plan.
 */
export async function listConferences(actor, query) {
  const filter = {};
  if (actor.role !== 'admin' || !query.status) filter.status = 'published';
  if (actor.role === 'admin' && query.status) filter.status = query.status;
  if (query.when === 'upcoming') filter.endDate = { $gte: today() };
  if (query.when === 'past') filter.endDate = { $lt: today() };
  if (query.specialty) filter.specialty = new RegExp(`^${escapeRegex(query.specialty)}$`, 'i');
  if (query.q) filter.title = new RegExp(escapeRegex(query.q), 'i');

  const { skip, limit, meta } = paging(query);
  const [items, total] = await Promise.all([
    Conference.find(filter)
      .sort(query.when === 'past' ? { startDate: -1 } : { startDate: 1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    Conference.countDocuments(filter),
  ]);

  if (actor.role === 'doctor') {
    const mine = await ConferenceParticipation.find({ doctor: actor._id, conference: { $in: items.map((c) => c._id) } }).lean();
    const byConf = new Map(mine.map((p) => [p.conference.toString(), p.status]));
    return {
      items: items.map((c) => present(c, byConf.get(c._id.toString()) ?? null)),
      meta: { ...meta(total), summary: await doctorSummary(actor._id) },
    };
  }
  if (actor.role === 'admin') {
    const counts = await participantCounts(items.map((c) => c._id));
    return { items: items.map((c) => present(c, undefined, counts.get(c._id.toString()) ?? emptyCounts())), meta: meta(total) };
  }
  return { items: items.map((c) => present(c)), meta: meta(total) };
}

const emptyCounts = () => Object.fromEntries(PARTICIPATION.map((s) => [s, 0]));

async function participantCounts(conferenceIds) {
  const rows = await ConferenceParticipation.aggregate([
    { $match: { conference: { $in: conferenceIds } } },
    { $group: { _id: { c: '$conference', s: '$status' }, n: { $sum: 1 } } },
  ]);
  const out = new Map();
  for (const r of rows) {
    const key = r._id.c.toString();
    if (!out.has(key)) out.set(key, emptyCounts());
    out.get(key)[r._id.s] = r.n;
  }
  return out;
}

/** Header counters on the Conference Participation Plan screen. */
async function doctorSummary(doctorId) {
  const upcomingIds = await Conference.find({ status: 'published', endDate: { $gte: today() } }).distinct('_id');
  const rows = await ConferenceParticipation.aggregate([
    { $match: { doctor: doctorId, conference: { $in: upcomingIds } } },
    { $group: { _id: '$status', n: { $sum: 1 } } },
  ]);
  return { upcoming: upcomingIds.length, ...emptyCounts(), ...Object.fromEntries(rows.map((r) => [r._id, r.n])) };
}

export async function getConference(actor, id) {
  const c = await Conference.findById(id).lean();
  if (!c || (c.status !== 'published' && actor.role !== 'admin')) {
    throw ApiError.notFound('Conference not found', 'CONFERENCE_NOT_FOUND');
  }
  if (actor.role === 'doctor') {
    const p = await ConferenceParticipation.findOne({ conference: id, doctor: actor._id }).lean();
    return present(c, p?.status ?? null);
  }
  if (actor.role === 'admin') return present(c, undefined, (await participantCounts([c._id])).get(id) ?? emptyCounts());
  return present(c);
}

export async function setParticipation(doctor, id, status, req) {
  const c = await Conference.findById(id).lean();
  if (!c || c.status !== 'published') throw ApiError.notFound('Conference not found', 'CONFERENCE_NOT_FOUND');
  if (c.endDate < today()) throw ApiError.unprocessable('This conference is already over', 'CONFERENCE_OVER');
  const before = await ConferenceParticipation.findOneAndUpdate(
    { conference: id, doctor: doctor._id },
    { $set: { status } },
    { upsert: true, new: false },
  ).lean();
  await audit({
    actor: doctor,
    action: 'conference.participation_set',
    module: 'conferences',
    entityType: 'Conference',
    entityId: id,
    before: before ? { status: before.status } : undefined,
    after: { status },
    req,
  });
  return getConference(doctor, id);
}

export async function clearParticipation(doctor, id, req) {
  const removed = await ConferenceParticipation.findOneAndDelete({ conference: id, doctor: doctor._id }).lean();
  if (removed) {
    await audit({
      actor: doctor,
      action: 'conference.participation_cleared',
      module: 'conferences',
      entityType: 'Conference',
      entityId: id,
      before: { status: removed.status },
      req,
    });
  }
  return getConference(doctor, id);
}

// ---- Admin ------------------------------------------------------------------

function assertDates({ startDate, endDate }) {
  if (startDate && endDate && endDate < startDate) {
    throw ApiError.badRequest('End date must be on or after the start date', [{ path: 'endDate', message: 'Before start date' }], 'VALIDATION_ERROR');
  }
}

/** Tells doctors of the matching specialty (or everyone when none) about a new conference. */
async function announce(c) {
  const profileFilter = c.specialty ? { specialty: new RegExp(`^${escapeRegex(c.specialty)}$`, 'i') } : {};
  const doctorIds = await DoctorProfile.find(profileFilter).distinct('user');
  const active = await User.find({ _id: { $in: doctorIds }, role: 'doctor', status: 'active' }).distinct('_id');
  await notify(active, {
    type: 'conference.new',
    title: c.title,
    body: [c.venue, c.city].filter(Boolean).join(', '),
    data: { conferenceId: c._id.toString() },
  });
}

export async function createConference(admin, body, req) {
  assertDates(body);
  const c = await Conference.create({ ...body, createdBy: admin._id });
  await audit({ actor: admin, action: 'conference.created', module: 'conferences', entityType: 'Conference', entityId: c._id, after: body, req });
  if (c.status === 'published') await announce(c);
  return getConference(admin, c._id.toString());
}

export async function updateConference(admin, id, body, req) {
  const c = await Conference.findById(id);
  if (!c) throw ApiError.notFound('Conference not found', 'CONFERENCE_NOT_FOUND');
  assertDates({ startDate: body.startDate ?? c.startDate, endDate: body.endDate ?? c.endDate });
  const before = c.toObject();
  const wasPublished = c.status === 'published';
  c.set(body);
  await c.save();
  await audit({
    actor: admin,
    action: 'conference.updated',
    module: 'conferences',
    entityType: 'Conference',
    entityId: c._id,
    before: Object.fromEntries(Object.keys(body).map((k) => [k, before[k]])),
    after: body,
    req,
  });
  if (!wasPublished && c.status === 'published') await announce(c);
  return getConference(admin, id);
}
