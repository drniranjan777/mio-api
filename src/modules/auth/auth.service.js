import crypto from 'node:crypto';

import bcrypt from 'bcryptjs';

import { ApiError } from '../../utils/ApiError.js';
import { hasActiveGrant, requestAccess } from '../access/access.service.js';
import { audit } from '../audit/audit.js';
import { profileModelFor } from '../profiles/profile.models.js';
import { nextCode } from '../users/counter.model.js';
import { User } from '../users/user.model.js';
import { issueOtp, verifyOtp } from './otp.service.js';
import { adminAccessFor } from '../staff/adminAccess.js';
import { assertAdminPassword } from './passwordPolicy.js';
import { issueTokens, revokeAllSessions, revokeRefreshToken, rotateRefreshToken } from './token.service.js';

const purposeFor = (role) => `login:${role}`;

// Real hash of a random value so unknown emails cost the same as wrong passwords.
let dummyHash;
const getDummyHash = () => (dummyHash ??= bcrypt.hashSync(crypto.randomUUID(), 12));

/** Checks the number may sign in as this role; returns the existing user (or null). */
async function assertCanSignIn(mobile, role) {
  const user = await User.findOne({ mobile });
  if (user && user.role !== role) {
    throw ApiError.conflict(`This number is registered as ${user.role === 'mr' ? 'an MR' : `a ${user.role}`}`, 'ROLE_MISMATCH');
  }
  if (user && user.status !== 'active') throw ApiError.forbidden('Your account is not active', 'ACCOUNT_INACTIVE');
  if (role === 'receptionist' && !(user && (await hasActiveGrant(user._id)))) {
    throw ApiError.forbidden('A doctor has not given you access yet', 'NO_DOCTOR_ACCESS');
  }
  return user;
}

export async function requestOtp({ mobile, role }) {
  await assertCanSignIn(mobile, role);
  return issueOtp(mobile, purposeFor(role));
}

/** Receptionist "Send Request": sends the OTP when a doctor already granted access. */
export async function receptionistRequest({ mobile }, req) {
  const result = await requestAccess(mobile, req);
  if (result.status !== 'granted') return result;
  return { ...result, ...(await issueOtp(mobile, purposeFor('receptionist'))) };
}

export async function verifyLogin({ mobile, role, otp }, req) {
  await assertCanSignIn(mobile, role);
  await verifyOtp(mobile, purposeFor(role), otp);

  let user = await User.findOne({ mobile });
  const isNewUser = !user;
  if (!user) {
    user = await User.create({ role, mobile });
    await profileModelFor(role).create({ user: user._id, code: await nextCode(role) });
  }
  user.lastLoginAt = new Date();
  await user.save();

  await audit({ actor: user, action: isNewUser ? 'auth.signup' : 'auth.login', module: 'auth', entityType: 'User', entityId: user._id, req });
  return { user: user.toPublic(), isNewUser, tokens: await issueTokens(user, req) };
}

export async function adminLogin({ email, password }, req) {
  const user = await User.findOne({ email, role: 'admin' }).select('+passwordHash');
  // Compare even when the user is missing to keep timing uniform.
  const ok = await bcrypt.compare(password, user?.passwordHash ?? getDummyHash());
  if (!user || !ok) throw ApiError.unauthorized('Invalid email or password', 'INVALID_CREDENTIALS');
  if (user.status !== 'active') throw ApiError.forbidden('Your account is not active', 'ACCOUNT_INACTIVE');
  user.lastLoginAt = new Date();
  await user.save();
  await audit({ actor: user, action: 'auth.admin_login', module: 'auth', entityType: 'User', entityId: user._id, req });
  return { user: user.toPublic(), access: await adminAccessFor(user), tokens: await issueTokens(user, req) };
}

/**
 * Admin changes their own password (required after a temporary one).
 * Every other session is signed out; this one gets fresh tokens.
 */
export async function changeAdminPassword(actor, { currentPassword, newPassword }, req) {
  const user = await User.findById(actor._id).select('+passwordHash');
  if (!(await bcrypt.compare(currentPassword, user.passwordHash ?? getDummyHash()))) {
    throw ApiError.badRequest('Current password is incorrect', [{ path: 'currentPassword', message: 'Incorrect' }], 'INVALID_CREDENTIALS');
  }
  assertAdminPassword(newPassword);
  if (await bcrypt.compare(newPassword, user.passwordHash)) {
    throw ApiError.badRequest('Choose a password different from the current one', [{ path: 'newPassword', message: 'Same as current' }], 'VALIDATION_ERROR');
  }
  user.passwordHash = await bcrypt.hash(newPassword, 12);
  user.mustChangePassword = false;
  await user.save();
  await revokeAllSessions(user._id);
  const fresh = await User.findById(user._id);
  await audit({ actor: user, action: 'auth.admin_password_changed', module: 'auth', entityType: 'User', entityId: user._id, req });
  return { user: fresh.toPublic(), access: await adminAccessFor(fresh), tokens: await issueTokens(fresh, req) };
}

export async function refresh({ refreshToken }, req) {
  const { user, tokens } = await rotateRefreshToken(refreshToken, req);
  return { user: user.toPublic(), tokens };
}

export async function logout({ refreshToken }) {
  await revokeRefreshToken(refreshToken);
}
