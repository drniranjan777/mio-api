import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import {
  P,
  api,
  auth,
  deleteAccount,
  login,
  loginReceptionist,
  nextMobile,
  registeredDoctor,
  reset,
  setup,
  slot,
  teardown,
  validDoctorProfile,
} from './helpers.js';

before(setup);
after(teardown);
beforeEach(reset);

describe('Registration', () => {
  it('validates required fields and marks onboarding progress', async () => {
    const d = await login('doctor');
    const bad = await api().put(`${P}/doctors/me/profile`).set(auth(d.token)).send({ name: 'X' }).expect(400);
    assert.equal(bad.body.error.code, 'VALIDATION_ERROR');
    assert.ok(bad.body.error.details.length > 5);

    const ok = await api().put(`${P}/doctors/me/profile`).set(auth(d.token)).send(validDoctorProfile()).expect(200);
    assert.deepEqual(ok.body.data.user.onboarding, { profile: true, final: false });
    assert.equal(ok.body.data.profile.practice.city, 'Hyderabad');
  });

  it('ignores fields the client is not allowed to set (mass assignment)', async () => {
    const d = await login('doctor');
    const body = { ...validDoctorProfile(), role: 'admin', code: 'DR99999', availability: 'unavailable', user: '000000000000000000000000' };
    const { body: res } = await api().put(`${P}/doctors/me/profile`).set(auth(d.token)).send(body).expect(200);
    assert.equal(res.data.user.role, 'doctor');
    assert.notEqual(res.data.profile.code, 'DR99999');
    assert.equal(res.data.profile.availability, 'auto');
  });

  it('gives new accounts zero-padded codes and new doctors auto mode', async () => {
    const d1 = await login('doctor');
    const d2 = await login('doctor');
    const mr = await login('mr');
    const me = async (t) => (await api().get(`${P}/me`).set(auth(t)).expect(200)).body.data.profile;
    assert.equal((await me(d1.token)).code, 'DR00001');
    assert.equal((await me(d2.token)).code, 'DR00002');
    assert.equal((await me(mr.token)).code, 'MR00001');
    assert.equal((await me(d1.token)).availability, 'auto');
  });

  it('accepts mobile numbers starting with 5', async () => {
    const mr = await login('mr', '5123456789');
    assert.equal(mr.user.mobile, '5123456789');
    await api().post(`${P}/auth/otp/request`).send({ mobile: '4123456789', role: 'mr' }).expect(400);
  });

  it('doctor: optional DOB/DOM/HPR, sub-specialty, both places, optional clinic contacts', async () => {
    const d = await login('doctor');
    const { dateOfBirth, hprId, ...rest } = validDoctorProfile();
    assert.ok(dateOfBirth && hprId);
    const profile = {
      ...rest,
      dateOfBirth: '',
      subSpecialty: 'Interventional Cardiology',
      practice: { ...rest.practice, type: 'both', territoryClass: 'City Outskirts' },
    };
    const saved = await api().put(`${P}/doctors/me/profile`).set(auth(d.token)).send(profile).expect(200);
    assert.equal(saved.body.data.profile.subSpecialty, 'Interventional Cardiology');
    assert.equal(saved.body.data.profile.practice.type, 'both');
    assert.equal(saved.body.data.profile.dateOfBirth, undefined);

    const fin = {
      mrCall: { days: ['Mon'], from: '00:05', to: '23:55', maxPerDay: 100, companyTypes: ['all'] },
      contacts: { receptionistName: '', receptionistMobile: '', pharmacyName: '', pharmacistName: '', pharmacistMobile: '' },
    };
    await api().put(`${P}/doctors/me/final`).set(auth(d.token)).send(fin).expect(200);
    await api().put(`${P}/doctors/me/final`).set(auth(d.token)).send({ ...fin, mrCall: { ...fin.mrCall, maxPerDay: 101 } }).expect(400);
  });

  it('MR: multi-specialty coverage, personal email, optional last working date', async () => {
    const mr = await login('mr');
    const body = {
      name: 'Rohit Verma',
      qualification: 'B.Pharm',
      gender: 'male',
      age: 18,
      dateOfBirth: '05/06',
      maritalStatus: 'Other',
      company: { name: 'Sun Pharma', type: 'Pharmaceutical', address: 'Hyderabad' },
      employerStatus: 'Working',
      joiningDate: '01/01/2025',
      lastWorkingDate: '',
      employeeCode: 'E-1',
      email: 'rohit@gmail.com',
      specialties: ['Cardiology', 'Neurology', 'Cardiology'],
      division: 'Cardio',
      hq: { name: 'Hyderabad HQ', class: 'Metro', city: 'Hyderabad', district: 'Hyderabad', state: 'Telangana', zone: 'East' },
      referralMobile: nextMobile(),
    };
    const saved = await api().put(`${P}/mrs/me/profile`).set(auth(mr.token)).send(body).expect(200);
    assert.deepEqual(saved.body.data.profile.specialties, ['Cardiology', 'Neurology']);
    assert.equal(saved.body.data.profile.specialty, 'Cardiology, Neurology');
    assert.equal(saved.body.data.profile.email, 'rohit@gmail.com');
    assert.equal(saved.body.data.profile.lastWorkingDate, undefined);
    // Older app builds still send one specialty and the official email.
    const { specialties, email, ...legacy } = body;
    assert.ok(specialties && email);
    const old = await api()
      .put(`${P}/mrs/me/profile`)
      .set(auth(mr.token))
      .send({ ...legacy, specialty: 'Dermatology', officialEmail: 'r@sunpharma.com' })
      .expect(200);
    assert.deepEqual(old.body.data.profile.specialties, ['Dermatology']);
    await api().put(`${P}/mrs/me/profile`).set(auth(mr.token)).send({ ...legacy }).expect(400);
  });

  it('only the owning role can use a registration endpoint', async () => {
    const mr = await login('mr');
    await api().put(`${P}/doctors/me/profile`).set(auth(mr.token)).send(validDoctorProfile()).expect(403);
  });
});

