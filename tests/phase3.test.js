import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { after, before, beforeEach, describe, it } from 'node:test';

import { seedCatalog } from '../scripts/catalog.js';
import { PaymentOrder, Subscription } from '../src/modules/billing/billing.models.js';
import { P, api, auth, login, loginAdmin, loginReceptionist, nextMobile, registeredDoctor, reset, setup, teardown } from './helpers.js';

before(setup);
after(teardown);
beforeEach(async () => {
  await reset();
  await seedCatalog();
});

const get = (who, path) => api().get(`${P}${path}`).set(auth(who.token));
const post = (who, path, body = {}) => api().post(`${P}${path}`).set(auth(who.token)).send(body);
const patch = (who, path, body = {}) => api().patch(`${P}${path}`).set(auth(who.token)).send(body);
const put = (who, path, body = {}) => api().put(`${P}${path}`).set(auth(who.token)).send(body);
const DAY = 86_400_000;

async function buy(mr, planCode = 'mr-yearly', simulate) {
  const { order } = (await post(mr, '/subscriptions/checkout', { planCode, method: 'upi' }).expect(201)).body.data;
  return { order, res: await post(mr, `/subscriptions/orders/${order.id}/confirm`, simulate ? { simulate } : {}) };
}

describe('Plans & subscriptions', () => {
  it('lists plans per role with a GST-inclusive split', async () => {
    const [mr, doctor] = await Promise.all([login('mr'), registeredDoctor()]);
    const mrPlans = (await get(mr, '/plans').expect(200)).body.data;
    assert.deepEqual(mrPlans.map((p) => p.code), ['mr-yearly', 'mr-monthly']);
    const yearly = mrPlans[0];
    assert.equal(yearly.pricePaise, 20000);
    assert.equal(yearly.basePaise + yearly.taxPaise, 20000);
    assert.equal(yearly.basePaise, 16949);
    assert.deepEqual((await get(doctor, '/plans').expect(200)).body.data.map((p) => p.code), ['doctor-lifetime-free']);
  });

  it('charges the server price, activates a year and shows it on /me', async () => {
    const mr = await login('mr');
    const checkout = await post(mr, '/subscriptions/checkout', { planCode: 'mr-yearly', method: 'gpay', amountPaise: 1 }).expect(201);
    assert.equal(checkout.body.data.order.amountPaise, 20000, 'client amount is ignored');
    assert.equal(checkout.body.data.order.status, 'created');

    const res = await post(mr, `/subscriptions/orders/${checkout.body.data.order.id}/confirm`).expect(200);
    assert.equal(res.body.data.order.status, 'paid');
    const ends = new Date(res.body.data.subscription.endsAt).getTime();
    assert.ok(Math.abs(ends - (Date.now() + 365 * DAY)) < 60_000);

    const me = (await get(mr, '/me').expect(200)).body.data;
    assert.equal(me.subscription.plan.code, 'mr-yearly');
    const notes = (await get(mr, '/notifications').expect(200)).body.data;
    assert.equal(notes[0].type, 'subscription.activated');
  });

  it('confirming twice (even concurrently) grants one subscription', async () => {
    const mr = await login('mr');
    const { order } = (await post(mr, '/subscriptions/checkout', { planCode: 'mr-monthly', method: 'upi' }).expect(201)).body.data;
    const results = await Promise.all([1, 2, 3].map(() => post(mr, `/subscriptions/orders/${order.id}/confirm`)));
    assert.ok(results.every((r) => r.status === 200), JSON.stringify(results.map((r) => r.body)));
    assert.equal(await Subscription.countDocuments({ user: mr.id }), 1);
    await post(mr, `/subscriptions/orders/${order.id}/confirm`).expect(200);
    assert.equal(await Subscription.countDocuments({ user: mr.id }), 1);
  });

  it('renewals stack on the remaining time', async () => {
    const mr = await login('mr');
    await buy(mr, 'mr-monthly');
    const { res } = await buy(mr, 'mr-monthly');
    const ends = new Date(res.body.data.subscription.endsAt).getTime();
    assert.ok(Math.abs(ends - (Date.now() + 60 * DAY)) < 60_000);
  });

  it('handles failed and expired payments without granting access', async () => {
    const mr = await login('mr');
    const { order, res } = await buy(mr, 'mr-yearly', 'failure');
    assert.equal(res.status, 422);
    assert.equal(res.body.error.code, 'PAYMENT_FAILED');
    const again = await post(mr, `/subscriptions/orders/${order.id}/confirm`).expect(422);
    assert.equal(again.body.error.code, 'ORDER_CLOSED');

    const { order: late } = (await post(mr, '/subscriptions/checkout', { planCode: 'mr-yearly', method: 'card' }).expect(201)).body.data;
    await PaymentOrder.updateOne({ _id: late.id }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    const expired = await post(mr, `/subscriptions/orders/${late.id}/confirm`).expect(422);
    assert.equal(expired.body.error.code, 'ORDER_EXPIRED');
    assert.equal((await get(mr, '/subscriptions/me').expect(200)).body.data.current, null);
  });

  it('keeps orders private and plans role-bound; free plan is claimed, not bought', async () => {
    const [mr, other, doctor] = await Promise.all([login('mr'), login('mr'), registeredDoctor()]);
    const { order } = (await post(mr, '/subscriptions/checkout', { planCode: 'mr-yearly', method: 'upi' }).expect(201)).body.data;
    await post(other, `/subscriptions/orders/${order.id}/confirm`).expect(404);

    await post(doctor, '/subscriptions/checkout', { planCode: 'mr-yearly', method: 'upi' }).expect(403);
    const free = await post(doctor, '/subscriptions/checkout', { planCode: 'doctor-lifetime-free', method: 'upi' }).expect(422);
    assert.equal(free.body.error.code, 'PLAN_IS_FREE');
    await post(mr, '/subscriptions/claim-free', { planCode: 'doctor-lifetime-free' }).expect(403);
    await post(mr, '/subscriptions/checkout', { planCode: 'mr-yearly', method: 'bitcoin' }).expect(400);

    const claim = await post(doctor, '/subscriptions/claim-free', { planCode: 'doctor-lifetime-free' }).expect(200);
    assert.equal(claim.body.data.subscription.lifetime, true);
    await post(doctor, '/subscriptions/claim-free', { planCode: 'doctor-lifetime-free' }).expect(200);
    assert.equal(await Subscription.countDocuments({ user: doctor.id }), 1);
  });

  it('refuses the mock payment provider in production', () => {
    const out = spawnSync(process.execPath, ['-e', "import('./src/config/env.js')"], {
      env: {
        ...process.env,
        NODE_ENV: 'production',
        OTP_DEV_MODE: 'false',
        PAYMENT_PROVIDER: 'mock',
        MONGODB_URI: 'mongodb://x',
      },
      encoding: 'utf8',
    });
    assert.notEqual(out.status, 0);
    assert.match(out.stderr, /mock payment provider cannot be used in production/);

    // With payments switched off the server starts, and checkout says so plainly.
    const off = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        "const { env } = await import('./src/config/env.js'); const b = await import('./src/modules/billing/billing.service.js'); " +
          "try { await b.checkout({ role: 'mr' }, { planCode: 'mr-yearly', method: 'upi' }); } catch (e) { console.log(env.isProduction, e.status, e.code); }",
      ],
      { env: { ...process.env, NODE_ENV: 'production', OTP_DEV_MODE: 'false', PAYMENTS_ENABLED: 'false', MONGODB_URI: 'mongodb://x' }, encoding: 'utf8' },
    );
    assert.equal(off.status, 0, off.stderr);
    assert.match(off.stdout, /true 503 PAYMENTS_UNAVAILABLE/);
  });

  it('refuses to "send" an OTP when no SMS gateway exists outside dev mode', () => {
    const out = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        "const o = await import('./src/modules/auth/otp.service.js'); try { await o.issueOtp('9876543210', 'login:mr'); } catch (e) { console.log(e.status, e.code); }",
      ],
      { env: { ...process.env, NODE_ENV: 'test', OTP_DEV_MODE: 'false', MONGODB_URI: 'mongodb://x' }, encoding: 'utf8' },
    );
    assert.equal(out.status, 0, out.stderr);
    assert.match(out.stdout, /503 SMS_NOT_CONFIGURED/);
  });
});

