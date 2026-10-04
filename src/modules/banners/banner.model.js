import mongoose from 'mongoose';

const { Schema } = mongoose;

/** What the admin chose; `all` = every doctor, the rest use `locations`. */
export const TARGETING = Object.freeze(['all', 'state', 'city', 'multiple']);
export const BANNER_STATUS = Object.freeze(['draft', 'active', 'inactive']);
export const REDIRECT_TYPES = Object.freeze(['none', 'internal', 'external']);

/**
 * App screens a banner may open. Keys are stable identifiers; the app maps
 * each to its own route, and ignores keys it does not know (older app builds).
 */
export const INTERNAL_TARGETS = Object.freeze([
  { key: 'conferences', label: 'Conference Participation Plan' },
  { key: 'birthday_wishes', label: 'Birthday Wishes' },
  { key: 'appointments', label: 'Appointments' },
  { key: 'reports', label: 'Reports' },
  { key: 'notifications', label: 'Notifications' },
  { key: 'subscription', label: 'Subscription Plan' },
  { key: 'receptionist_access', label: 'Receptionist Access' },
  { key: 'profile', label: 'My Profile' },
  { key: 'help_desk', label: 'Help Desk' },
  { key: 'faqs', label: 'FAQs' },
  { key: 'terms', label: 'Terms & Policies' },
]);

/**
 * Promotional / informational banner on the doctor home screen.
 *
 * Visibility = status "active" + inside the schedule + location match.
 * "Scheduled" (starts later) and "Expired" (ended) are derived from the dates,
 * not stored, so they can never drift out of sync with the clock.
 *
 * `locations` holds Location ids (states and/or cities): the MongoDB form of a
 * banner_locations join table — one multikey index, one query per request.
 */
const bannerSchema = new Schema(
  {
    title: { type: String, required: true, trim: true, maxlength: 120 },
    description: { type: String, trim: true, maxlength: 300 },
    imageKey: { type: String, required: true },
    mobileImageKey: { type: String },
    /** Overlay the title/description on the image (for plain artwork without text). */
    showText: { type: Boolean, default: false },
    redirectType: { type: String, enum: REDIRECT_TYPES, default: 'none' },
    /** internal → INTERNAL_TARGETS key · external → https URL. */
    redirectTarget: { type: String, trim: true, maxlength: 500 },
    targeting: { type: String, enum: TARGETING, required: true },
    locations: [{ type: Schema.Types.ObjectId, ref: 'Location' }],
    status: { type: String, enum: BANNER_STATUS, default: 'draft' },
    /** Inclusive local-day window; null = open-ended. */
    startAt: { type: Date, default: null },
    endAt: { type: Date, default: null },
    /** 1 = highest. */
    priority: { type: Number, default: 10, min: 1, max: 999 },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);

bannerSchema.index({ status: 1, startAt: 1, endAt: 1 });
bannerSchema.index({ locations: 1 });
bannerSchema.index({ targeting: 1, status: 1 });
bannerSchema.index({ priority: 1, createdAt: -1 });

export const Banner = mongoose.model('Banner', bannerSchema);