describe('Delete account', () => {
  it('requires explicit confirmation', async () => {
    const mr = await login('mr');
    await api().delete(`${P}/me`).set(auth(mr.token)).send({}).expect(400);
  });

  it('doctor deletion cancels upcoming visits, revokes receptionists and sessions, frees the number', async () => {
    const doctor = await registeredDoctor();
    const mr = await login('mr');
    const appt = await api().post(`${P}/appointments`).set(auth(mr.token)).send({ doctorId: doctor.id, startAt: slot(0) }).expect(201);
    const rMobile = nextMobile();
    await api().post(`${P}/doctors/me/receptionists`).set(auth(doctor.token)).send({ name: 'P', mobile: rMobile }).expect(201);
    const receptionist = await loginReceptionist(rMobile);

    // Without the PIN, or with a wrong one, nothing is deleted.
    await api().delete(`${P}/me`).set(auth(doctor.token)).send({ confirm: true, reason: 'Other' }).expect(400);
    const otp = await api().post(`${P}/me/delete/otp`).set(auth(doctor.token)).expect(200);
    const wrongPin = otp.body.data.devOtp === '0000' ? '1111' : '0000';
    const wrong = await api().delete(`${P}/me`).set(auth(doctor.token)).send({ confirm: true, otp: wrongPin }).expect(400);
    assert.equal(wrong.body.error.code, 'OTP_INVALID');
    await api().get(`${P}/me`).set(auth(doctor.token)).expect(200);

    assert.equal((await deleteAccount(doctor.token)).status, 204);

    await api().get(`${P}/me`).set(auth(doctor.token)).expect(401);
    await api().post(`${P}/auth/refresh`).send({ refreshToken: doctor.tokens.refreshToken }).expect(401);
    const seen = await api().get(`${P}/appointments/${appt.body.data.id}`).set(auth(mr.token)).expect(200);
    assert.equal(seen.body.data.status, 'cancelled');
    const list = await api().get(`${P}/appointments`).set(auth(receptionist.token)).expect(200);
    assert.equal(list.body.data.length, 0);

    // The mobile number can register again as a fresh account.
    const again = await login('doctor', doctor.mobile);
    assert.equal(again.isNewUser, true);
  });
});
