import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import {
  P,
  api,
  auth,
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
    const body = { ...validDoctorProfile(), role: 'admin', code: 'DR00001', availability: 'auto', user: '000000000000000000000000' };
    const { body: res } = await api().put(`${P}/doctors/me/profile`).set(auth(d.token)).send(body).expect(200);
    assert.equal(res.data.user.role, 'doctor');
    assert.notEqual(res.data.profile.code, 'DR00001');
    assert.equal(res.data.profile.availability, 'manual');
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

    await api().delete(`${P}/me`).set(auth(doctor.token)).send({ confirm: true, reason: 'Other' }).expect(204);

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
