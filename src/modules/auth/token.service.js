import crypto from 'node:crypto';

import jwt from 'jsonwebtoken';

import { env } from '../../config/env.js';
import { ApiError } from '../../utils/ApiError.js';
import { User } from '../users/user.model.js';
import { RefreshToken } from './auth.models.js';

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

export function signAccessToken(user) {
  return jwt.sign({ sub: user._id.toString(), role: user.role, tv: user.tokenVersion }, env.JWT_ACCESS_SECRET, {
    expiresIn: env.JWT_ACCESS_TTL,
    algorithm: 'HS256',
  });
}

export function verifyAccessToken(token) {
  return jwt.verify(token, env.JWT_ACCESS_SECRET, { algorithms: ['HS256'] });
}

async function createRefreshToken(user, family, req) {
  const raw = crypto.randomBytes(32).toString('base64url');
  await RefreshToken.create({
    user: user._id,
    tokenHash: sha256(raw),
    family,
    expiresAt: new Date(Date.now() + env.REFRESH_TOKEN_TTL_DAYS * 86_400_000),
    userAgent: req?.get?.('user-agent'),
    ip: req?.ip,
  });
  return raw;
}

export async function issueTokens(user, req) {
  const refreshToken = await createRefreshToken(user, crypto.randomUUID(), req);
  return { accessToken: signAccessToken(user), refreshToken, tokenType: 'Bearer' };
}

/**
 * Rotates a refresh token. Presenting an already-rotated token is treated as
 * theft: the whole token family is revoked.
 */
export async function rotateRefreshToken(raw, req) {
  const stored = await RefreshToken.findOne({ tokenHash: sha256(raw) });
  if (!stored || stored.expiresAt.getTime() < Date.now()) {
    throw ApiError.unauthorized('Session expired. Please sign in again.', 'REFRESH_INVALID');
  }
  if (stored.revokedAt) {
    await RefreshToken.updateMany({ family: stored.family, revokedAt: null }, { revokedAt: new Date() });
    throw ApiError.unauthorized('Session expired. Please sign in again.', 'REFRESH_REUSED');
  }
  const user = await User.findById(stored.user);
  if (!user || user.status !== 'active') {
    throw ApiError.unauthorized('Account is not active', 'ACCOUNT_INACTIVE');
  }
  const next = await createRefreshToken(user, stored.family, req);
  stored.revokedAt = new Date();
  stored.replacedBy = sha256(next);
  await stored.save();
  return { user, tokens: { accessToken: signAccessToken(user), refreshToken: next, tokenType: 'Bearer' } };
}

export async function revokeRefreshToken(raw) {
  await RefreshToken.updateOne({ tokenHash: sha256(raw), revokedAt: null }, { revokedAt: new Date() });
}

/** Signs the user out everywhere: kills refresh tokens and invalidates access tokens. */
export async function revokeAllSessions(userId) {
  await RefreshToken.updateMany({ user: userId, revokedAt: null }, { revokedAt: new Date() });
  await User.updateOne({ _id: userId }, { $inc: { tokenVersion: 1 } });
}
