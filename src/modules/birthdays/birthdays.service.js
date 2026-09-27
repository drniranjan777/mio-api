import { ApiError } from '../../utils/ApiError.js';
import { audit } from '../audit/audit.js';
import { McLEntry } from '../mcl/mcl.model.js';
import { notify } from '../notifications/notifications.service.js';
import { DoctorProfile, MrProfile } from '../profiles/profile.models.js';
import { User } from '../users/user.model.js';
import { AHEAD_DAYS, canWish, occurrence, parseDob } from './birthday.js';
import { WISHES_PER_BIRTHDAY, Wish } from './wish.model.js';

const doctorCard = (user, profile, occ) => ({
  id: user._id.toString(),
  name: user.name,
  photoUrl: user.photoUrl,
  specialty: profile.specialty,
  placeType: profile.practice?.type,
  clinicName: profile.practice?.clinicName,
  city: profile.practice?.city,
  birthday: occ,
  canWish: canWish(occ),
});

/**
 * Upcoming doctor birthdays for MRs. `range`: week (next 7 days), month (next
 * 30 days) or all (every doctor with a birthday on file, soonest first).
 * `scope=mcl` limits the list to the MR's own call list.
 */
export async function listBirthdays(actor, { range = 'all', scope = 'all' }) {
  const filter = { dateOfBirth: { $exists: true, $ne: '' } };
  if (scope === 'mcl' && actor.role === 'mr') {
    const mine = await McLEntry.find({ mr: actor._id }).select('doctor').lean();
    filter.user = { $in: mine.map((m) => m.doctor) };
  }
  const profiles = await DoctorProfile.find(filter)
    .select('user dateOfBirth specialty practice.type practice.clinicName practice.city')
    .lean();
  const users = await User.find({ _id: { $in: profiles.map((p) => p.user) }, role: 'doctor', status: 'active' })
    .select('name photoUrl')
    .lean();
  const userById = new Map(users.map((u) => [u._id.toString(), u]));

  const all = [];
  for (const p of profiles) {
    const user = userById.get(p.user.toString());
    const dob = parseDob(p.dateOfBirth);
    if (!user || !dob) continue;
    all.push(doctorCard(user, p, occurrence(dob)));
  }
  all.sort((a, b) => a.birthday.daysUntil - b.birthday.daysUntil || a.name.localeCompare(b.name));

  const inWeek = all.filter((d) => d.birthday.daysUntil >= 0 && d.birthday.daysUntil < 7);
  const inMonth = all.filter((d) => d.birthday.daysUntil >= 0 && d.birthday.daysUntil <= AHEAD_DAYS);
  const items = range === 'week' ? inWeek : range === 'month' ? inMonth : all;

  if (actor.role === 'mr' && items.length) {
    const wished = await Wish.find({ mr: actor._id, doctor: { $in: items.map((d) => d.id) } })
      .select('doctor birthdayOn')
      .lean();
    const key = new Set(wished.map((w) => `${w.doctor}|${w.birthdayOn}`));
    for (const d of items) d.wishedByMe = key.has(`${d.id}|${d.birthday.date}`);
  }
  return { items, counts: { all: all.length, week: inWeek.length, month: inMonth.length } };
}

async function loadBirthdayDoctor(doctorId) {
  const user = await User.findOne({ _id: doctorId, role: 'doctor', status: 'active' }).select('name photoUrl').lean();
  const profile = user && (await DoctorProfile.findOne({ user: doctorId }).lean());
  if (!user || !profile) throw ApiError.notFound('Doctor not found', 'DOCTOR_NOT_FOUND');
  const dob = parseDob(profile.dateOfBirth);
  if (!dob) throw ApiError.unprocessable('This doctor has no birthday on file', 'NO_BIRTHDAY');
  return { user, profile, occ: occurrence(dob) };
}

async function presentWishes(wishes, viewer) {
  const mrIds = [...new Set(wishes.map((w) => w.mr.toString()))];
  const mrs = await User.find({ _id: { $in: mrIds } }).select('name photoUrl status').lean();
  const byId = new Map(mrs.map((u) => [u._id.toString(), u]));
  return wishes.map((w) => {
    const mr = byId.get(w.mr.toString());
    const gone = !mr || mr.status === 'deleted';
    return {
      id: w._id.toString(),
      message: w.message,
      createdAt: w.createdAt,
      hidden: Boolean(w.hiddenAt),
      mine: viewer?.role === 'mr' && w.mr.toString() === viewer.id,
      from: {
        id: w.mr.toString(),
        name: gone ? 'Former MR' : mr.name,
        photoUrl: gone ? undefined : mr.photoUrl,
        company: w.company,
      },
    };
  });
}

