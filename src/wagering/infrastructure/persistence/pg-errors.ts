import { QueryFailedError } from "typeorm";

interface PgErrorLike {
  code?: string;
  constraint?: string;
  message?: string;
}

const TRANSIENT_SQLSTATES = new Set([
  "40001", // serialization_failure
  "40P01", // deadlock_detected
  "55P03", // lock_not_available (lock_timeout)
  "57014", // query_canceled (statement_timeout)
  "57P01", // admin_shutdown
  "57P02", // crash_shutdown
  "57P03", // cannot_connect_now
  "53300", // too_many_connections
  "08000",
  "08003",
  "08006",
  "08001",
  "08004",
]);

const TRANSIENT_NODE_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "EPIPE",
  "ENOTFOUND",
  "EAI_AGAIN",
]);
const TRANSIENT_MESSAGES = [
  /Connection terminated/i,
  /timeout exceeded when trying to connect/i,
  /Client has encountered a connection error/i,
];

function driverError(error: unknown): PgErrorLike | undefined {
  if (error instanceof QueryFailedError) {
    return error.driverError as PgErrorLike;
  }
  if (error && typeof error === "object") {
    return error as PgErrorLike;
  }
  return undefined;
}

export function sqlState(error: unknown): string | undefined {
  return driverError(error)?.code;
}

export function isUniqueViolation(error: unknown): boolean {
  return sqlState(error) === "23505";
}

export function violatedConstraint(error: unknown): string | undefined {
  return driverError(error)?.constraint;
}

/** Lock contention signals, counted in the lock-conflict metric. */
export function isLockConflict(error: unknown): boolean {
  const code = sqlState(error);
  return code === "55P03" || code === "40P01" || code === "40001";
}

export function isTransientDbError(error: unknown): boolean {
  const e = driverError(error);
  if (!e) return false;
  if (e.code && (TRANSIENT_SQLSTATES.has(e.code) || TRANSIENT_NODE_CODES.has(e.code))) return true;
  return TRANSIENT_MESSAGES.some((re) => re.test(e.message ?? ""));
}
