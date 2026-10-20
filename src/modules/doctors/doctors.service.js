import { env } from '../../config/env.js';
import { ApiError } from '../../utils/ApiError.js';
import { paging } from '../../utils/http.js';
import { receptionistCan } from '../access/access.service.js';
import { ACTIVE_STATUSES, Appointment } from '../appointments/appointment.model.js';
import { countFutureSlots, dayBounds, localParts } from '../appointments/schedule.js';
import { McLEntry } from '../mcl/mcl.model.js';
import { DoctorProfile } from '../profiles/profile.models.js';
import { User } from '../users/user.model.js';

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Only what a directory card and the slot count need (keeps Master MCL fast). */
const CARD_PROFILE_FIELDS = 'user code qualification specialty practice.type practice.clinicName practice.city practice.state availability mrCall';
const CARD_USER_FIELDS = 'name photoUrl';

/** "N cities" on the Master MCL header changes rarely: computed at most once a minute. */
const CITY_COUNT_TTL_MS = 60_000;
let cityCount = { value: 0, at: 0 };
async function countCities() {
  if (Date.now() - cityCount.at < CITY_COUNT_TTL_MS) return cityCount.value;
  const cities = await DoctorProfile.distinct('practice.city');
  cityCount = { value: cities.filter(Boolean).length, at: Date.now() };
  return cityCount.value;
}

/**
 * Distinct non-empty values, case-insensitively, sorted. Of "Chennai" and
 * "chennai" the capitalised spelling wins (code-point order puts it first).
 */
const distinctSorted = (values) => {
  const clean = values.map((v) => (typeof v === 'string' ? v.trim() : '')).filter(Boolean).sort();
  const byKey = new Map();
  for (const v of clean) if (!byKey.has(v.toLowerCase())) byKey.set(v.toLowerCase(), v);
  return [...byKey.values()].sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' }));
};

/** Filter choices change rarely: cached for a minute per process (not in tests). */
let filterCache = { value: null, at: 0 };

/** Master MCL filter choices, from the doctors an MR can actually find. */
export async function directoryFilters() {
  if (!env.isTest && filterCache.value && Date.now() - filterCache.at < CITY_COUNT_TTL_MS) return filterCache.value;
  const users = await User.find({ role: 'doctor', status: 'active', 'onboarding.profile': true }).select('_id').lean();
  const profiles = await DoctorProfile.find({ user: { $in: users.map((u) => u._id) } })
    .select('specialty practice.city practice.clinicName')
    .lean();
  const value = {
    specialties: distinctSorted(profiles.map((p) => p.specialty)),
    cities: distinctSorted(profiles.map((p) => p.practice?.city)),
    clinicNames: distinctSorted(profiles.map((p) => p.practice?.clinicName)),
  };
  filterCache = { value, at: Date.now() };
  return value;
}

const card = (user, profile, slotsLeft) => ({
  id: user._id.toString(),
  name: user.name,
  photoUrl: user.photoUrl,
  code: profile?.code,
  qualification: profile?.qualification,
  specialty: profile?.specialty,
  placeType: profile?.practice?.type,
  clinicName: profile?.practice?.clinicName,
  city: profile?.practice?.city,
  state: profile?.practice?.state,
  availability: profile?.availability,
  slotsLeft,
  /** Same number; the name used by app builds before 1.0.4 (always today there). */
  slotsLeftToday: slotsLeft,
});

/** Free MR slots per doctor on `dateStr` (default today): future slots, capped by the daily maximum. */
async function slotsLeftOn(profiles, dateStr = localParts(new Date()).dateStr) {
  const { start, end } = dayBounds(dateStr);
  const booked = await Appointment.aggregate([
    { $match: { doctor: { $in: profiles.map((p) => p.user) }, status: { $in: ACTIVE_STATUSES }, startAt: { $gte: start, $lt: end } } },
    { $group: { _id: '$doctor', n: { $sum: 1 } } },
  ]);
  const byDoctor = new Map(booked.map((b) => [b._id.toString(), b.n]));
  const now = new Date();
  return new Map(
    profiles.map((p) => {
      const future = countFutureSlots(p, dateStr, now);
      const cap = p.mrCall?.maxPerDay ?? Infinity;
      const taken = byDoctor.get(p.user.toString()) ?? 0;
      return [p.user.toString(), Math.max(0, Math.min(future, cap - taken))];
    }),
  );
}

