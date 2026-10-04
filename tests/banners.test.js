import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';

// helpers.js first: it sets the test environment before any config is loaded.
import { P, api, auth, login, loginAdmin, registeredDoctor, reset, setup, teardown } from './helpers.js';
import { makePng } from '../scripts/lib/png.js';
import { runMigrations } from '../scripts/migrate.js';
import { seedCatalog } from '../scripts/catalog.js';
import { DoctorProfile } from '../src/modules/profiles/profile.models.js';

before(setup);
after(teardown);
beforeEach(async () => {
  await reset();
  await seedCatalog();
  await runMigrations('up', { quiet: true });
});

const get = (who, p) => api().get(`${P}${p}`).set(auth(who.token));
const post = (who, p, body = {}) => api().post(`${P}${p}`).set(auth(who.token)).send(body);
const put = (who, p, body = {}) => api().put(`${P}${p}`).set(auth(who.token)).send(body);
const patch = (who, p, body = {}) => api().patch(`${P}${p}`).set(auth(who.token)).send(body);
const del = (who, p) => api().delete(`${P}${p}`).set(auth(who.token));

const upload = (who, buf, type = 'image/png') =>
  api().post(`${P}/admin/uploads/images?purpose=banner`).set(auth(who.token)).set('Content-Type', type).send(buf);

async function uploadKey(admin, w = 1080, h = 490) {
  return (await upload(admin, makePng(w, h)).expect(201)).body.data.key;
}

async function loc(admin, name, type) {
  const items = (await get(admin, `/admin/locations?q=${encodeURIComponent(name)}&type=${type}`).expect(200)).body.data;
  return items.find((l) => l.name === name).id;
}

async function banner(admin, body) {
  const imageKey = body.imageKey ?? (await uploadKey(admin));
  return (await post(admin, '/admin/banners', { status: 'active', ...body, imageKey }).expect(201)).body.data;
}

/** Doctor with a given practice location (blank → removed from the profile). */
async function doctorAt(state, city, extra = {}) {
  const d = await registeredDoctor({ practice: { state: state || 'x', city: city || 'x' } });
  // Fields the registration form does not take (e.g. district, as in CSV imports).
  if (Object.keys(extra).length) {
    await DoctorProfile.updateOne({ user: d.id }, { $set: Object.fromEntries(Object.entries(extra).map(([k, v]) => [`practice.${k}`, v])) });
  }
  const unset = {};
  if (!state) unset['practice.state'] = 1;
  if (!city) unset['practice.city'] = 1;
  if (Object.keys(unset).length) await DoctorProfile.updateOne({ user: d.id }, { $unset: unset });
  return d;
}

const titles = async (doctor) => (await get(doctor, '/doctors/me/banners').expect(200)).body.data.map((b) => b.title);

