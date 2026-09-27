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
} from './helpers.js';

before(setup);
after(teardown);
beforeEach(reset);

const book = (who, body) => api().post(`${P}/appointments`).set(auth(who.token)).send(body);

async function receptionistFor(doctor, permissions) {
  const mobile = nextMobile();
  await api()
    .post(`${P}/doctors/me/receptionists`)
    .set(auth(doctor.token))
    .send({ name: 'Priya', mobile, permissions })
    .expect(201);
  return loginReceptionist(mobile);
}

describe('Booking', () => {
  it('MR booking is pending for a manual-mode doctor and approved in auto mode', async () => {
    const manual = await registeredDoctor();
    const auto = await registeredDoctor({ availability: 'auto' });
    const mr = await login('mr');

    const a = await book(mr, { doctorId: manual.id, startAt: slot(0) }).expect(201);
    assert.equal(a.body.data.status, 'pending');
    const b = await book(mr, { doctorId: auto.id, startAt: slot(0) }).expect(201);
    assert.equal(b.body.data.status, 'approved');
  });

  it('prevents double booking of the same slot, including concurrent requests', async () => {
    const doctor = await registeredDoctor();
    const [mr1, mr2] = await Promise.all([login('mr'), login('mr')]);
    const results = await Promise.all([
      book(mr1, { doctorId: doctor.id, startAt: slot(1) }),
      book(mr2, { doctorId: doctor.id, startAt: slot(1) }),
    ]);
    const codes = results.map((r) => r.status).sort();
    assert.deepEqual(codes, [201, 409]);
    assert.equal(results.find((r) => r.status === 409).body.error.code, 'SLOT_TAKEN');
  });

  it('rejects slots in the past, off-grid or outside MR hours', async () => {
    const doctor = await registeredDoctor();
    const mr = await login('mr');
    const past = new Date(Date.now() - 3_600_000).toISOString();
    assert.equal((await book(mr, { doctorId: doctor.id, startAt: past }).expect(422)).body.error.code, 'SLOT_IN_PAST');
    const offGrid = new Date(new Date(slot(0)).getTime() + 7 * 60_000).toISOString();
    assert.equal((await book(mr, { doctorId: doctor.id, startAt: offGrid }).expect(422)).body.error.code, 'SLOT_UNAVAILABLE');
    assert.equal((await book(mr, { doctorId: doctor.id, startAt: slot(40) }).expect(422)).body.error.code, 'SLOT_UNAVAILABLE');
  });

  it('blocks bookings while the doctor is unavailable', async () => {
    const doctor = await registeredDoctor({ availability: 'unavailable' });
    const mr = await login('mr');
    const res = await book(mr, { doctorId: doctor.id, startAt: slot(0) }).expect(422);
    assert.equal(res.body.error.code, 'DOCTOR_UNAVAILABLE');
  });

  it('frees the slot again after cancellation', async () => {
    const doctor = await registeredDoctor();
    const mr = await login('mr');
    const a = await book(mr, { doctorId: doctor.id, startAt: slot(2) }).expect(201);
    await api().post(`${P}/appointments/${a.body.data.id}/cancel`).set(auth(mr.token)).send({}).expect(200);
    await book(mr, { doctorId: doctor.id, startAt: slot(2) }).expect(201);
  });
});

