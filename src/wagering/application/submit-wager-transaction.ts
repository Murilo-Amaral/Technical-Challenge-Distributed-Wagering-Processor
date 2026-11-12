import { InboxMessage } from "../domain/inbox-message";
import { WagerTransaction } from "../domain/wager-transaction";
import { type Wallet } from "../domain/wallet";
import { IdempotencyConflictError, NotFoundError } from "./errors";
import type { AppLogger } from "./logger";
import type { Metrics } from "./metrics";
import type { Clock, IdGenerator, TransactionContext, UnitOfWork } from "./ports";
import type { WagerProcessor } from "./wager-processor";
import type { WagerCommand } from "./wager-request";

export interface SubmitOptions {
  source: "http" | "sqs";
  correlationId: string;
  causationId?: string | undefined;
  /** Present when the request arrived through the queue: recorded in the inbox in the same SQL transaction. */
  inbox?: { consumerName: string; messageId: string; payloadHash: string } | undefined;
}

export type SubmitResult =
  | { type: "result"; transaction: WagerTransaction; idempotentReplay: boolean }
  /** The same queue message was already processed (inbox hit). */
  | { type: "duplicate-message"; transaction: WagerTransaction | undefined; payloadMismatch: boolean };

/**
 * The single entry point for wager operations, reused by the HTTP controller and the SQS consumer.
 *
 * One SQL transaction: [inbox] -> lock wallet (FOR UPDATE) -> idempotency lookup -> settle -> transaction + ledger +
 * balance + outbox (+ dependents). Correctness rests on the database: the wallet row lock serializes writers of a
 * wallet across all instances, and unique constraints / triggers back every invariant.
 */
export class SubmitWagerTransaction {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly processor: WagerProcessor,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly metrics: Metrics,
    private readonly logger: AppLogger,
  ) {}

  async execute(command: WagerCommand, options: SubmitOptions): Promise<SubmitResult> {
    const startedAt = performance.now();
    let outcome = "error";
    try {
      const result = await this.uow.run((ctx) => this.inTransaction(ctx, command, options), {
        name: "submit_wager_transaction",
      });
      outcome =
        result.type === "duplicate-message" ? "duplicate" : result.idempotentReplay ? "replay" : "new";
      return result;
    } catch (error) {
      outcome = error instanceof IdempotencyConflictError ? "conflict" : outcome;
      throw error;
    } finally {
      this.metrics.processingDuration(
        { source: options.source, outcome },
        (performance.now() - startedAt) / 1000,
      );
    }
  }

  private async inTransaction(
    ctx: TransactionContext,
    cmd: WagerCommand,
    options: SubmitOptions,
  ): Promise<SubmitResult> {
    const now = this.clock.now();
    const log = this.logger.child({
      correlationId: options.correlationId,
      messageId: options.inbox?.messageId,
      walletId: cmd.walletId,
      providerId: cmd.providerId,
    });

    if (options.inbox) {
      const inbox = InboxMessage.receive({ ...options.inbox, receivedAt: now });
      const receipt = await ctx.inbox.receive(inbox);
      if (receipt.duplicate) {
        this.metrics.duplicateDetected({ source: options.source, type: "inbox" });
        const payloadMismatch = receipt.existing.payloadHash !== options.inbox.payloadHash;
        log.info("duplicate queue message ignored (inbox)", { payloadMismatch });
        return {
          type: "duplicate-message",
          transaction: await ctx.transactions.findByIdempotencyKey(cmd.idempotencyKey),
          payloadMismatch,
        };
      }
      inbox.markProcessed(now);
      await ctx.inbox.markProcessed(inbox);
    }

    // The per-wallet serialization point. Everything below sees a stable wallet.
    const wallet = await ctx.wallets.lockById(cmd.walletId);
    // Looked up even when the wallet is unknown: reusing a key with a different walletId is a conflict, not a 404.
    const existing = await this.findExisting(ctx, cmd, options.source);
    if (!wallet) {
      throw new NotFoundError("WALLET_NOT_FOUND", `Wallet ${cmd.walletId} not found`);
    }
    if (existing) {
      this.metrics.duplicateDetected({ source: options.source, type: "idempotent_replay" });
      log.info("idempotent replay", { transactionId: existing.id });
      return { type: "result", transaction: existing, idempotentReplay: true };
    }

    const transaction = WagerTransaction.create({
      id: this.ids.next(),
      providerId: cmd.providerId,
      externalTransactionId: cmd.externalTransactionId,
      idempotencyKey: cmd.idempotencyKey,
      payloadHash: cmd.payloadHash,
      walletId: cmd.walletId,
      playerId: cmd.playerId,
      roundId: cmd.roundId,
      gameId: cmd.gameId,
      kind: cmd.kind,
      money: cmd.money,
      referenceExternalTransactionId: cmd.referenceExternalTransactionId,
      createdAt: now,
    });
    await this.processor.processNew(transaction, this.processingContext(ctx, wallet, now, options));
    return { type: "result", transaction, idempotentReplay: false };
  }

  /** Replay when the same key (or the same provider transaction) carries the same payload; conflict otherwise. */
  private async findExisting(
    ctx: TransactionContext,
    cmd: WagerCommand,
    source: SubmitOptions["source"],
  ): Promise<WagerTransaction | undefined> {
    const byKey = await ctx.transactions.findByIdempotencyKey(cmd.idempotencyKey);
    if (byKey) {
      if (!byKey.matchesPayload(cmd.payloadHash)) {
        this.metrics.duplicateDetected({ source, type: "conflict" });
        throw new IdempotencyConflictError(
          "IDEMPOTENCY_KEY_CONFLICT",
          "Idempotency-Key was already used with a different payload",
          byKey.id,
        );
      }
      return byKey;
    }
    const byExternalId = await ctx.transactions.findByProviderExternalId(
      cmd.providerId,
      cmd.externalTransactionId,
    );
    if (byExternalId) {
      if (!byExternalId.matchesPayload(cmd.payloadHash)) {
        this.metrics.duplicateDetected({ source, type: "conflict" });
        throw new IdempotencyConflictError(
          "EXTERNAL_TRANSACTION_ID_CONFLICT",
          "externalTransactionId was already used by this provider with a different payload",
          byExternalId.id,
        );
      }
      return byExternalId;
    }
    return undefined;
  }

  private processingContext(ctx: TransactionContext, wallet: Wallet, now: Date, options: SubmitOptions) {
    return {
      ctx,
      wallet,
      now,
      correlationId: options.correlationId,
      causationId: options.causationId ?? options.inbox?.messageId,
      source: options.source,
    };
  }
}