describe('Banner targeting (requested scenario)', () => {
  it('Telangana / Bengaluru / global banners reach the right doctors', async () => {
    const admin = await loginAdmin();
    await banner(admin, { title: 'Telangana CME Conference', targeting: 'state', locationIds: [await loc(admin, 'Telangana', 'state')] });
    await banner(admin, { title: 'Bengaluru Medical Event', targeting: 'city', locationIds: [await loc(admin, 'Bengaluru', 'city')] });
    await banner(admin, { title: 'Mio Doctors Announcement', targeting: 'all' });

    const a = await doctorAt('Telangana', 'Hyderabad');
    const b = await doctorAt('Karnataka', 'Bengaluru');
    const c = await doctorAt('Maharashtra', 'Mumbai');
    assert.deepEqual(await titles(a), ['Telangana CME Conference', 'Mio Doctors Announcement']);
    assert.deepEqual(await titles(b), ['Bengaluru Medical Event', 'Mio Doctors Announcement']);
    assert.deepEqual(await titles(c), ['Mio Doctors Announcement']);

    const first = (await get(a, '/doctors/me/banners')).body.data[0];
    assert.deepEqual(first.location, { type: 'state', name: 'Telangana' });
    assert.match(first.imageUrl, /^http:\/\/localhost:\d+\/uploads\/banners\/[a-f0-9]{32}\.png$/);
  });

  it('ranks city > state > global, then priority; matches aliases and city-only doctors', async () => {
    const admin = await loginAdmin();
    const karnataka = await loc(admin, 'Karnataka', 'state');
    const bengaluru = await loc(admin, 'Bengaluru', 'city');
    const hyderabad = await loc(admin, 'Hyderabad', 'city');
    const telangana = await loc(admin, 'Telangana', 'state');
    await banner(admin, { title: 'Global P1', targeting: 'all', priority: 1 });
    await banner(admin, { title: 'Karnataka P5', targeting: 'state', locationIds: [karnataka], priority: 5 });
    await banner(admin, { title: 'Karnataka P2', targeting: 'state', locationIds: [karnataka], priority: 2 });
    await banner(admin, { title: 'Bengaluru P9', targeting: 'city', locationIds: [bengaluru], priority: 9 });
    await banner(admin, { title: 'Multi TG+BLR', targeting: 'multiple', locationIds: [telangana, bengaluru], priority: 3 });
    await banner(admin, { title: 'Hyderabad only', targeting: 'city', locationIds: [hyderabad] });

    // "Bangalore" is an alias of Bengaluru.
    assert.deepEqual(await titles(await doctorAt('Karnataka', 'Bangalore')), ['Multi TG+BLR', 'Bengaluru P9', 'Karnataka P2', 'Karnataka P5', 'Global P1']);
    // Karnataka doctor in a city without banners: state + global only.
    assert.deepEqual(await titles(await doctorAt('Karnataka', 'Mysuru')), ['Karnataka P2', 'Karnataka P5', 'Global P1']);
    // City only (no state) → Telangana derived from Hyderabad.
    assert.deepEqual(await titles(await doctorAt('', 'hyderabad')), ['Hyderabad only', 'Multi TG+BLR', 'Global P1']);
    // City not in the list but district is.
    assert.deepEqual(await titles(await doctorAt('Telangana', 'Banjara Hills', { district: 'Hyderabad' })), ['Hyderabad only', 'Multi TG+BLR', 'Global P1']);
  });

  it('edge cases: no location, unknown location, mismatched city/state, location change', async () => {
    const admin = await loginAdmin();
    await banner(admin, { title: 'Telangana', targeting: 'state', locationIds: [await loc(admin, 'Telangana', 'state')] });
    await banner(admin, { title: 'Global', targeting: 'all' });

    assert.deepEqual(await titles(await doctorAt('', '')), ['Global']);
    assert.deepEqual(await titles(await doctorAt('Atlantis', 'Nowhere')), ['Global']);
    // Hyderabad is not in Karnataka → no city match; Karnataka has no banner.
    assert.deepEqual(await titles(await doctorAt('Karnataka', 'Hyderabad')), ['Global']);

    // The doctor moves: next request reflects the new profile.
    const d = await doctorAt('Maharashtra', 'Pune');
    assert.deepEqual(await titles(d), ['Global']);
    await DoctorProfile.updateOne({ user: d.id }, { $set: { 'practice.state': 'Telangana', 'practice.city': 'Warangal' } });
    assert.deepEqual(await titles(d), ['Telangana', 'Global']);

    // The app cannot pick its own location.
    assert.deepEqual((await get(await doctorAt('Maharashtra', 'Pune'), '/doctors/me/banners?state=Telangana&city=Hyderabad')).body.data.map((b) => b.title), ['Global']);
  });
});

