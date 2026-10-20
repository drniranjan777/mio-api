/**
 * App Corrections of 18 Oct 2026 — data part.
 *
 * 1. Plans: the MR and doctor plans get the client's feature lists. A plan is
 *    only changed while it still carries one of the lists we shipped before
 *    (an admin's own wording is left alone and reported).
 * 2. Help Desk: the doctors' support email becomes support@miodoctors.com if
 *    it is still the old default.
 *
 * Sundays, fee ranges, designation and the company-type choice need no data
 * changes: old values stay valid and are shown as before.
 *
 * Down puts the previous feature lists and email back (again only where the
 * values are still the ones this migration wrote).
 */
import { DOCTOR_FEATURES, MR_FEATURES, PREVIOUS_FEATURE_LISTS } from '../scripts/catalog.js';

const OLD_DOCTOR_EMAIL = 'doctor@miodoctors.com';
const NEW_DOCTOR_EMAIL = 'support@miodoctors.com';
const OLD_MR = ['View Doctor Profiles', 'Book / View Appointments', 'Other App Features'];
const OLD_DOCTOR = ['Manage MR Appointments', 'Receptionist Access', 'Reports', 'Other App Features'];

const sameList = (a = [], b = []) => a.length === b.length && a.every((v, i) => v === b[i]);

async function setFeatures(db, role, from, to, log) {
  const plans = await db.collection('plans').find({ role }, { projection: { code: 1, features: 1 } }).toArray();
  let changed = 0;
  for (const p of plans) {
    if (from.some((list) => sameList(p.features, list))) {
      await db.collection('plans').updateOne({ _id: p._id }, { $set: { features: to, updatedAt: new Date() } });
      changed += 1;
    } else if (!sameList(p.features, to)) {
      log(`  plan ${p.code}: custom feature list kept (edit it in the admin panel if needed)`);
    }
  }
  log(`  ${role} plans: features updated on ${changed}`);
}

async function setDoctorEmail(db, from, to, log) {
  const res = await db
    .collection('appsettings')
    .updateOne({ key: 'support', 'value.emails.doctor': from }, { $set: { 'value.emails.doctor': to, updatedAt: new Date() } });
  log(`  help desk: doctor email ${res.modifiedCount ? `set to ${to}` : 'unchanged (default or custom value)'}`);
}

export async function up({ db, log }) {
  await setFeatures(db, 'mr', PREVIOUS_FEATURE_LISTS, MR_FEATURES, log);
  await setFeatures(db, 'doctor', PREVIOUS_FEATURE_LISTS, DOCTOR_FEATURES, log);
  await setDoctorEmail(db, OLD_DOCTOR_EMAIL, NEW_DOCTOR_EMAIL, log);
}

export async function down({ db, log }) {
  await setFeatures(db, 'mr', [MR_FEATURES], OLD_MR, log);
  await setFeatures(db, 'doctor', [DOCTOR_FEATURES], OLD_DOCTOR, log);
  await setDoctorEmail(db, NEW_DOCTOR_EMAIL, OLD_DOCTOR_EMAIL, log);
}
