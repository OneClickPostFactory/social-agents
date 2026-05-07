export class HttpError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly details?: Record<string, unknown>;
  readonly expose: boolean;

  constructor(
    status: number,
    message: string,
    options?: {
      code?: string;
      details?: Record<string, unknown>;
      expose?: boolean;
    }
  ) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = options?.code;
    this.details = options?.details;
    this.expose = options?.expose ?? status < 500;
  }
}

export function badRequest(message: string, code?: string, details?: Record<string, unknown>): never {
  throw new HttpError(400, message, { code, details });
}

export function unauthorized(message = 'Authentication required', code?: string): never {
  throw new HttpError(401, message, { code });
}

export function forbidden(message = 'Forbidden', code?: string, details?: Record<string, unknown>): never {
  throw new HttpError(403, message, { code, details });
}

export function notFound(message = 'Not found', code?: string): never {
  throw new HttpError(404, message, { code });
}

export function conflict(message: string, code?: string, details?: Record<string, unknown>): never {
  throw new HttpError(409, message, { code, details });
}

export function tooManyRequests(message: string, code?: string, details?: Record<string, unknown>): never {
  throw new HttpError(429, message, { code, details });
}

export function locked(message: string, code?: string, details?: Record<string, unknown>): never {
  throw new HttpError(423, message, { code, details });
}

export function serviceUnavailable(message: string, code?: string, details?: Record<string, unknown>): never {
  throw new HttpError(503, message, { code, details });
}

export function upstreamFailure(message = 'Upstream provider request failed', code = 'UPSTREAM_FAILURE'): never {
  throw new HttpError(502, message, { code });
}

export function isHttpError(value: unknown): value is HttpError {
  return value instanceof HttpError;
}
