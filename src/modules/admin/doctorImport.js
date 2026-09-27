import { z } from 'zod';

import { ApiError } from '../../utils/ApiError.js';
import { parseCsv } from '../../utils/csv.js';
import { mobile as mobileSchema } from '../../utils/zod.js';
import { audit } from '../audit/audit.js';
import { DoctorProfile } from '../profiles/profile.models.js';
import { DAYS } from '../profiles/shared.schemas.js';
import { nextCode } from '../users/counter.model.js';
import { User } from '../users/user.model.js';

export const MAX_IMPORT_ROWS = 1000;
const BOM = String.fromCharCode(0xfeff); // lets Excel open UTF-8 correctly

/** Template columns, in order. `*` in the label = required. */
export const DOCTOR_COLUMNS = [
  ['name', 'Full name incl. "Dr." *'],
  ['mobile', '10-digit mobile, used for OTP sign-in *'],
  ['specialty', 'e.g. Cardiology *'],
  ['city', 'Practice city *'],
  ['qualification', 'e.g. MBBS, MD'],
  ['gender', 'male / female / other'],
  ['date_of_birth', 'DD/MM or DD/MM/YYYY'],
  ['email', 'Personal email'],
  ['council_reg_no', 'Medical council reg. no'],
  ['practice_type', 'hospital / clinic'],
  ['clinic_name', 'Hospital or clinic name'],
  ['address', 'Street address'],
  ['state', 'State'],
  ['district', 'District'],
  ['pincode', '6-digit PIN'],
  ['availability', 'auto / manual / unavailable (default manual)'],
  ['mr_call_days', 'e.g. Mon|Tue|Wed|Thu|Fri|Sat'],
  ['mr_call_from', 'HH:mm, e.g. 10:00'],
  ['mr_call_to', 'HH:mm, e.g. 16:00'],
  ['max_mr_per_day', 'Number, e.g. 20'],
];

const DEMO_ROWS = [
  ['Dr. Anand Verma', '9000000201', 'Cardiology', 'Hyderabad', 'MBBS, MD', 'male', '14/03/1979', 'anand.verma@example.com', 'TSMC10231', 'hospital', 'Care Hospitals', 'Road No. 1, Banjara Hills', 'Telangana', 'Hyderabad', '500034', 'manual', 'Mon|Tue|Wed|Thu|Fri|Sat', '10:00', '16:00', '20'],
  ['Dr. Kavya Iyer', '9000000202', 'Dermatology', 'Bengaluru', 'MBBS, DDVL', 'female', '02/11', 'kavya.iyer@example.com', 'KMC55120', 'clinic', 'Skin & You Clinic', '12th Main, Indiranagar', 'Karnataka', 'Bengaluru Urban', '560038', 'auto', 'Mon|Wed|Fri', '11:00', '14:00', '10'],
  ['Dr. Farhan Siddiqui', '9000000203', 'Diabetology', 'Mumbai', 'MBBS, MD (Medicine)', 'male', '', '', '', 'clinic', 'Sugar Care Clinic', 'Linking Road, Bandra West', 'Maharashtra', 'Mumbai Suburban', '400050', '', '', '', '', ''],
];

const DAY_WORDS = { Mon: 'monday', Tue: 'tuesday', Wed: 'wednesday', Thu: 'thursday', Fri: 'friday', Sat: 'saturday', Sun: 'sunday' };

const optional = (max) => z.string().trim().max(max).optional().transform((v) => (v ? v : undefined));
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:mm (24h), e.g. 10:00');

