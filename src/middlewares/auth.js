import { verifyAccessToken } from '../modules/auth/token.service.js';
import { User } from '../modules/users/user.model.js';
import { ApiError } from '../utils/ApiError.js';

/**
 * Verifies the Bearer token and loads the user from the database, so role,
 * status and token version always come from the server — never the client.
 */
export async function authenticate(req, _res, next) {
  try {
    const header = req.get('authorization') ?? '';
    const [scheme, token] = header.split(' ');
    if (scheme !== 'Bearer' || !token) throw ApiError.unauthorized();

    let payload;
    try {
      payload = verifyAccessToken(token);
    } catch (err) {
      throw err?.name === 'TokenExpiredError'
        ? ApiError.unauthorized('Access token expired', 'TOKEN_EXPIRED')
        : ApiError.unauthorized('Invalid access token', 'TOKEN_INVALID');
    }

    const user = await User.findById(payload.sub);
    if (!user || user.tokenVersion !== payload.tv) throw ApiError.unauthorized('Session ended', 'SESSION_REVOKED');
    if (user.status !== 'active') throw ApiError.forbidden('Your account is not active', 'ACCOUNT_INACTIVE');

    req.user = user;
    next();
  } catch (err) {
    next(err);
  }
}

export const requireRole =
  (...roles) =>
  (req, _res, next) => {
    if (!req.user) return next(ApiError.unauthorized());
    if (!roles.includes(req.user.role)) return next(ApiError.forbidden());
    return next();
  };
