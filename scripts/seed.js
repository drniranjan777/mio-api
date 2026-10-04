/* eslint-disable no-console */
/**
 * npm run seed        → first admin (from SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD) + catalogue
 * npm run seed:demo   → + demo doctors, MR, receptionist and appointments
 * Idempotent: existing records (by mobile/email) are left untouched.
 */
import bcrypt from 'bcryptjs';

import { connectDb, disconnectDb } from '../src/config/db.js';
import { env } from '../src/config/env.js';
import { ensureSystemRoles } from '../src/modules/staff/adminAccess.js';
import { seedCatalog } from './catalog.js';
import { makePng } from './lib/png.js';
import { runMigrations } from './migrate.js';
import { checkAdminPassword } from './password-policy.js';
import { ReceptionistAccess } from '../src/modules/access/receptionistAccess.model.js';
import { Appointment } from '../src/modules/appointments/appointment.model.js';
import { Banner } from '../src/modules/banners/banner.model.js';
import { Wish } from '../src/modules/birthdays/wish.model.js';
import { occurrence, parseDob } from '../src/modules/birthdays/birthday.js';
import { Conference } from '../src/modules/conferences/conference.models.js';
import { Location } from '../src/modules/locations/location.model.js';
import { McLEntry } from '../src/modules/mcl/mcl.model.js';
import { buildSlots, localParts } from '../src/modules/appointments/schedule.js';
import { DoctorProfile, MrProfile, ReceptionistProfile } from '../src/modules/profiles/profile.models.js';
import { nextCode } from '../src/modules/users/counter.model.js';
import { saveImage } from '../src/modules/uploads/storage.service.js';
import { User } from '../src/modules/users/user.model.js';

const demo = process.argv.includes('--demo');

async function seedAdmin() {
  const email = process.env.SEED_ADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.SEED_ADMIN_PASSWORD;
  if (!email || !password) {
    console.log('• Admin skipped (set SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD in .env to create one)');
    return;
  }
  checkAdminPassword(password);
  if (await User.exists({ email })) return console.log(`• Admin ${email} already exists (change its password with: npm run admin:password)`);
  await User.create({ role: 'admin', name: 'Administrator', email, passwordHash: await bcrypt.hash(password, 12) });
  console.log(`• Admin ${email} created`);
}

async function upsertUser(role, mobile, name, Profile, profile) {
  let user = await User.findOne({ mobile });
  if (!user) {
    user = await User.create({ role, mobile, name, onboarding: { profile: true, final: true } });
    await Profile.create({ user: user._id, code: await nextCode(role), ...profile });
  }
  return user;
}

