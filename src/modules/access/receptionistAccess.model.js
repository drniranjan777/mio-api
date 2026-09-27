import mongoose from 'mongoose';

const { Schema } = mongoose;

export const PERMISSIONS = Object.freeze(['view', 'book', 'reschedule', 'cancel']);
export const GRANT_STATUS = Object.freeze(['pending', 'active', 'inactive']);

/** Doctor ↔ receptionist access. Many-to-many; permissions are per doctor. */
const receptionistAccessSchema = new Schema(
  {
    doctor: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    receptionist: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    status: { type: String, enum: GRANT_STATUS, required: true },
    permissions: { type: [{ type: String, enum: PERMISSIONS }], default: ['view'] },
    requestedAt: Date,
    grantedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    grantedAt: Date,
    revokedAt: Date,
  },
  { timestamps: true },
);

receptionistAccessSchema.index({ doctor: 1, receptionist: 1 }, { unique: true });
receptionistAccessSchema.index({ receptionist: 1, status: 1 });
receptionistAccessSchema.index({ doctor: 1, status: 1 });

export const ReceptionistAccess = mongoose.model('ReceptionistAccess', receptionistAccessSchema);
