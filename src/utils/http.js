/** Wraps an async route handler so rejections reach the error middleware. */
export const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

export function ok(res, data, meta, status = 200) {
  const body = { success: true, data };
  if (meta) body.meta = meta;
  return res.status(status).json(body);
}

export const created = (res, data) => ok(res, data, undefined, 201);

export function noContent(res) {
  return res.status(204).end();
}

/** Parses `page` / `limit` (already validated) into skip/limit + meta builder. */
export function paging({ page = 1, limit = 20 }) {
  return {
    skip: (page - 1) * limit,
    limit,
    meta: (total) => ({ page, limit, total, pages: Math.ceil(total / limit) }),
  };
}
