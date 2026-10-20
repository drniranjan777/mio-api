/**
 * UI/UX change list of 11 Oct 2026: receptionist → doctor mapping, mobile
 * number change and account recovery, banner video + audience targeting,
 * and the code renumbering migration.
 */
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { P, api, auth, login, loginAdmin, loginReceptionist, nextMobile, registeredDoctor, reset, setup, teardown } from './helpers.js';
import { makePng } from '../scripts/lib/png.js';
import { runMigrations } from '../scripts/migrate.js';
import { seedCatalog } from '../scripts/catalog.js';
import { DoctorProfile, MrProfile } from '../src/modules/profiles/profile.models.js';
import { Counter } from '../src/modules/users/counter.model.js';

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
const publicPost = (p, body) => api().post(`${P}${p}`).send(body);
const codeOf = async (doctor) => (await get(doctor, '/me').expect(200)).body.data.profile.code;

describe('Receptionist request reaches the right doctor', () => {
  it('asks for the doctor when nobody listed the receptionist', async () => {
    const res = await publicPost('/auth/receptionist/request', { mobile: nextMobile() }).expect(200);
    assert.equal(res.body.data.status, 'pending');
    assert.equal(res.body.data.routedTo, 0);
    assert.equal(res.body.data.needsDoctor, true);
  });

  it('routes by Mio doctor code or doctor mobile; the doctor approves; then sign-in works', async () => {
    const doctor = await registeredDoctor();
    const mobile = nextMobile();
    const byCode = await publicPost('/auth/receptionist/request', { mobile, doctorCode: (await codeOf(doctor)).toLowerCase() }).expect(200);
    assert.deepEqual([byCode.body.data.status, byCode.body.data.routedTo, byCode.body.data.needsDoctor], ['pending', 1, false]);

    const list = (await get(doctor, '/doctors/me/receptionists').expect(200)).body.data;
    assert.equal(list[0].status, 'pending');
    await patch(doctor, `/doctors/me/receptionists/${list[0].receptionist.id}`, { status: 'active' }).expect(200);
    await loginReceptionist(mobile);

    const other = await registeredDoctor();
    const byMobile = await publicPost('/auth/receptionist/request', { mobile: nextMobile(), doctorMobile: other.mobile }).expect(200);
    assert.equal(byMobile.body.data.routedTo, 1);

    const unknown = await publicPost('/auth/receptionist/request', { mobile: nextMobile(), doctorCode: 'DR99999' }).expect(404);
    assert.equal(unknown.body.error.code, 'DOCTOR_NOT_FOUND');
  });
});

describe('Mobile number change and account recovery', () => {
  it('a signed-in user moves to a new number with a PIN sent to it', async () => {
    const mr = await login('mr');
    const taken = await login('doctor');
    await post(mr, '/me/mobile/otp', { mobile: taken.mobile }).expect(409);

    const newMobile = nextMobile();
    const otp = await post(mr, '/me/mobile/otp', { mobile: newMobile }).expect(200);
    const res = await put(mr, '/me/mobile', { mobile: newMobile, otp: otp.body.data.devOtp }).expect(200);
    assert.equal(res.body.data.me.user.mobile, newMobile);

    // Old sessions end; the new tokens work; the new number signs in to the same account.
    await get(mr, '/me').expect(401);
    await api().get(`${P}/me`).set(auth(res.body.data.tokens.accessToken)).expect(200);
    const again = await login('mr', newMobile);
    assert.equal(again.isNewUser, false);
    assert.equal(again.user.id, mr.id);
  });

  it('a user who lost the old number files a request that an admin approves', async () => {
    const doctor = await registeredDoctor();
    const code = await codeOf(doctor);
    const newMobile = nextMobile();

    const otp = await publicPost('/auth/recovery/otp', { role: 'doctor', newMobile }).expect(200);
    const filed = await publicPost('/auth/recovery', { role: 'doctor', oldMobile: doctor.mobile, newMobile, code, otp: otp.body.data.devOtp }).expect(201);
    assert.equal(filed.body.data.status, 'submitted');

    // Unknown numbers get the same answer (no account discovery).
    const stranger = nextMobile();
    const otp2 = await publicPost('/auth/recovery/otp', { role: 'mr', newMobile: stranger }).expect(200);
    const ghost = await publicPost('/auth/recovery', { role: 'mr', oldMobile: nextMobile(), newMobile: stranger, otp: otp2.body.data.devOtp }).expect(201);
    assert.equal(ghost.body.data.status, 'submitted');

    const admin = await loginAdmin();
    const pending = (await get(admin, '/admin/recovery-requests?status=pending').expect(200)).body.data;
    const mine = pending.find((r) => r.newMobile === newMobile);
    assert.equal(mine.codeMatches, true);
    assert.equal(mine.account.id, doctor.id);
    const noAccount = pending.find((r) => r.newMobile === stranger);
    await patch(admin, `/admin/recovery-requests/${noAccount.id}`, { decision: 'approve' }).expect(422);

    const approved = await patch(admin, `/admin/recovery-requests/${mine.id}`, { decision: 'approve', note: 'Verified by phone call' }).expect(200);
    assert.equal(approved.body.data.status, 'approved');
    await patch(admin, `/admin/recovery-requests/${mine.id}`, { decision: 'reject' }).expect(409);

    await get(doctor, '/me').expect(401);
    const back = await login('doctor', newMobile);
    assert.equal(back.user.id, doctor.id);
  });

  it('admin can change a user\'s number directly; app users cannot use the admin route', async () => {
    const mr = await login('mr');
    const admin = await loginAdmin();
    const newMobile = nextMobile();
    const res = await patch(admin, `/admin/users/${mr.id}/mobile`, { mobile: newMobile, reason: 'Ticket HD10012' }).expect(200);
    assert.equal(res.body.data.user.mobile, newMobile);
    await patch(mr, `/admin/users/${mr.id}/mobile`, { mobile: nextMobile() }).expect(401);
  });
});

