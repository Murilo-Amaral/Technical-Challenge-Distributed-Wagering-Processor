import { FailureCode } from "../domain/failure-code";
import { WagerTransactionStatus } from "../domain/wager-transaction";
import { TransientInfrastructureError } from "./errors";
import type { AppLogger } from "./logger";
import type { Metrics } from "./metrics";
import type { Clock, UnitOfWork } from "./ports";
import type { WagerProcessor } from "./wager-processor";

/**
 * Scheduled worker step: re-attempts PENDING_REFERENCE transactions whose backoff has elapsed.
 *
 * Safe with many instances: each candidate is handled in its own SQL transaction that locks the wallet first and
 * then re-reads the transaction; if another instance already handled it (status changed or rescheduled) it is skipped.
 */
export class ProcessPendingReferences {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly processor: WagerProcessor,
    private readonly clock: Clock,
    private readonly metrics: Metrics,
    private readonly logger: AppLogger,
    private readonly batchSize: number,
  ) {}

  /** @returns how many transactions were actually settled or rescheduled (0 lets the runner sleep). */
  async runOnce(): Promise<number> {
    const candidates = await this.uow.run(
      (ctx) => ctx.transactions.findDuePendingReferences(this.clock.now(), this.batchSize),
      {
        name: "pending_references_scan",
      },
    );
    let handled = 0;
    for (const candidate of candidates) {
      try {
        const processed = await this.uow.run(
          async (ctx) => {
            const now = this.clock.now();
            const wallet = await ctx.wallets.lockById(candidate.walletId);
            const tx = await ctx.transactions.lockById(candidate.id);
            if (!wallet || !tx || tx.status !== WagerTransactionStatus.PendingReference) return false;
            if (tx.nextReferenceAttemptAt && tx.nextReferenceAttemptAt > now) return false;
            this.metrics.retry({ component: "pending_references", reason: "reference_missing" });
            await this.processor.processPending(tx, {
              ctx,
              wallet,
              now,
              correlationId: tx.id,
              causationId: tx.id,
              source: "pending-reference-worker",
            });
            return true;
          },
          { name: "pending_references_process" },
        );
        if (processed) handled++;
      } catch (error) {
        if (error instanceof TransientInfrastructureError) {
          // Left untouched: it stays due and is picked up on the next tick.
          this.logger.warn("pending reference retry deferred", {
            transactionId: candidate.id,
            error: String(error),
          });
          continue;
        }
        await this.markFailed(candidate.id, candidate.walletId, error);
        handled++;
      }
    }
    return handled;
  }

  /** A non-transient error is permanent for this transaction: FAILED keeps it auditable instead of looping forever. */
  private async markFailed(transactionId: string, walletId: string, cause: unknown): Promise<void> {
    this.logger.error("pending reference processing failed permanently", {
      transactionId,
      walletId,
      error: cause instanceof Error ? cause.message : String(cause),
    });
    await this.uow.run(
      async (ctx) => {
        await ctx.wallets.lockById(walletId);
        const tx = await ctx.transactions.lockById(transactionId);
        if (!tx || tx.isTerminal()) return;
        tx.fail(FailureCode.ProcessingFailed, this.clock.now());
        await ctx.transactions.update(tx);
        this.metrics.transactionFinished({
          status: tx.status,
          kind: tx.kind,
          source: "pending-reference-worker",
        });
      },
      { name: "pending_references_fail" },
    );
  }
}
