import crypto from 'node:crypto';

process.env.NODE_ENV = 'test';
process.env.JWT_ACCESS_SECRET ??= crypto.randomBytes(48).toString('hex');
process.env.OTP_PEPPER ??= crypto.randomBytes(24).toString('hex');
process.env.OTP_DEV_MODE = 'true';
process.env.OTP_RESEND_SECONDS = '0';
process.env.MONGODB_URI ??= 'mongodb://placeholder';

const { MongoMemoryServer } = await import('mongodb-memory-server');
const mongoose = (await import('mongoose')).default;
const request = (await import('supertest')).default;
const { createApp } = await import('../src/app.js');
const { connectDb } = await import('../src/config/db.js');

let mongod;
export let app;

export async function setup() {
  mongod = await MongoMemoryServer.create();
  await connectDb(mongod.getUri('mio_test'));
  app = createApp();
}

export async function teardown() {
  await mongoose.disconnect();
  await mongod?.stop();
}

export async function reset() {
  const collections = await mongoose.connection.db.collections();
  await Promise.all(collections.map((c) => c.deleteMany({})));
}

export const api = () => request(app);
export const P = '/api/v1';

let seq = 0;
/** Unique valid Indian mobile for each call. */
export const nextMobile = () => `9${String(100000000 + (seq++ % 899999999)).padStart(9, '0')}`;

/** Full OTP login for doctor / mr (creates the account on first login). */
export async function login(role, mobile = nextMobile()) {
  const reqRes = await api().post(`${P}/auth/otp/request`).send({ mobile, role });
  if (reqRes.status !== 200) throw new Error(`otp/request ${reqRes.status} ${JSON.stringify(reqRes.body)}`);
  const res = await api().post(`${P}/auth/otp/verify`).send({ mobile, role, otp: reqRes.body.data.devOtp });
  if (res.status !== 200) throw new Error(`otp/verify ${res.status} ${JSON.stringify(res.body)}`);
  return { mobile, ...res.body.data, token: res.body.data.tokens.accessToken, id: res.body.data.user.id };
}

/** Receptionist login through "Send Request". */
export async function loginReceptionist(mobile) {
  const reqRes = await api().post(`${P}/auth/receptionist/request`).send({ mobile });
  if (reqRes.body.data?.status !== 'granted') throw new Error(`receptionist not granted: ${JSON.stringify(reqRes.body)}`);
  const res = await api().post(`${P}/auth/otp/verify`).send({ mobile, role: 'receptionist', otp: reqRes.body.data.devOtp });
  return { mobile, ...res.body.data, token: res.body.data.tokens.accessToken, id: res.body.data.user.id };
}

export const auth = (token) => ({ Authorization: `Bearer ${token}` });

export const validDoctorProfile = (name = 'Dr. Rahul Sharma') => ({
  name,
  qualification: 'MBBS, MD',
  gender: 'male',
  age: 39,
  dateOfBirth: '12/01',
  maritalStatus: 'Married',
  specialty: 'Cardiology',
  email: `dr${seq++}@example.com`,
  religion: 'Hindu',
  councilRegNo: 'APMC12345',
  hprId: 'HPR987654',
  practice: {
    type: 'hospital',
    clinicName: 'Apollo Hospital',
    preferredPlace: 'Hospital',
    address: 'A-102, Green Park',
    city: 'Hyderabad',
    state: 'Telangana',
    hometown: 'Hyderabad',
    pincode: '500034',
    locationType: 'Metro',
    territoryClass: 'HQ',
  },
});

export const validDoctorFinal = (receptionistMobile = nextMobile()) => ({
  mrCall: { days: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'], from: '10:00', to: '16:00', maxPerDay: 20, companyTypes: ['all'] },
  contacts: {
    receptionistName: 'Suman Reddy',
    receptionistMobile,
    pharmacyName: 'Apollo Pharmacy',
    pharmacistName: 'Ramesh Kumar',
    pharmacistMobile: nextMobile(),
  },
  consultation: { days: ['Mon'], from: '09:00', to: '14:00', feeRupees: 800, avgPatientsPerDay: 60 },
});

/** A registered doctor ready to receive bookings. */
export async function registeredDoctor(opts = {}) {
  const d = await login('doctor');
  const profile = { ...validDoctorProfile(opts.name), ...(opts.specialty && { specialty: opts.specialty }) };
  if (opts.dateOfBirth) profile.dateOfBirth = opts.dateOfBirth;
  await api().put(`${P}/doctors/me/profile`).set(auth(d.token)).send(profile).expect(200);
  await api().put(`${P}/doctors/me/final`).set(auth(d.token)).send(validDoctorFinal(opts.receptionistMobile)).expect(200);
  if (opts.availability) {
    await api().patch(`${P}/doctors/me/availability`).set(auth(d.token)).send({ availability: opts.availability }).expect(200);
  }
  return d;
}

/** Next valid slot start (tomorrow 10:00 IST + n * 15 min) as ISO string. */
export function slot(n = 0, daysAhead = 1) {
  const now = new Date(Date.now() + 330 * 60_000);
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const d = now.getUTCDate() + daysAhead;
  return new Date(Date.UTC(y, m, d, 10, 0) - 330 * 60_000 + n * 15 * 60_000).toISOString();
}

/** "DD/MM/YYYY" for a birthday `daysAhead` from today (IST), born `age` years ago. */
export function dobIn(daysAhead, age = 40) {
  const d = new Date(Date.now() + 330 * 60_000 + daysAhead * 86_400_000);
  const two = (n) => String(n).padStart(2, '0');
  return `${two(d.getUTCDate())}/${two(d.getUTCMonth() + 1)}/${d.getUTCFullYear() - age}`;
}

/** Creates an admin directly (no public sign-up exists) and signs in. */
export async function loginAdmin() {
  const bcrypt = (await import('bcryptjs')).default;
  const { User } = await import('../src/modules/users/user.model.js');
  const email = `admin${seq++}@example.com`;
  const password = 'Admin-password-123';
  await User.create({ role: 'admin', name: 'Admin', email, passwordHash: await bcrypt.hash(password, 4) });
  const res = await api().post(`${P}/auth/admin/login`).send({ email, password });
  if (res.status !== 200) throw new Error(`admin login ${res.status} ${JSON.stringify(res.body)}`);
  return { token: res.body.data.tokens.accessToken, id: res.body.data.user.id };
}
