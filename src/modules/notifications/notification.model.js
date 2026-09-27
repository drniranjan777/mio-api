import mongoose from 'mongoose';

const { Schema } = mongoose;

export const NOTIFICATION_TYPES = Object.freeze([
  'appointment.requested',
  'appointment.booked',
  'appointment.approved',
  'appointment.rejected',
  'appointment.cancelled',
  'appointment.rescheduled',
  'appointment.completed',
  'wish.received',
  'conference.new',
  'access.granted',
  'access.requested',
  'subscription.activated',
  'ticket.updated',
]);

const notificationSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    type: { type: String, enum: NOTIFICATION_TYPES, required: true },
    title: { type: String, required: true, maxlength: 140 },
    body: { type: String, maxlength: 300 },
    /** Deep-link targets for the app (ids only, never personal data). */
    data: {
      appointmentId: String,
      conferenceId: String,
      doctorId: String,
      wishId: String,
      ticketId: String,
    },
    readAt: Date,
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);
notificationSchema.index({ user: 1, createdAt: -1 });
notificationSchema.index({ user: 1, readAt: 1 });
// Kept for 90 days.
notificationSchema.index({ createdAt: 1 }, { expireAfterSeconds: 90 * 24 * 3600 });

export const Notification = mongoose.model('Notification', notificationSchema);
