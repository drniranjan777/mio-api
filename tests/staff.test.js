import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import ExcelJS from 'exceljs';

import { seedCatalog } from '../scripts/catalog.js';
import { P, api, auth, login, loginAdmin, nextMobile, registeredDoctor, reset, setup, slot, teardown } from './helpers.js';

before(setup);
after(teardown);
beforeEach(async () => {
  await reset();
  await seedCatalog();
});

const get = (who, path) => api().get(`${P}${path}`).set(auth(who.token));
const post = (who, path, body = {}) => api().post(`${P}${path}`).set(auth(who.token)).send(body);
const patch = (who, path, body = {}) => api().patch(`${P}${path}`).set(auth(who.token)).send(body);
const del = (who, path) => api().delete(`${P}${path}`).set(auth(who.token));

async function roleId(owner, name) {
  const { roles } = (await get(owner, '/admin/roles').expect(200)).body.data;
  return roles.find((r) => r.name === name).id;
}

/** Creates a team member, signs in with the temporary password and sets a real one. */
async function staffMember(owner, roleName, email = `staff${Date.now()}${Math.random()}@example.com`.replace(/0\./, '')) {
  const res = (await post(owner, '/admin/staff', { name: 'Team Member', email, roleId: await roleId(owner, roleName) }).expect(201)).body.data;
  const signIn = (await api().post(`${P}/auth/admin/login`).send({ email, password: res.temporaryPassword }).expect(200)).body.data;
  const changed = (
    await post({ token: signIn.tokens.accessToken }, '/auth/admin/change-password', { currentPassword: res.temporaryPassword, newPassword: 'A-new-password-42' }).expect(200)
  ).body.data;
  return { id: res.staff.id, email, token: changed.tokens.accessToken, access: changed.access };
}

