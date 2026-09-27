import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import {
  P,
  api,
  auth,
  dobIn,
  login,
  loginAdmin,
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

const get = (who, path) => api().get(`${P}${path}`).set(auth(who.token));
const post = (who, path, body = {}) => api().post(`${P}${path}`).set(auth(who.token)).send(body);
const put = (who, path, body = {}) => api().put(`${P}${path}`).set(auth(who.token)).send(body);
const del = (who, path) => api().delete(`${P}${path}`).set(auth(who.token));

async function receptionistFor(doctor, permissions = ['view']) {
  const mobile = nextMobile();
  await post(doctor, '/doctors/me/receptionists', { name: 'Priya', mobile, permissions }).expect(201);
  return loginReceptionist(mobile);
}

describe('My MCL', () => {
  it('adds, lists, flags and removes doctors; adding twice is harmless', async () => {
    const [d1, d2] = await Promise.all([registeredDoctor({ name: 'Dr. A' }), registeredDoctor({ name: 'Dr. B' })]);
    const mr = await login('mr');

    await put(mr, `/mrs/me/mcl/${d1.id}`).expect(200);
    await put(mr, `/mrs/me/mcl/${d1.id}`).expect(200);
    await put(mr, `/mrs/me/mcl/${d2.id}`).expect(200);

    const list = await get(mr, '/mrs/me/mcl').expect(200);
    assert.equal(list.body.data.length, 2);
    assert.ok(list.body.data.every((d) => d.inMcl));

    const master = await get(mr, '/doctors').expect(200);
    assert.equal(master.body.data.find((d) => d.id === d1.id).inMcl, true);

    await del(mr, `/mrs/me/mcl/${d1.id}`).expect(200);
    const after = await get(mr, '/mrs/me/mcl').expect(200);
    assert.deepEqual(after.body.data.map((d) => d.id), [d2.id]);
  });

  it('is private to each MR and MR-only', async () => {
    const doctor = await registeredDoctor();
    const [mr1, mr2] = await Promise.all([login('mr'), login('mr')]);
    await put(mr1, `/mrs/me/mcl/${doctor.id}`).expect(200);
    assert.equal((await get(mr2, '/mrs/me/mcl').expect(200)).body.data.length, 0);
    await get(doctor, '/mrs/me/mcl').expect(403);
    await put(mr1, '/mrs/me/mcl/000000000000000000000000').expect(404);
    await put(mr1, '/mrs/me/mcl/not-an-id').expect(400);
  });
});

describe('Birthdays & wishes', () => {
  it('groups upcoming birthdays by week / month and computes the age', async () => {
    await registeredDoctor({ name: 'Dr. Soon', dateOfBirth: dobIn(2, 40) });
    await registeredDoctor({ name: 'Dr. Later', dateOfBirth: dobIn(20) });
    await registeredDoctor({ name: 'Dr. Far', dateOfBirth: dobIn(120) });
    const mr = await login('mr');

    const all = await get(mr, '/birthdays').expect(200);
    assert.deepEqual(all.body.data.counts, { all: 3, week: 1, month: 2 });
    assert.deepEqual(all.body.data.items.map((d) => d.name), ['Dr. Soon', 'Dr. Later', 'Dr. Far']);
    const soon = all.body.data.items[0];
    assert.equal(soon.birthday.daysUntil, 2);
    assert.equal(soon.birthday.turning, 40);
    assert.equal(soon.canWish, true);
    assert.equal(all.body.data.items[2].canWish, false);

    const week = await get(mr, '/birthdays?range=week').expect(200);
    assert.deepEqual(week.body.data.items.map((d) => d.name), ['Dr. Soon']);
  });

  it('sends a wish, notifies the doctor, enforces the window and per-birthday limit', async () => {
    const doctor = await registeredDoctor({ dateOfBirth: dobIn(3) });
    const far = await registeredDoctor({ dateOfBirth: dobIn(100) });
    const mr = await login('mr');

    const sent = await post(mr, `/birthdays/${doctor.id}/wishes`, { message: 'Happy Birthday Doctor!' }).expect(201);
    assert.equal(sent.body.data.mine, true);
    await post(mr, `/birthdays/${doctor.id}/wishes`, { message: 'Second' }).expect(201);
    await post(mr, `/birthdays/${doctor.id}/wishes`, { message: 'Third' }).expect(201);
    const limited = await post(mr, `/birthdays/${doctor.id}/wishes`, { message: 'Fourth' }).expect(429);
    assert.equal(limited.body.error.code, 'WISH_LIMIT');

    const closed = await post(mr, `/birthdays/${far.id}/wishes`, { message: 'Too early' }).expect(422);
    assert.equal(closed.body.error.code, 'WISH_WINDOW_CLOSED');
    await post(mr, `/birthdays/${doctor.id}/wishes`, { message: '   ' }).expect(400);

    const thread = await get(mr, `/birthdays/${doctor.id}/wishes`).expect(200);
    assert.equal(thread.body.data.items.length, 3);
    assert.equal(thread.body.data.remaining, 0);

    const list = await get(mr, '/birthdays').expect(200);
    assert.equal(list.body.data.items.find((d) => d.id === doctor.id).wishedByMe, true);

    const notes = await get(doctor, '/notifications').expect(200);
    assert.equal(notes.body.data.filter((n) => n.type === 'wish.received').length, 3);
  });

  it('lets the doctor read and hide wishes; only the owner can hide or delete', async () => {
    const doctor = await registeredDoctor({ dateOfBirth: dobIn(1) });
    const other = await registeredDoctor({ dateOfBirth: dobIn(1) });
    const [mr, mr2] = await Promise.all([login('mr'), login('mr')]);
    const wish = (await post(mr, `/birthdays/${doctor.id}/wishes`, { message: 'Many happy returns' }).expect(201)).body.data;

    const received = await get(doctor, '/wishes/received').expect(200);
    assert.equal(received.body.data.total, 1);
    assert.equal(received.body.data.birthday.daysUntil, 1);

    await post(other, `/wishes/${wish.id}/hide`).expect(404);
    await post(doctor, `/wishes/${wish.id}/hide`).expect(200);
    assert.equal((await get(mr, `/birthdays/${doctor.id}/wishes`).expect(200)).body.data.items.length, 0);
    assert.equal((await get(doctor, '/wishes/received').expect(200)).body.data.total, 0);
    assert.equal((await get(doctor, '/wishes/received?includeHidden=true').expect(200)).body.data.items.length, 1);

    await del(mr2, `/wishes/${wish.id}`).expect(404);
    await del(mr, `/wishes/${wish.id}`).expect(204);
    await get(mr, '/wishes/received').expect(403);
    await get(doctor, '/birthdays').expect(403);
  });
});

describe('Conferences', () => {
  const conference = (over = {}) => {
    const d = (days) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
    return { title: 'CIS Annual Conference', startDate: d(30), endDate: d(33), venue: 'HICC', city: 'Hyderabad', specialty: 'Cardiology', ...over };
  };

  it('admin publishes, matching doctors are notified, doctors set participation', async () => {
    const admin = await loginAdmin();
    const cardio = await registeredDoctor({ specialty: 'Cardiology' });
    const neuro = await registeredDoctor({ specialty: 'Neurology' });

    const c = (await post(admin, '/conferences', conference()).expect(201)).body.data;
    await post(admin, '/conferences', conference({ title: 'Draft one', status: 'draft' })).expect(201);

    const cardioNotes = await get(cardio, '/notifications').expect(200);
    assert.equal(cardioNotes.body.data[0].type, 'conference.new');
    assert.equal(cardioNotes.body.data[0].data.conferenceId, c.id);
    assert.equal((await get(neuro, '/notifications').expect(200)).body.data.length, 0);

    const list = await get(cardio, '/conferences').expect(200);
    assert.equal(list.body.data.length, 1, 'drafts are hidden');
    assert.equal(list.body.data[0].myStatus, null);

    await put(cardio, `/conferences/${c.id}/participation`, { status: 'registered' }).expect(200);
    await put(cardio, `/conferences/${c.id}/participation`, { status: 'wrong' }).expect(400);
    const mine = await get(cardio, '/conferences').expect(200);
    assert.equal(mine.body.data[0].myStatus, 'registered');
    assert.equal(mine.body.meta.summary.registered, 1);
    assert.equal(mine.body.meta.summary.upcoming, 1);

    const adminView = await get(admin, `/conferences/${c.id}`).expect(200);
    assert.equal(adminView.body.data.participants.registered, 1);

    await del(cardio, `/conferences/${c.id}/participation`).expect(200);
    assert.equal((await get(cardio, '/conferences').expect(200)).body.meta.summary.registered, 0);
  });

  it('guards roles, dates and finished conferences', async () => {
    const admin = await loginAdmin();
    const doctor = await registeredDoctor();
    const mr = await login('mr');

    await post(doctor, '/conferences', conference()).expect(403);
    const bad = await post(admin, '/conferences', conference({ endDate: '2020-01-01' })).expect(400);
    assert.equal(bad.body.error.code, 'VALIDATION_ERROR');
    await post(admin, '/conferences', conference({ logoUrl: 'javascript:alert(1)' })).expect(400);

    const past = (await post(admin, '/conferences', conference({ startDate: '2024-01-01', endDate: '2024-01-03' })).expect(201)).body.data;
    const res = await put(doctor, `/conferences/${past.id}/participation`, { status: 'planning' }).expect(422);
    assert.equal(res.body.error.code, 'CONFERENCE_OVER');

    const c = (await post(admin, '/conferences', conference()).expect(201)).body.data;
    await put(mr, `/conferences/${c.id}/participation`, { status: 'planning' }).expect(403);
    assert.equal((await get(mr, '/conferences').expect(200)).body.data[0].myStatus, undefined);
  });
});

describe('Notifications', () => {
  it('MR booking notifies the doctor and receptionists; approval notifies the MR', async () => {
    const doctor = await registeredDoctor();
    const receptionist = await receptionistFor(doctor, ['view', 'reschedule']);
    const mr = await login('mr');

    const appt = (await post(mr, '/appointments', { doctorId: doctor.id, startAt: slot(0) }).expect(201)).body.data;
    for (const who of [doctor, receptionist]) {
      const notes = await get(who, '/notifications').expect(200);
      const n = notes.body.data.find((x) => x.type === 'appointment.requested');
      assert.ok(n, `${who.user.role} notified`);
      assert.equal(n.data.appointmentId, appt.id);
    }

    await post(receptionist, `/appointments/${appt.id}/approve`).expect(200);
    const mrNotes = await get(mr, '/notifications').expect(200);
    assert.equal(mrNotes.body.data[0].type, 'appointment.approved');
    assert.equal(mrNotes.body.meta.unread, 1);
    // Receptionist acted → the doctor hears about it too, the actor does not.
    assert.ok((await get(doctor, '/notifications').expect(200)).body.data.some((n) => n.type === 'appointment.approved'));
    assert.ok(!(await get(receptionist, '/notifications').expect(200)).body.data.some((n) => n.type === 'appointment.approved'));
  });

  it('marks read, reads all and never exposes another user’s notification', async () => {
    const doctor = await registeredDoctor();
    const mr = await login('mr');
    await post(mr, '/appointments', { doctorId: doctor.id, startAt: slot(0) }).expect(201);
    await post(mr, '/appointments', { doctorId: doctor.id, startAt: slot(1) }).expect(201);

    const list = (await get(doctor, '/notifications').expect(200)).body;
    assert.equal(list.meta.unread, 2);
    await post(mr, `/notifications/${list.data[0].id}/read`).expect(404);
    await post(doctor, `/notifications/${list.data[0].id}/read`).expect(200);
    assert.equal((await get(doctor, '/notifications/unread-count').expect(200)).body.data.unread, 1);
    await post(doctor, '/notifications/read-all').expect(200);
    assert.equal((await get(doctor, '/notifications?unread=true').expect(200)).body.data.length, 0);
  });
});

describe('Reports', () => {
  it('scopes data per role and blocks reports of the other audience', async () => {
    const doctor = await registeredDoctor();
    const otherDoctor = await registeredDoctor();
    const [mr1, mr2] = await Promise.all([login('mr'), login('mr')]);
    await post(mr1, '/appointments', { doctorId: doctor.id, startAt: slot(0) }).expect(201);
    await post(mr1, '/appointments', { doctorId: otherDoctor.id, startAt: slot(0) }).expect(201);
    await post(mr2, '/appointments', { doctorId: doctor.id, startAt: slot(1) }).expect(201);

    const q = '?to=' + new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10);
    const mine = await get(mr1, `/reports/performance${q}`).expect(200);
    assert.equal(mine.body.data.rows.find((r) => r.metric === 'Total appointments').value, 2);
    await get(mr1, `/reports/company-visits${q}`).expect(403);

    const doc = await get(doctor, `/reports/mr-wise${q}`).expect(200);
    assert.equal(doc.body.data.rows.reduce((a, r) => a + r.visits, 0), 2);
    await get(doctor, `/reports/performance${q}`).expect(403);

    const receptionist = await receptionistFor(doctor);
    const rec = await get(receptionist, `/reports/monitoring${q}`).expect(200);
    assert.equal(rec.body.data.rows.length, 2);
    await get(receptionist, `/reports/monitoring${q}&doctorId=${otherDoctor.id}`).expect(403);

    const filters = await get(mr1, '/reports/filters').expect(200);
    assert.equal(filters.body.data.doctors.length, 2);
    assert.equal(filters.body.data.reports.length, 6);
  });

  it('exports CSV with spreadsheet formulas neutralised and validates ranges', async () => {
    const doctor = await registeredDoctor();
    await post(doctor, '/appointments', {
      startAt: slot(0),
      visitor: { name: '=HYPERLINK("http://evil")', company: '+Cipla' },
    }).expect(201);

    const q = '?to=' + new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10);
    const csv = await get(doctor, `/reports/mr-wise${q}&format=csv`).expect(200);
    assert.match(csv.headers['content-type'], /text\/csv/);
    assert.match(csv.headers['content-disposition'], /attachment; filename="mr-wise_/);
    assert.ok(csv.text.includes(`"'=HYPERLINK(""http://evil"")"`));
    assert.ok(csv.text.includes(`"'+Cipla"`));

    await get(doctor, '/reports/mr-wise?from=2024-01-01&to=2026-01-01').expect(400);
    await get(doctor, '/reports/mr-wise?from=2026-02-01&to=2026-01-01').expect(400);
    await get(doctor, '/reports/nope').expect(400);
  });
});
