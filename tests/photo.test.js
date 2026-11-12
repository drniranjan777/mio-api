import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';

// helpers.js first: it sets the test environment before any config is loaded.
import { P, api, auth, deleteAccount, login, loginAdmin, reset, setup, teardown } from './helpers.js';
import { makePng } from '../scripts/lib/png.js';

before(setup);
after(teardown);
beforeEach(reset);

const putPhoto = (who, buf, type = 'image/png') =>
  api().put(`${P}/me/photo`).set(auth(who.token)).set('Content-Type', type).send(buf);
const fileOf = (url) => path.join(process.env.UPLOADS_DIR, new URL(url).pathname.replace(/^\/uploads\//, ''));
const exists = (file) => fs.access(file).then(() => true, () => false);

describe('Profile photo', () => {
  it('uploads, replaces (old file removed) and removes the photo', async () => {
    const mr = await login('mr');
    const first = (await putPhoto(mr, makePng(400, 400)).expect(200)).body.data.user.photoUrl;
    assert.match(first, /^http:\/\/localhost:\d+\/uploads\/photos\/[a-f0-9]{32}\.png$/);
    assert.ok(await exists(fileOf(first)));
    await api().get(new URL(first).pathname).expect(200).expect('Content-Type', 'image/png');

    const second = (await putPhoto(mr, makePng(600, 500)).expect(200)).body.data.user.photoUrl;
    assert.notEqual(second, first);
    assert.ok(!(await exists(fileOf(first))));

    const me = (await api().get(`${P}/me`).set(auth(mr.token)).expect(200)).body.data;
    assert.equal(me.user.photoUrl, second);

    const cleared = (await api().delete(`${P}/me/photo`).set(auth(mr.token)).expect(200)).body.data;
    assert.equal(cleared.user.photoUrl, undefined);
    assert.ok(!(await exists(fileOf(second))));
  });

  it('rejects bad images and other roles', async () => {
    const doctor = await login('doctor');
    assert.equal((await putPhoto(doctor, Buffer.from('not an image'), 'image/jpeg').expect(400)).body.error.code, 'UPLOAD_TYPE');
    assert.equal((await putPhoto(doctor, makePng(100, 100)).expect(400)).body.error.code, 'UPLOAD_TOO_SMALL');
    assert.equal((await putPhoto(doctor, makePng(1000, 300)).expect(400)).body.error.code, 'UPLOAD_RATIO');
    await putPhoto(doctor, Buffer.alloc(0)).expect(400);
    await api().put(`${P}/me/photo`).set('Content-Type', 'image/png').send(makePng(400, 400)).expect(401);

    const admin = await loginAdmin();
    await putPhoto(admin, makePng(400, 400)).expect(403);
    // Admins cannot use the banner uploader to drop files into photos/.
    await api().post(`${P}/admin/uploads/images?purpose=photo`).set(auth(admin.token)).set('Content-Type', 'image/png').send(makePng(400, 400)).expect(400);
  });

  it('deleting the account removes the photo file', async () => {
    const mr = await login('mr');
    const url = (await putPhoto(mr, makePng(400, 400)).expect(200)).body.data.user.photoUrl;
    assert.equal((await deleteAccount(mr.token)).status, 204);
    assert.ok(!(await exists(fileOf(url))));
  });
});