const mrCall = { days: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'], from: '10:00', to: '16:00', slotMinutes: 15, maxPerDay: 20, companyTypes: ['all'] };
const practice = (type, clinicName) => ({
  type,
  clinicName,
  preferredPlace: type === 'hospital' ? 'Hospital' : 'Clinic',
  address: 'A-102, Green Park',
  city: 'Hyderabad',
  state: 'Telangana',
  pincode: '500034',
  locationType: 'Metro',
  territoryClass: 'HQ',
});

async function seedDemo() {
  const rahul = await upsertUser('doctor', '9000000001', 'Dr. Rahul Sharma', DoctorProfile, {
    qualification: 'MBBS, MD', specialty: 'Cardiology', practice: practice('clinic', 'Sunrise Clinic'), mrCall,
    contacts: { receptionistName: 'Priya Sharma', receptionistMobile: '9876543210' }, availability: 'manual',
  });
  const priyaM = await upsertUser('doctor', '9000000002', 'Dr. Priya Mehta', DoctorProfile, {
    qualification: 'MBBS, DM', specialty: 'Neurology', practice: practice('hospital', 'Apollo Hospital'), mrCall, availability: 'auto',
  });
  const arjun = await upsertUser('doctor', '9000000004', 'Dr. Arjun Rao', DoctorProfile, {
    qualification: 'MBBS, MD', specialty: 'Diabetology', practice: practice('clinic', 'Care Clinic'), mrCall,
  });
  const mr = await upsertUser('mr', '9000000101', 'Rohit Sharma', MrProfile, {
    company: { name: 'Cipla Ltd.', type: 'Pharmaceutical' }, division: 'Cardio Care', specialty: 'General Physician',
  });
  const receptionist = await upsertUser('receptionist', '9876543210', 'Priya Sharma', ReceptionistProfile, {});
  const suman = await upsertUser('receptionist', '9987766554', 'Suman Reddy', ReceptionistProfile, {});

  const grants = [
    [rahul, receptionist, 'active', ['view', 'book', 'reschedule', 'cancel']],
    [priyaM, receptionist, 'active', ['view', 'book', 'reschedule']],
    [arjun, receptionist, 'inactive', ['view']],
    [rahul, suman, 'active', ['view']],
  ];
  for (const [doctor, r, status, permissions] of grants) {
    await ReceptionistAccess.updateOne(
      { doctor: doctor._id, receptionist: r._id },
      { $setOnInsert: { status, permissions, grantedBy: doctor._id, grantedAt: new Date() } },
      { upsert: true },
    );
  }

  if (!(await Appointment.exists({ doctor: rahul._id }))) {
    // Next working day's slots, a mix of statuses as in the designs.
    let date = new Date(Date.now() + 86_400_000);
    while (!buildSlots({ mrCall }, localParts(date).dateStr).length) date = new Date(date.getTime() + 86_400_000);
    const slots = buildSlots({ mrCall }, localParts(date).dateStr);
    const visits = [
      [rahul, 0, 'approved', 'Deepak Sharma', 'Sun Pharma', 'Neuro-prizma'],
      [rahul, 1, 'approved', 'Anjali Verma', 'Cipla', 'Respiratory Care'],
      [rahul, 3, 'pending', 'Rajesh Kumar', 'Abbott', 'Cardiology'],
      [rahul, 4, 'cancelled', 'Priya Mehta', 'Mankind Pharma', 'Gastro'],
      [rahul, 5, 'approved', 'Amit Singh', "Dr. Reddy's Lab.", 'Diabetology'],
      [priyaM, 4, 'approved', 'Rajesh Kumar', 'Sun Pharma', 'Neuro Care'],
      [priyaM, 6, 'pending', 'Anjali Verma', 'Cipla', 'Respiratory Care'],
    ];
    for (const [doctor, i, status, name, company, division] of visits) {
      await Appointment.create({
        doctor: doctor._id,
        visitor: { name, company, division },
        startAt: slots[i].startAt,
        endAt: slots[i].endAt,
        status,
        purpose: 'Product Discussion',
        createdBy: { user: doctor._id, role: 'doctor' },
        history: [{ action: 'created', by: doctor._id, role: 'doctor', to: { status } }],
      });
    }
    await Appointment.create({
      doctor: rahul._id,
      mr: mr._id,
      visitor: { name: mr.name, company: 'Cipla Ltd.', division: 'Cardio Care' },
      startAt: slots[8].startAt,
      endAt: slots[8].endAt,
      status: 'pending',
      purpose: 'Product Discussion',
      createdBy: { user: mr._id, role: 'mr' },
      history: [{ action: 'created', by: mr._id, role: 'mr', to: { status: 'pending' } }],
    });
  }

  await seedPhase2({ rahul, priyaM, arjun, mr });
  await seedBanners(rahul);

  console.log(`• Demo data ready
    Doctor        9000000001  Dr. Rahul Sharma  (manual approval)
    Doctor        9000000002  Dr. Priya Mehta   (auto approval)
    Doctor        9000000004  Dr. Arjun Rao
    MR            9000000101  Rohit Sharma
    Receptionist  9876543210  Priya Sharma  (Rahul: all · Priya Mehta: view/book/reschedule · Arjun: inactive)
    Receptionist  9987766554  Suman Reddy   (Rahul: view only)
    OTP: dev mode returns the PIN in the API response.`);
}

/** "DD/MM/YYYY" for a birthday `days` from today (IST), born `age` years ago. */
function dobIn(days, age) {
  const d = localParts(new Date(Date.now() + days * 86_400_000)).dateStr.split('-').map(Number);
  return `${String(d[2]).padStart(2, '0')}/${String(d[1]).padStart(2, '0')}/${d[0] - age}`;
}

async function seedPhase2({ rahul, priyaM, arjun, mr }) {
  // Birthdays: only set when the doctor has none yet.
  for (const [doctor, days, age] of [
    [rahul, 3, 38],
    [priyaM, 12, 41],
    [arjun, 45, 52],
  ]) {
    await DoctorProfile.updateOne(
      { user: doctor._id, $or: [{ dateOfBirth: { $exists: false } }, { dateOfBirth: '' }] },
      { $set: { dateOfBirth: dobIn(days, age) } },
    );
  }

  for (const doctor of [rahul, priyaM]) {
    await McLEntry.updateOne({ mr: mr._id, doctor: doctor._id }, { $setOnInsert: { createdAt: new Date() } }, { upsert: true });
  }

  const rahulProfile = await DoctorProfile.findOne({ user: rahul._id }).lean();
  const occ = occurrence(parseDob(rahulProfile.dateOfBirth));
  if (!(await Wish.exists({ doctor: rahul._id }))) {
    await Wish.create({
      doctor: rahul._id,
      mr: mr._id,
      birthdayOn: occ.date,
      company: 'Cipla Ltd.',
      message: 'Happy Birthday Doctor! Wishing you great health, happiness and many more successful years ahead.',
    });
  }

  if (!(await Conference.exists({}))) {
    // Logos are app asset paths for the demo; real conferences use https URLs.
    const year = new Date().getFullYear() + 1;
    await Conference.insertMany([
      { title: `CIS Annual Conference ${year}`, organizer: 'Cardiological Society of India', startDate: `${year}-01-15`, endDate: `${year}-01-18`, venue: 'Hyderabad International Convention Centre', city: 'Hyderabad', specialty: 'Cardiology', logoUrl: 'assets/images/logo_cis.png' },
      { title: `ANCIPS ${year}`, organizer: 'Indian Psychiatric Society', startDate: `${year}-01-28`, endDate: `${year}-01-31`, venue: 'Pragati Maidan', city: 'New Delhi', specialty: 'Psychiatry', logoUrl: 'assets/images/logo_ancips.png' },
      { title: `AOSRA Annual Meeting ${year}`, organizer: 'AOSRA', startDate: `${year}-01-10`, endDate: `${year}-01-12`, venue: 'Bangalore International Exhibition Centre', city: 'Bengaluru', specialty: 'Orthopedics', logoUrl: 'assets/images/logo_aosra.png' },
      { title: `Neurology Update ${year}`, organizer: 'Neurological Society of India', startDate: `${year}-02-12`, endDate: `${year}-02-14`, venue: 'Taj Convention Centre', city: 'New Delhi', specialty: 'Neurology', logoUrl: 'assets/images/logo_cis.png' },
    ]);
  }
}

/** The three location scenarios from the banner spec, with generated artwork. */
async function seedBanners(createdBy) {
  if (await Banner.exists({})) return;
  const byName = async (name, type) => (await Location.findOne({ name, type }).lean())?._id;
  const demo = [
    ['Telangana CME Conference', 'Earn CME credits — register now', 'state', [await byName('Telangana', 'state')], [11, 94, 160], [32, 157, 120], 1],
    ['Bengaluru Medical Event', 'Meet 200+ specialists this month', 'city', [await byName('Bengaluru', 'city')], [111, 66, 193], [214, 51, 132], 1],
    ['Mio Doctors Announcement', 'New: Excel reports and conference plans', 'all', [], [8, 100, 172], [95, 168, 232], 5],
  ];
  for (const [title, description, targeting, locations, from, to, priority] of demo) {
    const image = await saveImage(makePng(1080, 490, from, to), 'banner');
    await Banner.create({ title, description, imageKey: image.key, showText: true, targeting, locations, status: 'active', priority, createdBy: createdBy._id });
  }
}

await connectDb(env.MONGODB_URI);
try {
  await seedAdmin();
  await runMigrations('up');
  await seedCatalog();
  await ensureSystemRoles();
  console.log('• Catalogue ready (plans, FAQs, terms pages, admin roles)');
  if (demo) await seedDemo();
} finally {
  await disconnectDb();
}