describe('Banners: video and audience targeting', () => {
  const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), Buffer.alloc(64, 1)]);
  const uploadImage = async (admin) =>
    (await api().post(`${P}/admin/uploads/images?purpose=banner`).set(auth(admin.token)).set('Content-Type', 'image/png').send(makePng(1080, 490)).expect(201)).body.data.key;
  const uploadVideo = (admin, buf) => api().post(`${P}/admin/uploads/videos?purpose=banner`).set(auth(admin.token)).set('Content-Type', 'video/mp4').send(buf);

  it('accepts MP4 only and serves video banners with a cover image', async () => {
    const admin = await loginAdmin();
    await uploadVideo(admin, Buffer.from('not a video at all')).expect(400);
    await uploadVideo(admin, Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypqt  '), Buffer.alloc(16)])).expect(400);
    const videoKey = (await uploadVideo(admin, MP4).expect(201)).body.data.key;
    assert.match(videoKey, /^banners\/[a-f0-9]{32}\.mp4$/);

    const imageKey = await uploadImage(admin);
    await post(admin, '/admin/banners', { title: 'No video yet', imageKey, mediaType: 'video', targeting: 'all', status: 'active' }).expect(400);
    const b = (await post(admin, '/admin/banners', { title: 'Launch video', imageKey, mediaType: 'video', videoKey, targeting: 'all', status: 'active' }).expect(201)).body.data;
    assert.equal(b.mediaType, 'video');
    assert.ok(b.videoUrl.endsWith(videoKey));

    const doctor = await registeredDoctor();
    const [shown] = (await get(doctor, '/doctors/me/banners').expect(200)).body.data;
    assert.equal(shown.mediaType, 'video');
    assert.ok(shown.videoUrl && shown.imageUrl);

    // Switching back to an image banner drops the video.
    const img = (await put(admin, `/admin/banners/${b.id}`, { mediaType: 'image' }).expect(200)).body.data;
    assert.equal(img.videoKey, null);
  });

  it('filters by specialty, gender and Metro / Non-Metro class', async () => {
    const admin = await loginAdmin();
    const make = async (title, extra) =>
      post(admin, '/admin/banners', { title, imageKey: await uploadImage(admin), targeting: 'all', status: 'active', ...extra }).expect(201);
    await make('Everyone', {});
    await make('Cardio only', { specialties: ['cardiology'] });
    await make('Women doctors', { genders: ['female'] });
    await make('Non-metro clinics', { locationClasses: ['Non-Metro'] });
    await make('Cardio women metro', { specialties: ['Cardiology'], genders: ['female'], locationClasses: ['Metro'] });

    const opts = (await get(admin, '/admin/banners/options').expect(200)).body.data;
    assert.ok(opts.specialties.includes('Cardiology'));
    assert.deepEqual(opts.locationClasses, ['Metro', 'Non-Metro']);

    const titles = async (d) => (await get(d, '/doctors/me/banners').expect(200)).body.data.map((x) => x.title).sort();
    const cardioMan = await registeredDoctor({ specialty: 'Cardiology' });
    assert.deepEqual(await titles(cardioMan), ['Cardio only', 'Everyone']);
    const cardioWoman = await registeredDoctor({ specialty: 'Cardiology', gender: 'female' });
    assert.deepEqual(await titles(cardioWoman), ['Cardio only', 'Cardio women metro', 'Everyone', 'Women doctors']);
    const ruralDerm = await registeredDoctor({ specialty: 'Dermatology', practice: { locationType: 'Non-Metro' } });
    assert.deepEqual(await titles(ruralDerm), ['Everyone', 'Non-metro clinics']);
  });
});

describe('Code renumbering migration', () => {
  it('renumbers existing codes in registration order and keeps the old ones', async () => {
    const d1 = await login('doctor');
    const d2 = await login('doctor');
    const mr = await login('mr');
    // Simulate first-release codes.
    await DoctorProfile.updateOne({ user: d1.id }, { $set: { code: 'DR10001' } });
    await DoctorProfile.updateOne({ user: d2.id }, { $set: { code: 'DR10002' } });
    await MrProfile.updateOne({ user: mr.id }, { $set: { code: 'MR10001', specialty: 'Cardiology' } });
    const mongoose = (await import('mongoose')).default;
    await mongoose.connection.db.collection('migrations').deleteMany({});

    await runMigrations('up', { quiet: true });
    const p1 = await DoctorProfile.findOne({ user: d1.id }).lean();
    const p2 = await DoctorProfile.findOne({ user: d2.id }).lean();
    assert.deepEqual([p1.code, p1.legacyCode, p2.code], ['DR00001', 'DR10001', 'DR00002']);
    assert.deepEqual((await MrProfile.findOne({ user: mr.id }).lean()).specialties, ['Cardiology']);
    assert.equal((await Counter.findById('doctor').lean()).seq, 2);

    const next = await login('doctor');
    assert.equal(await codeOf(next), 'DR00003');

    // `down` undoes the newest migration only: the 18 Oct one first, then this one.
    await runMigrations('down', { quiet: true });
    await runMigrations('down', { quiet: true });
    assert.equal((await DoctorProfile.findOne({ user: d1.id }).lean()).code, 'DR10001');
  });
});