describe('Admin roles & team', () => {
  it('seeds Super Admin + starter roles; only Super Admins manage the team', async () => {
    const owner = await loginAdmin();
    const { roles, permissions } = (await get(owner, '/admin/roles').expect(200)).body.data;
    assert.deepEqual(roles.map((r) => r.name), ['Super Admin', 'Finance', 'Operations', 'Support']);
    assert.ok(permissions.includes('tickets') && !permissions.includes('staff'));
    assert.equal(roles[0].members, 1, 'the role-less owner counts as Super Admin');

    const support = await staffMember(owner, 'Support');
    await get(support, '/admin/staff').expect(403);
    await post(support, '/admin/roles', { name: 'Mine', permissions: ['users'] }).expect(403);
  });

  it('forces a new password first, then enforces section permissions on every request', async () => {
    const owner = await loginAdmin();
    const email = 'finance@example.com';
    const created = (await post(owner, '/admin/staff', { name: 'Fin', email, roleId: await roleId(owner, 'Finance') }).expect(201)).body.data;
    assert.ok(created.temporaryPassword.length >= 12);
    assert.equal(created.staff.mustChangePassword, true);

    const first = (await api().post(`${P}/auth/admin/login`).send({ email, password: created.temporaryPassword }).expect(200)).body.data;
    assert.equal(first.user.mustChangePassword, true);
    const temp = { token: first.tokens.accessToken };
    const blocked = await get(temp, '/admin/dashboard').expect(403);
    assert.equal(blocked.body.error.code, 'PASSWORD_CHANGE_REQUIRED');
    await get(temp, '/me').expect(200);

    await post(temp, '/auth/admin/change-password', { currentPassword: 'wrong', newPassword: 'Another-pass-99' }).expect(400);
    await post(temp, '/auth/admin/change-password', { currentPassword: created.temporaryPassword, newPassword: 'short' }).expect(400);
    const changed = (await post(temp, '/auth/admin/change-password', { currentPassword: created.temporaryPassword, newPassword: 'Another-pass-99' }).expect(200)).body.data;
    await get(temp, '/admin/dashboard').expect(401); // old session ended
    const fin = { token: changed.tokens.accessToken };

    await get(fin, '/admin/dashboard').expect(200);
    await get(fin, '/admin/orders').expect(200);
    const denied = await get(fin, '/admin/users').expect(403);
    assert.equal(denied.body.error.code, 'ADMIN_PERMISSION_DENIED');
    await get(fin, '/help-tickets').expect(403);
    await api().put(`${P}/content/terms-of-service`).set(auth(fin.token)).send({ title: 'x', effectiveDate: '2026-01-01', sections: [] }).expect(403);
    assert.deepEqual((await get(fin, '/me').expect(200)).body.data.access.permissions, ['dashboard', 'billing', 'reports']);

    // Permission changes apply on the very next request.
    await patch(owner, `/admin/roles/${await roleId(owner, 'Finance')}`, { permissions: ['dashboard', 'billing', 'reports', 'users'] }).expect(200);
    await get(fin, '/admin/users').expect(200);
  });

  it('protects roles and the last Super Admin; deactivation ends sessions', async () => {
    const owner = await loginAdmin();
    const superId = await roleId(owner, 'Super Admin');
    await patch(owner, `/admin/roles/${superId}`, { permissions: ['users'] }).expect(422);
    await del(owner, `/admin/roles/${superId}`).expect(422);
    await post(owner, '/admin/roles', { name: 'support', permissions: ['tickets'] }).expect(409); // case-insensitive
    await post(owner, '/admin/roles', { name: 'Nothing', permissions: [] }).expect(400);
    await post(owner, '/admin/roles', { name: 'Sneaky', permissions: ['staff'] }).expect(400);

    const member = await staffMember(owner, 'Operations');
    await del(owner, `/admin/roles/${await roleId(owner, 'Operations')}`).expect(409);

    const me = (await get(owner, '/me').expect(200)).body.data.user.id;
    await patch(owner, `/admin/staff/${me}`, { status: 'inactive' }).expect(422);

    const reset1 = (await post(owner, `/admin/staff/${member.id}/reset-password`).expect(200)).body.data;
    assert.equal(reset1.staff.mustChangePassword, true);
    await get(member, '/admin/dashboard').expect(401);

    const other = await staffMember(owner, 'Support');
    await patch(owner, `/admin/staff/${other.id}`, { status: 'inactive' }).expect(200);
    await get(other, '/admin/dashboard').expect(401);
    const signIn = await api().post(`${P}/auth/admin/login`).send({ email: other.email, password: 'A-new-password-42' }).expect(403);
    assert.equal(signIn.body.error.code, 'ACCOUNT_INACTIVE');

    // Promote someone to Super Admin, then the owner may be demoted — but not the last one.
    const second = await staffMember(owner, 'Support');
    const financeId = await roleId(owner, 'Finance');
    await patch(owner, `/admin/staff/${second.id}`, { roleId: superId }).expect(200);
    await patch(second, `/admin/staff/${me}`, { roleId: await roleId(second, 'Support') }).expect(200);
    const demoted = await patch(owner, `/admin/staff/${second.id}`, { roleId: financeId }).expect(403);
    assert.equal(demoted.body.error.code, 'SUPER_ADMIN_ONLY');
    // `second` is now the only Super Admin and cannot demote themselves.
    await patch(second, `/admin/staff/${second.id}`, { roleId: financeId }).expect(422);
  });
});

describe('Help desk assignment', () => {
  it('bulk-assigns requests to a Help Desk member who can filter "assigned to me"', async () => {
    const owner = await loginAdmin();
    const support = await staffMember(owner, 'Support');
    const finance = await staffMember(owner, 'Finance');
    const mr = await login('mr');
    const { topics } = (await get(mr, '/support').expect(200)).body.data;
    const ids = [];
    for (const m of ['First issue text', 'Second issue text', 'Third issue text']) {
      ids.push((await post(mr, '/help-tickets', { category: topics[0], message: m }).expect(201)).body.data.id);
    }

    const assignees = (await get(owner, '/help-tickets/assignees').expect(200)).body.data.map((a) => a.id);
    assert.ok(assignees.includes(support.id) && !assignees.includes(finance.id));

    const bad = await post(owner, '/help-tickets/assign', { ticketIds: ids, assignedTo: finance.id }).expect(400);
    assert.equal(bad.body.error.code, 'VALIDATION_ERROR');
    const res = (await post(owner, '/help-tickets/assign', { ticketIds: ids.slice(0, 2), assignedTo: support.id }).expect(200)).body.data;
    assert.equal(res.updated, 2);

    const mine = (await get(support, '/help-tickets?assigned=me').expect(200)).body.data;
    assert.equal(mine.length, 2);
    assert.equal(mine[0].assignedTo.id, support.id);
    assert.equal((await get(owner, '/help-tickets?assigned=none').expect(200)).body.data.length, 1);

    await patch(support, `/help-tickets/${ids[2]}`, { assignedTo: support.id, status: 'in_progress' }).expect(200);
    await patch(owner, `/help-tickets/${ids[0]}`, { assignedTo: null }).expect(200);
    assert.equal((await get(support, '/help-tickets?assigned=me').expect(200)).body.data.length, 2);

    // The MR never sees who handles it.
    assert.equal((await get(mr, `/help-tickets/${ids[1]}`).expect(200)).body.data.assignedTo, undefined);
  });
});

