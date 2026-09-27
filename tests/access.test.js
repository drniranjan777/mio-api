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
  teardown,
} from './helpers.js';

before(setup);
after(teardown);
beforeEach(reset);

const give = (doctor, mobile, permissions = ['view', 'book', 'reschedule', 'cancel']) =>
  api().post(`${P}/doctors/me/receptionists`).set(auth(doctor.token)).send({ name: 'Priya Sharma', mobile, permissions });

describe('Receptionist access is owned by doctors', () => {
  it('doctor gives access; receptionist can then sign in', async () => {
    const doctor = await registeredDoctor();
    const mobile = nextMobile();
    const res = await give(doctor, mobile).expect(201);
    assert.equal(res.body.data.status, 'active');

    const r = await loginReceptionist(mobile);
    const me = await api().get(`${P}/me`).set(auth(r.token)).expect(200);
    assert.equal(me.body.data.doctors.length, 1);
    assert.deepEqual(me.body.data.doctors[0].permissions.sort(), ['book', 'cancel', 'reschedule', 'view']);
  });

  it('MRs and receptionists cannot manage receptionist access', async () => {
    const mr = await login('mr');
    await api().get(`${P}/doctors/me/receptionists`).set(auth(mr.token)).expect(403);
    await give(mr, nextMobile()).expect(403);
  });

  it('view permission is always kept', async () => {
    const doctor = await registeredDoctor();
    const mobile = nextMobile();
    const { body } = await give(doctor, mobile, []).expect(201);
    assert.deepEqual(body.data.permissions, ['view']);
  });

  it('unknown receptionist request is routed to the doctor who listed that mobile', async () => {
    const mobile = nextMobile();
    const doctor = await registeredDoctor({ receptionistMobile: mobile });
    const req1 = await api().post(`${P}/auth/receptionist/request`).send({ mobile }).expect(200);
    assert.equal(req1.body.data.status, 'pending');
    assert.equal(req1.body.data.routedTo, 1);
    assert.equal(req1.body.data.devOtp, undefined);

    const list = await api().get(`${P}/doctors/me/receptionists`).set(auth(doctor.token)).expect(200);
    assert.equal(list.body.data[0].status, 'pending');

    // Approve → receptionist can now sign in.
    const rid = list.body.data[0].receptionist.id;
    await api()
      .patch(`${P}/doctors/me/receptionists/${rid}`)
      .set(auth(doctor.token))
      .send({ status: 'active', permissions: ['view', 'book'] })
      .expect(200);
    await loginReceptionist(mobile);
  });

  it('deactivation takes effect immediately, even for an issued token', async () => {
    const doctor = await registeredDoctor();
    const mobile = nextMobile();
    const { body } = await give(doctor, mobile).expect(201);
    const r = await loginReceptionist(mobile);

    await api()
      .patch(`${P}/doctors/me/receptionists/${body.data.receptionist.id}`)
      .set(auth(doctor.token))
      .send({ status: 'inactive' })
      .expect(200);

    const list = await api().get(`${P}/appointments`).set(auth(r.token)).expect(200);
    assert.equal(list.body.data.length, 0);
    const again = await api().post(`${P}/auth/receptionist/request`).send({ mobile }).expect(200);
    assert.equal(again.body.data.status, 'blocked');
  });

  it('a receptionist can work for several doctors', async () => {
    const d1 = await registeredDoctor({ name: 'Dr. One' });
    const d2 = await registeredDoctor({ name: 'Dr. Two' });
    const mobile = nextMobile();
    await give(d1, mobile).expect(201);
    await give(d2, mobile, ['view']).expect(201);
    const r = await loginReceptionist(mobile);
    const { body } = await api().get(`${P}/receptionists/me/doctors`).set(auth(r.token)).expect(200);
    assert.deepEqual(body.data.map((d) => d.name).sort(), ['Dr. One', 'Dr. Two']);
  });

  it('refuses to turn another role\'s number into a receptionist', async () => {
    const doctor = await registeredDoctor();
    const mr = await login('mr');
    const res = await give(doctor, mr.mobile).expect(409);
    assert.equal(res.body.error.code, 'MOBILE_IN_USE');
  });
});
