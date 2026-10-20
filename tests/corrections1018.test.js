/**
 * App Corrections of 18 Oct 2026: Sundays closed for MR appointments, Master
 * MCL multi-select filters + date, MR report list, MR designation, fee ranges,
 * company-type choice, plan features and the doctors' support email.
 */
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import mongoose from 'mongoose';

import { P, api, auth, bookableDay, login, loginAdmin, nextMobile, nextSunday, registeredDoctor, reset, setup, slot, teardown } from './helpers.js';
import { DOCTOR_FEATURES, MR_FEATURES, seedCatalog } from '../scripts/catalog.js';
import { runMigrations } from '../scripts/migrate.js';

before(setup);
after(teardown);
beforeEach(async () => {
  await reset();
  await seedCatalog();
});

const get = (who, p) => api().get(`${P}${p}`).set(auth(who.token));
const post = (who, p, body = {}) => api().post(`${P}${p}`).set(auth(who.token)).send(body);
const put = (who, p, body = {}) => api().put(`${P}${p}`).set(auth(who.token)).send(body);
const isoOf = ([y, m, d]) => new Date(Date.UTC(y, m, d)).toISOString().slice(0, 10);
/** 10:00 IST on a "YYYY-MM-DD" day as an ISO instant. */
const tenAm = (date) => new Date(Date.parse(`${date}T10:00:00Z`) - 330 * 60_000).toISOString();

describe('Sundays are closed for MR appointments', () => {
  it('no slots, no bookings and no reschedules on a Sunday, even if the doctor ticked Sunday', async () => {
    // The test doctor's saved days include "Sun" (older data / admin import).
    const doctor = await registeredDoctor({ availability: 'auto' });
    const mr = await login('mr');
    const sunday = nextSunday();

    const day = (await get(mr, `/doctors/${doctor.id}/slots?date=${sunday}`).expect(200)).body.data;
    assert.equal(day.closed, true);
    assert.deepEqual([day.slots.length, day.available], [0, 0]);
    const weekday = (await get(mr, `/doctors/${doctor.id}/slots?date=${isoOf(bookableDay(1))}`).expect(200)).body.data;
    assert.equal(weekday.closed, false);
    assert.ok(weekday.slots.length > 0);

    const res = await post(mr, '/appointments', { doctorId: doctor.id, startAt: tenAm(sunday) }).expect(422);
    assert.equal(res.body.error.code, 'SUNDAY_CLOSED');

    const appt = (await post(mr, '/appointments', { doctorId: doctor.id, startAt: slot(0) }).expect(201)).body.data;
    const moved = await post(doctor, `/appointments/${appt.id}/reschedule`, { startAt: tenAm(sunday) }).expect(422);
    assert.equal(moved.body.error.code, 'SUNDAY_CLOSED');

    // Master MCL: no free slots on a Sunday, the day's slots on a working day.
    const list = async (date) => (await get(mr, `/doctors?date=${date}`).expect(200)).body.data[0];
    assert.equal((await list(sunday)).slotsLeft, 0);
    const monday = await list(isoOf(bookableDay(1)));
    assert.ok(monday.slotsLeft > 0);
    assert.equal(monday.slotsLeftToday, monday.slotsLeft, 'older app builds read slotsLeftToday');
  });
});