describe('Help desk tickets', () => {
  it('creates tickets from listed categories with limits and privacy', async () => {
    const [mr, other] = await Promise.all([login('mr'), login('mr')]);
    const info = (await get(mr, '/support').expect(200)).body.data;
    assert.ok(info.topics.length > 0);
    assert.equal(info.email, 'mr@miodoctors.com');

    const t = (await post(mr, '/help-tickets', { category: info.topics[0], message: 'The doctor timings shown are wrong.' }).expect(201)).body.data;
    assert.match(t.number, /^HD\d{5}$/);
    assert.equal(t.status, 'open');
    await post(mr, '/help-tickets', { category: 'Made up', message: 'Something is wrong here.' }).expect(400);
    await post(mr, '/help-tickets', { category: info.topics[0], message: 'short' }).expect(400);

    await get(other, `/help-tickets/${t.id}`).expect(404);
    assert.equal((await get(other, '/help-tickets').expect(200)).body.data.length, 0);

    for (let i = 0; i < 4; i++) {
      await post(mr, '/help-tickets', { category: info.topics[1], message: `Issue number ${i} details` }).expect(201);
    }
    const limited = await post(mr, '/help-tickets', { category: info.topics[1], message: 'One more issue here' }).expect(422);
    assert.equal(limited.body.error.code, 'TOO_MANY_OPEN_TICKETS');
  });

  it('admin replies and resolves; the user is notified and can follow up', async () => {
    const admin = await loginAdmin();
    const doctor = await registeredDoctor();
    const { topics } = (await get(doctor, '/support').expect(200)).body.data;
    const t = (await post(doctor, '/help-tickets', { category: topics[2], message: 'The app does not open on my phone.' }).expect(201)).body.data;

    const all = (await get(admin, '/help-tickets').expect(200)).body.data;
    assert.equal(all[0].user.id, doctor.id);

    const replied = (await post(admin, `/help-tickets/${t.id}/replies`, { message: 'Please update the app.' }).expect(200)).body.data;
    assert.equal(replied.status, 'in_progress');
    assert.equal(replied.replies[0].fromSupport, true);
    await patch(doctor, `/help-tickets/${t.id}`, { status: 'resolved' }).expect(403);
    await patch(admin, `/help-tickets/${t.id}`, { status: 'resolved' }).expect(200);

    const notes = (await get(doctor, '/notifications').expect(200)).body.data.filter((n) => n.type === 'ticket.updated');
    assert.equal(notes.length, 2);

    const followUp = (await post(doctor, `/help-tickets/${t.id}/replies`, { message: 'Still not working' }).expect(200)).body.data;
    assert.equal(followUp.status, 'open');
    await patch(admin, `/help-tickets/${t.id}`, { status: 'closed' }).expect(200);
    const closed = await post(doctor, `/help-tickets/${t.id}/replies`, { message: 'Hello?' }).expect(422);
    assert.equal(closed.body.error.code, 'TICKET_CLOSED');
  });

  it('hides WhatsApp for receptionists and lets admin change contacts', async () => {
    const admin = await loginAdmin();
    await put(admin, '/support', { whatsapp: '+919000012345' }).expect(200);
    const doctor = await registeredDoctor();
    const mobile = nextMobile();
    await post(doctor, '/doctors/me/receptionists', { name: 'R', mobile, permissions: ['view'] }).expect(201);
    const receptionist = await loginReceptionist(mobile);
    assert.equal((await get(doctor, '/support').expect(200)).body.data.whatsapp, '+919000012345');
    assert.equal((await get(receptionist, '/support').expect(200)).body.data.whatsapp, null);
    await put(doctor, '/support', { whatsapp: '+919000012345' }).expect(403);
    await put(admin, '/support', { whatsapp: 'call me' }).expect(400);
  });
});

