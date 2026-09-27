/** Error with an HTTP status and a stable machine-readable code. */
export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }

  static badRequest(message, details, code = 'BAD_REQUEST') {
    return new ApiError(400, code, message, details);
  }

  static unauthorized(message = 'Authentication required', code = 'UNAUTHORIZED') {
    return new ApiError(401, code, message);
  }

  static forbidden(message = 'You do not have permission to do this', code = 'FORBIDDEN') {
    return new ApiError(403, code, message);
  }

  static notFound(message = 'Resource not found', code = 'NOT_FOUND') {
    return new ApiError(404, code, message);
  }

  static conflict(message, code = 'CONFLICT') {
    return new ApiError(409, code, message);
  }

  static unprocessable(message, code = 'BUSINESS_RULE') {
    return new ApiError(422, code, message);
  }

  static tooMany(message, code = 'RATE_LIMITED') {
    return new ApiError(429, code, message);
  }
}
