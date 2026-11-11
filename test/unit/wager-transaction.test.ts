import { describe, expect, test } from "bun:test";
import { InvalidTransactionStateError, InvalidWagerTransactionError } from "../../src/wagering/domain/errors";
import { FailureCode } from "../../src/wagering/domain/failure-code";
import { LedgerDirection } from "../../src/wagering/domain/ledger";
import {
  canTransition,
  WagerTransactionKind as K,
  WagerTransactionStatus as S,
  WAGER_TRANSITIONS,
} from "../../src/wagering/domain/wager-transaction";
import { brl, referencePolicy, T0, wagerTx } from "../support/domain-builders";

describe("WagerTransaction state machine", () => {
  test("is born PENDING", () => {
    expect(wagerTx().status).toBe(S.Pending);
  });

  test("terminal states have no outgoing transitions", () => {
    for (const terminal of [S.Processed, S.Rejected, S.Failed]) {
      expect(WAGER_TRANSITIONS[terminal]).toEqual([]);
    }
    expect(canTransition(S.Pending, S.PendingReference)).toBe(true);
    expect(canTransition(S.PendingReference, S.PendingReference)).toBe(true);
    expect(canTransition(S.PendingReference, S.Pending)).toBe(false);
  });

  test("touching a terminal transaction is a programming error", () => {
    const processed = wagerTx();
    processed.markProcessed(undefined, T0, brl("1.00"));
    expect(processed.isTerminal()).toBe(true);
    expect(() => processed.reject(FailureCode.InsufficientFunds, T0, undefined)).toThrow(
      InvalidTransactionStateError,
    );
    expect(() => processed.markProcessed(undefined, T0, brl("1.00"))).toThrow(InvalidTransactionStateError);

    const rejected = wagerTx();
    rejected.reject(FailureCode.InsufficientFunds, T0, brl("0.00"));
    expect(() => rejected.markPendingReference(T0, referencePolicy, brl("0.00"))).toThrow(
      InvalidTransactionStateError,
    );

    const failed = wagerTx();
    failed.fail(FailureCode.ProcessingFailed, T0);
    expect(() => failed.markProcessed(undefined, T0, brl("0.00"))).toThrow(InvalidTransactionStateError);
  });

  test("pending reference counts attempts and schedules with exponential backoff", () => {
    const tx = wagerTx({ kind: K.Refund, reference: "bet-1" });
    tx.markPendingReference(T0, referencePolicy, brl("0.00"));
    expect(tx.referenceAttempts).toBe(1);
    expect(tx.nextReferenceAttemptAt?.getTime()).toBe(T0.getTime() + 1000);
    tx.markPendingReference(T0, referencePolicy, brl("0.00"));
    expect(tx.nextReferenceAttemptAt?.getTime()).toBe(T0.getTime() + 2000);
  });

  test("REFUND and ROLLBACK require a reference; BET cannot have one", () => {
    expect(() => wagerTx({ kind: K.Refund })).toThrow(InvalidWagerTransactionError);
    expect(() => wagerTx({ kind: K.Rollback })).toThrow(InvalidWagerTransactionError);
    expect(() => wagerTx({ kind: K.Bet, reference: "x" })).toThrow(InvalidWagerTransactionError);
    expect(wagerTx({ kind: K.Refund, reference: "x" }).requiresReference()).toBe(true);
  });

  test("zero amount only allowed for LOSS", () => {
    expect(() => wagerTx({ amount: "0.00" })).toThrow(InvalidWagerTransactionError);
    expect(wagerTx({ kind: K.Loss, amount: "0.00" }).affectsBalance()).toBe(false);
  });

  test("ledger direction per kind, ROLLBACK inverts its reference", () => {
    const bet = wagerTx();
    const win = wagerTx({ kind: K.Win });
    expect(bet.ledgerDirectionFor()).toBe(LedgerDirection.Debit);
    expect(win.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    expect(wagerTx({ kind: K.Refund, reference: "b" }).ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    const rollback = wagerTx({ kind: K.Rollback, reference: "b" });
    expect(rollback.ledgerDirectionFor(bet)).toBe(LedgerDirection.Credit);
    expect(rollback.ledgerDirectionFor(win)).toBe(LedgerDirection.Debit);
    expect(() => rollback.ledgerDirectionFor()).toThrow(InvalidWagerTransactionError);
  });

  test("matchesPayload compares the canonical hash", () => {
    const tx = wagerTx();
    expect(tx.matchesPayload(tx.payloadHash)).toBe(true);
    expect(tx.matchesPayload("other")).toBe(false);
  });
});