describe('FAQs, content and settings', () => {
  it('serves FAQs and terms publicly; only admins edit them', async () => {
    const all = (await api().get(`${P}/faqs`).expect(200)).body.data;
    const mrOnly = (await api().get(`${P}/faqs?role=mr`).expect(200)).body.data;
    assert.ok(mrOnly.length < all.length);
    assert.ok(mrOnly.every((f) => ['all', 'mr'].includes(f.audience)));

    const admin = await loginAdmin();
    const mr = await login('mr');
    await api().post(`${P}/faqs`).send({ question: 'Hello there?', answer: 'Hi' }).expect(401);
    await post(mr, '/faqs', { question: 'Hello there?', answer: 'Hi' }).expect(403);
    const faq = (await post(admin, '/faqs', { audience: 'mr', question: 'How do I renew?', answer: 'Open Subscription Plan.' }).expect(201)).body.data;
    assert.equal((await api().get(`${P}/faqs?role=mr`).expect(200)).body.data.length, mrOnly.length + 1);
    await api().delete(`${P}/faqs/${faq.id}`).set(auth(admin.token)).expect(204);

    const tos = (await api().get(`${P}/content/terms-of-service`).expect(200)).body.data;
    assert.equal(tos.version, 1);
    assert.ok(tos.sections.length >= 3);
    await api().get(`${P}/content/secret-page`).expect(400);
    await put(mr, '/content/terms-of-service', { ...tos }).expect(403);
    const saved = (
      await put(admin, '/content/terms-of-service', { title: tos.title, effectiveDate: '2026-10-01', intro: tos.intro, sections: tos.sections }).expect(200)
    ).body.data;
    assert.equal(saved.version, 2);
    assert.equal(saved.effectiveDate, '2026-10-01');
  });

  it('saves app settings on the user', async () => {
    const mr = await login('mr');
    const res = await patch(mr, '/me/settings', { language: 'te', notifications: false }).expect(200);
    assert.deepEqual(res.body.data, { notifications: false, language: 'te' });
    assert.equal((await get(mr, '/me').expect(200)).body.data.user.settings.language, 'te');
    await patch(mr, '/me/settings', { language: 'fr' }).expect(400);
    await patch(mr, '/me/settings', { role: 'admin' }).expect(400);
    await patch(mr, '/me/settings', {}).expect(400);
  });
});
