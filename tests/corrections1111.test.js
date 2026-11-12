/**
 * Corrections of 11 Nov 2026: doctor ↔ receptionist links in the admin user
 * list, receptionist "request a doctor", MR registration type-ahead options,
 * Annual / Quarterly plans.
 */
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import mongoose from 'mongoose';

import { P, api, auth, login, loginAdmin, loginReceptionist, nextMobile, registeredDoctor, reset, setup, teardown } from './helpers.js';
import { MR_FEATURES, seedCatalog } from '../scripts/catalog.js';
import { runMigrations } from '../scripts/migrate.js';
import { ReceptionistAccess } from '../src/modules/access/receptionistAccess.model.js';
import { Plan } from '../src/modules/billing/billing.models.js';

before(setup);
after(teardown);
beforeEach(async () => {
  await reset();
  await seedCatalog();
});

const get = (who, p) => api().get(`${P}${p}`).set(auth(who.token));
const post = (who, p, body = {}) => api().post(`${P}${p}`).set(auth(who.token)).send(body);
const put = (who, p, body = {}) => api().put(`${P}${p}`).set(auth(who.token)).send(body);
const patch = (who, p, body = {}) => api().patch(`${P}${p}`).set(auth(who.token)).send(body);
const DAY = 86_400_000;
const codeOf = async (who) => (await get(who, '/me').expect(200)).body.data.profile.code;

/** Receptionist approved by `doctor` and signed in. */
async function receptionistOf(doctor, name = 'Priya') {
  const mobile = nextMobile();
  await post(doctor, '/doctors/me/receptionists', { name, mobile, permissions: ['view'] }).expect(201);
  return loginReceptionist(mobile);
}

describe('Admin user list: doctor ↔ receptionist links', () => {
  it('shows tagged doctors on receptionists and receptionists on doctors, active first, removed hidden', async () => {
    const [d1, d2, d3] = await Promise.all([registeredDoctor({ name: 'Dr. One' }), registeredDoctor({ name: 'Dr. Two' }), registeredDoctor({ name: 'Dr. Three' })]);
    const [c1, c2, c3] = await Promise.all([codeOf(d1), codeOf(d2), codeOf(d3)]);
    const r = await receptionistOf(d1);
    await post(r, '/receptionists/me/doctor-access', { doctor: c2 }).expect(200); // pending with Dr. Two
    // Dr. Three approved, then removed: not shown.
    await post(r, '/receptionists/me/doctor-access', { doctor: c3 }).expect(200);
    await patch(d3, `/doctors/me/receptionists/${r.id}`, { status: 'active' }).expect(200);
    await patch(d3, `/doctors/me/receptionists/${r.id}`, { status: 'inactive' }).expect(200);
    const rCode = await codeOf(r);

    const admin = await loginAdmin();
    const recs = (await get(admin, '/admin/users?role=receptionist').expect(200)).body.data;
    const row = recs.find((u) => u.id === r.id);
    assert.deepEqual(
      row.links.map((l) => [l.code, l.status, l.name]),
      [
        [c1, 'active', 'Dr. One'],
        [c2, 'pending', 'Dr. Two'],
      ],
    );
    assert.equal(row.links[0].id, d1.id, 'each link carries the user id the panel opens');

    const docs = (await get(admin, '/admin/users?role=doctor').expect(200)).body.data;
    const byId = new Map(docs.map((d) => [d.id, d]));
    assert.deepEqual(byId.get(d1.id).links.map((l) => [l.code, l.status]), [[rCode, 'active']]);
    assert.deepEqual(byId.get(d2.id).links.map((l) => [l.code, l.status]), [[rCode, 'pending']]);
    assert.deepEqual(byId.get(d3.id).links, []);
    // MRs carry no links field; the user drawer shows the code of the other side.
    const all = (await get(admin, '/admin/users').expect(200)).body.data;
    assert.ok(all.filter((u) => u.role === 'mr').every((u) => !('links' in u)));
    const drawer = (await get(admin, `/admin/users/${r.id}`).expect(200)).body.data;
    assert.ok(drawer.access.some((a) => a.with.code === c1));
  });
});

