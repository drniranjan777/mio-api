import mongoose from 'mongoose';

export const ROLES = Object.freeze(['admin', 'doctor', 'mr', 'receptionist']);
export const APP_ROLES = Object.freeze(['doctor', 'mr', 'receptionist']);
export const USER_STATUS = Object.freeze(['active', 'inactive', 'deleted']);

const userSchema = new mongoose.Schema(
  {
    role: { type: String, enum: ROLES, required: true },
    name: { type: String, trim: true, maxlength: 120, default: '' },
    mobile: { type: String, trim: true },
    email: { type: String, trim: true, lowercase: true },
    passwordHash: { type: String, select: false },
    photoUrl: { type: String },
    status: { type: String, enum: USER_STATUS, default: 'active' },
    /** Bumped to invalidate every issued access token (logout-all, deactivate, delete). */
    tokenVersion: { type: Number, default: 0 },
    onboarding: {
      profile: { type: Boolean, default: false },
      final: { type: Boolean, default: false },
    },
    /** Admin panel only: role with module permissions (none = original owner = Super Admin). */
    adminRole: { type: mongoose.Schema.Types.ObjectId, ref: 'AdminRole' },
    /** Admin panel only: set for new staff / after a reset, cleared on password change. */
    mustChangePassword: { type: Boolean, default: false },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    /** App preferences (bottom sheet "App Settings"). */
    settings: {
      notifications: { type: Boolean, default: true },
      language: { type: String, enum: ['en', 'hi', 'te'], default: 'en' },
    },
    lastLoginAt: Date,
    deletedAt: Date,
    deletionReason: String,
  },
  { timestamps: true },
);

// Deleted accounts have mobile/email unset, so the number can register again.
userSchema.index({ mobile: 1 }, { unique: true, partialFilterExpression: { mobile: { $type: 'string' } } });
userSchema.index({ email: 1 }, { unique: true, partialFilterExpression: { email: { $type: 'string' } } });
userSchema.index({ role: 1, status: 1, createdAt: -1 });

userSchema.methods.toPublic = function toPublic() {
  return {
    id: this._id.toString(),
    role: this.role,
    name: this.name,
    mobile: this.mobile,
    email: this.email,
    photoUrl: this.photoUrl,
    status: this.status,
    onboarding: { profile: this.onboarding?.profile ?? false, final: this.onboarding?.final ?? false },
    settings: { notifications: this.settings?.notifications ?? true, language: this.settings?.language ?? 'en' },
    ...(this.role === 'admin' && { mustChangePassword: Boolean(this.mustChangePassword) }),
    createdAt: this.createdAt,
  };
};

export const User = mongoose.model('User', userSchema);
