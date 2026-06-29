// Typed, operational errors — same idea as your server AppError, minus HTTP plumbing.
// statusCode is kept for parity/log triage; the TUI maps these to friendly messages.
export class AppError extends Error {
  constructor(message, statusCode = 500, opts = {}) {
    super(message);
    this.name = this.constructor.name;
    this.statusCode = statusCode;
    this.isOperational = true;
    if (opts.cause) this.cause = opts.cause;
    if (opts.meta) Object.assign(this, opts.meta);
  }
}

// Critical-vs-decorative branching at the call site, instead of string-matching.
export class NotFoundError extends AppError {
  constructor(message = 'Not found', opts) { super(message, 404, opts); }
}
export class SourceError extends AppError {
  constructor(message = 'Source unavailable', opts) { super(message, 502, opts); }
}
export class UnsupportedError extends AppError {
  constructor(message = 'Unsupported', opts) { super(message, 422, opts); }
}
export class AuthError extends AppError {
  constructor(message = 'Authentication required', opts) { super(message, 401, opts); }
}
