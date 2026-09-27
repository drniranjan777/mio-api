import mongoose from 'mongoose';

const { Schema } = mongoose;

const otpSchema = new Schema(
  {
    mobile: { type: String, required: true },
    purpose: { type: String, required: true }, // e.g. "login:doctor"
    codeHash: { type: String, required: true },
    attempts: { type: Number, default: 0 },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true },
);
otpSchema.index({ mobile: 1, purpose: 1, createdAt: -1 });
otpSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const refreshTokenSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    tokenHash: { type: String, required: true, unique: true },
    /** All tokens rotated from one login share a family; reuse revokes the family. */
    family: { type: String, required: true },
    expiresAt: { type: Date, required: true },
    revokedAt: Date,
    replacedBy: String,
    userAgent: String,
    ip: String,
  },
  { timestamps: true },
);
refreshTokenSchema.index({ user: 1, revokedAt: 1 });
refreshTokenSchema.index({ family: 1 });
refreshTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const OtpCode = mongoose.model('OtpCode', otpSchema);
export const RefreshToken = mongoose.model('RefreshToken', refreshTokenSchema);
