import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { seedCatalog } from '../scripts/catalog.js';
import { P, api, auth, login, loginAdmin, loginReceptionist, nextMobile, registeredDoctor, reset, setup, slot, teardown } from './helpers.js';

before(setup);
after(teardown);
beforeEach(async () => {
  await reset();
  await seedCatalog();
});

const get = (who, path) => api().get(`${P}${path}`).set(auth(who.token));
const post = (who, path, body = {}) => api().post(`${P}${path}`).set(auth(who.token)).send(body);
const patch = (who, path, body = {}) => api().patch(`${P}${path}`).set(auth(who.token)).send(body);

describe('Admin API', () => {
  it('is closed to every non-admin role and to anonymous callers', async () => {
    const [doctor, mr] = await Promise.all([registeredDoctor(), login('mr')]);
    for (const path of ['/admin/dashboard', '/admin/users', '/admin/audit-logs', '/admin/orders']) {
      await api().get(`${P}${path}`).expect(401);
      await get(doctor, path).expect(403);
      await get(mr, path).expect(403);
    }
  });

  it('dashboard aggregates users, appointments, tickets and revenue', async () => {
    const admin = await loginAdmin();
    const doctor = await registeredDoctor();
    const mr = await login('mr');
    await post(mr, '/appointments', { doctorId: doctor.id, startAt: slot(0) }).expect(201);
    const { order } = (await post(mr, '/subscriptions/checkout', { planCode: 'mr-monthly', method: 'upi' }).expect(201)).body.data;
    await post(mr, `/subscriptions/orders/${order.id}/confirm`).expect(200);

    const d = (await get(admin, '/admin/dashboard').expect(200)).body.data;
    assert.equal(d.users.doctor, 1);
    assert.equal(d.users.mr, 1);
    assert.equal(d.upcomingNext7Days, 1);
    assert.equal(d.activeSubscriptions, 1);
    assert.deepEqual(d.revenueLast30Days, { paise: 2000, orders: 1 });
    assert.equal(d.appointmentTrend.length, 14);
  });

  it('lists, searches and deactivates users — deactivation ends their sessions', async () => {
    const admin = await loginAdmin();
    const doctor = await registeredDoctor({ name: 'Dr. Findable Person' });
    await login('mr');

    const all = (await get(admin, '/admin/users').expect(200)).body;
    assert.equal(all.meta.total, 2);
    const found = (await get(admin, '/admin/users?q=Findable').expect(200)).body.data;
    assert.equal(found.length, 1);
    assert.match(found[0].code, /^DR\d+/);
    await get(admin, '/admin/users?q=%24where').expect(200); // regex-escaped, no injection

    const detail = (await get(admin, `/admin/users/${doctor.id}`).expect(200)).body.data;
    assert.equal(detail.profile.specialty, 'Cardiology');

    await patch(admin, `/admin/users/${doctor.id}/status`, { status: 'inactive' }).expect(200);
    await get(doctor, '/me').expect(401); // token version bumped
    await patch(admin, `/admin/users/${doctor.id}/status`, { status: 'deleted' }).expect(400);
    await patch(admin, `/admin/users/${admin.id}/status`, { status: 'inactive' }).expect(404); // admins are not managed here
    await patch(admin, `/admin/users/${doctor.id}/status`, { status: 'active' }).expect(200);
  });

  it('manages receptionist access across doctors', async () => {
    const admin = await loginAdmin();
    const doctor = await registeredDoctor();
    const mobile = nextMobile();
    await post(doctor, '/doctors/me/receptionists', { name: 'Rita', mobile, permissions: ['view', 'book'] }).expect(201);
    const receptionist = await loginReceptionist(mobile);

    const [grant] = (await get(admin, '/admin/receptionist-access').expect(200)).body.data;
    assert.equal(grant.doctor.id, doctor.id);
    assert.deepEqual(grant.permissions.sort(), ['book', 'view']);

    const updated = (await patch(admin, `/admin/receptionist-access/${grant.id}`, { status: 'inactive' }).expect(200)).body.data;
    assert.equal(updated.status, 'inactive');
    await get(receptionist, `/appointments?doctorId=${doctor.id}`).expect(403);
    await patch(admin, `/admin/receptionist-access/${grant.id}`, { status: 'pending' }).expect(400);
  });

  it('shows orders, subscriptions, all plans, FAQs and filtered audit logs', async () => {
    const admin = await loginAdmin();
    const mr = await login('mr');
    const { order } = (await post(mr, '/subscriptions/checkout', { planCode: 'mr-yearly', method: 'card' }).expect(201)).body.data;
    await post(mr, `/subscriptions/orders/${order.id}/confirm`, { simulate: 'failure' }).expect(422);

    const orders = (await get(admin, '/admin/orders?status=failed').expect(200)).body.data;
    assert.equal(orders.length, 1);
    assert.equal(orders[0].user.id, mr.id);
    assert.equal((await get(admin, '/admin/subscriptions?state=active').expect(200)).body.data.length, 0);

    await api().put(`${P}/plans`).set(auth(admin.token)).send({ code: 'mr-old', role: 'mr', name: 'Old', period: 'monthly', pricePaise: 100, active: false }).expect(200);
    const plans = (await get(admin, '/admin/plans').expect(200)).body.data;
    assert.ok(plans.some((p) => p.code === 'mr-old' && !p.active), 'inactive plans are visible to admins');
    assert.ok(!(await get(mr, '/plans').expect(200)).body.data.some((p) => p.code === 'mr-old'));

    assert.ok((await get(admin, '/admin/faqs').expect(200)).body.data.length > 0);

    const logs = (await get(admin, '/admin/audit-logs?module=billing').expect(200)).body;
    assert.ok(logs.data.length >= 2);
    assert.ok(logs.data.every((l) => l.module === 'billing'));
    assert.ok(logs.meta.modules.includes('auth'));
    await get(admin, '/admin/audit-logs?actorId=bad').expect(400);
  });
});
