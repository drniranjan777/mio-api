import { ApiError } from '../../utils/ApiError.js';
import { audit } from '../audit/audit.js';
import { notify } from '../notifications/notifications.service.js';
import { DoctorProfile, ReceptionistProfile } from '../profiles/profile.models.js';
import { nextCode } from '../users/counter.model.js';
import { User } from '../users/user.model.js';
import { ReceptionistAccess } from './receptionistAccess.model.js';

const withView = (perms) => [...new Set(['view', ...(perms ?? [])])];

/** The central permission check for everything a receptionist does. */
export async function receptionistCan(receptionistId, doctorId, permission) {
  const grant = await ReceptionistAccess.findOne({
    doctor: doctorId,
    receptionist: receptionistId,
    status: 'active',
  }).lean();
  return Boolean(grant?.permissions.includes(permission));
}

/** Doctor ids whose appointments the receptionist may see (active + view). */
export async function grantedDoctorIds(receptionistId, permission = 'view') {
  const grants = await ReceptionistAccess.find({
    receptionist: receptionistId,
    status: 'active',
    permissions: permission,
  })
    .select('doctor')
    .lean();
  return grants.map((g) => g.doctor.toString());
}

export async function hasActiveGrant(receptionistId) {
  return Boolean(await ReceptionistAccess.exists({ receptionist: receptionistId, status: 'active' }));
}

async function ensureReceptionistUser(mobile, name) {
  const existing = await User.findOne({ mobile });
  if (existing) {
    if (existing.role !== 'receptionist') {
      throw ApiError.conflict('This mobile number belongs to another type of account', 'MOBILE_IN_USE');
    }
    if (name && !existing.name) {
      existing.name = name;
      await existing.save();
    }
    return existing;
  }
  const user = await User.create({ role: 'receptionist', mobile, name: name ?? '' });
  await ReceptionistProfile.create({ user: user._id, code: await nextCode('receptionist') });
  return user;
}

const present = (grant, receptionist) => ({
  receptionist: {
    id: receptionist._id.toString(),
    name: receptionist.name,
    mobile: receptionist.mobile,
    photoUrl: receptionist.photoUrl,
  },
  status: grant.status,
  permissions: grant.permissions,
  requestedAt: grant.requestedAt,
  grantedAt: grant.grantedAt,
  updatedAt: grant.updatedAt,
});

const notifyGranted = (doctor, receptionistId) =>
  notify([receptionistId], {
    type: 'access.granted',
    title: 'Access Granted',
    body: `${doctor.name || 'A doctor'} gave you access to manage appointments`,
    data: { doctorId: doctor._id.toString() },
  });

// ---- Doctor-side management ------------------------------------------------

export async function listForDoctor(doctorId) {
  const grants = await ReceptionistAccess.find({ doctor: doctorId })
    .populate('receptionist', 'name mobile photoUrl status')
    .sort({ status: 1, updatedAt: -1 })
    .lean();
  return grants.filter((g) => g.receptionist && g.receptionist.status !== 'deleted').map((g) => present(g, g.receptionist));
}

