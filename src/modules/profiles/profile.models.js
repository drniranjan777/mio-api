import mongoose from 'mongoose';

import { consultationSchema, mrCallSchema, personalFields, practiceSchema, socialSchema } from './shared.schemas.js';

const { Schema } = mongoose;
const ref = (model) => ({ type: Schema.Types.ObjectId, ref: model, required: true });

const doctorProfileSchema = new Schema(
  {
    user: { ...ref('User'), unique: true },
    code: { type: String, unique: true, required: true },
    ...personalFields,
    specialty: String,
    councilRegNo: String,
    hprId: String,
    practice: practiceSchema,
    mrCall: mrCallSchema,
    contacts: {
      receptionistName: String,
      receptionistMobile: String,
      pharmacyName: String,
      pharmacistName: String,
      pharmacistMobile: String,
    },
    consultation: consultationSchema,
    referralMobile: String,
    social: socialSchema,
    /** auto: MR bookings auto-approved · manual: need approval · unavailable: no new bookings. */
    availability: { type: String, enum: ['auto', 'manual', 'unavailable'], default: 'manual' },
  },
  { timestamps: true },
);
doctorProfileSchema.index({ specialty: 1 });
doctorProfileSchema.index({ 'practice.city': 1 });
doctorProfileSchema.index({ 'contacts.receptionistMobile': 1 });

const mrProfileSchema = new Schema(
  {
    user: { ...ref('User'), unique: true },
    code: { type: String, unique: true, required: true },
    ...personalFields,
    company: { name: String, type: { type: String }, address: String },
    employerStatus: String,
    lastWorkingDate: String,
    employeeCode: String,
    officialEmail: { type: String, lowercase: true, trim: true },
    joiningDate: String,
    specialty: String,
    division: String,
    hq: { name: String, class: String, city: String, district: String, state: String, zone: String },
    referralMobile: String,
    social: socialSchema,
  },
  { timestamps: true },
);

const receptionistProfileSchema = new Schema(
  {
    user: { ...ref('User'), unique: true },
    code: { type: String, unique: true, required: true },
    ...personalFields,
    practice: practiceSchema,
    final: {
      territoryClass: String,
      gpsLink: String,
      pharmacyName: String,
      pharmacistName: String,
      pharmacistMobile: String,
      mrCall: mrCallSchema,
      referralMobile: String,
      consultation: consultationSchema,
    },
  },
  { timestamps: true },
);

export const DoctorProfile = mongoose.model('DoctorProfile', doctorProfileSchema);
export const MrProfile = mongoose.model('MrProfile', mrProfileSchema);
export const ReceptionistProfile = mongoose.model('ReceptionistProfile', receptionistProfileSchema);

export const profileModelFor = (role) =>
  ({ doctor: DoctorProfile, mr: MrProfile, receptionist: ReceptionistProfile })[role];