describe('Receptionist: request another doctor', () => {
  it('files a request with a new doctor, notifies them, and handles repeats and removals', async () => {
    const [d1, d2] = await Promise.all([registeredDoctor({ name: 'Dr. One' }), registeredDoctor({ name: 'Dr. Two' })]);
    const c2 = await codeOf(d2);
    const r = await receptionistOf(d1);

    const first = (await post(r, '/receptionists/me/doctor-access', { doctor: c2.toLowerCase() }).expect(200)).body.data;
    assert.equal(first.status, 'pending');
    assert.equal(first.alreadyRequested, false);
    assert.deepEqual([first.doctor.name, first.doctor.code], ['Dr. Two', c2]);
    assert.deepEqual(first.doctors.map((d) => [d.doctor.name, d.status]), [['Dr. One', 'active'], ['Dr. Two', 'pending']]);
    const notes = (await get(d2, '/notifications').expect(200)).body.data;
    assert.equal(notes.filter((n) => n.type === 'access.requested').length, 1);

    // Asking again: nothing new, no second notification.
    const again = (await post(r, '/receptionists/me/doctor-access', { doctor: c2 }).expect(200)).body.data;
    assert.equal(again.alreadyRequested, true);
    assert.equal((await get(d2, '/notifications').expect(200)).body.data.filter((n) => n.type === 'access.requested').length, 1);

    // Already working for Dr. One (by mobile too).
    const linked = await post(r, '/receptionists/me/doctor-access', { doctor: d1.mobile }).expect(409);
    assert.equal(linked.body.error.code, 'ALREADY_LINKED');
    assert.equal((await post(r, '/receptionists/me/doctor-access', { doctor: 'DR99999' }).expect(404)).body.error.code, 'DOCTOR_NOT_FOUND');
    await post(r, '/receptionists/me/doctor-access', { doctor: 'hello' }).expect(400);
    await post(r, '/receptionists/me/doctor-access', {}).expect(400);

    // Dr. Two approves → both active; the receptionist can see Dr. Two's day.
    await patch(d2, `/doctors/me/receptionists/${r.id}`, { status: 'active' }).expect(200);
    const list = (await get(r, '/receptionists/me/doctor-access').expect(200)).body.data;
    assert.deepEqual(list.map((d) => d.status), ['active', 'active']);
    assert.equal((await get(r, '/receptionists/me/doctors').expect(200)).body.data.length, 2);

    // Removed by Dr. Two → may ask again (pending, Dr. Two notified again).
    await patch(d2, `/doctors/me/receptionists/${r.id}`, { status: 'inactive' }).expect(200);
    const reopened = (await post(r, '/receptionists/me/doctor-access', { doctor: c2 }).expect(200)).body.data;
    assert.equal(reopened.alreadyRequested, false);
    assert.equal((await ReceptionistAccess.findOne({ doctor: d2.id, receptionist: r.id }).lean()).status, 'pending');
    assert.equal((await get(d2, '/notifications').expect(200)).body.data.filter((n) => n.type === 'access.requested').length, 2);
  });

  it('only receptionists can use it', async () => {
    const [mr, doctor] = await Promise.all([login('mr'), registeredDoctor()]);
    await post(mr, '/receptionists/me/doctor-access', { doctor: await codeOf(doctor) }).expect(403);
    await get(doctor, '/receptionists/me/doctor-access').expect(403);
  });

  it('sign-in "Send Request" naming a new doctor files the request even when already approved', async () => {
    const [d1, d2] = await Promise.all([registeredDoctor(), registeredDoctor()]);
    const r = await receptionistOf(d1);
    const res = await api().post(`${P}/auth/receptionist/request`).send({ mobile: r.mobile, doctorCode: await codeOf(d2) }).expect(200);
    assert.equal(res.body.data.status, 'granted', 'still signs in');
    assert.equal((await ReceptionistAccess.findOne({ doctor: d2.id, receptionist: r.id }).lean()).status, 'pending');
    // Naming the doctor they already work for changes nothing.
    await api().post(`${P}/auth/receptionist/request`).send({ mobile: r.mobile, doctorCode: await codeOf(d1) }).expect(200);
    assert.equal(await ReceptionistAccess.countDocuments({ receptionist: r.id }), 2);
  });
});

describe('MR registration type-ahead options', () => {
  const profile = (company, division) => ({
    name: 'Rohit Verma',
    qualification: 'B.Pharm',
    gender: 'male',
    age: 28,
    dateOfBirth: '05/06',
    maritalStatus: 'Single',
    company: { name: company, type: 'Pharmaceutical', address: 'Hyderabad' },
    designation: 'Medical Representative',
    joiningDate: '01/01/2025',
    employeeCode: 'E-1',
    email: `${nextMobile()}@example.com`,
    specialties: ['Cardiology'],
    division,
    hq: { name: 'Hyderabad HQ', class: 'Metro', city: 'Hyderabad', district: 'Hyderabad', state: 'Telangana', zone: 'East' },
    referralMobile: nextMobile(),
  });

  it('lists companies and the divisions of a company, once each, ignoring case and spaces', async () => {
    const entries = [
      ['Cipla', 'Cardio'],
      ['cipla ', 'Neuro'],
      ['Cipla', 'cardio'],
      ['Sun  Pharma', 'Derma'],
    ];
    for (const [company, division] of entries) {
      const mr = await login('mr');
      await put(mr, '/mrs/me/profile', profile(company, division)).expect(200);
    }
    const mr = await login('mr');
    const all = (await get(mr, '/mrs/me/registration-options').expect(200)).body.data;
    assert.deepEqual(all.companies, ['Cipla', 'Sun Pharma']);
    assert.deepEqual(all.divisions, ['Cardio', 'Derma', 'Neuro']);
    assert.deepEqual((await get(mr, '/mrs/me/registration-options?company=CIPLA').expect(200)).body.data.divisions, ['Cardio', 'Neuro']);
    assert.deepEqual((await get(mr, '/mrs/me/registration-options?company=Abbott').expect(200)).body.data.divisions, []);
    // Regex characters are taken literally.
    assert.deepEqual((await get(mr, '/mrs/me/registration-options?company=.*').expect(200)).body.data.divisions, []);
    await get(await registeredDoctor(), '/mrs/me/registration-options').expect(403);
  });
});

