import mongoose from 'mongoose';

const { Schema } = mongoose;

export const CONFERENCE_STATUS = Object.freeze(['draft', 'published', 'cancelled']);
export const PARTICIPATION = Object.freeze(['planning', 'registered', 'more_info']);

const conferenceSchema = new Schema(
  {
    title: { type: String, required: true, trim: true, maxlength: 160 },
    organizer: { type: String, trim: true, maxlength: 160 },
    /** Local calendar dates, "YYYY-MM-DD". */
    startDate: { type: String, required: true },
    endDate: { type: String, required: true },
    venue: { type: String, trim: true, maxlength: 200 },
    city: { type: String, trim: true, maxlength: 80 },
    specialty: { type: String, trim: true, maxlength: 80 },
    logoUrl: { type: String, trim: true, maxlength: 500 },
    website: { type: String, trim: true, maxlength: 500 },
    description: { type: String, trim: true, maxlength: 2000 },
    status: { type: String, enum: CONFERENCE_STATUS, default: 'published' },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);
conferenceSchema.index({ status: 1, endDate: 1, startDate: 1 });
conferenceSchema.index({ specialty: 1 });

/** A doctor's own plan for a conference (one row per doctor per conference). */
const participationSchema = new Schema(
  {
    conference: { type: Schema.Types.ObjectId, ref: 'Conference', required: true },
    doctor: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    status: { type: String, enum: PARTICIPATION, required: true },
  },
  { timestamps: true },
);
participationSchema.index({ conference: 1, doctor: 1 }, { unique: true });
participationSchema.index({ doctor: 1, status: 1 });

export const Conference = mongoose.model('Conference', conferenceSchema);
export const ConferenceParticipation = mongoose.model('ConferenceParticipation', participationSchema);