const rowSchema = z
  .object({
    name: z.string().trim().min(2, 'Name is required').max(120),
    mobile: mobileSchema,
    specialty: z.string().trim().min(2, 'Specialty is required').max(80),
    city: z.string().trim().min(2, 'City is required').max(80),
    qualification: optional(120),
    gender: z
      .string()
      .trim()
      .toLowerCase()
      .optional()
      .transform((v) => v || undefined)
      .pipe(z.enum(['male', 'female', 'other'], { message: 'Use male, female or other' }).optional()),
    date_of_birth: z
      .string()
      .trim()
      .optional()
      .transform((v) => v || undefined)
      .pipe(z.string().regex(/^\d{2}\/\d{2}(\/\d{4})?$/, 'Use DD/MM or DD/MM/YYYY').optional()),
    email: z
      .string()
      .trim()
      .toLowerCase()
      .optional()
      .transform((v) => v || undefined)
      .pipe(z.string().email('Invalid email').max(160).optional()),
    council_reg_no: optional(40),
    practice_type: z
      .string()
      .trim()
      .toLowerCase()
      .optional()
      .transform((v) => v || undefined)
      .pipe(z.enum(['hospital', 'clinic'], { message: 'Use hospital or clinic' }).optional()),
    clinic_name: optional(160),
    address: optional(250),
    state: optional(60),
    district: optional(60),
    pincode: z
      .string()
      .trim()
      .optional()
      .transform((v) => v || undefined)
      .pipe(z.string().regex(/^\d{6}$/, 'PIN must be 6 digits').optional()),
    availability: z
      .string()
      .trim()
      .toLowerCase()
      .optional()
      .transform((v) => v || 'manual')
      .pipe(z.enum(['auto', 'manual', 'unavailable'], { message: 'Use auto, manual or unavailable' })),
    mr_call_days: z
      .string()
      .trim()
      .optional()
      .transform((v, ctx) => {
        if (!v) return undefined;
        // Accepts "Mon", "monday", "MON"; reports unknown words as written.
        const tokens = v.split(/[|;/ ]+/).filter(Boolean);
        const toDay = (t) => DAYS.find((d) => t.toLowerCase().startsWith(d.toLowerCase()) && DAY_WORDS[d].startsWith(t.toLowerCase()));
        const bad = tokens.filter((t) => !toDay(t));
        if (bad.length) ctx.addIssue({ code: 'custom', message: `Unknown day(s): ${bad.join(', ')}. Use Mon|Tue|Wed|Thu|Fri|Sat|Sun` });
        return [...new Set(tokens.map(toDay).filter(Boolean))];
      }),
    mr_call_from: z.string().trim().optional().transform((v) => v || undefined).pipe(hhmm.optional()),
    mr_call_to: z.string().trim().optional().transform((v) => v || undefined).pipe(hhmm.optional()),
    max_mr_per_day: z
      .string()
      .trim()
      .optional()
      .transform((v) => v || undefined)
      .pipe(z.coerce.number().int('Whole number').min(1).max(200).optional()),
  })
  .superRefine((r, ctx) => {
    const call = [r.mr_call_days, r.mr_call_from, r.mr_call_to];
    if (call.some(Boolean) && !call.every(Boolean)) {
      ctx.addIssue({ code: 'custom', path: ['mr_call_days'], message: 'Give MR call days, from and to together (or leave all three empty)' });
    }
    if (r.mr_call_from && r.mr_call_to && r.mr_call_from >= r.mr_call_to) {
      ctx.addIssue({ code: 'custom', path: ['mr_call_to'], message: '"To" must be after "From"' });
    }
  });

/** Header text → column key ("Date of Birth" → date_of_birth). */
const normalise = (h) => h.trim().toLowerCase().replace(/\*/g, '').replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

export function templateCsv() {
  const quote = (v) => `"${String(v).replace(/"/g, '""')}"`;
  const lines = [DOCTOR_COLUMNS.map(([k]) => k), ...DEMO_ROWS].map((r) => r.map(quote).join(','));
  return `${BOM}${lines.join('\r\n')}\r\n`;
}

/**
 * Validates every row. With `commit`, creates the valid ones and skips the rest.
 * Result rows: { row, name, mobile, status: 'ok'|'created'|'error'|'skipped', errors[] }.
 */
