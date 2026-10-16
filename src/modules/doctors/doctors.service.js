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
  slotsLeftToday: slotsLeft,
});

async function slotsLeftToday(profiles) {
  const today = localParts(new Date()).dateStr;
  const { start, end } = dayBounds(today);
  const booked = await Appointment.aggregate([
    { $match: { doctor: { $in: profiles.map((p) => p.user) }, status: { $in: ACTIVE_STATUSES }, startAt: { $gte: start, $lt: end } } },
    { $group: { _id: '$doctor', n: { $sum: 1 } } },
  ]);
  const byDoctor = new Map(booked.map((b) => [b._id.toString(), b.n]));
  const now = new Date();
  return new Map(
    profiles.map((p) => {
      const future = countFutureSlots(p, today, now);
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
  const [left, mcl] = await Promise.all([slotsLeftToday(profiles), mclSet(mrId, users.map((u) => u._id))]);
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

/** Master MCL: searchable, filterable doctor directory. */
export async function listDoctors(query, actor) {
  const profileFilter = {};
  if (query.specialty) profileFilter.specialty = new RegExp(`^${escapeRegex(query.specialty)}$`, 'i');
  // Doctors practising at both places match either filter.
  if (query.placeType) profileFilter['practice.type'] = { $in: [query.placeType, 'both'] };
  if (query.city) profileFilter['practice.city'] = new RegExp(`^${escapeRegex(query.city)}$`, 'i');

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
    slotsLeftToday(profiles),
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
  const left = await slotsLeftToday(profile ? [profile] : []);
  return {
    ...card(user, profile, left.get(doctorId) ?? 0),
    mrCall: profile?.mrCall,
    consultation: profile?.consultation,
    social: profile?.social,
  };
}
