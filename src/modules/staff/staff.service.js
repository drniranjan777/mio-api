import crypto from 'node:crypto';

import bcrypt from 'bcryptjs';

import { ApiError } from '../../utils/ApiError.js';
import { audit } from '../audit/audit.js';
import { revokeAllSessions } from '../auth/token.service.js';
import { User } from '../users/user.model.js';
import { adminAccessFor, ensureSystemRoles } from './adminAccess.js';
import { AdminRole } from './adminRole.model.js';

/** 16 URL-safe characters; shown once to the creator, never stored in plain text. */
const temporaryPassword = () => crypto.randomBytes(12).toString('base64url');

const presentRole = (r, members = 0) => ({
  id: r._id.toString(),
  name: r.name,
  description: r.description ?? '',
  permissions: r.permissions,
  isSuper: r.isSuper,
  isSystem: r.isSystem,
  members,
});

async function presentStaff(u, actorId) {
  const access = await adminAccessFor(u);
  return {
    id: u._id.toString(),
    name: u.name,
    email: u.email,
    status: u.status,
    role: { id: u.adminRole?.toString() ?? null, name: access.roleName ?? 'No role', isSuper: access.isSuper },
    permissions: access.permissions,
    mustChangePassword: Boolean(u.mustChangePassword),
    lastLoginAt: u.lastLoginAt ?? null,
    createdAt: u.createdAt,
    isSelf: u._id.toString() === actorId,
  };
}

// ---- Roles ------------------------------------------------------------------------

export async function listRoles() {
  await ensureSystemRoles();
  const [roles, counts] = await Promise.all([
    AdminRole.find().sort({ isSuper: -1, name: 1 }).lean(),
    User.aggregate([{ $match: { role: 'admin', status: { $ne: 'deleted' } } }, { $group: { _id: '$adminRole', n: { $sum: 1 } } }]),
  ]);
  const byRole = new Map(counts.map((c) => [String(c._id), c.n]));
  const superRole = roles.find((r) => r.isSuper);
  // Admins without a role are Super Admins.
  return roles.map((r) => presentRole(r, (byRole.get(r._id.toString()) ?? 0) + (r === superRole ? byRole.get('null') ?? 0 : 0)));
}

async function uniqueName(name, exceptId) {
  const clash = await AdminRole.findOne({ name })
    .collation({ locale: 'en', strength: 2 })
    .lean();
  if (clash && clash._id.toString() !== exceptId) throw ApiError.conflict('A role with this name already exists', 'ROLE_EXISTS');
}

export async function createRole(actor, body, req) {
  await uniqueName(body.name);
  const role = await AdminRole.create({ ...body, isSuper: false, isSystem: false, createdBy: actor._id });
  await audit({ actor, action: 'admin_role.created', module: 'staff', entityType: 'AdminRole', entityId: role._id, after: body, req });
  return presentRole(role);
}

export async function updateRole(actor, id, body, req) {
  const role = await AdminRole.findById(id);
  if (!role) throw ApiError.notFound('Role not found', 'ROLE_NOT_FOUND');
  if (role.isSystem) throw ApiError.unprocessable('Built-in roles cannot be changed', 'ROLE_SYSTEM');
  if (body.name) await uniqueName(body.name, id);
  const before = { name: role.name, permissions: [...role.permissions] };
  role.set(body);
  await role.save();
  await audit({ actor, action: 'admin_role.updated', module: 'staff', entityType: 'AdminRole', entityId: role._id, before, after: body, req });
  return presentRole(role);
}

export async function deleteRole(actor, id, req) {
  const role = await AdminRole.findById(id);
  if (!role) throw ApiError.notFound('Role not found', 'ROLE_NOT_FOUND');
  if (role.isSystem) throw ApiError.unprocessable('Built-in roles cannot be deleted', 'ROLE_SYSTEM');
  const members = await User.countDocuments({ role: 'admin', adminRole: role._id, status: { $ne: 'deleted' } });
  if (members) throw ApiError.conflict(`${members} team member(s) still have this role. Move them first.`, 'ROLE_IN_USE');
  await role.deleteOne();
  await audit({ actor, action: 'admin_role.deleted', module: 'staff', entityType: 'AdminRole', entityId: role._id, before: { name: role.name }, req });
}

