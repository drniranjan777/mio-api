import { z } from 'zod';

import { day, hhmm, mobile, text } from '../../utils/zod.js';

const req = (max = 120) => z.string().trim().min(1, 'Required').max(max);
/** Optional free text: an empty string becomes undefined, so cleared fields are not stored as "". */
const opt = (max = 120) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => (v === '' ? undefined : v))
    .optional();
const gender = z.enum(['male', 'female', 'other']);
const age = z.coerce.number().int().min(18).max(100);
const dm = z.string().trim().regex(/^\d{2}\/\d{2}(\/\d{4})?$/, 'Use DD/MM or DD/MM/YYYY');
const optDm = z.union([dm, z.literal('').transform(() => undefined)]).optional();
const optMobile = z.union([mobile, z.literal('').transform(() => undefined)]).optional();
const email = z.string().trim().toLowerCase().email();
const pincode = z.string().trim().regex(/^\d{6}$/, 'Enter a 6-digit pin code');
const url = z.string().trim().url().max(500);
const companyType = z.enum(['all', 'mnc', 'startup']);
const otp = z.string().regex(/^\d{4}$/, 'Enter the 4 digit PIN');

/** Practicing place: hospital, clinic or both (UI change list, 11 Oct 2026). */
export const PLACE_TYPES = Object.freeze(['hospital', 'clinic', 'both']);

const social = z
  .object({
    linkedin: url.optional(),
    youtube: url.optional(),
    whatsapp: mobile.optional(),
    facebook: url.optional(),
    instagram: url.optional(),
  })
  .partial();

const timeWindow = z
  .object({ days: z.array(day).min(1, 'Select at least one day'), from: hhmm, to: hhmm })
  .refine((v) => v.from < v.to, { message: 'From time must be before To time', path: ['to'] });

// ---- Doctor ------------------------------------------------------------------

export const doctorProfileBody = z.object({
  name: req(),
  qualification: req(),
  gender,
  age,
  dateOfBirth: optDm,
  dateOfMarriage: optDm,
  maritalStatus: req(40),
  specialty: req(),
  subSpecialty: opt(120),
  email,
  religion: req(40),
  councilRegNo: req(60),
  hprId: opt(60),
  practice: z.object({
    type: z.enum(PLACE_TYPES),
    clinicName: req(),
    preferredPlace: req(),
    address: req(300),
    city: req(),
    state: req(),
    /** Shown under Personal Information in the app; stored here for compatibility. */
    hometown: req(),
    pincode,
    /** "Practicing Location Type": Metro / Non-Metro. */
    locationType: req(40),
    /** "Clinic / Hospital Location Category": Within City / City Outskirts / Outside City Limits. */
    territoryClass: req(40),
    gpsLink: url.optional(),
  }),
});

export const doctorFinalBody = z.object({
  mrCall: timeWindow.and(
    z.object({
      maxPerDay: z.coerce.number().int().min(1).max(100),
      companyTypes: z.array(companyType).min(1, 'Select at least one'),
    }),
  ),
  /** Every clinic contact is optional. */
  contacts: z
    .object({
      receptionistName: opt(),
      receptionistMobile: optMobile,
      pharmacyName: opt(),
      pharmacistName: opt(),
      pharmacistMobile: optMobile,
    })
    .default({}),
  referralMobile: mobile.optional(),
  consultation: z
    .object({
      days: z.array(day).optional(),
      from: hhmm.optional(),
      to: hhmm.optional(),
      feeRupees: z.coerce.number().min(0).max(100000).optional(),
      avgPatientsPerDay: z.coerce.number().int().min(1).max(100).optional(),
    })
    .optional(),
  social: social.optional(),
});

export const availabilityBody = z.object({ availability: z.enum(['auto', 'manual', 'unavailable']) });

// ---- MR ------------------------------------------------------------------------

/**
 * Specialty coverage is multi-select. Older app builds still send a single
 * `specialty` string, so both shapes are accepted; the list is stored as
 * `specialties` plus a joined `specialty` (used by reports and the admin panel).
 */
export const mrProfileBody = z
  .object({
    name: req(),
    qualification: req(),
    gender,
    age,
    dateOfBirth: dm,
    dateOfMarriage: optDm,
    maritalStatus: req(40),
    company: z.object({ name: req(), type: req(60), address: req(300) }),
    employerStatus: req(40),
    joiningDate: dm,
    /** Previous employer's last working date; freshers leave it empty. */
    lastWorkingDate: optDm,
    employeeCode: req(60),
    /** Personal email (replaces the official email of the first release). */
    email: email.optional(),
    officialEmail: email.optional(),
    specialties: z.array(req(80)).max(30).optional(),
    specialty: opt(),
    division: req(),
    hq: z.object({ name: req(), class: req(40), city: req(), district: req(), state: req(), zone: req(40) }),
    referralMobile: mobile,
    social: social.optional(),
  })
  .superRefine((b, ctx) => {
    if (!b.specialties?.length && !b.specialty) {
      ctx.addIssue({ code: 'custom', path: ['specialties'], message: 'Select at least one specialty' });
    }
    if (!b.email && !b.officialEmail) ctx.addIssue({ code: 'custom', path: ['email'], message: 'Required' });
  })
  .transform(({ specialties, specialty, ...rest }) => {
    const list = [...new Set((specialties?.length ? specialties : [specialty]).filter(Boolean))];
    return { ...rest, specialties: list, specialty: list.join(', ') };
  });

// ---- Receptionist ------------------------------------------------------------------

export const receptionistProfileBody = z.object({
  name: req(),
  qualification: req(),
  gender,
  age,
  dateOfBirth: dm,
  maritalStatus: req(40),
  email,
  religion: req(40),
  practice: z.object({
    type: z.enum(PLACE_TYPES),
    clinicName: req(),
    address: req(300),
    city: req(),
    state: req(),
    district: req(),
    zone: req(40),
    pincode,
  }),
});

export const receptionistFinalBody = z.object({
  territoryClass: req(40),
  gpsLink: url.optional(),
  pharmacyName: opt(),
  pharmacistName: opt(),
  pharmacistMobile: optMobile,
  mrCall: timeWindow.and(
    z.object({
      maxPerDay: z.coerce.number().int().min(1).max(100),
      companyTypes: z.array(companyType).min(1, 'Select at least one'),
    }),
  ),
  referralMobile: mobile.optional(),
  consultation: z
    .object({
      days: z.array(day).optional(),
      from: hhmm.optional(),
      to: hhmm.optional(),
      feeRupees: z.coerce.number().min(0).max(100000).optional(),
      avgPatientsPerDay: z.coerce.number().int().min(1).max(100).optional(),
    })
    .optional(),
});

export const updateMeBody = z.object({ name: text(120) }).strict();
export const settingsBody = z
  .object({ notifications: z.boolean(), language: z.enum(['en', 'hi', 'te']) })
  .partial()
  .strict()
  .refine((b) => Object.keys(b).length > 0, 'Nothing to update');

/** Deleting an account needs the PIN sent to the registered mobile (POST /me/delete/otp). */
export const deleteMeBody = z.object({ confirm: z.literal(true), reason: text(200), otp });
export const changeMobileOtpBody = z.object({ mobile }).strict();
export const changeMobileBody = z.object({ mobile, otp }).strict();