/** The "Wished" thread for one doctor's current birthday (visible wishes only). */
export async function wishThread(actor, doctorId) {
  const { user, profile, occ } = await loadBirthdayDoctor(doctorId);
  const wishes = await Wish.find({ doctor: doctorId, birthdayOn: occ.date, hiddenAt: null }).sort({ createdAt: 1 }).lean();
  const mine = actor.role === 'mr' ? wishes.filter((w) => w.mr.toString() === actor.id).length : 0;
  return {
    doctor: doctorCard(user, profile, occ),
    remaining: actor.role === 'mr' ? Math.max(0, WISHES_PER_BIRTHDAY - mine) : 0,
    items: await presentWishes(wishes, actor),
  };
}

export async function sendWish(mr, doctorId, { message }, req) {
  const { user, occ } = await loadBirthdayDoctor(doctorId);
  if (!canWish(occ)) {
    throw ApiError.unprocessable(
      `Wishes open ${AHEAD_DAYS} days before the birthday and close 7 days after`,
      'WISH_WINDOW_CLOSED',
    );
  }
  const sent = await Wish.countDocuments({ mr: mr._id, doctor: doctorId, birthdayOn: occ.date });
  if (sent >= WISHES_PER_BIRTHDAY) {
    throw ApiError.tooMany(`You can send up to ${WISHES_PER_BIRTHDAY} wishes per birthday`, 'WISH_LIMIT');
  }
  const mrProfile = await MrProfile.findOne({ user: mr._id }).select('company.name').lean();
  const wish = await Wish.create({
    doctor: doctorId,
    mr: mr._id,
    birthdayOn: occ.date,
    message,
    company: mrProfile?.company?.name,
  });
  await audit({
    actor: mr,
    action: 'wish.sent',
    module: 'birthdays',
    entityType: 'Wish',
    entityId: wish._id,
    after: { doctor: doctorId },
    req,
  });
  await notify([doctorId], {
    type: 'wish.received',
    title: 'Birthday Wish',
    body: `${mr.name || 'An MR'}${wish.company ? ` (${wish.company})` : ''} sent you a birthday wish`,
    data: { wishId: wish._id.toString(), doctorId: user._id.toString() },
  });
  const [present] = await presentWishes([wish.toObject()], mr);
  return present;
}

/** An MR may take back their own wish. */
export async function deleteWish(mr, wishId, req) {
  const wish = await Wish.findOneAndDelete({ _id: wishId, mr: mr._id });
  if (!wish) throw ApiError.notFound('Wish not found', 'WISH_NOT_FOUND');
  await audit({ actor: mr, action: 'wish.deleted', module: 'birthdays', entityType: 'Wish', entityId: wish._id, req });
}

/** Doctor's "Birthday Wishes" screen: own birthday + wishes received in the last year. */
export async function receivedWishes(doctor, { includeHidden = false }) {
  const profile = await DoctorProfile.findOne({ user: doctor._id }).select('dateOfBirth').lean();
  const dob = parseDob(profile?.dateOfBirth);
  const since = new Date(Date.now() - 365 * 86_400_000);
  const filter = { doctor: doctor._id, createdAt: { $gte: since } };
  if (!includeHidden) filter.hiddenAt = null;
  const [wishes, total] = await Promise.all([
    Wish.find(filter).sort({ createdAt: -1 }).limit(200).lean(),
    Wish.countDocuments({ doctor: doctor._id, createdAt: { $gte: since }, hiddenAt: null }),
  ]);
  return { birthday: dob ? occurrence(dob) : null, total, items: await presentWishes(wishes, doctor) };
}

export async function setWishHidden(doctor, wishId, hidden, req) {
  const wish = await Wish.findOneAndUpdate(
    { _id: wishId, doctor: doctor._id },
    hidden ? { $set: { hiddenAt: new Date() } } : { $unset: { hiddenAt: 1 } },
    { new: true },
  ).lean();
  if (!wish) throw ApiError.notFound('Wish not found', 'WISH_NOT_FOUND');
  await audit({
    actor: doctor,
    action: hidden ? 'wish.hidden' : 'wish.unhidden',
    module: 'birthdays',
    entityType: 'Wish',
    entityId: wish._id,
    req,
  });
  const [present] = await presentWishes([wish], doctor);
  return present;
}