describe('Master MCL filters', () => {
  async function directory() {
    await registeredDoctor({ name: 'Dr. Asha Rao', specialty: 'Cardiology', practice: { city: 'Hyderabad', clinicName: 'Apollo Hospital' } });
    await registeredDoctor({ name: 'Dr. Bala Iyer', specialty: 'Neurology', practice: { city: 'Chennai', clinicName: 'Kauvery Clinic' } });
    await registeredDoctor({ name: 'Dr. Charu Sen', specialty: 'Dermatology', practice: { city: 'Hyderabad', clinicName: 'Skin Care Clinic' } });
    await registeredDoctor({ name: 'Dr. Dev Nair', specialty: 'cardiology', practice: { city: 'chennai', clinicName: 'apollo hospital' } });
    return login('mr');
  }
  const names = (res) => res.body.data.map((d) => d.name).sort();

  it('specialty, location and hospital/clinic name each take several values', async () => {
    const mr = await directory();
    const q = (s) => get(mr, `/doctors?${s}`).expect(200);

    assert.deepEqual(names(await q('specialty=Cardiology&specialty=Neurology')), ['Dr. Asha Rao', 'Dr. Bala Iyer', 'Dr. Dev Nair']);
    assert.deepEqual(names(await q('city=Hyderabad')), ['Dr. Asha Rao', 'Dr. Charu Sen']);
    assert.deepEqual(names(await q('clinicName=Apollo%20Hospital&clinicName=Kauvery%20Clinic')), ['Dr. Asha Rao', 'Dr. Bala Iyer', 'Dr. Dev Nair']);
    // Different filters combine with AND.
    assert.deepEqual(names(await q('specialty=Cardiology&city=Chennai')), ['Dr. Dev Nair']);
    assert.deepEqual(names(await q('specialty=Cardiology&city=Hyderabad&clinicName=Skin%20Care%20Clinic')), []);
    // Search by doctor name; regex characters are taken literally.
    assert.deepEqual(names(await q('q=charu')), ['Dr. Charu Sen']);
    assert.deepEqual(names(await q('q=.*')), []);
    // Old single-value calls keep working.
    assert.deepEqual(names(await q('specialty=Neurology')), ['Dr. Bala Iyer']);
    await get(mr, '/doctors?date=2026-13-40').expect(400);
  });

  it('lists the filter choices once each, case-insensitively, for MRs and admins only', async () => {
    const mr = await directory();
    const f = (await get(mr, '/doctors/filters').expect(200)).body.data;
    assert.deepEqual(f.specialties, ['Cardiology', 'Dermatology', 'Neurology']);
    assert.deepEqual(f.cities, ['Chennai', 'Hyderabad']);
    assert.deepEqual(f.clinicNames, ['Apollo Hospital', 'Kauvery Clinic', 'Skin Care Clinic']);
    await get(await loginAdmin(), '/doctors/filters').expect(200);
    await get(await registeredDoctor(), '/doctors/filters').expect(403);
  });
});

describe('MR report list', () => {
  it('drops the company & employee summary for MRs; the panel keeps it', async () => {
    const mr = await login('mr');
    const types = (await get(mr, '/reports/filters').expect(200)).body.data.reports.map((r) => r.type);
    assert.ok(!types.includes('company-summary'));
    assert.ok(types.includes('doctor-visits') && types.includes('monthly-visit-dates'));
    await get(mr, '/reports/company-summary').expect(403);

    const admin = await loginAdmin();
    const all = (await get(admin, '/reports/filters').expect(200)).body.data.reports.map((r) => r.type);
    assert.ok(all.includes('company-summary'));
    await get(admin, '/reports/company-summary').expect(200);
  });
});

describe('Registration fields', () => {
  const mrBody = (extra) => ({
    name: 'Rohit Verma',
    qualification: 'B.Pharm',
    gender: 'male',
    age: 28,
    dateOfBirth: '05/06',
    maritalStatus: 'Single',
    company: { name: 'Cipla', type: 'Pharmaceutical', address: 'Hyderabad' },
    joiningDate: '01/01/2025',
    employeeCode: 'E-1',
    email: 'rohit@gmail.com',
    specialties: ['Cardiology'],
    division: 'Cardio',
    hq: { name: 'Hyderabad HQ', class: 'Metro', city: 'Hyderabad', district: 'Hyderabad', state: 'Telangana', zone: 'East' },
    referralMobile: nextMobile(),
    ...extra,
  });

  it('MR: Designation replaces Employer Status (older builds still send the status)', async () => {
    const mr = await login('mr');
    const saved = await put(mr, '/mrs/me/profile', mrBody({ designation: '  Senior Medical Representative ' })).expect(200);
    assert.equal(saved.body.data.profile.designation, 'Senior Medical Representative');

    const missing = await put(mr, '/mrs/me/profile', mrBody({ designation: '' })).expect(400);
    assert.ok(missing.body.error.details.some((d) => d.path === 'designation'));
    await put(mr, '/mrs/me/profile', mrBody({ employerStatus: 'Working' })).expect(200);
    await put(mr, '/mrs/me/profile', mrBody({ designation: 'x'.repeat(81) })).expect(400);
  });

  it('doctor: consultation fee range and one pharma company type', async () => {
    const doctor = await registeredDoctor();
    const fin = {
      mrCall: { days: ['Mon', 'Tue'], from: '09:00', to: '13:00', maxPerDay: 10, companyTypes: ['mnc'] },
      consultation: { days: ['Mon'], from: '09:00', to: '12:00', feeRange: '501-1000', avgPatientsPerDay: 25 },
    };
    const saved = (await put(doctor, '/doctors/me/final', fin).expect(200)).body.data.profile;
    assert.deepEqual(saved.mrCall.companyTypes, ['mnc']);
    assert.equal(saved.consultation.feeRange, '501-1000');
    assert.equal(saved.consultation.feePaise, undefined, 'the old exact fee is replaced');

    // "All" with anything else means all; unknown ranges are refused.
    const all = (await put(doctor, '/doctors/me/final', { ...fin, mrCall: { ...fin.mrCall, companyTypes: ['startup', 'all'] } }).expect(200)).body.data;
    assert.deepEqual(all.profile.mrCall.companyTypes, ['all']);
    await put(doctor, '/doctors/me/final', { ...fin, consultation: { ...fin.consultation, feeRange: '1-99' } }).expect(400);
    // Older builds send an exact fee.
    const old = (await put(doctor, '/doctors/me/final', { ...fin, consultation: { feeRupees: 800 } }).expect(200)).body.data;
    assert.equal(old.profile.consultation.feePaise, 80000);
  });
});

