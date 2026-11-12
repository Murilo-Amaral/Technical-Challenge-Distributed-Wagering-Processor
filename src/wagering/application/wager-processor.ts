import type { EventContext, IntegrationEvent } from "../domain/events/integration-event";
import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
} from "../domain/events/wagering-events";
import { OutboxMessage } from "../domain/outbox-message";
import type { ExponentialBackoff } from "../domain/retry-policy";
import { type ReferenceLookup, Settlement, type SettlementOutcome } from "../domain/settlement";
import type { WagerTransaction } from "../domain/wager-transaction";
import type { Wallet } from "../domain/wallet";
import type { AppLogger } from "./logger";
import type { Metrics } from "./metrics";
import type { IdGenerator, TransactionContext } from "./ports";

export interface ProcessingContext {
  ctx: TransactionContext;
  /** Must be the row-locked wallet of `transaction`. */
  wallet: Wallet;
  now: Date;
  correlationId: string;
  causationId?: string | undefined;
  source: string;
}

/**
 * Application service shared by the submit use case and the pending-reference worker. Given a locked wallet it:
 * resolves the reference, runs the Settlement domain service, persists transaction + ledger + balance + outbox
 * (all on the same SQL transaction) and then settles any PENDING_REFERENCE transactions of the same wallet that were
 * waiting for this one.
 */
export class WagerProcessor {
  constructor(
    private readonly ids: IdGenerator,
    private readonly referencePolicy: ExponentialBackoff,
    private readonly metrics: Metrics,
    private readonly logger: AppLogger,
  ) {}

  /** Settles a new transaction (status PENDING) and inserts it. */
  async processNew(transaction: WagerTransaction, pc: ProcessingContext): Promise<SettlementOutcome> {
    const outcome = await this.settle(transaction, pc);
    await pc.ctx.transactions.insert(transaction);
    await this.persistEffects(transaction, outcome, pc);
    await this.settleDependents(transaction, pc);
    return outcome;
  }

  /** Re-attempts a transaction already stored as PENDING_REFERENCE (row-locked by the caller). */
  async processPending(transaction: WagerTransaction, pc: ProcessingContext): Promise<SettlementOutcome> {
    const outcome = await this.settle(transaction, pc);
    await pc.ctx.transactions.update(transaction);
    await this.persistEffects(transaction, outcome, pc);
    await this.settleDependents(transaction, pc);
    return outcome;
  }

  private async settle(transaction: WagerTransaction, pc: ProcessingContext): Promise<SettlementOutcome> {
    const reference = transaction.needsReferenceResolution()
      ? await this.resolveReference(transaction, pc.ctx)
      : undefined;
    return Settlement.settle({
      transaction,
      wallet: pc.wallet,
      reference,
      referenceRetryPolicy: this.referencePolicy,
      ids: { ledgerEntryId: this.ids.next(), systemEntryId: this.ids.next() },
      now: pc.now,
    });
  }

  private async resolveReference(tx: WagerTransaction, ctx: TransactionContext): Promise<ReferenceLookup> {
    // Resolved by (providerId, referenceExternalTransactionId). The reference may live in another wallet: then the
    // context check rejects it. Reading it without locking is safe because only terminal (immutable) references are
    // ever used to settle; non-terminal ones keep the dependent waiting.
    const reference = await ctx.transactions.findByProviderExternalId(
      tx.providerId,
      tx.referenceExternalTransactionId!,
    );
    if (!reference) {
      return { found: false };
    }
    const alreadyReversed = tx.isReversal()
      ? await ctx.transactions.hasProcessedReversal(reference.id)
      : false;
    return { found: true, transaction: reference, alreadyReversed };
  }

  private async persistEffects(
    tx: WagerTransaction,
    outcome: SettlementOutcome,
    pc: ProcessingContext,
  ): Promise<void> {
    const eventCtx: EventContext = {
      correlationId: pc.correlationId,
      causationId: pc.causationId,
      occurredAt: pc.now,
      newEventId: () => this.ids.next(),
    };
    const events: IntegrationEvent<unknown>[] = [];

    switch (outcome.kind) {
      case "processed":
        if (outcome.journal) {
          await pc.ctx.ledger.append(outcome.journal);
          await pc.ctx.wallets.saveBalance(pc.wallet, outcome.journal.walletEntry.walletVersion - 1);
          events.push(WalletBalanceChanged.from(pc.wallet, outcome.journal.walletEntry, eventCtx));
        }
        events.push(WagerTransactionProcessed.from(tx, eventCtx));
        break;
      case "rejected":
        events.push(WagerTransactionRejected.from(tx, eventCtx));
        break;
      case "pending-reference":
        // Published once, when the transaction starts waiting; reschedules are internal.
        if (outcome.firstTime) {
          events.push(WagerTransactionPendingReference.from(tx, eventCtx));
        }
        break;
    }
    await pc.ctx.outbox.enqueue(events.map((e) => OutboxMessage.enqueue(e)));

    if (outcome.kind !== "pending-reference" || outcome.firstTime) {
      this.metrics.transactionFinished({ status: tx.status, kind: tx.kind, source: pc.source });
    }
    this.logger.info("wager transaction settled", {
      correlationId: pc.correlationId,
      transactionId: tx.id,
      walletId: tx.walletId,
      providerId: tx.providerId,
      kind: tx.kind,
      status: tx.status,
      failureCode: tx.failureCode,
      source: pc.source,
    });
  }

  /** Breadth-first: a settled BET can unblock a REFUND, which can in turn unblock a ROLLBACK of that REFUND. */
  private async settleDependents(root: WagerTransaction, pc: ProcessingContext): Promise<void> {
    const queue = [root];
    while (queue.length > 0) {
      const settled = queue.shift()!;
      if (!settled.isTerminal()) continue;
      const dependents = await pc.ctx.transactions.findPendingDependents(
        pc.wallet.id,
        settled.providerId,
        settled.externalTransactionId,
      );
      for (const dependent of dependents) {
        await this.processPending(dependent, { ...pc, causationId: settled.id, source: "reference-arrival" });
        queue.push(dependent);
      }
    }
  }
}