describe('Banner status & schedule', () => {
  it('shows only active banners inside their date window; changes apply immediately', async () => {
    const admin = await loginAdmin();
    const day = (n) => new Date(Date.now() + n * 86_400_000 + 330 * 60_000).toISOString().slice(0, 10);
    const live = await banner(admin, { title: 'Live', targeting: 'all', startDate: day(-1), endDate: day(1) });
    await banner(admin, { title: 'Ends today', targeting: 'all', endDate: day(0) });
    await banner(admin, { title: 'Starts today', targeting: 'all', startDate: day(0) });
    await banner(admin, { title: 'Future', targeting: 'all', startDate: day(2) });
    await banner(admin, { title: 'Expired', targeting: 'all', startDate: day(-5), endDate: day(-1) });
    await banner(admin, { title: 'Draft', targeting: 'all', status: 'draft' });
    await banner(admin, { title: 'Inactive', targeting: 'all', status: 'inactive' });

    const doctor = await doctorAt('Telangana', 'Hyderabad');
    assert.deepEqual((await titles(doctor)).sort(), ['Ends today', 'Live', 'Starts today']);

    const statuses = Object.fromEntries((await get(admin, '/admin/banners?limit=50').expect(200)).body.data.map((b) => [b.title, b.effectiveStatus]));
    assert.deepEqual(statuses, { Live: 'active', 'Ends today': 'active', 'Starts today': 'active', Future: 'scheduled', Expired: 'expired', Draft: 'draft', Inactive: 'inactive' });
    assert.deepEqual((await get(admin, '/admin/banners?status=scheduled')).body.data.map((b) => b.title), ['Future']);
    assert.deepEqual((await get(admin, '/admin/banners?status=expired')).body.data.map((b) => b.title), ['Expired']);

    await patch(admin, `/admin/banners/${live.id}/status`, { status: 'inactive' }).expect(200);
    assert.ok(!(await titles(doctor)).includes('Live'));
    await patch(admin, `/admin/banners/${live.id}/status`, { status: 'active' }).expect(200);
    assert.ok((await titles(doctor)).includes('Live'));
  });
});

