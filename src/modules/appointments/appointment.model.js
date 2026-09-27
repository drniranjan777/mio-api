import mongoose from 'mongoose';

const { Schema } = mongoose;

export const APPOINTMENT_STATUS = Object.freeze(['pending', 'approved', 'cancelled', 'completed']);
export const ACTIVE_STATUSES = Object.freeze(['pending', 'approved']);

const actorSchema = new Schema(
  { user: { type: Schema.Types.ObjectId, ref: 'User' }, role: String },
  { _id: false },
);

const appointmentSchema = new Schema(
  {
    doctor: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    mr: { type: Schema.Types.ObjectId, ref: 'User' },
    /** MR details as captured at booking (always present, also for walk-ins booked by staff). */
    visitor: {
      name: { type: String, required: true, trim: true },
      company: { type: String, trim: true },
      division: { type: String, trim: true },
    },
    startAt: { type: Date, required: true },
    endAt: { type: Date, required: true },
    status: { type: String, enum: APPOINTMENT_STATUS, required: true },
    purpose: { type: String, trim: true, maxlength: 200 },
    note: { type: String, trim: true, maxlength: 500 },
    createdBy: actorSchema,
    cancel: {
      by: { type: Schema.Types.ObjectId, ref: 'User' },
      role: String,
      reason: String,
      at: Date,
    },
    history: [
      {
        _id: false,
        action: String,
        by: { type: Schema.Types.ObjectId, ref: 'User' },
        role: String,
        at: { type: Date, default: Date.now },
        from: Schema.Types.Mixed,
        to: Schema.Types.Mixed,
      },
    ],
  },
  { timestamps: true },
);

appointmentSchema.index({ doctor: 1, startAt: 1 });
appointmentSchema.index({ mr: 1, startAt: 1 });
appointmentSchema.index({ status: 1, startAt: 1 });
// One active booking per doctor per slot — race-safe double-booking guard.
appointmentSchema.index(
  { doctor: 1, startAt: 1 },
  { unique: true, name: 'uniq_active_slot', partialFilterExpression: { status: { $in: ['pending', 'approved'] } } },
);

export const Appointment = mongoose.model('Appointment', appointmentSchema);
