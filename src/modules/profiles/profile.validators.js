import { z } from 'zod';

import { day, hhmm, mobile, text } from '../../utils/zod.js';

const req = (max = 120) => z.string().trim().min(1, 'Required').max(max);
const gender = z.enum(['male', 'female', 'other']);
const age = z.coerce.number().int().min(18).max(100);
const dm = z.string().trim().regex(/^\d{2}\/\d{2}(\/\d{4})?$/, 'Use DD/MM or DD/MM/YYYY');
const email = z.string().trim().toLowerCase().email();
const pincode = z.string().trim().regex(/^\d{6}$/, 'Enter a 6-digit pin code');
const url = z.string().trim().url().max(500);
const companyType = z.enum(['all', 'mnc', 'startup']);

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
  dateOfBirth: dm,
  dateOfMarriage: dm.optional(),
  maritalStatus: req(40),
  specialty: req(),
  email,
  religion: req(40),
  councilRegNo: req(60),
  hprId: req(60),
  practice: z.object({
    type: z.enum(['hospital', 'clinic']),
    clinicName: req(),
    preferredPlace: req(),
    address: req(300),
    city: req(),
    state: req(),
    hometown: req(),
    pincode,
    locationType: req(40),
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
  contacts: z.object({
    receptionistName: req(),
    receptionistMobile: mobile,
    pharmacyName: req(),
    pharmacistName: req(),
    pharmacistMobile: mobile,
  }),
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

export const mrProfileBody = z.object({
  name: req(),
  qualification: req(),
  gender,
  age,
  dateOfBirth: dm,
  dateOfMarriage: dm.optional(),
  maritalStatus: req(40),
  company: z.object({ name: req(), type: req(60), address: req(300) }),
  employerStatus: req(40),
  lastWorkingDate: dm.optional(),
  employeeCode: req(60),
  officialEmail: email,
  joiningDate: dm,
  specialty: req(),
  division: req(),
  hq: z.object({ name: req(), class: req(40), city: req(), district: req(), state: req(), zone: req(40) }),
  referralMobile: mobile,
  social: social.optional(),
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
    type: z.enum(['hospital', 'clinic']),
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
  pharmacyName: req(),
  pharmacistName: req(),
  pharmacistMobile: mobile,
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
export const deleteMeBody = z.object({ confirm: z.literal(true), reason: text(200) });
