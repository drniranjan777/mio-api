import { ApiError } from '../../utils/ApiError.js';
import { doctorsForReceptionist } from '../access/access.service.js';
import { ReceptionistAccess } from '../access/receptionistAccess.model.js';
import { cancelUpcomingFor } from '../appointments/appointments.service.js';
import { audit } from '../audit/audit.js';
import { issueOtp, verifyOtp } from '../auth/otp.service.js';
import { issueTokens, revokeAllSessions } from '../auth/token.service.js';
import { currentSubscription } from '../billing/billing.service.js';
import { adminAccessFor } from '../staff/adminAccess.js';
import { deleteImage, keyFromUrl, saveImage } from '../uploads/storage.service.js';
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

/**
 * Optional top-level fields of each full-form save. The app leaves a cleared
 * field out of the body, so a missing key here means "remove the old value".
 */
const CLEARABLE = {
  'doctor:profile': ['dateOfBirth', 'dateOfMarriage', 'hprId', 'subSpecialty'],
  'doctor:final': ['referralMobile'],
  'mr:profile': ['dateOfMarriage', 'lastWorkingDate'],
};

/** Profile photo: stores the new image, points photoUrl at it, removes the old file. */
export async function setPhoto(user, buffer, req) {
  const image = await saveImage(buffer, 'photo');
  const before = { photoUrl: user.photoUrl };
  user.photoUrl = image.url;
  try {
    await user.save();
  } catch (err) {
    await deleteImage(image.key);
    throw err;
  }
  await deleteImage(keyFromUrl(before.photoUrl));
  await audit({ actor: user, action: 'user.photo_updated', module: 'users', entityType: 'User', entityId: user._id, before, after: { photoUrl: user.photoUrl, bytes: image.bytes, width: image.width, height: image.height }, req });
  return getMe(user);
}

export async function removePhoto(user, req) {
  const before = { photoUrl: user.photoUrl };
  if (before.photoUrl) {
    user.photoUrl = undefined;
    await user.save();
    await deleteImage(keyFromUrl(before.photoUrl));
    await audit({ actor: user, action: 'user.photo_removed', module: 'users', entityType: 'User', entityId: user._id, before, req });
  }
  return getMe(user);
}

async function saveProfile(user, Model, fields, step, req) {
  const { name, ...rest } = fields;
  const clear = (CLEARABLE[`${user.role}:${step}`] ?? []).filter((k) => rest[k] === undefined);
  const update = { $set: rest, ...(clear.length && { $unset: Object.fromEntries(clear.map((k) => [k, ''])) }) };
  const profile = await Model.findOneAndUpdate({ user: user._id }, update, { new: true, runValidators: true });
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

// ---- Mobile number change (signed in) ---------------------------------------------

/** PINs are bound to the account, so a PIN for one user can never change another's number. */
const changeMobilePurpose = (user) => `change-mobile:${user._id}`;
const deletePurpose = (user) => `delete-account:${user._id}`;

async function assertMobileFree(mobile, user) {
  if (mobile === user.mobile) {
    throw ApiError.badRequest('This is already your mobile number', [{ path: 'mobile', message: 'Same as current' }], 'VALIDATION_ERROR');
  }
  if (await User.exists({ mobile })) {
    throw ApiError.conflict('This mobile number is already registered with Mio Doctors', 'MOBILE_IN_USE');
  }
}

/** Step 1: send a PIN to the new number (proves the user owns it). */
export async function requestMobileChange(user, { mobile }) {
  await assertMobileFree(mobile, user);
  return issueOtp(mobile, changeMobilePurpose(user));
}

/**
 * Step 2: verify the PIN and switch the number. Every session is signed out
 * (the number is the login identity); this device gets fresh tokens.
 */
export async function confirmMobileChange(user, { mobile, otp }, req) {
  await assertMobileFree(mobile, user);
  await verifyOtp(mobile, changeMobilePurpose(user), otp);
  const before = user.mobile;
  user.mobile = mobile;
  try {
    await user.save();
  } catch (err) {
    // Registered by someone else between the check and the save.
    if (err?.code === 11000) throw ApiError.conflict('This mobile number is already registered with Mio Doctors', 'MOBILE_IN_USE');
    throw err;
  }
  await revokeAllSessions(user._id);
  const fresh = await User.findById(user._id);
  await audit({ actor: user, action: 'user.mobile_changed', module: 'users', entityType: 'User', entityId: user._id, before: { mobile: before }, after: { mobile }, req });
  return { me: await getMe(fresh), tokens: await issueTokens(fresh, req) };
}

// ---- Delete account ------------------------------------------------------------------

/** Sends the PIN that authorises deleting the signed-in account to its registered mobile. */
export async function requestDeleteOtp(user) {
  if (!user.mobile) throw ApiError.unprocessable('No mobile number on this account', 'NO_MOBILE');
  return issueOtp(user.mobile, deletePurpose(user));
}

/**
 * Delete account: soft delete + anonymise, revoke every session and grant,
 * cancel upcoming appointments. History stays consistent for the other party.
 * Requires the PIN from requestDeleteOtp().
 */
export async function deleteAccount(user, { reason, otp }, req) {
  if (user.role === 'admin') throw ApiError.forbidden('Admin accounts are removed by another admin');
  await verifyOtp(user.mobile, deletePurpose(user), otp);

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
  await deleteImage(keyFromUrl(user.photoUrl));
  await revokeAllSessions(user._id);
  await audit({ actor: user, action: 'user.deleted', module: 'users', entityType: 'User', entityId: user._id, after: { reason }, req });
}
