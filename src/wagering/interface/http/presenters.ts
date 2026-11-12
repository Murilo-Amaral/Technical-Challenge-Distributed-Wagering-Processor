import type { ReconciliationReport } from "../../application/reconcile-wallet";
import type { WalletLedgerEntry } from "../../domain/ledger";
import { type WagerTransaction, WagerTransactionStatus } from "../../domain/wager-transaction";
import type { Wallet } from "../../domain/wallet";

export const presentWallet = (w: Wallet) => ({
  id: w.id,
  playerId: w.playerId,
  balance: w.balance.toJSON(),
  version: w.version,
  createdAt: w.createdAt.toISOString(),
  updatedAt: w.updatedAt.toISOString(),
});

export const presentLedgerEntry = (e: WalletLedgerEntry) => e.toJSON();

export const presentTransaction = (t: WagerTransaction) => ({
  id: t.id,
  providerId: t.providerId,
  externalTransactionId: t.externalTransactionId,
  walletId: t.walletId,
  playerId: t.playerId,
  roundId: t.roundId,
  gameId: t.gameId,
  kind: t.kind,
  money: t.money.toJSON(),
  referenceExternalTransactionId: t.referenceExternalTransactionId ?? null,
  referenceTransactionId: t.referenceTransactionId ?? null,
  status: t.status,
  failureCode: t.failureCode ?? null,
  balance: t.resultBalance?.toJSON() ?? null,
  referenceAttempts: t.referenceAttempts,
  nextReferenceAttemptAt: t.nextReferenceAttemptAt?.toISOString() ?? null,
  processedAt: t.processedAt?.toISOString() ?? null,
  createdAt: t.createdAt.toISOString(),
  updatedAt: t.updatedAt.toISOString(),
});

/** Body of POST /wagering/transactions. A replay returns the same body with idempotentReplay=true. */
export const presentSubmission = (t: WagerTransaction, idempotentReplay: boolean) => ({
  transactionId: t.id,
  status: t.status,
  balance: t.resultBalance?.toJSON() ?? null,
  idempotentReplay,
  ...(t.failureCode ? { failureCode: t.failureCode } : {}),
  ...(t.status === WagerTransactionStatus.PendingReference
    ? {
        referenceExternalTransactionId: t.referenceExternalTransactionId,
        nextReferenceAttemptAt: t.nextReferenceAttemptAt?.toISOString(),
      }
    : {}),
});

/**
 * Status of a submission by outcome: 201 applied now · 200 replay of an applied one · 202 accepted, waiting for its
 * reference · 422 rejected by a business rule (terminal, failureCode tells why) · 500 FAILED (terminal, audited).
 */
export function submissionStatus(t: WagerTransaction, idempotentReplay: boolean): number {
  switch (t.status) {
    case WagerTransactionStatus.Processed:
      return idempotentReplay ? 200 : 201;
    case WagerTransactionStatus.PendingReference:
    case WagerTransactionStatus.Pending:
      return 202;
    case WagerTransactionStatus.Rejected:
      return 422;
    case WagerTransactionStatus.Failed:
      return 500;
  }
}

export const presentReconciliation = (r: ReconciliationReport) => ({
  walletId: r.walletId,
  storedBalance: r.storedBalance.toJSON(),
  calculatedBalance: r.calculatedBalance.toJSON(),
  difference: r.difference.toJSON(),
  consistent: r.consistent,
  checkedEntries: r.checkedEntries,
});