export async function importDoctors(admin, csvText, { commit = false }, req) {
  let table;
  try {
    table = parseCsv(csvText ?? '');
  } catch (err) {
    throw ApiError.badRequest(`Could not read the CSV: ${err.message}`, undefined, 'CSV_INVALID');
  }
  if (table.length < 2) throw ApiError.badRequest('The file has no data rows. Use the template.', undefined, 'CSV_EMPTY');

  const headers = table[0].map(normalise);
  const known = new Set(DOCTOR_COLUMNS.map(([k]) => k));
  const missing = ['name', 'mobile', 'specialty', 'city'].filter((k) => !headers.includes(k));
  if (missing.length) {
    throw ApiError.badRequest(`Missing required column(s): ${missing.join(', ')}. Use the template.`, undefined, 'CSV_COLUMNS');
  }
  const unknown = headers.filter((h) => h && !known.has(h));
  const data = table.slice(1);
  if (data.length > MAX_IMPORT_ROWS) {
    throw ApiError.badRequest(`At most ${MAX_IMPORT_ROWS} doctors per file (this file has ${data.length}). Split it and import in parts.`, undefined, 'CSV_TOO_MANY_ROWS');
  }

  // Validate rows and find duplicates inside the file.
  const seen = new Map();
  const results = data.map((cells, i) => {
    const raw = Object.fromEntries(headers.map((h, j) => [h, cells[j] ?? '']).filter(([h]) => known.has(h)));
    const parsed = rowSchema.safeParse(raw);
    const result = { row: i + 2, name: raw.name?.trim() ?? '', mobile: raw.mobile?.trim() ?? '', status: 'ok', errors: [] };
    if (!parsed.success) {
      result.status = 'error';
      result.errors = parsed.error.issues.map((iss) => `${iss.path[0] ?? 'row'}: ${iss.message}`);
    } else {
      result.data = parsed.data;
      const firstRow = seen.get(parsed.data.mobile);
      if (firstRow) {
        result.status = 'error';
        result.errors.push(`mobile: same number as row ${firstRow}`);
      } else seen.set(parsed.data.mobile, result.row);
    }
    return result;
  });

  // Mobiles already registered (any role).
  const mobiles = results.filter((r) => r.data).map((r) => r.data.mobile);
  const taken = new Map((await User.find({ mobile: { $in: mobiles } }).select('mobile role').lean()).map((u) => [u.mobile, u.role]));
  for (const r of results) {
    if (r.status === 'ok' && taken.has(r.data.mobile)) {
      r.status = 'error';
      r.errors.push(`mobile: already registered (${taken.get(r.data.mobile)})`);
    }
  }

  if (commit) {
    for (const r of results) {
      if (r.status !== 'ok') {
        r.status = 'skipped';
        continue;
      }
      try {
        await createDoctor(admin, r.data);
        r.status = 'created';
      } catch (err) {
        r.status = 'error';
        r.errors.push(err?.code === 11000 ? 'mobile: already registered' : 'Could not be created');
      }
    }
    const created = results.filter((r) => r.status === 'created').length;
    await audit({
      actor: admin,
      action: 'user.doctors_imported',
      module: 'admin',
      entityType: 'User',
      after: { rows: results.length, created, skipped: results.length - created },
      req,
    });
  }

  const count = (s) => results.filter((r) => r.status === s).length;
  return {
    committed: commit,
    summary: { rows: results.length, valid: count('ok'), invalid: count('error'), created: count('created'), skipped: count('skipped') },
    ignoredColumns: unknown,
    rows: results.map(({ data: _data, ...r }) => r),
  };
}

async function createDoctor(admin, d) {
  const user = await User.create({
    role: 'doctor',
    name: d.name,
    mobile: d.mobile,
    createdBy: admin._id,
    // Enough for the Master MCL; MR-call timings complete the "final" step.
    onboarding: { profile: true, final: Boolean(d.mr_call_days) },
  });
  try {
    await DoctorProfile.create({
      user: user._id,
      code: await nextCode('doctor'),
      qualification: d.qualification,
      gender: d.gender,
      dateOfBirth: d.date_of_birth,
      email: d.email,
      specialty: d.specialty,
      councilRegNo: d.council_reg_no,
      practice: {
        type: d.practice_type,
        clinicName: d.clinic_name,
        preferredPlace: d.practice_type === 'hospital' ? 'Hospital' : d.practice_type === 'clinic' ? 'Clinic' : undefined,
        address: d.address,
        city: d.city,
        state: d.state,
        district: d.district,
        pincode: d.pincode,
      },
      ...(d.mr_call_days && {
        mrCall: { days: d.mr_call_days, from: d.mr_call_from, to: d.mr_call_to, slotMinutes: 15, maxPerDay: d.max_mr_per_day, companyTypes: ['all'] },
      }),
      availability: d.availability,
    });
  } catch (err) {
    await User.deleteOne({ _id: user._id });
    throw err;
  }
}
