/**
 * UI/UX change list of 11 Oct 2026 — data part.
 *
 * 1. Person codes restart in the new format, in registration order:
 *    DR00001…, MR00001…, RC00001… The previous code is kept in `legacyCode`
 *    (support staff can still search it) and the counters continue from there.
 * 2. Plans: "Download Doctors List" removed from every feature list (the
 *    Master MCL cannot be downloaded any more); SAC code filled where empty;
 *    the MR "2 Months Free" trial plan added.
 * 3. MR profiles: `specialties` list filled from the single `specialty`.
 *
 * Down restores the old codes and counters, puts the removed feature back and
 * deactivates the trial plan (claimed trials stay valid).
 */
import { MR_FEATURES, DEFAULT_SAC, PLANS } from '../scripts/catalog.js';
import { Plan } from '../src/modules/billing/billing.models.js';
import { DoctorProfile, MrProfile, ReceptionistProfile } from '../src/modules/profiles/profile.models.js';
import { Counter, formatCode } from '../src/modules/users/counter.model.js';

const REMOVED_FEATURE = 'Download Doctors List';
const PEOPLE = [
  ['doctor', DoctorProfile],
  ['mr', MrProfile],
  ['receptionist', ReceptionistProfile],
];

async function renumber(role, Model, log) {
  const rows = await Model.find({}, { _id: 1, code: 1, legacyCode: 1 }).sort({ createdAt: 1, _id: 1 }).lean();
  // Two passes so a new code never collides with an old one under the unique index.
  await Model.bulkWrite(
    rows.map((r) => ({
      updateOne: {
        filter: { _id: r._id },
        update: { $set: { code: `TMP-${r._id}`, legacyCode: r.legacyCode ?? r.code } },
      },
    })),
    { ordered: false },
  );
  await Model.bulkWrite(
    rows.map((r, i) => ({ updateOne: { filter: { _id: r._id }, update: { $set: { code: formatCode(role, i + 1) } } } })),
    { ordered: false },
  );
  await Counter.updateOne({ _id: role }, { $set: { seq: rows.length } }, { upsert: true });
  log(`  ${role}: ${rows.length} code(s) renumbered`);
}

export async function up({ db, log }) {
  for (const [role, Model] of PEOPLE) {
    if (await Model.countDocuments()) await renumber(role, Model, log);
  }

  const plans = db.collection('plans');
  const pulled = await plans.updateMany({ features: REMOVED_FEATURE }, { $pull: { features: REMOVED_FEATURE } });
  await plans.updateMany({ $or: [{ sacCode: { $exists: false } }, { sacCode: '' }] }, { $set: { sacCode: DEFAULT_SAC } });
  const trial = PLANS.find((p) => p.period === 'trial');
  await Plan.updateOne({ code: trial.code }, { $setOnInsert: { ...trial, features: MR_FEATURES } }, { upsert: true });
  log(`  plans: feature removed from ${pulled.modifiedCount}, trial plan "${trial.code}" ensured`);

  const mrs = await db
    .collection('mrprofiles')
    // Mongoose stores missing arrays as [], so "not set" means absent or empty.
    .updateMany(
      { specialty: { $type: 'string', $ne: '' }, $or: [{ specialties: { $exists: false } }, { specialties: { $size: 0 } }] },
      [{ $set: { specialties: ['$specialty'] } }],
    );
  log(`  MR profiles: specialties filled on ${mrs.modifiedCount}`);
}

export async function down({ db, log }) {
  for (const [role, Model] of PEOPLE) {
    const rows = await Model.find({ legacyCode: { $type: 'string' } }, { _id: 1, legacyCode: 1 }).lean();
    if (!rows.length) continue;
    await Model.bulkWrite(rows.map((r) => ({ updateOne: { filter: { _id: r._id }, update: { $set: { code: `TMP-${r._id}` } } } })), { ordered: false });
    await Model.bulkWrite(
      rows.map((r) => ({ updateOne: { filter: { _id: r._id }, update: { $set: { code: r.legacyCode }, $unset: { legacyCode: '' } } } })),
      { ordered: false },
    );
    // Old format was 10000 + seq.
    const max = Math.max(0, ...rows.map((r) => Number(String(r.legacyCode).replace(/\D/g, '')) - 10000));
    await Counter.updateOne({ _id: role }, { $set: { seq: max } }, { upsert: true });
    log(`  ${role}: ${rows.length} code(s) restored`);
  }
  await db.collection('plans').updateMany({ role: 'mr', period: { $in: ['monthly', 'yearly'] } }, { $addToSet: { features: REMOVED_FEATURE } });
  await db.collection('plans').updateOne({ code: 'mr-free-2-months' }, { $set: { active: false } });
  log('  plans: feature restored, trial plan deactivated');
}