/** Directory cards for the given doctor user ids, in the given order. */
export async function doctorCards(userIds, mrId) {
  const users = await User.find({ _id: { $in: userIds }, role: 'doctor', status: 'active' }).select(CARD_USER_FIELDS).lean();
  const byId = new Map(users.map((u) => [u._id.toString(), u]));
  const profiles = await DoctorProfile.find({ user: { $in: users.map((u) => u._id) } }).select(CARD_PROFILE_FIELDS).lean();
  const byUser = new Map(profiles.map((p) => [p.user.toString(), p]));
  const [left, mcl] = await Promise.all([slotsLeftOn(profiles), mclSet(mrId, users.map((u) => u._id))]);
  return userIds
    .map(String)
    .filter((id) => byId.has(id))
    .map((id) => ({ ...card(byId.get(id), byUser.get(id), left.get(id) ?? 0), inMcl: mcl.has(id) }));
}

async function mclSet(mrId, doctorIds) {
  if (!mrId) return new Set();
  const rows = await McLEntry.find({ mr: mrId, doctor: { $in: doctorIds } }).select('doctor').lean();
  return new Set(rows.map((r) => r.doctor.toString()));
}

/** Exact, case-insensitive match against any of `values`. */
const anyOf = (values) => ({ $in: values.map((v) => new RegExp(`^${escapeRegex(v)}$`, 'i')) });

/**
 * Master MCL: searchable, filterable doctor directory. Specialty, city and
 * hospital/clinic name each take several values (any of them matches); the
 * filters combine with AND.
 */
export async function listDoctors(query, actor) {
  const profileFilter = {};
  if (query.specialty?.length) profileFilter.specialty = anyOf(query.specialty);
  // Doctors practising at both places match either filter.
  if (query.placeType) profileFilter['practice.type'] = { $in: [query.placeType, 'both'] };
  if (query.city?.length) profileFilter['practice.city'] = anyOf(query.city);
  if (query.clinicName?.length) profileFilter['practice.clinicName'] = anyOf(query.clinicName);

  const userFilter = { role: 'doctor', status: 'active', 'onboarding.profile': true };
  if (query.q) {
    const rx = new RegExp(escapeRegex(query.q), 'i');
    const bySpecialty = await DoctorProfile.find({ specialty: rx }).select('user').lean();
    userFilter.$or = [{ name: rx }, { _id: { $in: bySpecialty.map((p) => p.user) } }];
  }
  if (Object.keys(profileFilter).length) {
    const matching = await DoctorProfile.find(profileFilter).select('user').lean();
    userFilter._id = { ...(userFilter._id ?? {}), $in: matching.map((p) => p.user) };
  }

  const { skip, limit, meta } = paging(query);
  const [users, total, cities] = await Promise.all([
    User.find(userFilter).sort({ name: 1 }).skip(skip).limit(limit).select(CARD_USER_FIELDS).lean(),
    User.countDocuments(userFilter),
    countCities(),
  ]);
  const profiles = await DoctorProfile.find({ user: { $in: users.map((u) => u._id) } }).select(CARD_PROFILE_FIELDS).lean();
  const byUser = new Map(profiles.map((p) => [p.user.toString(), p]));
  const [left, mcl] = await Promise.all([
    slotsLeftOn(profiles, query.date),
    mclSet(actor?.role === 'mr' ? actor._id : undefined, users.map((u) => u._id)),
  ]);
  return {
    items: users.map((u) => ({
      ...card(u, byUser.get(u._id.toString()), left.get(u._id.toString()) ?? 0),
      inMcl: mcl.has(u._id.toString()),
    })),
    meta: { ...meta(total), cities },
  };
}

export async function getDoctor(actor, doctorId) {
  if (actor.role === 'doctor' && actor.id !== doctorId) throw ApiError.forbidden();
  if (actor.role === 'receptionist' && !(await receptionistCan(actor._id, doctorId, 'view'))) {
    throw ApiError.forbidden('You do not have access to this doctor', 'DOCTOR_FORBIDDEN');
  }
  const user = await User.findOne({ _id: doctorId, role: 'doctor', status: 'active' }).lean();
  if (!user) throw ApiError.notFound('Doctor not found', 'DOCTOR_NOT_FOUND');
  const profile = await DoctorProfile.findOne({ user: doctorId }).lean();
  const left = await slotsLeftOn(profile ? [profile] : []);
  return {
    ...card(user, profile, left.get(doctorId) ?? 0),
    mrCall: profile?.mrCall,
    consultation: profile?.consultation,
    social: profile?.social,
  };
}
