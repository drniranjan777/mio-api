import crypto from 'node:crypto';

import { env } from '../../config/env.js';
import { ApiError } from '../../utils/ApiError.js';
import { OtpCode } from './auth.models.js';
import { activeSmsProvider } from './sms.provider.js';

const OTP_LENGTH = 4; // "Enter 4 digit PIN" per the design
const HOURLY_LIMIT = 5;

const hash = (mobile, purpose, code) =>
  crypto.createHmac('sha256', env.OTP_PEPPER).update(`${mobile}|${purpose}|${code}`).digest('hex');

const generate = () => crypto.randomInt(0, 10 ** OTP_LENGTH).toString().padStart(OTP_LENGTH, '0');

/** Issues an OTP. Returns `{ expiresIn, resendIn, devOtp? }`. */
export async function issueOtp(mobile, purpose) {
  // The dev provider sends nothing; outside dev mode that would silently lock users out.
  if (activeSmsProvider.name === 'dev' && !env.OTP_DEV_MODE) {
    throw new ApiError(503, 'SMS_NOT_CONFIGURED', 'Sign-in by SMS is not available yet. Please try again later.');
  }
  const now = Date.now();
  const latest = await OtpCode.findOne({ mobile, purpose }).sort({ createdAt: -1 }).lean();
  if (latest) {
    const wait = env.OTP_RESEND_SECONDS * 1000 - (now - latest.createdAt.getTime());
    if (wait > 0) {
      throw ApiError.tooMany(`Please wait ${Math.ceil(wait / 1000)}s before requesting a new PIN`, 'OTP_RESEND_WAIT');
    }
  }
  const lastHour = await OtpCode.countDocuments({ mobile, createdAt: { $gte: new Date(now - 3_600_000) } });
  if (lastHour >= HOURLY_LIMIT) throw ApiError.tooMany('Too many PIN requests. Try again later.', 'OTP_LIMIT');

  const code = generate();
  await OtpCode.deleteMany({ mobile, purpose });
  await OtpCode.create({
    mobile,
    purpose,
    codeHash: hash(mobile, purpose, code),
    expiresAt: new Date(now + env.OTP_TTL_SECONDS * 1000),
  });
  await activeSmsProvider.sendOtp(mobile, code);

  const result = { expiresIn: env.OTP_TTL_SECONDS, resendIn: env.OTP_RESEND_SECONDS };
  if (env.OTP_DEV_MODE) result.devOtp = code;
  return result;
}

/** Verifies and consumes an OTP; throws on any failure. */
export async function verifyOtp(mobile, purpose, code) {
  const otp = await OtpCode.findOne({ mobile, purpose }).sort({ createdAt: -1 });
  if (!otp || otp.expiresAt.getTime() < Date.now()) {
    throw ApiError.badRequest('PIN expired. Please request a new one.', undefined, 'OTP_EXPIRED');
  }
  if (otp.attempts >= env.OTP_MAX_ATTEMPTS) {
    await otp.deleteOne();
    throw ApiError.tooMany('Too many wrong attempts. Please request a new PIN.', 'OTP_LOCKED');
  }
  const expected = Buffer.from(otp.codeHash, 'hex');
  const given = Buffer.from(hash(mobile, purpose, code), 'hex');
  if (!crypto.timingSafeEqual(expected, given)) {
    otp.attempts += 1;
    await otp.save();
    throw ApiError.badRequest('Incorrect PIN', undefined, 'OTP_INVALID');
  }
  await otp.deleteOne();
}
