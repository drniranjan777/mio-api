import { ApiError } from '../../utils/ApiError.js';
import { paging } from '../../utils/http.js';
import { audit } from '../audit/audit.js';
import { issueOtp, verifyOtp } from '../auth/otp.service.js';
import { revokeAllSessions } from '../auth/token.service.js';
import { notify } from '../notifications/notifications.service.js';
import { profileModelFor } from '../profiles/profile.models.js';
import { User } from '../users/user.model.js';
import { RecoveryRequest } from './recovery.model.js';

const purposeFor = (role) => `recovery:${role}`;
const MAX_PENDING_PER_NUMBER = 3;

async function assertNewMobileFree(newMobile) {
  if (await User.exists({ mobile: newMobile })) {
    throw ApiError.conflict('This mobile number is already registered. Sign in with it instead.', 'MOBILE_IN_USE');
  }
}

/** Step 1: PIN to the new number. */
export async function requestRecoveryOtp({ role, newMobile }) {
  await assertNewMobileFree(newMobile);
  return issueOtp(newMobile, purposeFor(role));
}

/**
 * Step 2: file the request. The answer never says whether the old number or
 * code exist, so the form cannot be used to discover registered numbers.
 */
export async function submitRecovery({ role, oldMobile, newMobile, code, name, note, otp }, req) {
  if (oldMobile === newMobile) {
    throw ApiError.badRequest('The new number must be different from the old one', [{ path: 'newMobile', message: 'Same as old number' }], 'VALIDATION_ERROR');
  }
  await assertNewMobileFree(newMobile);
  await verifyOtp(newMobile, purposeFor(role), otp);

  const pending = await RecoveryRequest.countDocuments({ newMobile, status: 'pending' });
  if (pending >= MAX_PENDING_PER_NUMBER) {
    throw ApiError.tooMany('A request for this number is already being reviewed', 'RECOVERY_PENDING');
  }

  const user = await User.findOne({ mobile: oldMobile, role, status: { $ne: 'deleted' } }).lean();
  const profile = user && (await profileModelFor(role).findOne({ user: user._id }).select('code').lean());
  const codeMatches = Boolean(profile?.code && code && profile.code.toUpperCase() === code.toUpperCase());

  const request = await RecoveryRequest.create({
    role,
    oldMobile,
    newMobile,
    code,
    name,
    note,
    user: user?._id ?? null,
    codeMatches,
    ip: req?.ip,
  });
  await audit({
    actor: user ?? null,
    action: 'account.recovery_requested',
    module: 'users',
    entityType: 'RecoveryRequest',
    entityId: request._id,
    after: { role, matchedAccount: Boolean(user), codeMatches },
    req,
  });
  return { status: 'submitted', id: request._id.toString() };
}

// ---- Admin -------------------------------------------------------------------------------

const present = (r) => ({
  id: r._id.toString(),
  role: r.role,
  oldMobile: r.oldMobile,
  newMobile: r.newMobile,
  code: r.code ?? null,
  name: r.name ?? null,
  note: r.note ?? null,
  account: r.user ? { id: r.user._id.toString(), name: r.user.name, mobile: r.user.mobile ?? null, status: r.user.status } : null,
  codeMatches: r.codeMatches,
  status: r.status,
  adminNote: r.adminNote ?? null,
  reviewedBy: r.reviewedBy ? { id: r.reviewedBy._id.toString(), name: r.reviewedBy.name } : null,
  reviewedAt: r.reviewedAt ?? null,
  createdAt: r.createdAt,
});

export async function listRecoveryRequests(query) {
  const filter = query.status ? { status: query.status } : {};
  const { skip, limit, meta } = paging(query);
  const [items, total] = await Promise.all([
    RecoveryRequest.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).populate('user', 'name mobile status').populate('reviewedBy', 'name').lean(),
    RecoveryRequest.countDocuments(filter),
  ]);
  return { items: items.map(present), meta: meta(total) };
}

/** Moves a user's login number; used by recovery approval and the admin "Change mobile" action. */
export async function moveMobile(admin, userId, newMobile, req, reason) {
  const user = await User.findOne({ _id: userId, role: { $in: ['doctor', 'mr', 'receptionist'] } });
  if (!user) throw ApiError.notFound('User not found', 'USER_NOT_FOUND');
  if (user.status === 'deleted') throw ApiError.unprocessable('Deleted accounts cannot be changed', 'USER_DELETED');
  if (user.mobile === newMobile) return user;
  await assertNewMobileFree(newMobile);
  const before = user.mobile;
  user.mobile = newMobile;
  try {
    await user.save();
  } catch (err) {
    if (err?.code === 11000) throw ApiError.conflict('This mobile number is already registered', 'MOBILE_IN_USE');
    throw err;
  }
  await revokeAllSessions(user._id);
  await audit({ actor: admin, action: 'user.mobile_changed_by_admin', module: 'admin', entityType: 'User', entityId: user._id, before: { mobile: before }, after: { mobile: newMobile, reason }, req });
  await notify([user._id], {
    type: 'account.mobile_changed',
    title: 'Mobile number updated',
    body: `Your Mio Doctors login number is now +91 ${newMobile}`,
  });
  return user;
}

export async function reviewRecovery(admin, id, { decision, note }, req) {
  const request = await RecoveryRequest.findById(id);
  if (!request) throw ApiError.notFound('Request not found', 'RECOVERY_NOT_FOUND');
  if (request.status !== 'pending') throw ApiError.conflict(`This request was already ${request.status}`, 'RECOVERY_CLOSED');

  if (decision === 'approve') {
    if (!request.user) throw ApiError.unprocessable('No account matches the old number — reject this request', 'RECOVERY_NO_ACCOUNT');
    await moveMobile(admin, request.user, request.newMobile, req, 'account recovery');
  }
  request.status = decision === 'approve' ? 'approved' : 'rejected';
  request.reviewedBy = admin._id;
  request.reviewedAt = new Date();
  request.adminNote = note;
  await request.save();
  await audit({ actor: admin, action: `account.recovery_${request.status}`, module: 'admin', entityType: 'RecoveryRequest', entityId: request._id, after: { note }, req });

  const fresh = await RecoveryRequest.findById(id).populate('user', 'name mobile status').populate('reviewedBy', 'name').lean();
  return present(fresh);
}
