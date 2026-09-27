import { ApiError } from '../../utils/ApiError.js';
import { doctorsForReceptionist } from '../access/access.service.js';
import { ReceptionistAccess } from '../access/receptionistAccess.model.js';
import { cancelUpcomingFor } from '../appointments/appointments.service.js';
import { audit } from '../audit/audit.js';
import { revokeAllSessions } from '../auth/token.service.js';
import { currentSubscription } from '../billing/billing.service.js';
import { adminAccessFor } from '../staff/adminAccess.js';
import { User } from '../users/user.model.js';
import { DoctorProfile, MrProfile, ReceptionistProfile, profileModelFor } from './profile.models.js';

const PRIVATE_FIELDS = '-__v -user';

const toPaise = (consultation) => {
  if (!consultation) return consultation;
  const { feeRupees, ...rest } = consultation;
  return feeRupees === undefined ? rest : { ...rest, feePaise: Math.round(feeRupees * 100) };
};

export async function getMe(user) {
  const profile = await profileModelFor(user.role)?.findOne({ user: user._id }).select(PRIVATE_FIELDS).lean();
  const me = { user: user.toPublic(), profile: profile ?? null };
  if (user.role === 'admin') me.access = await adminAccessFor(user);
  if (user.role !== 'admin') {
    const sub = await currentSubscription(user._id);
    me.subscription = sub ? { plan: sub.planSnapshot, endsAt: sub.endsAt ?? null, lifetime: !sub.endsAt } : null;
  }
  if (user.role === 'receptionist') me.doctors = await doctorsForReceptionist(user._id);
  return me;
}

export async function updateSettings(user, settings, req) {
  const before = { ...(user.settings?.toObject?.() ?? user.settings) };
  user.settings = { ...before, ...settings };
  await user.save();
  await audit({ actor: user, action: 'user.settings_updated', module: 'users', entityType: 'User', entityId: user._id, before, after: user.settings, req });
  return user.toPublic().settings;
}

export async function updateMe(user, { name }, req) {
  const before = { name: user.name };
  if (name !== undefined) user.name = name;
  await user.save();
  await audit({ actor: user, action: 'user.updated', module: 'users', entityType: 'User', entityId: user._id, before, after: { name: user.name }, req });
  return getMe(user);
}

async function saveProfile(user, Model, fields, step, req) {
  const { name, ...rest } = fields;
  const profile = await Model.findOneAndUpdate({ user: user._id }, { $set: rest }, { new: true, runValidators: true });
  if (!profile) throw ApiError.notFound('Profile not found', 'PROFILE_NOT_FOUND');
  if (name) user.name = name;
  user.onboarding = { ...user.onboarding, [step]: true };
  await user.save();
  await audit({
    actor: user,
    action: `profile.${step}_saved`,
    module: 'profiles',
    entityType: Model.modelName,
    entityId: profile._id,
    after: { fields: Object.keys(fields) },
    req,
  });
  return getMe(user);
}

export const saveDoctorProfile = (user, body, req) => saveProfile(user, DoctorProfile, body, 'profile', req);

export const saveDoctorFinal = (user, body, req) =>
  saveProfile(user, DoctorProfile, { ...body, consultation: toPaise(body.consultation) }, 'final', req);

export const saveMrProfile = async (user, body, req) => {
  const me = await saveProfile(user, MrProfile, body, 'profile', req);
  // MR registration is a single step.
  user.onboarding = { ...user.onboarding, final: true };
  await user.save();
  return { ...me, user: user.toPublic() };
};

export const saveReceptionistProfile = (user, body, req) => saveProfile(user, ReceptionistProfile, body, 'profile', req);

export const saveReceptionistFinal = (user, body, req) =>
  saveProfile(user, ReceptionistProfile, { final: { ...body, consultation: toPaise(body.consultation) } }, 'final', req);

export async function setAvailability(user, availability, req) {
  const profile = await DoctorProfile.findOneAndUpdate({ user: user._id }, { $set: { availability } }, { new: false });
  if (!profile) throw ApiError.notFound('Profile not found', 'PROFILE_NOT_FOUND');
  await audit({
    actor: user,
    action: 'doctor.availability_changed',
    module: 'profiles',
    entityType: 'DoctorProfile',
    entityId: profile._id,
    before: { availability: profile.availability },
    after: { availability },
    req,
  });
  return { availability };
}

/**
 * Delete account: soft delete + anonymise, revoke every session and grant,
 * cancel upcoming appointments. History stays consistent for the other party.
 */
export async function deleteAccount(user, { reason }, req) {
  if (user.role === 'admin') throw ApiError.forbidden('Admin accounts are removed by another admin');

  if (user.role === 'doctor') {
    await cancelUpcomingFor(user, 'doctor', 'Doctor account deleted');
    await ReceptionistAccess.deleteMany({ doctor: user._id });
  } else if (user.role === 'mr') {
    await cancelUpcomingFor(user, 'mr', 'MR account deleted');
  } else if (user.role === 'receptionist') {
    await ReceptionistAccess.deleteMany({ receptionist: user._id });
  }
  await profileModelFor(user.role)?.deleteOne({ user: user._id });

  await User.updateOne(
    { _id: user._id },
    {
      $set: { status: 'deleted', name: 'Deleted user', deletedAt: new Date(), deletionReason: reason },
      $unset: { mobile: '', email: '', photoUrl: '' },
    },
  );
  await revokeAllSessions(user._id);
  await audit({ actor: user, action: 'user.deleted', module: 'users', entityType: 'User', entityId: user._id, after: { reason }, req });
}
