import mongoose from 'mongoose';

const { Schema } = mongoose;

export const DAYS = Object.freeze(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']);
export const COMPANY_TYPES = Object.freeze(['all', 'mnc', 'startup']);

/**
 * "New Patient Consultation Fee" ranges (App Corrections, 18 Oct 2026):
 * Upto ₹100 · ₹101–500 · ₹501–1000 · ₹1001–2000 · ₹2001–3000 · ₹3001–4000 ·
 * ₹4001–5000 · ₹5001–10000 · More than ₹10,000. Labels live in the app and panel.
 */
export const FEE_RANGES = Object.freeze(['upto-100', '101-500', '501-1000', '1001-2000', '2001-3000', '3001-4000', '4001-5000', '5001-10000', 'above-10000']);

/** Clinic / hospital location block (Doctor & Receptionist registration). */
export const practiceSchema = new Schema(
  {
    type: { type: String, enum: ['hospital', 'clinic', 'both'] },
    clinicName: String,
    preferredPlace: String,
    address: String,
    city: String,
    state: String,
    district: String,
    zone: String,
    pincode: String,
    hometown: String,
    locationType: String,
    territoryClass: String,
    gpsLink: String,
  },
  { _id: false },
);

/** "MR Call Available on Each (Month) in Selected" block. */
export const mrCallSchema = new Schema(
  {
    days: [{ type: String, enum: DAYS }],
    from: String, // "HH:mm" local time
    to: String,
    slotMinutes: { type: Number, default: 15 },
    maxPerDay: Number,
    companyTypes: [{ type: String, enum: COMPANY_TYPES }],
  },
  { _id: false },
);

export const consultationSchema = new Schema(
  {
    days: [{ type: String, enum: DAYS }],
    from: String,
    to: String,
    /** Exact fee from app builds before 1.0.4; newer builds send `feeRange`. */
    feePaise: Number,
    feeRange: { type: String, enum: FEE_RANGES },
    avgPatientsPerDay: Number,
  },
  { _id: false },
);

export const socialSchema = new Schema(
  { linkedin: String, youtube: String, whatsapp: String, facebook: String, instagram: String },
  { _id: false },
);

export const personalFields = {
  qualification: String,
  gender: { type: String, enum: ['male', 'female', 'other'] },
  age: Number,
  dateOfBirth: String, // "DD/MM" or "DD/MM/YYYY" as captured by the form
  dateOfMarriage: String,
  maritalStatus: String,
  religion: String,
  email: { type: String, lowercase: true, trim: true },
};
