import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { ApiError } from '../../utils/ApiError.js';

/**
 * SMS delivery boundary. SMS_PROVIDER picks the gateway; the auth logic
 * never changes. Neither the code nor the auth key is ever logged.
 */
const masked = (mobile) => `******${mobile.slice(-4)}`;

export const devSmsProvider = {
  name: 'dev',
  async sendOtp(mobile, _code) {
    // In dev mode the code is returned by the API instead.
    logger.info({ to: masked(mobile) }, 'OTP issued (dev provider, not sent)');
  },
};

/**
 * MSG91 OTP API (v5) with our own generated code. The DLT-approved template
 * must contain the ##OTP## variable. Numbers are Indian 10-digit → "91" prefix.
 */
export const msg91SmsProvider = {
  name: 'msg91',
  async sendOtp(mobile, code) {
    const url = new URL('/api/v5/otp', env.MSG91_BASE_URL);
    url.search = new URLSearchParams({
      template_id: env.MSG91_OTP_TEMPLATE_ID,
      mobile: `91${mobile}`,
      otp: code,
      otp_expiry: String(Math.ceil(env.OTP_TTL_SECONDS / 60)),
    }).toString();

    let status;
    let body;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { authkey: env.MSG91_AUTH_KEY, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: '{}',
        signal: AbortSignal.timeout(10_000),
      });
      status = res.status;
      body = await res.json().catch(() => null);
    } catch (err) {
      logger.error({ to: masked(mobile), err: err?.name ?? 'Error' }, 'MSG91 request failed');
      throw new ApiError(502, 'SMS_FAILED', 'Could not send the PIN. Please try again.');
    }
    if (status < 200 || status >= 300 || body?.type !== 'success') {
      logger.error({ to: masked(mobile), status, msg91: body?.message ?? null }, 'MSG91 rejected the OTP');
      throw new ApiError(502, 'SMS_FAILED', 'Could not send the PIN. Please try again.');
    }
    logger.info({ to: masked(mobile), requestId: body.request_id }, 'OTP sent (MSG91)');
  },
};

const providers = { dev: devSmsProvider, msg91: msg91SmsProvider };

export const activeSmsProvider = providers[env.SMS_PROVIDER];
