import { env } from '../../config/env.js';
import { ApiError } from '../../utils/ApiError.js';

/** Admin-panel passwords: 12+ characters in production, 8+ allowed in development. */
export const minAdminPasswordLength = () => (env.isProduction ? 12 : 8);

export function assertAdminPassword(password, path = 'newPassword') {
  const min = minAdminPasswordLength();
  if (typeof password !== 'string' || password.length < min || password.length > 128) {
    throw ApiError.badRequest(`Password must be ${min}–128 characters`, [{ path, message: `At least ${min} characters` }], 'VALIDATION_ERROR');
  }
}
