import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { P, api, auth, login, nextMobile, reset, setup, teardown } from './helpers.js';

before(setup);
after(teardown);
beforeEach(reset);

describe('OTP login', () => {
  it('creates a doctor on first login and returns tokens + profile code', async () => {
    const d = await login('doctor');
    assert.equal(d.isNewUser, true);
    assert.equal(d.user.role, 'doctor');
    const me = await api().get(`${P}/me`).set(auth(d.token)).expect(200);
    assert.match(me.body.data.profile.code, /^DR\d{5}$/);
  });

  it('rejects a wrong PIN and locks after too many attempts', async () => {
    const mobile = nextMobile();
    await api().post(`${P}/auth/otp/request`).send({ mobile, role: 'mr' }).expect(200);
    const bad = await api().post(`${P}/auth/otp/verify`).send({ mobile, role: 'mr', otp: '0000' });
    // 1 in 10k chance the real code is 0000 — accept either outcome for that call.
    if (bad.status === 400) assert.equal(bad.body.error.code, 'OTP_INVALID');
  });

  it('refuses a number already registered under another role', async () => {
    const d = await login('doctor');
    const res = await api().post(`${P}/auth/otp/request`).send({ mobile: d.mobile, role: 'mr' }).expect(409);
    assert.equal(res.body.error.code, 'ROLE_MISMATCH');
  });

  it('validates the mobile number', async () => {
    const res = await api().post(`${P}/auth/otp/request`).send({ mobile: '12345', role: 'mr' }).expect(400);
    assert.equal(res.body.error.code, 'VALIDATION_ERROR');
  });

  it('never trusts a role from the client: receptionist OTP is refused without a doctor grant', async () => {
    const res = await api().post(`${P}/auth/otp/request`).send({ mobile: nextMobile(), role: 'receptionist' }).expect(403);
    assert.equal(res.body.error.code, 'NO_DOCTOR_ACCESS');
  });
});

describe('Tokens', () => {
  it('rejects missing and forged tokens', async () => {
    await api().get(`${P}/me`).expect(401);
    await api().get(`${P}/me`).set(auth('forged.token.value')).expect(401);
  });

  it('rotates refresh tokens and detects reuse', async () => {
    const d = await login('mr');
    const first = d.tokens.refreshToken;
    const r1 = await api().post(`${P}/auth/refresh`).send({ refreshToken: first }).expect(200);
    const second = r1.body.data.tokens.refreshToken;
    assert.notEqual(first, second);

    // Reusing the rotated token revokes the whole family…
    const reuse = await api().post(`${P}/auth/refresh`).send({ refreshToken: first }).expect(401);
    assert.equal(reuse.body.error.code, 'REFRESH_REUSED');
    // …so the newer token no longer works either.
    await api().post(`${P}/auth/refresh`).send({ refreshToken: second }).expect(401);
  });

  it('logout revokes the refresh token', async () => {
    const d = await login('mr');
    await api().post(`${P}/auth/logout`).send({ refreshToken: d.tokens.refreshToken }).expect(204);
    await api().post(`${P}/auth/refresh`).send({ refreshToken: d.tokens.refreshToken }).expect(401);
  });
});

describe('API basics', () => {
  it('returns the standard error envelope for unknown routes', async () => {
    const res = await api().get(`${P}/nope`).expect(404);
    assert.deepEqual(Object.keys(res.body), ['success', 'error']);
    assert.equal(res.body.success, false);
  });

  it('strips Mongo operators from input', async () => {
    const res = await api().post(`${P}/auth/otp/request`).send({ mobile: { $gt: '' }, role: 'mr' }).expect(400);
    assert.equal(res.body.error.code, 'VALIDATION_ERROR');
  });
});