export async function giveAccess(doctor, { name, mobile, permissions }, req) {
  const receptionist = await ensureReceptionistUser(mobile, name);
  const before = await ReceptionistAccess.findOne({ doctor: doctor._id, receptionist: receptionist._id }).lean();
  const grant = await ReceptionistAccess.findOneAndUpdate(
    { doctor: doctor._id, receptionist: receptionist._id },
    {
      $set: {
        status: 'active',
        permissions: withView(permissions),
        grantedBy: doctor._id,
        grantedAt: new Date(),
        revokedAt: null,
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
  await audit({
    actor: doctor,
    action: before ? 'receptionist_access.regranted' : 'receptionist_access.granted',
    module: 'receptionist_access',
    entityType: 'ReceptionistAccess',
    entityId: grant._id,
    before: before && { status: before.status, permissions: before.permissions },
    after: { status: grant.status, permissions: grant.permissions, receptionist: receptionist._id.toString() },
    req,
  });
  if (before?.status !== 'active') await notifyGranted(doctor, receptionist._id);
  return present(grant, receptionist);
}

export async function updateAccess(doctor, receptionistId, { status, permissions }, req) {
  const grant = await ReceptionistAccess.findOne({ doctor: doctor._id, receptionist: receptionistId });
  if (!grant) throw ApiError.notFound('Receptionist not found', 'ACCESS_NOT_FOUND');
  if (status === 'pending') throw ApiError.badRequest('Status cannot be set back to pending');

  const before = { status: grant.status, permissions: [...grant.permissions] };
  if (status) {
    if (status === 'active' && grant.status !== 'active') {
      grant.grantedBy = doctor._id;
      grant.grantedAt = new Date();
      grant.revokedAt = undefined;
    }
    if (status === 'inactive' && grant.status !== 'inactive') grant.revokedAt = new Date();
    grant.status = status;
  }
  if (permissions) grant.permissions = withView(permissions);
  await grant.save();

  const action =
    before.status === 'pending' && grant.status === 'active'
      ? 'receptionist_access.approved'
      : status && status !== before.status
        ? `receptionist_access.${status === 'active' ? 'activated' : 'deactivated'}`
        : 'receptionist_access.permissions_changed';
  await audit({
    actor: doctor,
    action,
    module: 'receptionist_access',
    entityType: 'ReceptionistAccess',
    entityId: grant._id,
    before,
    after: { status: grant.status, permissions: grant.permissions },
    req,
  });
  if (before.status !== 'active' && grant.status === 'active') await notifyGranted(doctor, receptionistId);
  const receptionist = await User.findById(receptionistId).lean();
  return present(grant, receptionist);
}

export async function removeAccess(doctor, receptionistId, req) {
  const grant = await ReceptionistAccess.findOneAndDelete({ doctor: doctor._id, receptionist: receptionistId });
  if (!grant) throw ApiError.notFound('Receptionist not found', 'ACCESS_NOT_FOUND');
  await audit({
    actor: doctor,
    action: grant.status === 'pending' ? 'receptionist_access.rejected' : 'receptionist_access.removed',
    module: 'receptionist_access',
    entityType: 'ReceptionistAccess',
    entityId: grant._id,
    before: { status: grant.status, permissions: grant.permissions },
    req,
  });
}

// ---- Receptionist-side --------------------------------------------------------

/**
 * "Send Request" on the receptionist login.
 *  - granted: at least one active grant → caller may send the OTP
 *  - blocked: grants exist but every one is deactivated
 *  - pending: request filed with doctors that listed this receptionist mobile
 */
export async function requestAccess(mobile, req) {
  const user = await User.findOne({ mobile });
  if (user && user.role !== 'receptionist') {
    throw ApiError.conflict('This mobile number belongs to another type of account', 'MOBILE_IN_USE');
  }
  if (user?.status === 'inactive') throw ApiError.forbidden('Your account is not active', 'ACCOUNT_INACTIVE');

  if (user) {
    const grants = await ReceptionistAccess.find({ receptionist: user._id }).lean();
    if (grants.some((g) => g.status === 'active')) return { status: 'granted', routedTo: 0 };
    if (grants.length && grants.every((g) => g.status === 'inactive')) return { status: 'blocked', routedTo: 0 };
  }

  const receptionist = user ?? (await ensureReceptionistUser(mobile));
  const doctors = await DoctorProfile.find({ 'contacts.receptionistMobile': mobile }).select('user').lean();
  const newlyAsked = [];
  for (const d of doctors) {
    const res = await ReceptionistAccess.updateOne(
      { doctor: d.user, receptionist: receptionist._id },
      { $setOnInsert: { status: 'pending', permissions: ['view'], requestedAt: new Date() } },
      { upsert: true },
    );
    if (res.upsertedCount) newlyAsked.push(d.user);
  }
  await notify(newlyAsked, {
    type: 'access.requested',
    title: 'Receptionist Access Request',
    body: `${receptionist.name || `+91 ${mobile}`} asked to manage your appointments`,
  });
  await audit({
    actor: receptionist,
    action: 'receptionist_access.requested',
    module: 'receptionist_access',
    entityType: 'User',
    entityId: receptionist._id,
    after: { routedTo: doctors.length },
    req,
  });
  return { status: 'pending', routedTo: doctors.length };
}

export async function doctorsForReceptionist(receptionistId) {
  const grants = await ReceptionistAccess.find({ receptionist: receptionistId, status: 'active' })
    .populate('doctor', 'name photoUrl status')
    .lean();
  const live = grants.filter((g) => g.doctor && g.doctor.status === 'active');
  const profiles = await DoctorProfile.find({ user: { $in: live.map((g) => g.doctor._id) } })
    .select('user specialty code practice.clinicName practice.city availability')
    .lean();
  const byUser = new Map(profiles.map((p) => [p.user.toString(), p]));
  return live.map((g) => {
    const p = byUser.get(g.doctor._id.toString());
    return {
      id: g.doctor._id.toString(),
      name: g.doctor.name,
      photoUrl: g.doctor.photoUrl,
      code: p?.code,
      specialty: p?.specialty,
      clinicName: p?.practice?.clinicName,
      city: p?.practice?.city,
      availability: p?.availability,
      permissions: g.permissions,
    };
  });
}