describe('Plans and Help Desk', () => {
  it('plans carry the client feature lists; doctors write to support@', async () => {
    const mr = await login('mr');
    const doctor = await login('doctor');
    const mrPlans = (await get(mr, '/plans').expect(200)).body.data;
    assert.ok(mrPlans.length >= 2 && mrPlans.every((p) => JSON.stringify(p.features) === JSON.stringify(MR_FEATURES)));
    const doctorPlans = (await get(doctor, '/plans').expect(200)).body.data;
    assert.deepEqual(doctorPlans[0].features, DOCTOR_FEATURES);

    assert.equal((await get(doctor, '/support').expect(200)).body.data.email, 'support@miodoctors.com');
    assert.equal((await get(mr, '/support').expect(200)).body.data.email, 'mr@miodoctors.com');
  });

  it('migration updates shipped feature lists and the old doctor email, keeps custom values, and rolls back', async () => {
    const db = mongoose.connection.db;
    const plans = db.collection('plans');
    const oldMr = ['View Doctor Profiles', 'Book / View Appointments', 'Other App Features'];
    await plans.updateMany({ role: 'mr' }, { $set: { features: oldMr } });
    // Production had the MR list on the doctor plan too.
    await plans.updateOne({ code: 'doctor-lifetime-free' }, { $set: { features: oldMr } });
    await plans.updateOne({ code: 'mr-monthly' }, { $set: { features: ['Our own wording'] } });
    await db.collection('appsettings').insertOne({ key: 'support', value: { topics: ['Other'], emails: { mr: 'mr@miodoctors.com', doctor: 'doctor@miodoctors.com', receptionist: 'support@miodoctors.com' } } });
    await db.collection('migrations').deleteMany({});
    await db.collection('migrations').insertOne({ name: '20261004-001-locations-and-banners.js', appliedAt: new Date(0) });
    await db.collection('migrations').insertOne({ name: '20261015-001-ui-changes-oct-2026.js', appliedAt: new Date(1) });

    await runMigrations('up', { quiet: true });
    const features = async (code) => (await plans.findOne({ code })).features;
    assert.deepEqual(await features('mr-yearly'), MR_FEATURES);
    assert.deepEqual(await features('mr-free-2-months'), MR_FEATURES);
    assert.deepEqual(await features('doctor-lifetime-free'), DOCTOR_FEATURES);
    assert.deepEqual(await features('mr-monthly'), ['Our own wording']);
    const doctor = await login('doctor');
    assert.equal((await get(doctor, '/support').expect(200)).body.data.email, 'support@miodoctors.com');

    await runMigrations('down', { quiet: true });
    assert.deepEqual(await features('mr-yearly'), oldMr);
    assert.deepEqual(await features('mr-monthly'), ['Our own wording']);
    assert.equal((await get(doctor, '/support').expect(200)).body.data.email, 'doctor@miodoctors.com');
  });
});
