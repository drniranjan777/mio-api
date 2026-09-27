/**
 * Base catalogue every environment needs: plans, FAQs and legal pages.
 * Copy comes from the design PDFs. Inserted only when missing, so admin edits
 * made later (Phase 4 panel) are never overwritten by re-seeding.
 */
import { Plan } from '../src/modules/billing/billing.models.js';
import { ContentPage, Faq } from '../src/modules/support/support.models.js';

const MR_FEATURES = ['Download Doctors List', 'View Doctor Profiles', 'Book / View Appointments', 'Other App Features'];

export const PLANS = [
  { code: 'mr-yearly', role: 'mr', name: 'Yearly', period: 'yearly', pricePaise: 20000, mrpPaise: 40000, features: MR_FEATURES, sort: 1 },
  { code: 'mr-monthly', role: 'mr', name: 'Monthly', period: 'monthly', pricePaise: 2000, mrpPaise: 4000, features: MR_FEATURES, sort: 2 },
  { code: 'doctor-lifetime-free', role: 'doctor', name: 'Lifetime Free', period: 'lifetime', pricePaise: 0, mrpPaise: 4000, features: MR_FEATURES, sort: 1 },
];

export const FAQS = [
  ['all', 'How can I manage MR appointments?', 'I want to view, accept, reschedule, or manage appointments with Medical Representatives.'],
  ['doctor', 'How can I change my appointment availability?', 'Open Home and switch between Auto Mode, Manual Mode or Out of clinic.'],
  ['all', 'I am not receiving appointment notifications', 'Check App Settings > Notification and make sure notifications are enabled.'],
  ['all', 'How can I view my reports?', 'Open the Reports tab, choose your filters and tap Generate Reports.'],
  ['doctor', 'How can I change my consultation fee?', 'Go to Profile > Profile Details and edit the consultation fee.'],
  ['doctor', 'How can I update pharmacist details?', 'Go to Profile > Profile Details > Personal Contact details.'],
  ['all', 'How can I contact MIO support?', 'Use Help Desk to chat on WhatsApp or email the support team.'],
];

export const PAGES = [
  {
    key: 'terms-of-service',
    title: 'Terms of Service',
    effectiveDate: '2026-09-15',
    intro:
      'Welcome to the MioLife Healthcare Doctor App. These Terms of Service govern your access to and use of the application and its services. By registering or using the app, you agree to comply with these terms.',
    sections: [
      {
        title: '1. Eligibility',
        points: [
          'The app is intended for registered doctors and authorized healthcare professionals.',
          'You must provide accurate and complete information during registration.',
          'You are responsible for maintaining the accuracy of your profile information.',
        ],
      },
      {
        title: '2. Doctor Account',
        points: [
          'Your account is personal to you and should not be shared with another person.',
          'You are responsible for keeping your login credentials secure.',
          'You must immediately report any unauthorized access to your account.',
        ],
      },
      {
        title: 'Subscription & Payments',
        points: [
          'Certain features or services may require a paid subscription.',
          'Applicable subscription fees, taxes, billing frequency, and payment details will be displayed before payment.',
          'Subscriptions may automatically renew where applicable and according to the selected plan.',
        ],
      },
    ],
  },
  {
    key: 'terms-of-agreement',
    title: 'Terms of Agreement',
    effectiveDate: '2026-09-15',
    intro: 'By registering with MioLife Healthcare and using the Doctor App, I acknowledge and agree to the following:',
    sections: [
      {
        title: '1. Professional Information',
        body: 'I confirm that the professional, educational, registration, contact, and practice information submitted by me is true, accurate, and up to date.',
      },
      {
        title: '2. Professional Credentials',
        body: 'I confirm that I possess the qualifications and registrations required to practice my stated profession or specialty and will provide supporting documentation when requested.',
      },
      {
        title: '3. Account Security',
        body: 'I am responsible for protecting my account credentials and for all activity performed through my account, except where caused by circumstances outside my reasonable control.',
      },
      {
        title: '4. Suspension',
        body: 'I understand that access to my account may be restricted or suspended if information is found to be fraudulent, inaccurate, unauthorized, or in violation of applicable terms or policies.',
      },
    ],
  },
];

export async function seedCatalog() {
  for (const plan of PLANS) {
    await Plan.updateOne({ code: plan.code }, { $setOnInsert: plan }, { upsert: true });
  }
  if (!(await Faq.exists({}))) {
    await Faq.insertMany(FAQS.map(([audience, question, answer], sort) => ({ audience, question, answer, sort })));
  }
  for (const page of PAGES) {
    await ContentPage.updateOne({ key: page.key }, { $setOnInsert: page }, { upsert: true });
  }
}
