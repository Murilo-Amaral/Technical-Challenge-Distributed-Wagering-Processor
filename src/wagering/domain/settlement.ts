import { InsufficientFundsError } from "./errors";
import { FailureCode } from "./failure-code";
import { LedgerDirection, LedgerJournal, SystemAccount } from "./ledger";
import type { ExponentialBackoff } from "./retry-policy";
import { type WagerTransaction, WagerTransactionKind, WagerTransactionStatus } from "./wager-transaction";
import type { Wallet } from "./wallet";

/** What the repository found for the transaction's reference. */
export type ReferenceLookup =
  | { found: false }
  | { found: true; transaction: WagerTransaction; alreadyReversed: boolean };

export interface SettlementIds {
  ledgerEntryId: string;
  systemEntryId: string;
}

export type SettlementOutcome =
  | { kind: "processed"; journal: LedgerJournal | undefined }
  | { kind: "rejected"; failureCode: FailureCode }
  | { kind: "pending-reference"; firstTime: boolean };

export interface SettleProps {
  transaction: WagerTransaction;
  wallet: Wallet;
  /** Required when the transaction carries a referenceExternalTransactionId. */
  reference?: ReferenceLookup;
  referenceRetryPolicy: ExponentialBackoff;
  ids: SettlementIds;
  now: Date;
}

/**
 * Domain service holding the wagering rules (BET, WIN, LOSS, REFUND, ROLLBACK). It decides the outcome and
 * drives both aggregates (WagerTransaction transitions + Wallet movement) so balance and ledger never drift.
 * It is pure: persistence, locking and events are the caller's job.
 */
export class Settlement {
  static settle(props: SettleProps): SettlementOutcome {
    const { transaction: tx, wallet, now } = props;

    if (tx.playerId !== wallet.playerId || tx.walletId !== wallet.id) {
      return Settlement.reject(tx, wallet, FailureCode.PlayerWalletMismatch, now);
    }
    if (!tx.money.hasSameCurrency(wallet.currency)) {
      return Settlement.reject(tx, wallet, FailureCode.CurrencyMismatch, now);
    }

    let reference: WagerTransaction | undefined;
    if (tx.needsReferenceResolution()) {
      const lookup = props.reference ?? { found: false };
      if (!lookup.found || Settlement.isStillOpen(lookup.transaction)) {
        return Settlement.waitForReference(props);
      }
      const failure = Settlement.validateReference(tx, lookup.transaction, lookup.alreadyReversed);
      if (failure) {
        return Settlement.reject(tx, wallet, failure, now);
      }
      reference = lookup.transaction;
    }

    if (!tx.affectsBalance()) {
      tx.markProcessed(reference?.id, now, wallet.balance);
      return { kind: "processed", journal: undefined };
    }

    const direction = tx.ledgerDirectionFor(reference);
    const movement = {
      money: tx.money,
      transactionId: tx.id,
      ledgerEntryId: props.ids.ledgerEntryId,
      at: now,
    };
    try {
      const walletEntry =
        direction === LedgerDirection.Debit ? wallet.debit(movement) : wallet.credit(movement);
      const journal = LedgerJournal.create({
        walletEntry,
        systemEntryId: props.ids.systemEntryId,
        contraAccount: tx.kind === WagerTransactionKind.Opening ? SystemAccount.Funding : SystemAccount.House,
      });
      tx.markProcessed(reference?.id, now, wallet.balance);
      return { kind: "processed", journal };
    } catch (error) {
      if (error instanceof InsufficientFundsError) {
        const code = tx.isReversal() ? FailureCode.ReversalInsufficientFunds : FailureCode.InsufficientFunds;
        return Settlement.reject(tx, wallet, code, now);
      }
      throw error;
    }
  }

  private static validateReference(
    tx: WagerTransaction,
    reference: WagerTransaction,
    alreadyReversed: boolean,
  ): FailureCode | undefined {
    if (reference.status !== WagerTransactionStatus.Processed) {
      return FailureCode.ReferenceNotProcessed;
    }
    if (!tx.canReference(reference.kind)) {
      return FailureCode.ReferenceKindNotAllowed;
    }
    const sameContext =
      reference.providerId === tx.providerId &&
      reference.playerId === tx.playerId &&
      reference.walletId === tx.walletId &&
      reference.roundId === tx.roundId &&
      reference.money.hasSameCurrency(tx.money.currency);
    if (!sameContext) {
      return FailureCode.ReferenceContextMismatch;
    }
    if (tx.isReversal()) {
      if (!reference.money.equals(tx.money)) {
        return FailureCode.AmountMismatch;
      }
      if (alreadyReversed) {
        return FailureCode.ReferenceAlreadyReversed;
      }
    }
    return undefined;
  }

  /** A reference that is itself still waiting cannot be judged yet: keep waiting. */
  private static isStillOpen(reference: WagerTransaction): boolean {
    return (
      reference.status === WagerTransactionStatus.Pending ||
      reference.status === WagerTransactionStatus.PendingReference
    );
  }

  private static waitForReference(props: SettleProps): SettlementOutcome {
    const { transaction: tx, wallet, now, referenceRetryPolicy } = props;
    // referenceAttempts counts resolution attempts already made; this one is attempt + 1.
    if (referenceRetryPolicy.isExhausted(tx.referenceAttempts + 1)) {
      return Settlement.reject(tx, wallet, FailureCode.ReferenceNotFound, now);
    }
    const firstTime = tx.status === WagerTransactionStatus.Pending;
    tx.markPendingReference(now, referenceRetryPolicy, wallet.balance);
    return { kind: "pending-reference", firstTime };
  }

  private static reject(
    tx: WagerTransaction,
    wallet: Wallet,
    code: FailureCode,
    now: Date,
  ): SettlementOutcome {
    tx.reject(code, now, wallet.balance);
    return { kind: "rejected", failureCode: code };
  }
}