describe('Banner admin API', () => {
  it('validates targeting, redirects, dates and text', async () => {
    const admin = await loginAdmin();
    const imageKey = await uploadKey(admin);
    const telangana = await loc(admin, 'Telangana', 'state');
    const hyderabad = await loc(admin, 'Hyderabad', 'city');
    const india = (await get(admin, '/admin/locations?type=country')).body.data[0].id;
    const base = { title: 'Test banner', imageKey, targeting: 'all' };
    const bad = async (body, field) => {
      const res = await post(admin, '/admin/banners', { ...base, ...body }).expect(400);
      if (field) assert.ok(JSON.stringify(res.body.error).includes(field), JSON.stringify(res.body.error));
    };

    await bad({ targeting: 'state', locationIds: [hyderabad] }, 'locationIds');
    await bad({ targeting: 'city', locationIds: [telangana] }, 'locationIds');
    await bad({ targeting: 'state', locationIds: [telangana, await loc(admin, 'Karnataka', 'state')] }, 'locationIds');
    await bad({ targeting: 'multiple', locationIds: [] }, 'locationIds');
    await bad({ targeting: 'multiple', locationIds: [india] }, 'locationIds');
    await bad({ redirectType: 'external', redirectTarget: 'http://example.com' }, 'redirectTarget');
    await bad({ redirectType: 'external', redirectTarget: 'javascript:alert(1)' }, 'redirectTarget');
    await bad({ redirectType: 'internal', redirectTarget: 'admin_panel' }, 'redirectTarget');
    await bad({ startDate: '2026-10-10', endDate: '2026-10-01' }, 'endDate');
    await bad({ imageKey: 'banners/../../etc/passwd' }, 'imageKey');
    await bad({ imageKey: `banners/${'a'.repeat(32)}.png` }, 'imageKey'); // well-formed but never uploaded
    await bad({ title: '<b></b>' }, 'title');

    const ok = (
      await post(admin, '/admin/banners', {
        ...base,
        title: '  <script>alert(1)</script>Special   offer ',
        description: 'Line<br>two',
        redirectType: 'external',
        redirectTarget: 'https://miodoctors.com/cme?x=1',
        targeting: 'multiple',
        locationIds: [telangana, hyderabad, telangana],
      }).expect(201)
    ).body.data;
    assert.equal(ok.title, 'alert(1) Special offer');
    assert.equal(ok.description, 'Line two');
    assert.equal(ok.locations.length, 2);
    assert.equal(ok.status, 'draft');

    const internal = (await post(admin, '/admin/banners', { ...base, imageKey: await uploadKey(admin), redirectType: 'internal', redirectTarget: 'conferences' }).expect(201)).body.data;
    assert.equal(internal.redirectTarget, 'conferences');
    const opts = (await get(admin, '/admin/banners/options').expect(200)).body.data;
    assert.ok(opts.internalTargets.some((t) => t.key === 'conferences'));
    assert.equal(opts.states.find((s) => s.name === 'Telangana').cities.some((c) => c.name === 'Hyderabad'), true);
  });

  it('edits, replaces and deletes images, filters and paginates', async () => {
    const admin = await loginAdmin();
    const b = await banner(admin, { title: 'Alpha', targeting: 'all', priority: 3 });
    const oldFile = path.join(process.env.UPLOADS_DIR, b.imageKey);
    await fs.access(oldFile);

    const newKey = await uploadKey(admin, 1200, 540);
    const edited = (await put(admin, `/admin/banners/${b.id}`, { title: 'Alpha 2', imageKey: newKey, targeting: 'city', locationIds: [await loc(admin, 'Pune', 'city')] }).expect(200)).body.data;
    assert.equal(edited.title, 'Alpha 2');
    assert.equal(edited.locations[0].name, 'Pune');
    await assert.rejects(fs.access(oldFile), 'replaced image is deleted');

    for (let i = 0; i < 3; i++) await banner(admin, { title: `Beta ${i}`, targeting: 'all', priority: 1 });
    const page = (await get(admin, '/admin/banners?limit=2&page=1&sort=priority').expect(200)).body;
    assert.equal(page.meta.total, 4);
    assert.equal(page.data.length, 2);
    assert.equal((await get(admin, '/admin/banners?q=alpha')).body.data.length, 1);
    assert.equal((await get(admin, `/admin/banners?locationId=${await loc(admin, 'Pune', 'city')}`)).body.data.length, 1);
    assert.equal((await get(admin, '/admin/banners?locationId=all')).body.data.length, 3);

    // A missing file is flagged for the admin and skipped for doctors.
    const beta = (await get(admin, '/admin/banners?q=Beta 0')).body.data[0];
    await fs.unlink(path.join(process.env.UPLOADS_DIR, beta.imageKey));
    assert.equal((await get(admin, `/admin/banners/${beta.id}`)).body.data.imageMissing, true);
    assert.ok(!(await titles(await doctorAt('Telangana', 'Hyderabad'))).includes('Beta 0'));

    await del(admin, `/admin/banners/${b.id}`).expect(204);
    await assert.rejects(fs.access(path.join(process.env.UPLOADS_DIR, newKey)));
    await get(admin, `/admin/banners/${b.id}`).expect(404);
  });

  it('accepts only real, well-sized banner images and serves them safely', async () => {
    const admin = await loginAdmin();
    const res = await upload(admin, makePng(1080, 490)).expect(201);
    assert.deepEqual([res.body.data.width, res.body.data.height], [1080, 490]);

    const err = async (buf, code, type) => assert.equal((await upload(admin, buf, type).expect(400)).body.error.code, code);
    await err(makePng(600, 260), 'UPLOAD_TOO_SMALL');
    await err(makePng(800, 800), 'UPLOAD_RATIO');
    await err(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'UPLOAD_TYPE', 'image/png');
    await err(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(2.5 * 1024 * 1024)]), 'UPLOAD_TOO_LARGE');
    await api().post(`${P}/admin/uploads/images?purpose=avatar`).set(auth(admin.token)).set('Content-Type', 'image/png').send(makePng(1080, 490)).expect(400);

    const file = await api().get(`/uploads/${res.body.data.key}`).expect(200);
    assert.equal(file.headers['content-type'], 'image/png');
    assert.equal(file.headers['cross-origin-resource-policy'], 'cross-origin');
    assert.equal(file.headers['x-content-type-options'], 'nosniff');
    await api().get('/uploads/../.env').expect(404);
    await api().get('/uploads/banners/').expect(404);
  });
});

