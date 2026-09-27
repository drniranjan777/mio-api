import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { seedCatalog } from '../scripts/catalog.js';
import { parseCsv } from '../src/utils/csv.js';
import { P, api, auth, login, loginAdmin, registeredDoctor, reset, setup, teardown } from './helpers.js';

before(setup);
after(teardown);
beforeEach(async () => {
  await reset();
  await seedCatalog();
});

const upload = (who, csv, commit = false) =>
  api()
    .post(`${P}/admin/users/import/doctors?commit=${commit}`)
    .set(auth(who.token))
    .set('Content-Type', 'text/csv')
    .send(csv);

const HEADER = 'name,mobile,specialty,city,gender,date_of_birth,practice_type,mr_call_days,mr_call_from,mr_call_to,max_mr_per_day';

describe('CSV parser', () => {
  it('handles quotes, embedded commas/newlines, CRLF, BOM and blank lines', () => {
    const rows = parseCsv('﻿a,b,c\r\n"x, y","say ""hi""","line1\nline2"\r\n\r\n,,\n1,2,3');
    assert.deepEqual(rows, [
      ['a', 'b', 'c'],
      ['x, y', 'say "hi"', 'line1\nline2'],
      ['1', '2', '3'],
    ]);
    assert.throws(() => parseCsv('a,"b'), /Unclosed quote/);
  });
});

describe('Doctor CSV import', () => {
  it('previews without writing, then imports only valid rows', async () => {
    const admin = await loginAdmin();
    const existing = await registeredDoctor();
    const csv = [
      HEADER,
      'Dr. Good One,9000000301,Cardiology,Hyderabad,Male,12/05/1980,Hospital,Mon|Tue|Wed,10:00,16:00,20',
      '"Dr. Comma, Name",9000000302,Neurology,"Bengaluru",female,,clinic,,,,',
      'Dr. Bad Mobile,12345,Cardiology,Hyderabad,,,,,,,',
      'Dr. Dup In File,9000000301,Cardiology,Hyderabad,,,,,,,',
      `Dr. Already Here,${existing.mobile},Cardiology,Hyderabad,,,,,,,`,
      'Dr. Bad Values,9000000303,Cardiology,Hyderabad,robot,31-12-1980,tent,Funday,10:00,,',
      ',9000000304,,,,,,,,,',
    ].join('\n');

    const preview = (await upload(admin, csv).expect(200)).body.data;
    assert.equal(preview.committed, false);
    assert.deepEqual(preview.summary, { rows: 7, valid: 2, invalid: 5, created: 0, skipped: 0 });
    const byRow = Object.fromEntries(preview.rows.map((r) => [r.row, r]));
    assert.match(byRow[4].errors.join(), /mobile/);
    assert.match(byRow[5].errors.join(), /same number as row 2/);
    assert.match(byRow[6].errors.join(), /already registered \(doctor\)/);
    const bad = byRow[7].errors.join(' | ');
    for (const field of ['gender', 'date_of_birth', 'practice_type', 'mr_call_days']) assert.match(bad, new RegExp(field));
    assert.match(byRow[8].errors.join(), /Name is required/);
    assert.equal((await get(admin, '/admin/users?role=doctor')).body.meta.total, 1, 'preview wrote nothing');

    const done = (await upload(admin, csv, true).expect(200)).body.data;
    assert.deepEqual(done.summary, { rows: 7, valid: 0, invalid: 0, created: 2, skipped: 5 });

    // Imported doctors are complete enough for the Master MCL and keep their details.
    const mr = await login('mr');
    const names = (await get(mr, '/doctors?q=Dr.').expect(200)).body.data.map((d) => d.name);
    assert.ok(names.includes('Dr. Good One') && names.includes('Dr. Comma, Name'));
    const good = (await get(admin, '/admin/users?q=Good One')).body.data[0];
    const detail = (await get(admin, `/admin/users/${good.id}`)).body.data;
    assert.equal(detail.profile.gender, 'male');
    assert.equal(detail.profile.practice.type, 'hospital');
    assert.deepEqual(detail.profile.mrCall.days, ['Mon', 'Tue', 'Wed']);
    assert.equal(detail.user.onboarding.final, true);

    // The doctor signs in with OTP on the imported mobile, no re-registration of the profile.
    const signedIn = await login('doctor', '9000000301');
    assert.equal(signedIn.isNewUser, false);
    const comma = await login('doctor', '9000000302');
    assert.equal(comma.user.onboarding.final, false, 'without MR-call timings the final step is still open');

    const logs = (await get(admin, '/admin/audit-logs?action=user.doctors_imported')).body.data;
    assert.equal(logs[0].after.created, 2);
  });

  it('rejects files it cannot import and needs the Users section', async () => {
    const admin = await loginAdmin();
    await upload(admin, 'name,mobile\nDr. X,9000000401').expect(400); // missing required columns
    await upload(admin, HEADER).expect(400); // no data rows
    await upload(admin, 'name,mobile,specialty,city\n"Dr. Unclosed,9000000401,Cardio,Hyd').expect(400);
    const tooMany = [HEADER, ...Array.from({ length: 1001 }, (_, i) => `Dr. N${i},9${String(100000000 + i)},Cardiology,Hyd,,,,,,,`)].join('\n');
    const big = await upload(admin, tooMany).expect(400);
    assert.equal(big.body.error.code, 'CSV_TOO_MANY_ROWS');
    await api().post(`${P}/admin/users/import/doctors`).set(auth(admin.token)).send({ csv: 'x' }).expect(400);

    const ignored = (await upload(admin, 'name,mobile,specialty,city,favourite_colour\nDr. Y,9000000402,ENT,Pune,blue').expect(200)).body.data;
    assert.deepEqual(ignored.ignoredColumns, ['favourite_colour']);

    const mr = await login('mr');
    await upload(mr, HEADER).expect(403);
    const support = await (async () => {
      const { roles } = (await get(admin, '/admin/roles')).body.data;
      const created = (
        await api().post(`${P}/admin/staff`).set(auth(admin.token)).send({ name: 'Support Staff', email: 's@example.com', roleId: roles.find((r) => r.name === 'Support').id })
      ).body.data;
      const s = (await api().post(`${P}/auth/admin/login`).send({ email: 's@example.com', password: created.temporaryPassword })).body.data;
      const c = (
        await api().post(`${P}/auth/admin/change-password`).set(auth(s.tokens.accessToken)).send({ currentPassword: created.temporaryPassword, newPassword: 'Support-pass-123' })
      ).body.data;
      return { token: c.tokens.accessToken };
    })();
    await upload(support, HEADER).expect(403);
  });

  it('serves the demo template, which imports cleanly as-is', async () => {
    const admin = await loginAdmin();
    const tpl = await api().get(`${P}/admin/users/import/doctors/template`).set(auth(admin.token)).expect(200);
    assert.match(tpl.headers['content-type'], /text\/csv/);
    assert.match(tpl.headers['content-disposition'], /doctors_import_template\.csv/);
    const preview = (await upload(admin, tpl.text).expect(200)).body.data;
    assert.equal(preview.summary.valid, 3);
    assert.equal(preview.summary.invalid, 0);
  });
});

function get(who, path) {
  return api().get(`${P}${path}`).set(auth(who.token));
}
