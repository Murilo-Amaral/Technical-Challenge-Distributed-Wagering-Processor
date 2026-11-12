/**
 * Application-level errors (not business rules). The interface layer maps each one to a distinct HTTP status /
 * SQS handling so a provider never has to parse a message to decide whether to retry.
 */
export abstract class ApplicationError extends Error {
  abstract readonly code: string;

  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** Malformed input (schema, money format, forbidden kind). Do not retry as-is. */
export class ValidationError extends ApplicationError {
  readonly code = "VALIDATION_ERROR";

  constructor(
    message: string,
    readonly details: ReadonlyArray<{ path: string; message: string }> = [],
  ) {
    super(message);
  }
}

/** Same idempotency key (or same provider external id) with a different payload. Never a replay. */
export class IdempotencyConflictError extends ApplicationError {
  constructor(
    readonly code: "IDEMPOTENCY_KEY_CONFLICT" | "EXTERNAL_TRANSACTION_ID_CONFLICT",
    message: string,
    readonly existingTransactionId: string,
  ) {
    super(message);
  }
}

export class NotFoundError extends ApplicationError {
  constructor(
    readonly code: "WALLET_NOT_FOUND" | "TRANSACTION_NOT_FOUND",
    message: string,
  ) {
    super(message);
  }
}

export class WalletAlreadyExistsError extends ApplicationError {
  readonly code = "WALLET_ALREADY_EXISTS";
}

/** Temporary infrastructure failure (DB/SQS unavailable, lock contention after retries). Safe to retry. */
export class TransientInfrastructureError extends ApplicationError {
  readonly code = "SERVICE_UNAVAILABLE";

  constructor(
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message);
  }
}

/** Raised by repositories; retried by the unit of work. */
export class ConcurrencyConflictError extends ApplicationError {
  readonly code = "CONCURRENCY_CONFLICT";
}

/** Raised by repositories when a UNIQUE constraint fires; callers decide what it means. */
export class UniqueViolationError extends ApplicationError {
  readonly code = "UNIQUE_VIOLATION";

  constructor(readonly constraint: string | undefined) {
    super(`Unique constraint violated: ${constraint ?? "unknown"}`);
  }
}

/** Provider identity in the request does not match the authenticated principal. */
export class ProviderForbiddenError extends ApplicationError {
  readonly code = "PROVIDER_FORBIDDEN";
}