// ---- Staff -----------------------------------------------------------------------------

export async function listStaff(actor) {
  const users = await User.find({ role: 'admin', status: { $ne: 'deleted' } }).sort({ createdAt: 1 }).lean();
  return Promise.all(users.map((u) => presentStaff(u, actor.id)));
}

async function loadRole(roleId) {
  const role = await AdminRole.findById(roleId).lean();
  if (!role) throw ApiError.badRequest('Choose a valid role', [{ path: 'roleId', message: 'Unknown role' }], 'VALIDATION_ERROR');
  return role;
}

/** At least one active Super Admin must always remain. */
async function assertKeepsASuperAdmin(excludeUserId) {
  const superRoles = await AdminRole.find({ isSuper: true }).distinct('_id');
  const others = await User.countDocuments({
    _id: { $ne: excludeUserId },
    role: 'admin',
    status: 'active',
    $or: [{ adminRole: null }, { adminRole: { $in: superRoles } }],
  });
  if (!others) throw ApiError.unprocessable('At least one active Super Admin is required', 'LAST_SUPER_ADMIN');
}

export async function createStaff(actor, { name, email, roleId }, req) {
  await ensureSystemRoles();
  const role = await loadRole(roleId);
  if (await User.exists({ email })) throw ApiError.conflict('This email is already in use', 'EMAIL_IN_USE');
  const password = temporaryPassword();
  const user = await User.create({
    role: 'admin',
    name,
    email,
    passwordHash: await bcrypt.hash(password, 12),
    adminRole: role._id,
    mustChangePassword: true,
    createdBy: actor._id,
  });
  await audit({ actor, action: 'staff.created', module: 'staff', entityType: 'User', entityId: user._id, after: { email, role: role.name }, req });
  return { staff: await presentStaff(user.toObject(), actor.id), temporaryPassword: password };
}

export async function updateStaff(actor, id, { name, roleId, status }, req) {
  const user = await User.findOne({ _id: id, role: 'admin', status: { $ne: 'deleted' } });
  if (!user) throw ApiError.notFound('Team member not found', 'STAFF_NOT_FOUND');
  const self = user._id.equals(actor._id);
  if (self && (roleId || status)) throw ApiError.unprocessable('You cannot change your own role or status', 'STAFF_SELF');

  const before = { name: user.name, role: user.adminRole?.toString() ?? null, status: user.status };
  if (roleId) {
    const role = await loadRole(roleId);
    if (!role.isSuper && (await adminAccessFor(user)).isSuper) await assertKeepsASuperAdmin(user._id);
    user.adminRole = role._id;
  }
  if (status && status !== user.status) {
    if (status === 'inactive' && (await adminAccessFor(user)).isSuper) await assertKeepsASuperAdmin(user._id);
    user.status = status;
  }
  if (name) user.name = name;
  await user.save();
  if (status === 'inactive') await revokeAllSessions(user._id);
  await audit({ actor, action: 'staff.updated', module: 'staff', entityType: 'User', entityId: user._id, before, after: { name: user.name, role: user.adminRole?.toString(), status: user.status }, req });
  return presentStaff(user.toObject(), actor.id);
}

export async function resetStaffPassword(actor, id, req) {
  const user = await User.findOne({ _id: id, role: 'admin', status: { $ne: 'deleted' } });
  if (!user) throw ApiError.notFound('Team member not found', 'STAFF_NOT_FOUND');
  if (user._id.equals(actor._id)) throw ApiError.unprocessable('Use "Change password" for your own account', 'STAFF_SELF');
  const password = temporaryPassword();
  user.passwordHash = await bcrypt.hash(password, 12);
  user.mustChangePassword = true;
  await user.save();
  await revokeAllSessions(user._id);
  await audit({ actor, action: 'staff.password_reset', module: 'staff', entityType: 'User', entityId: user._id, req });
  return { staff: await presentStaff(user.toObject(), actor.id), temporaryPassword: password };
}