describe('Banner permissions & locations', () => {
  it('needs the Banners section for admins and the doctor role for the app feed', async () => {
    const owner = await loginAdmin();
    const { roles } = (await get(owner, '/admin/roles')).body.data;
    const created = (await post(owner, '/admin/staff', { name: 'Support Person', email: 'sp@example.com', roleId: roles.find((r) => r.name === 'Support').id })).body.data;
    const s = (await api().post(`${P}/auth/admin/login`).send({ email: 'sp@example.com', password: created.temporaryPassword })).body.data;
    const support = { token: (await post({ token: s.tokens.accessToken }, '/auth/admin/change-password', { currentPassword: created.temporaryPassword, newPassword: 'Support-pass-123' })).body.data.tokens.accessToken };

    await get(support, '/admin/banners').expect(403);
    await get(support, '/admin/locations').expect(403);
    await upload(support, makePng(1080, 490)).expect(403);
    const ops = (await get(owner, '/admin/roles')).body.data.roles.find((r) => r.name === 'Operations');
    assert.ok(ops.permissions.includes('banners'));

    const doctor = await doctorAt('Telangana', 'Hyderabad');
    const mr = await login('mr');
    await get(doctor, '/admin/banners').expect(403);
    await get(mr, '/doctors/me/banners').expect(403);
    await api().get(`${P}/doctors/me/banners`).expect(401);
  });

  it('manages locations: hierarchy rules, duplicates, in-use protection, inactive locations', async () => {
    const admin = await loginAdmin();
    const telangana = await loc(admin, 'Telangana', 'state');
    const city = (await post(admin, '/admin/locations', { name: 'Siddipet', type: 'city', parentId: telangana, aliases: ['Siddipeta'] }).expect(201)).body.data;
    await post(admin, '/admin/locations', { name: 'siddipet', type: 'city', parentId: telangana }).expect(409);
    await post(admin, '/admin/locations', { name: 'Orphan', type: 'city' }).expect(400);
    await post(admin, '/admin/locations', { name: 'Bad', type: 'city', parentId: city.id }).expect(400);

    await banner(admin, { title: 'Siddipet camp', targeting: 'city', locationIds: [city.id] });
    assert.deepEqual(await titles(await doctorAt('Telangana', 'Siddipeta')), ['Siddipet camp']);
    assert.equal((await del(admin, `/admin/locations/${city.id}`).expect(409)).body.error.code, 'LOCATION_IN_USE');
    assert.equal((await del(admin, `/admin/locations/${telangana}`).expect(409)).body.error.code, 'LOCATION_HAS_CHILDREN');

    await patch(admin, `/admin/locations/${city.id}`, { status: 'inactive' }).expect(200);
    assert.deepEqual(await titles(await doctorAt('Telangana', 'Siddipet')), []);
    await post(admin, '/admin/banners', { title: 'Nope', imageKey: await uploadKey(admin), targeting: 'city', locationIds: [city.id] }).expect(400);
  });

  it('migration rolls back and re-applies cleanly', async () => {
    const mongoose = (await import('mongoose')).default;
    await runMigrations('down', { quiet: true });
    const names = (await mongoose.connection.db.listCollections().toArray()).map((c) => c.name);
    assert.ok(!names.includes('locations') && !names.includes('banners'));
    await runMigrations('up', { quiet: true });
    assert.equal(await mongoose.connection.db.collection('locations').countDocuments({ type: 'state' }), 36);
  });
});
