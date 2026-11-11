import type { DataSource } from "typeorm";
import {
  ConcurrencyConflictError,
  TransientInfrastructureError,
  UniqueViolationError,
} from "../../application/errors";
import type { Metrics } from "../../application/metrics";
import type { TransactionContext, UnitOfWork, UnitOfWorkOptions } from "../../application/ports";
import { isLockConflict, isTransientDbError, sqlState } from "./pg-errors";
import { transactionContext } from "./typeorm-repositories";

export interface UnitOfWorkSettings {
  lockTimeoutMs: number;
  statementTimeoutMs: number;
  maxRetries: number;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * One SQL transaction per call, READ COMMITTED. Correctness does not depend on the isolation level: every write path
 * first takes the row lock of the wallet it touches (SELECT ... FOR UPDATE), so writers of the same wallet serialize
 * while different wallets proceed in parallel (no global lock).
 */
export class TypeOrmUnitOfWork implements UnitOfWork {
  constructor(
    private readonly dataSource: DataSource,
    private readonly settings: UnitOfWorkSettings,
    private readonly metrics: Metrics,
  ) {}

  async run<T>(work: (ctx: TransactionContext) => Promise<T>, options: UnitOfWorkOptions): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.dataSource.transaction("READ COMMITTED", async (manager) => {
          await manager.query(
            `SELECT set_config('lock_timeout', $1, true), set_config('statement_timeout', $2, true)`,
            [`${this.settings.lockTimeoutMs}ms`, `${this.settings.statementTimeoutMs}ms`],
          );
          return work(transactionContext(manager));
        });
      } catch (error) {
        const retryable = this.isRetryable(error);
        if (!retryable) throw error;
        const reason = this.reason(error);
        if (isLockConflict(error) || error instanceof ConcurrencyConflictError) {
          this.metrics.lockConflict({ component: options.name, reason });
        }
        if (attempt > this.settings.maxRetries) {
          throw new TransientInfrastructureError(
            `${options.name} failed after ${attempt} attempts (${reason})`,
            error,
          );
        }
        this.metrics.retry({ component: options.name, reason });
        // Exponential backoff with full jitter keeps competing writers from retrying in lockstep.
        await sleep(Math.random() * Math.min(1000, 25 * 2 ** attempt));
      }
    }
  }

  private isRetryable(error: unknown): boolean {
    return (
      isTransientDbError(error) ||
      error instanceof ConcurrencyConflictError ||
      // A unique race (two first-time requests for the same key on different wallets) resolves itself on retry:
      // the second attempt finds the committed row and answers replay/conflict.
      (error instanceof UniqueViolationError &&
        (error.constraint === "uq_wager_idempotency_key" ||
          error.constraint === "uq_wager_provider_external_id"))
    );
  }

  private reason(error: unknown): string {
    if (error instanceof ConcurrencyConflictError) return "version_conflict";
    if (error instanceof UniqueViolationError) return "unique_race";
    const code = sqlState(error);
    switch (code) {
      case "55P03":
        return "lock_timeout";
      case "40P01":
        return "deadlock";
      case "40001":
        return "serialization";
      default:
        return code ? `sqlstate_${code}` : "connection";
    }
  }
}
