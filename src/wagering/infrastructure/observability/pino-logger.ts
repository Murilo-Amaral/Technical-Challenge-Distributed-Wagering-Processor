import pino, { type Logger } from "pino";
import type { AppLogger, LogFields } from "../../application/logger";

/**
 * JSON structured logs. Financial payloads and credentials are redacted defensively even though call sites are
 * expected to log identifiers only (correlationId, messageId, transactionId, walletId, providerId).
 */
const REDACT_PATHS = [
  "money",
  "amount",
  "balance",
  "payload",
  "body",
  "authorization",
  "token",
  "*.money",
  "*.amount",
  "*.balance",
  "*.payload",
  "*.authorization",
  "*.token",
  "req.headers.authorization",
];

export class PinoAppLogger implements AppLogger {
  constructor(private readonly logger: Logger) {}

  static create(level: string, base: Record<string, unknown>): PinoAppLogger {
    return new PinoAppLogger(
      pino({
        level,
        base,
        messageKey: "message",
        timestamp: pino.stdTimeFunctions.isoTime,
        formatters: { level: (label) => ({ level: label }) },
        redact: { paths: REDACT_PATHS, censor: "[redacted]" },
      }),
    );
  }

  debug(message: string, fields?: LogFields): void {
    this.logger.debug(fields ?? {}, message);
  }
  info(message: string, fields?: LogFields): void {
    this.logger.info(fields ?? {}, message);
  }
  warn(message: string, fields?: LogFields): void {
    this.logger.warn(fields ?? {}, message);
  }
  error(message: string, fields?: LogFields): void {
    this.logger.error(fields ?? {}, message);
  }
  child(fields: LogFields): AppLogger {
    return new PinoAppLogger(this.logger.child(fields));
  }
}
