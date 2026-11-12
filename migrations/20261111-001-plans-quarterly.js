/**
 * Corrections of 11 Nov 2026 — MR plans.
 *
 * 1. "Yearly" is shown as "Annual" (price unchanged).
 * 2. "Monthly" (₹20) is replaced by "Quarterly": ₹60 incl. GST for 90 days,
 *    struck price ₹120. The Monthly plan is switched off; anyone on it keeps
 *    the days they have (subscriptions store their own plan snapshot).
 * 3. The trial's "How to avail" steps name Quarterly / Annual.
 *
 * Only values still at what we shipped are changed, so admin edits stay.
 * Down undoes each step the same way.
 */
import { MR_FEATURES, MR_TRIAL_STEPS, PLANS } from '../scripts/catalog.js';

const OLD_TRIAL_LAST = 'Before it ends, choose Monthly or Yearly to continue — the paid time starts after your free days';
const NEW_TRIAL_LAST = MR_TRIAL_STEPS.at(-1);
const QUARTERLY = PLANS.find((p) => p.code === 'mr-quarterly');

async function swapTrialStep(plans, from, to) {
  return plans.updateOne({ code: 'mr-free-2-months', howToAvail: from }, { $set: { 'howToAvail.$': to, updatedAt: new Date() } });
}

export async function up({ db, log }) {
  const plans = db.collection('plans');
  const renamed = await plans.updateOne({ code: 'mr-yearly', name: 'Yearly' }, { $set: { name: 'Annual', updatedAt: new Date() } });

  // Features follow the other MR plans as they are now (admin may have edited them).
  const yearly = await plans.findOne({ code: 'mr-yearly' }, { projection: { features: 1 } });
  const now = new Date();
  const added = await plans.updateOne(
    { code: QUARTERLY.code },
    { $setOnInsert: { ...QUARTERLY, features: yearly?.features?.length ? yearly.features : MR_FEATURES, active: true, createdAt: now, updatedAt: now } },
    { upsert: true },
  );
  const retired = await plans.updateOne({ code: 'mr-monthly', active: { $ne: false } }, { $set: { active: false, updatedAt: now } });
  const steps = await swapTrialStep(plans, OLD_TRIAL_LAST, NEW_TRIAL_LAST);

  log(`  Annual: ${renamed.modifiedCount ? 'renamed' : 'name kept'}`);
  log(`  Quarterly: ${added.upsertedCount ? 'added (₹60, struck ₹120, 90 days)' : 'already there'}`);
  log(`  Monthly: ${retired.modifiedCount ? 'switched off' : 'already off or missing'}`);
  log(`  trial steps: ${steps.modifiedCount ? 'updated' : 'unchanged'}`);
}

export async function down({ db, log }) {
  const plans = db.collection('plans');
  const now = new Date();
  await plans.updateOne({ code: 'mr-yearly', name: 'Annual' }, { $set: { name: 'Yearly', updatedAt: now } });
  await plans.updateOne({ code: QUARTERLY.code }, { $set: { active: false, updatedAt: now } });
  await plans.updateOne({ code: 'mr-monthly' }, { $set: { active: true, updatedAt: now } });
  await swapTrialStep(plans, NEW_TRIAL_LAST, OLD_TRIAL_LAST);
  log('  plans: Yearly / Monthly restored, Quarterly switched off');
}