describe('Plans: Annual and Quarterly', () => {
  it('MRs see Annual ₹200 and Quarterly ₹60 (struck ₹120) for 90 days; Monthly is gone', async () => {
    const mr = await login('mr');
    const plans = (await get(mr, '/plans').expect(200)).body.data;
    assert.deepEqual(
      plans.map((p) => [p.code, p.name, p.period, p.pricePaise, p.mrpPaise]),
      [
        ['mr-free-2-months', '2 Months Free', 'trial', 0, 4000],
        ['mr-yearly', 'Annual', 'yearly', 20000, 40000],
        ['mr-quarterly', 'Quarterly', 'quarterly', 6000, 12000],
      ],
    );
    assert.match(plans[0].howToAvail.at(-1), /Quarterly or Annual/);

    const { order } = (await post(mr, '/subscriptions/checkout', { planCode: 'mr-quarterly', method: 'upi' }).expect(201)).body.data;
    assert.equal(order.amountPaise, 6000);
    const sub = (await post(mr, `/subscriptions/orders/${order.id}/confirm`).expect(200)).body.data.subscription;
    assert.ok(Math.abs(new Date(sub.endsAt).getTime() - (Date.now() + 90 * DAY)) < 60_000);
    // The retired plan cannot be bought.
    await post(mr, '/subscriptions/checkout', { planCode: 'mr-monthly', method: 'upi' }).expect(404);
  });

  it('migration renames Yearly, adds Quarterly, retires Monthly, keeps edits, and rolls back', async () => {
    const db = mongoose.connection.db;
    const plans = db.collection('plans');
    // A database as it was before: Yearly / Monthly, old trial step, custom features.
    await plans.deleteOne({ code: 'mr-quarterly' });
    await plans.updateOne({ code: 'mr-yearly' }, { $set: { name: 'Yearly', features: ['Our wording'] } });
    await Plan.create({ code: 'mr-monthly', role: 'mr', name: 'Monthly', period: 'monthly', pricePaise: 2000, mrpPaise: 4000, features: MR_FEATURES, sort: 2 });
    const oldStep = 'Before it ends, choose Monthly or Yearly to continue — the paid time starts after your free days';
    await plans.updateOne({ code: 'mr-free-2-months' }, { $set: { 'howToAvail.3': oldStep } });
    const mr = await login('mr');
    // Someone already on Monthly keeps it.
    const { order } = (await post(mr, '/subscriptions/checkout', { planCode: 'mr-monthly', method: 'upi' }).expect(201)).body.data;
    const ends = (await post(mr, `/subscriptions/orders/${order.id}/confirm`).expect(200)).body.data.subscription.endsAt;

    await db.collection('migrations').deleteMany({});
    for (const [i, name] of ['20261004-001-locations-and-banners.js', '20261015-001-ui-changes-oct-2026.js', '20261018-001-app-corrections.js'].entries()) {
      await db.collection('migrations').insertOne({ name, appliedAt: new Date(i) });
    }
    await runMigrations('up', { quiet: true });
    const byCode = async (code) => plans.findOne({ code });
    assert.equal((await byCode('mr-yearly')).name, 'Annual');
    const quarterly = await byCode('mr-quarterly');
    assert.deepEqual([quarterly.pricePaise, quarterly.mrpPaise, quarterly.period, quarterly.active], [6000, 12000, 'quarterly', true]);
    assert.deepEqual(quarterly.features, ['Our wording'], 'follows the current MR plan features');
    assert.equal((await byCode('mr-monthly')).active, false);
    assert.match((await byCode('mr-free-2-months')).howToAvail[3], /Quarterly or Annual/);
    assert.equal((await get(mr, '/subscriptions/me').expect(200)).body.data.current.endsAt, ends);
    assert.deepEqual((await get(mr, '/plans').expect(200)).body.data.map((p) => p.code), ['mr-free-2-months', 'mr-yearly', 'mr-quarterly']);

    // An admin-chosen name is not touched; down restores the rest.
    await runMigrations('down', { quiet: true });
    assert.equal((await byCode('mr-yearly')).name, 'Yearly');
    assert.equal((await byCode('mr-quarterly')).active, false);
    assert.equal((await byCode('mr-monthly')).active, true);
    assert.equal((await byCode('mr-free-2-months')).howToAvail[3], oldStep);
    await plans.updateOne({ code: 'mr-yearly' }, { $set: { name: 'Gold Year' } });
    await runMigrations('up', { quiet: true });
    assert.equal((await byCode('mr-yearly')).name, 'Gold Year');
  });
});
