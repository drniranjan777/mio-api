import mongoose from 'mongoose';

const { Schema } = mongoose;

export const RECOVERY_STATUS = Object.freeze(['pending', 'approved', 'rejected']);

/**
 * "I changed my mobile number" request from a user who can no longer receive
 * the PIN on the old number. The new number is proven by OTP; the identity is
 * checked by an admin before the number is switched.
 */
const recoveryRequestSchema = new Schema(
  {
    role: { type: String, enum: ['doctor', 'mr', 'receptionist'], required: true },
    oldMobile: { type: String, required: true },
    newMobile: { type: String, required: true },
    /** Mio code the user typed (DR00001 / MR00001 / RC00001). */
    code: { type: String, trim: true, uppercase: true, maxlength: 20 },
    name: { type: String, trim: true, maxlength: 120 },
    note: { type: String, trim: true, maxlength: 300 },
    /** Account found for oldMobile + role (null when nothing matched). */
    user: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    /** The typed code belongs to that account — a strong hint for the reviewer. */
    codeMatches: { type: Boolean, default: false },
    status: { type: String, enum: RECOVERY_STATUS, default: 'pending' },
    reviewedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    reviewedAt: Date,
    adminNote: { type: String, trim: true, maxlength: 300 },
    ip: String,
  },
  { timestamps: true },
);
recoveryRequestSchema.index({ status: 1, createdAt: -1 });
recoveryRequestSchema.index({ user: 1, status: 1 });
recoveryRequestSchema.index({ newMobile: 1, status: 1 });

export const RecoveryRequest = mongoose.model('RecoveryRequest', recoveryRequestSchema);
