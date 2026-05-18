export type AdoErrorKind =
  | "configuration"
  | "authentication"
  | "authorization"
  | "not_found"
  | "validation"
  | "pagination"
  | "unsupported_field"
  | "network"
  | "unknown";

export interface AdoErrorOptions {
  kind: AdoErrorKind;
  status?: number;
  details?: unknown;
  cause?: unknown;
}

export class AdoError extends Error {
  readonly kind: AdoErrorKind;
  readonly status?: number;
  readonly details?: unknown;

  constructor(message: string, options: AdoErrorOptions) {
    super(message);
    this.name = "AdoError";
    this.kind = options.kind;
    if (options.status !== undefined) {
      this.status = options.status;
    }
    if (options.details !== undefined) {
      this.details = options.details;
    }
    if (options.cause !== undefined) {
      (this as Error & { cause?: unknown }).cause = options.cause;
    }
  }
}

export function isAdoError(error: unknown): error is AdoError {
  return error instanceof AdoError;
}

export function errorKindForStatus(status: number): AdoErrorKind {
  if (status === 401) {
    return "authentication";
  }
  if (status === 403) {
    return "authorization";
  }
  if (status === 404) {
    return "not_found";
  }
  if (status >= 400 && status < 500) {
    return "validation";
  }
  return "network";
}

export function serializeError(error: unknown): Record<string, unknown> {
  if (isAdoError(error)) {
    const payload: Record<string, unknown> = {
      kind: error.kind,
      message: error.message
    };
    if (error.status !== undefined) {
      payload.status = error.status;
    }
    if (error.details !== undefined) {
      payload.details = error.details;
    }
    return payload;
  }

  if (error instanceof Error) {
    return {
      kind: "unknown",
      message: error.message
    };
  }

  return {
    kind: "unknown",
    message: String(error)
  };
}

