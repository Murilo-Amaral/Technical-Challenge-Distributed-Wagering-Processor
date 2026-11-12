import type { FailureCode } from "../failure-code";
import type { LedgerDirection, WalletLedgerEntry } from "../ledger";
import type { MoneyProps } from "../money";
import type { WagerTransaction } from "../wager-transaction";
import type { Wallet } from "../wallet";
import { type EventContext, IntegrationEvent } from "./integration-event";

const base = (aggregateId: string, ctx: EventContext) => ({
  eventId: ctx.newEventId(),
  aggregateId,
  correlationId: ctx.correlationId,
  causationId: ctx.causationId,
  occurredAt: ctx.occurredAt,
});

interface TransactionSnapshot {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: MoneyProps;
}

const snapshot = (tx: WagerTransaction): TransactionSnapshot => ({
  transactionId: tx.id,
  providerId: tx.providerId,
  externalTransactionId: tx.externalTransactionId,
  walletId: tx.walletId,
  playerId: tx.playerId,
  roundId: tx.roundId,
  gameId: tx.gameId,
  kind: tx.kind,
  money: tx.money.toJSON(),
});

export interface WagerTransactionProcessedData extends TransactionSnapshot {
  referenceTransactionId: string | null;
  balanceAfter: MoneyProps;
  processedAt: string;
}

/** Any applied transaction, LOSS included. */
export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
  readonly eventType = "WagerTransactionProcessed";
  readonly version = 1;

  get partitionKey(): string {
    return this.data.walletId;
  }

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionProcessed {
    return new WagerTransactionProcessed({
      ...base(tx.id, ctx),
      data: {
        ...snapshot(tx),
        referenceTransactionId: tx.referenceTransactionId ?? null,
        balanceAfter: tx.resultBalance!.toJSON(),
        processedAt: tx.processedAt!.toISOString(),
      },
    });
  }
}

export interface WagerTransactionRejectedData extends TransactionSnapshot {
  failureCode: FailureCode;
  referenceExternalTransactionId: string | null;
}

export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  readonly eventType = "WagerTransactionRejected";
  readonly version = 1;

  get partitionKey(): string {
    return this.data.walletId;
  }

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionRejected {
    return new WagerTransactionRejected({
      ...base(tx.id, ctx),
      data: {
        ...snapshot(tx),
        failureCode: tx.failureCode!,
        referenceExternalTransactionId: tx.referenceExternalTransactionId ?? null,
      },
    });
  }
}

export interface WagerTransactionPendingReferenceData extends TransactionSnapshot {
  referenceExternalTransactionId: string;
  nextAttemptAt: string;
}

export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
  readonly eventType = "WagerTransactionPendingReference";
  readonly version = 1;

  get partitionKey(): string {
    return this.data.walletId;
  }

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionPendingReference {
    return new WagerTransactionPendingReference({
      ...base(tx.id, ctx),
      data: {
        ...snapshot(tx),
        referenceExternalTransactionId: tx.referenceExternalTransactionId!,
        nextAttemptAt: tx.nextReferenceAttemptAt!.toISOString(),
      },
    });
  }
}

export interface WalletBalanceChangedData {
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
}

/** Only emitted when the balance actually changes. */
export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  readonly eventType = "WalletBalanceChanged";
  readonly version = 1;

  get partitionKey(): string {
    return this.data.walletId;
  }

  static from(wallet: Wallet, entry: WalletLedgerEntry, ctx: EventContext): WalletBalanceChanged {
    return new WalletBalanceChanged({
      ...base(wallet.id, ctx),
      data: {
        walletId: wallet.id,
        transactionId: entry.transactionId,
        direction: entry.direction,
        money: entry.money.toJSON(),
        balanceBefore: entry.balanceBefore.toJSON(),
        balanceAfter: entry.balanceAfter.toJSON(),
        walletVersion: entry.walletVersion,
      },
    });
  }
}
