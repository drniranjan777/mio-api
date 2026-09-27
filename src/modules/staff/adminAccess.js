import { ApiError } from '../../utils/ApiError.js';
import { ADMIN_PERMISSIONS, AdminRole, SUPER_ADMIN_ROLE, TEMPLATE_ROLES } from './adminRole.model.js';

const FULL = Object.freeze({ isSuper: true, roleName: SUPER_ADMIN_ROLE, permissions: [...ADMIN_PERMISSIONS] });
const NONE = Object.freeze({ isSuper: false, roleName: null, permissions: [] });

/**
 * What an admin-panel user may do, read from the database on every request.
 * An admin without a role is the original seeded owner account → Super Admin.
 */
export async function adminAccessFor(user) {
  if (user?.role !== 'admin') return NONE;
  if (!user.adminRole) return FULL;
  const role = await AdminRole.findById(user.adminRole).lean();
  if (!role) return NONE; // role removed → no access until reassigned
  if (role.isSuper) return { ...FULL, roleName: role.name };
  return { isSuper: false, roleName: role.name, permissions: role.permissions };
}

async function load(req) {
  req.adminAccess ??= await adminAccessFor(req.user);
  return req.adminAccess;
}

function assertPasswordChanged(user) {
  if (user.mustChangePassword) {
    throw ApiError.forbidden('Please set a new password before continuing', 'PASSWORD_CHANGE_REQUIRED');
  }
}

/**
 * Admin permission gate. App users (doctor/MR/receptionist) pass straight
 * through — their access is governed by the route's own role checks.
 */
export const adminCan = (permission) => async (req, _res, next) => {
  try {
    if (req.user?.role !== 'admin') return next();
    assertPasswordChanged(req.user);
    const access = await load(req);
    if (!access.permissions.includes(permission)) {
      throw ApiError.forbidden('Your admin role does not include this section', 'ADMIN_PERMISSION_DENIED');
    }
    return next();
  } catch (err) {
    return next(err);
  }
};

export const requireSuperAdmin = async (req, _res, next) => {
  try {
    if (req.user?.role !== 'admin') throw ApiError.forbidden();
    assertPasswordChanged(req.user);
    if (!(await load(req)).isSuper) throw ApiError.forbidden('Only a Super Admin can manage the admin team', 'SUPER_ADMIN_ONLY');
    return next();
  } catch (err) {
    return next(err);
  }
};

/** Built-in Super Admin role + starter roles (idempotent). */
export async function ensureSystemRoles() {
  const superRole = await AdminRole.findOneAndUpdate(
    { isSuper: true, isSystem: true },
    { $setOnInsert: { name: SUPER_ADMIN_ROLE, description: 'Full access, including the admin team', permissions: [...ADMIN_PERMISSIONS], isSuper: true, isSystem: true } },
    { upsert: true, new: true },
  );
  if ((await AdminRole.countDocuments()) === 1) {
    await AdminRole.insertMany(TEMPLATE_ROLES, { ordered: false }).catch(() => {});
  }
  return superRole;
}