describe('Admin creates app users', () => {
  it('pre-registers doctors/MRs and receptionists linked to several doctors', async () => {
    const owner = await loginAdmin();
    const [d1, d2] = await Promise.all([registeredDoctor(), registeredDoctor()]);

    const mrMobile = nextMobile();
    const mr = (await post(owner, '/admin/users', { role: 'mr', name: 'New MR', mobile: mrMobile }).expect(201)).body.data;
    assert.match(mr.profile.code, /^MR\d+/);
    const signedIn = await login('mr', mrMobile);
    assert.equal(signedIn.isNewUser, false);
    assert.equal(signedIn.user.name, 'New MR');

    await post(owner, '/admin/users', { role: 'mr', name: 'Dup', mobile: mrMobile }).expect(409);
    await post(owner, '/admin/users', { role: 'receptionist', name: 'No doctor', mobile: nextMobile() }).expect(400);
    await post(owner, '/admin/users', { role: 'admin', name: 'Nope', mobile: nextMobile() }).expect(400);

    const recMobile = nextMobile();
    const rec = (
      await post(owner, '/admin/users', { role: 'receptionist', name: 'Front Desk', mobile: recMobile, doctorIds: [d1.id, d2.id], permissions: ['book'] }).expect(201)
    ).body.data;
    assert.equal(rec.access.length, 2);
    assert.ok(rec.access.every((a) => a.status === 'active' && a.permissions.includes('view') && a.permissions.includes('book')));
    const request = await api().post(`${P}/auth/receptionist/request`).send({ mobile: recMobile }).expect(200);
    assert.equal(request.body.data.status, 'granted');
  });
});

describe('Excel export', () => {
  const binary = (res, cb) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => cb(null, Buffer.concat(chunks)));
  };

  it('exports any report as a real .xlsx with typed cells and no formulas', async () => {
    const doctor = await registeredDoctor();
    await post(doctor, '/appointments', { startAt: slot(0), visitor: { name: '=HYPERLINK("http://evil")', company: 'Cipla' } }).expect(201);
    await post(doctor, '/appointments', { startAt: slot(1), visitor: { name: 'Anita', company: 'Cipla' } }).expect(201);

    const q = `?to=${new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10)}&format=xlsx`;
    const res = await api().get(`${P}/reports/mr-wise${q}`).set(auth(doctor.token)).buffer(true).parse(binary).expect(200);
    assert.match(res.headers['content-type'], /spreadsheetml/);
    assert.match(res.headers['content-disposition'], /mr-wise_.*\.xlsx"/);

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.body);
    const ws = wb.worksheets[0];
    assert.match(String(ws.getCell('A1').value), /MR-Wise/);
    assert.equal(ws.getCell('A4').value, 'MR Name');
    const names = [ws.getCell('A5').value, ws.getCell('A6').value];
    assert.ok(names.includes('=HYPERLINK("http://evil")'), 'kept as plain text');
    ws.eachRow((row) => row.eachCell((cell) => assert.notEqual(cell.type, ExcelJS.ValueType.Formula)));
    assert.equal(typeof ws.getCell('C5').value, 'number');
  });

  it('admin reports honour the "reports" section permission', async () => {
    const owner = await loginAdmin();
    const support = await staffMember(owner, 'Support');
    await get(owner, '/reports/monitoring').expect(200);
    await get(support, '/reports/monitoring').expect(403);
  });
});