describe('Receptionist permissions are per doctor', () => {
  it('can only act within each doctor\'s grant', async () => {
    const d1 = await registeredDoctor({ name: 'Dr. Full' });
    const d2 = await registeredDoctor({ name: 'Dr. ViewOnly' });
    const mobile = nextMobile();
    for (const [d, perms] of [
      [d1, ['view', 'book', 'reschedule', 'cancel']],
      [d2, ['view']],
    ]) {
      await api().post(`${P}/doctors/me/receptionists`).set(auth(d.token)).send({ name: 'Priya', mobile, permissions: perms }).expect(201);
    }
    const r = await loginReceptionist(mobile);
    const visitor = { name: 'Rajesh Kumar', company: 'Sun Pharma' };

    const ok = await book(r, { doctorId: d1.id, startAt: slot(0), visitor }).expect(201);
    assert.equal(ok.body.data.status, 'approved');
    assert.equal(ok.body.data.can.cancel, true);
    const denied = await book(r, { doctorId: d2.id, startAt: slot(0), visitor }).expect(403);
    assert.equal(denied.body.error.code, 'BOOK_FORBIDDEN');

    // Appointment with d2 booked by an MR: receptionist sees it but cannot cancel.
    const mr = await login('mr');
    const a2 = await book(mr, { doctorId: d2.id, startAt: slot(3) }).expect(201);
    const list = await api().get(`${P}/appointments`).set(auth(r.token)).expect(200);
    assert.equal(list.body.data.length, 2);
    const seen = list.body.data.find((x) => x.id === a2.body.data.id);
    assert.equal(seen.can.cancel, false);
    await api().post(`${P}/appointments/${a2.body.data.id}/cancel`).set(auth(r.token)).send({}).expect(403);

    // Filter to one doctor; a doctor outside the grants is refused.
    const only1 = await api().get(`${P}/appointments?doctorId=${d1.id}`).set(auth(r.token)).expect(200);
    assert.equal(only1.body.data.length, 1);
    const outsider = await registeredDoctor();
    await api().get(`${P}/appointments?doctorId=${outsider.id}`).set(auth(r.token)).expect(403);
  });

  it('receptionist reschedules and cancels with permission; history is recorded', async () => {
    const doctor = await registeredDoctor();
    const r = await receptionistFor(doctor, ['view', 'book', 'reschedule', 'cancel']);
    const a = await book(r, { doctorId: doctor.id, startAt: slot(0), visitor: { name: 'Amit' } }).expect(201);

    const moved = await api()
      .post(`${P}/appointments/${a.body.data.id}/reschedule`)
      .set(auth(r.token))
      .send({ startAt: slot(4) })
      .expect(200);
    assert.equal(moved.body.data.startAt, slot(4));

    const cancelled = await api()
      .post(`${P}/appointments/${a.body.data.id}/cancel`)
      .set(auth(r.token))
      .send({ reason: 'Doctor on leave' })
      .expect(200);
    assert.equal(cancelled.body.data.status, 'cancelled');
    assert.deepEqual(
      cancelled.body.data.history.map((h) => h.action),
      ['created', 'reschedule', 'cancel'],
    );
  });
});

describe('Workflow rules', () => {
  it('enforces valid status transitions', async () => {
    const doctor = await registeredDoctor();
    const mr = await login('mr');
    const a = await book(mr, { doctorId: doctor.id, startAt: slot(0) }).expect(201);
    const id = a.body.data.id;

    await api().post(`${P}/appointments/${id}/approve`).set(auth(mr.token)).send({}).expect(403);
    await api().post(`${P}/appointments/${id}/complete`).set(auth(doctor.token)).send({}).expect(422);
    await api().post(`${P}/appointments/${id}/approve`).set(auth(doctor.token)).send({}).expect(200);
    await api().post(`${P}/appointments/${id}/complete`).set(auth(doctor.token)).send({}).expect(200);
    const res = await api().post(`${P}/appointments/${id}/cancel`).set(auth(doctor.token)).send({}).expect(422);
    assert.equal(res.body.error.code, 'INVALID_TRANSITION');
  });

  it('users only see their own appointments', async () => {
    const d1 = await registeredDoctor();
    const d2 = await registeredDoctor();
    const mr = await login('mr');
    const a = await book(mr, { doctorId: d1.id, startAt: slot(0) }).expect(201);
    await api().get(`${P}/appointments/${a.body.data.id}`).set(auth(d2.token)).expect(403);
    const other = await login('mr');
    await api().get(`${P}/appointments/${a.body.data.id}`).set(auth(other.token)).expect(403);
    const list = await api().get(`${P}/appointments`).set(auth(d2.token)).expect(200);
    assert.equal(list.body.data.length, 0);
  });

  it('returns the day slot grid with taken slots marked', async () => {
    const doctor = await registeredDoctor();
    const mr = await login('mr');
    await book(mr, { doctorId: doctor.id, startAt: slot(0) }).expect(201);
    const date = new Date(new Date(slot(0)).getTime() + 330 * 60_000).toISOString().slice(0, 10);
    const { body } = await api().get(`${P}/doctors/${doctor.id}/slots?date=${date}`).set(auth(mr.token)).expect(200);
    assert.equal(body.data.slots.length, 24);
    assert.equal(body.data.slots[0].available, false);
    assert.equal(body.data.slots[0].label, '10:00 AM');
    assert.equal(body.data.booked, 1);
  });
});
