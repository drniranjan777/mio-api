import { ApiError } from '../utils/ApiError.js';

/**
 * Validates and replaces req.body / req.query / req.params with the parsed
 * (unknown keys stripped) values, which prevents mass assignment.
 */
export const validate =
  ({ body, query, params } = {}) =>
  (req, _res, next) => {
    const details = [];
    const run = (schema, key) => {
      if (!schema) return;
      const result = schema.safeParse(req[key] ?? {});
      if (result.success) {
        if (key === 'query') {
          Object.defineProperty(req, 'query', { value: result.data, writable: true, configurable: true });
        } else {
          req[key] = result.data;
        }
      } else {
        for (const issue of result.error.issues) {
          details.push({ in: key, path: issue.path.join('.'), message: issue.message });
        }
      }
    };
    run(params, 'params');
    run(query, 'query');
    run(body, 'body');
    if (details.length) return next(ApiError.badRequest('Validation failed', details, 'VALIDATION_ERROR'));
    return next();
  };
