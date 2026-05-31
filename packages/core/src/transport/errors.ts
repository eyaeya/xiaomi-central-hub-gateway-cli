import { ZodError, type ZodType } from 'zod';

export type XggErrorCode =
  | 'CONFIG'
  | 'AUTH_REQUIRED'
  | 'AUTH_EXPIRED'
  | 'NETWORK'
  | 'SCHEMA'
  | 'GATEWAY'
  | 'NOT_CONFIRMED'
  | 'NOT_FOUND'
  | 'UNKNOWN';

export class XggError extends Error {
  readonly code: XggErrorCode;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: XggErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'XggError';
    this.code = code;
    this.details = details;
  }
}

export class ConfigError extends XggError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('CONFIG', message, details);
    this.name = 'ConfigError';
  }
}

export class AuthRequiredError extends XggError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('AUTH_REQUIRED', message, details);
    this.name = 'AuthRequiredError';
  }
}

export class AuthExpiredError extends XggError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('AUTH_EXPIRED', message, details);
    this.name = 'AuthExpiredError';
  }
}

export class NetworkError extends XggError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('NETWORK', message, details);
    this.name = 'NetworkError';
  }
}

export class SchemaError extends XggError {
  constructor(message: string, details: { snapshotPath?: string } & Record<string, unknown>) {
    super('SCHEMA', message, details);
    this.name = 'SchemaError';
  }
}

export function parseOrThrow<T>(schema: ZodType<T>, raw: unknown, label: string): T {
  try {
    return schema.parse(raw);
  } catch (e) {
    if (e instanceof ZodError) {
      throw new SchemaError(`${label} parse failed`, { zodErrors: e.errors });
    }
    throw e;
  }
}

export class GatewayError extends XggError {
  constructor(message: string, details: { gatewayCode?: number } & Record<string, unknown>) {
    super('GATEWAY', message, details);
    this.name = 'GatewayError';
  }
}

export class NotConfirmedError extends XggError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('NOT_CONFIRMED', message, details);
    this.name = 'NotConfirmedError';
  }
}

export class NotFoundError extends XggError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('NOT_FOUND', message, details);
    this.name = 'NotFoundError';
  }
}
