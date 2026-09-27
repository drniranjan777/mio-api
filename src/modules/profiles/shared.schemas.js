import mongoose from 'mongoose';

const { Schema } = mongoose;

export const DAYS = Object.freeze(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']);
export const COMPANY_TYPES = Object.freeze(['all', 'mnc', 'startup']);

/** Clinic / hospital location block (Doctor & Receptionist registration). */
export const practiceSchema = new Schema(
  {
    type: { type: String, enum: ['hospital', 'clinic'] },
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
    feePaise: Number,
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
