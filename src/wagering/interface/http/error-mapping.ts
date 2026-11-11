import { HttpException } from "@nestjs/common";
import {
  IdempotencyConflictError,
  NotFoundError,
  ProviderForbiddenError,
  TransientInfrastructureError,
  ValidationError,
  WalletAlreadyExistsError,
} from "../../application/errors";
import { DomainError } from "../../domain/errors";
import { isTransientDbError } from "../../infrastructure/persistence/pg-errors";
import { UnauthorizedError } from "./auth/token-verifier";

export interface ErrorBody {
  error: {
    code: string;
    message: string;
    /** Whether resending the same request can succeed later without changes. */
    retryable: boolean;
    details?: ReadonlyArray<{ path: string; message: string }>;
    existingTransactionId?: string;
  };
}

export interface MappedError {
  status: number;
  body: ErrorBody;
  headers?: Record<string, string>;
}

const body = (
  code: string,
  message: string,
  retryable: boolean,
  extra: Partial<ErrorBody["error"]> = {},
): ErrorBody => ({
  error: { code, message, retryable, ...extra },
});

/**
 * Single source of truth for error -> HTTP status. Each situation a provider must tell apart has its own status:
 * 400 invalid payload · 401/403 auth · 404 not found · 409 idempotency/uniqueness conflict ·
 * 422 business rejection (see controllers) · 202 accepted pending · 503 transient (retry) · 500 unexpected.
 */
export function mapError(error: unknown): MappedError {
  if (error instanceof ValidationError) {
    return { status: 400, body: body(error.code, error.message, false, { details: error.details }) };
  }
  if (error instanceof DomainError) {
    return { status: 400, body: body("VALIDATION_ERROR", error.message, false) };
  }
  if (error instanceof UnauthorizedError) {
    return {
      status: 401,
      body: body(error.code, error.message, false),
      headers: { "WWW-Authenticate": "Bearer" },
    };
  }
  if (error instanceof ProviderForbiddenError) {
    return { status: 403, body: body(error.code, error.message, false) };
  }
  if (error instanceof NotFoundError) {
    return { status: 404, body: body(error.code, error.message, false) };
  }
  if (error instanceof IdempotencyConflictError) {
    return {
      status: 409,
      body: body(error.code, error.message, false, { existingTransactionId: error.existingTransactionId }),
    };
  }
  if (error instanceof WalletAlreadyExistsError) {
    return { status: 409, body: body(error.code, error.message, false) };
  }
  if (error instanceof TransientInfrastructureError || isTransientDbError(error)) {
    return {
      status: 503,
      body: body("SERVICE_UNAVAILABLE", "Temporary infrastructure failure, retry later", true),
      headers: { "Retry-After": "1" },
    };
  }
  if (error instanceof HttpException) {
    const status = error.getStatus();
    const code = status === 400 ? "VALIDATION_ERROR" : status === 404 ? "NOT_FOUND" : `HTTP_${status}`;
    return { status, body: body(code, error.message, status >= 500) };
  }
  return { status: 500, body: body("INTERNAL_ERROR", "Unexpected error", false) };
}
