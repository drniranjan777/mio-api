/* eslint-disable no-console */
/**
 * npm run admin:password
 * Sets the password of the admin in SEED_ADMIN_EMAIL to SEED_ADMIN_PASSWORD
 * (both from .env), creating the admin if it does not exist yet. Every
 * existing admin session is signed out. The password is never printed.
 */
import bcrypt from 'bcryptjs';

import { connectDb, disconnectDb } from '../src/config/db.js';
import { env } from '../src/config/env.js';
import { audit } from '../src/modules/audit/audit.js';
import { revokeAllSessions } from '../src/modules/auth/token.service.js';
import { User } from '../src/modules/users/user.model.js';
import { checkAdminPassword } from './password-policy.js';

async function main() {
  const email = process.env.SEED_ADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.SEED_ADMIN_PASSWORD;
  if (!email) throw new Error('Set SEED_ADMIN_EMAIL in .env');
  checkAdminPassword(password);

  await connectDb(env.MONGODB_URI);
  try {
    const passwordHash = await bcrypt.hash(password, 12);
    let admin = await User.findOne({ email, role: 'admin' });
    if (admin) {
      admin.passwordHash = passwordHash;
      admin.status = 'active';
      await admin.save();
      await revokeAllSessions(admin._id);
      console.log(`• Password updated for ${email} (all admin sessions signed out)`);
    } else {
      if (await User.exists({ email })) throw new Error(`${email} belongs to a non-admin account`);
      admin = await User.create({ role: 'admin', name: 'Administrator', email, passwordHash });
      console.log(`• Admin ${email} created`);
    }
    await audit({ actor: admin, action: 'auth.admin_password_set', module: 'auth', entityType: 'User', entityId: admin._id });
  } finally {
    await disconnectDb();
  }
}

main().catch((err) => {
  console.error(`✖ ${err.message}`);
  process.exitCode = 1;
});
