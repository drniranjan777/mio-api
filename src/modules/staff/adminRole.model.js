import mongoose from 'mongoose';

const { Schema } = mongoose;

/**
 * Admin-panel modules a role can be given. Managing staff and roles is not in
 * this list on purpose: only Super Admins can do that, so nobody can grant
 * themselves more access.
 */
export const ADMIN_PERMISSIONS = Object.freeze([
  'dashboard',
  'users',
  'access',
  'appointments',
  'conferences',
  'banners',
  'billing',
  'tickets',
  'faqs',
  'content',
  'settings',
  'reports',
  'audit',
]);

const adminRoleSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 60 },
    description: { type: String, trim: true, maxlength: 200 },
    permissions: [{ type: String, enum: ADMIN_PERMISSIONS }],
    /** Super Admin: every permission + staff & role management. */
    isSuper: { type: Boolean, default: false },
    /** Built-in roles cannot be edited or deleted. */
    isSystem: { type: Boolean, default: false },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);
adminRoleSchema.index({ name: 1 }, { unique: true, collation: { locale: 'en', strength: 2 } });

export const AdminRole = mongoose.model('AdminRole', adminRoleSchema);

export const SUPER_ADMIN_ROLE = 'Super Admin';

/** Starter roles created once, editable afterwards. */
export const TEMPLATE_ROLES = [
  { name: 'Support', description: 'Help desk, FAQs and policies', permissions: ['dashboard', 'tickets', 'faqs', 'content'] },
  { name: 'Operations', description: 'Users, access, appointments and conferences', permissions: ['dashboard', 'users', 'access', 'appointments', 'conferences', 'banners', 'reports'] },
  { name: 'Finance', description: 'Plans, payments and reports', permissions: ['dashboard', 'billing', 'reports'] },
];
