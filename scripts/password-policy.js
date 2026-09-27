/* eslint-disable no-console */
import { minAdminPasswordLength } from '../src/modules/auth/passwordPolicy.js';

/** Same rule as the API; shorter than 12 only in development (with a warning). */
export function checkAdminPassword(password) {
  const min = minAdminPasswordLength();
  if (!password || password.length < min) {
    throw new Error(`SEED_ADMIN_PASSWORD must be at least ${min} characters${min === 12 ? ' in production' : ''}`);
  }
  if (password.length < 12) {
    console.warn('! Admin password is shorter than 12 characters — fine for local development, not allowed in production.');
  }
}
