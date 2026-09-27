import { logger } from '../../config/logger.js';

/**
 * SMS delivery boundary. Swap `activeSmsProvider` for a real gateway
 * (MSG91, Twilio, …) without touching the auth logic.
 */
export const devSmsProvider = {
  name: 'dev',
  async sendOtp(mobile, _code) {
    // The code itself is never logged; in dev mode it is returned by the API instead.
    logger.info({ to: `******${mobile.slice(-4)}` }, 'OTP issued (dev provider, not sent)');
  },
};

export const activeSmsProvider = devSmsProvider;
