import { describe, expect, test } from "bun:test";
import { FailureCode } from "../../src/wagering/domain/failure-code";
import { LedgerDirection, SystemAccount } from "../../src/wagering/domain/ledger";
import { type ReferenceLookup, Settlement } from "../../src/wagering/domain/settlement";
import {
  WagerTransactionKind as K,
  WagerTransactionStatus as S,
  type WagerTransaction,
} from "../../src/wagering/domain/wager-transaction";
import type { Wallet } from "../../src/wagering/domain/wallet";
import { ids, openWallet, referencePolicy, T0, type TxOverrides, wagerTx } from "../support/domain-builders";

const settle = (wallet: Wallet, transaction: WagerTransaction, reference?: ReferenceLookup) =>
  Settlement.settle({
    wallet,
    transaction,
    reference,
    referenceRetryPolicy: referencePolicy,
    ids: ids(),
    now: T0,
  });

const found = (transaction: WagerTransaction, alreadyReversed = false): ReferenceLookup => ({
  found: true,
  transaction,
  alreadyReversed,
});

/** A processed BET on the given wallet, used as reference. */
const processedBet = (wallet: Wallet, o: TxOverrides = {}) => {
  const bet = wagerTx({ amount: "30.00", ...o });
  const outcome = settle(wallet, bet);
  expect(outcome.kind).toBe("processed");
  return bet;
};

describe("BET", () => {
  test("debits the wallet and produces one DEBIT entry + contra HOUSE credit", () => {
    const wallet = openWallet("100.00");
    const bet = wagerTx({ amount: "25.00" });
    const outcome = settle(wallet, bet);
    expect(outcome.kind).toBe("processed");
    if (outcome.kind !== "processed") return;
    expect(outcome.journal?.walletEntry.direction).toBe(LedgerDirection.Debit);
    expect(outcome.journal?.systemEntry.account).toBe(SystemAccount.House);
    expect(outcome.journal?.systemEntry.direction).toBe(LedgerDirection.Credit);
    expect(wallet.balance.amount).toBe("75.00");
    expect(bet.status).toBe(S.Processed);
    expect(bet.resultBalance?.amount).toBe("75.00");
  });

  test("is rejected with INSUFFICIENT_FUNDS without touching the balance", () => {
    const wallet = openWallet("100.00");
    settle(wallet, wagerTx({ amount: "80.00" }));
    const second = wagerTx({ amount: "80.00" });
    const outcome = settle(wallet, second);
    expect(outcome).toEqual({ kind: "rejected", failureCode: FailureCode.InsufficientFunds });
    expect(second.status).toBe(S.Rejected);
    expect(wallet.balance.amount).toBe("20.00");
    expect(wallet.version).toBe(2);
  });

  test("currency conflict is rejected and audited", () => {
    const wallet = openWallet("100.00");
    const tx = wagerTx({ currency: "USD" });
    expect(settle(wallet, tx)).toEqual({ kind: "rejected", failureCode: FailureCode.CurrencyMismatch });
    expect(wallet.version).toBe(1);
  });

  test("player that does not own the wallet is rejected", () => {
    const wallet = openWallet("100.00");
    expect(settle(wallet, wagerTx({ playerId: "intruder" }))).toEqual({
      kind: "rejected",
      failureCode: FailureCode.PlayerWalletMismatch,
    });
  });
});

describe("WIN", () => {
  test("credits the wallet without a reference", () => {
    const wallet = openWallet("10.00");
    const outcome = settle(wallet, wagerTx({ kind: K.Win, amount: "40.00" }));
    expect(outcome.kind).toBe("processed");
    expect(wallet.balance.amount).toBe("50.00");
  });

  test("may reference the BET of the same round", () => {
    const wallet = openWallet("100.00");
    const bet = processedBet(wallet);
    const win = wagerTx({ kind: K.Win, amount: "60.00", reference: bet.externalTransactionId });
    expect(settle(wallet, win, found(bet)).kind).toBe("processed");
    expect(win.referenceTransactionId).toBe(bet.id);
    expect(wallet.balance.amount).toBe("130.00");
  });

  test("referencing another round is rejected", () => {
    const wallet = openWallet("100.00");
    const bet = processedBet(wallet);
    const win = wagerTx({ kind: K.Win, reference: bet.externalTransactionId, roundId: "round-2" });
    expect(settle(wallet, win, found(bet))).toEqual({
      kind: "rejected",
      failureCode: FailureCode.ReferenceContextMismatch,
    });
  });
});

describe("WIN after a reversal", () => {
  test("a WIN referencing an already refunded BET is rejected", () => {
    const wallet = openWallet("100.00");
    const bet = processedBet(wallet);
    const win = wagerTx({ kind: K.Win, amount: "60.00", reference: bet.externalTransactionId });
    expect(settle(wallet, win, found(bet, true))).toEqual({
      kind: "rejected",
      failureCode: FailureCode.ReferenceAlreadyReversed,
    });
    expect(wallet.balance.amount).toBe("70.00");
  });
});

describe("LOSS", () => {
  test("is processed without moving the balance or producing a journal", () => {
    const wallet = openWallet("100.00");
    const loss = wagerTx({ kind: K.Loss, amount: "0.00" });
    const outcome = settle(wallet, loss);
    expect(outcome).toEqual({ kind: "processed", journal: undefined });
    expect(loss.status).toBe(S.Processed);
    expect(wallet.version).toBe(1);
    expect(wallet.balance.amount).toBe("100.00");
  });
});

describe("REFUND", () => {
  test("credits back a processed BET", () => {
    const wallet = openWallet("100.00");
    const bet = processedBet(wallet);
    const refund = wagerTx({ kind: K.Refund, amount: "30.00", reference: bet.externalTransactionId });
    const outcome = settle(wallet, refund, found(bet));
    expect(outcome.kind).toBe("processed");
    expect(wallet.balance.amount).toBe("100.00");
    expect(refund.referenceTransactionId).toBe(bet.id);
  });

  test("only once", () => {
    const wallet = openWallet("100.00");
    const bet = processedBet(wallet);
    const refund = wagerTx({ kind: K.Refund, amount: "30.00", reference: bet.externalTransactionId });
    expect(settle(wallet, refund, found(bet, true))).toEqual({
      kind: "rejected",
      failureCode: FailureCode.ReferenceAlreadyReversed,
    });
  });

  test("only of a BET", () => {
    const wallet = openWallet("100.00");
    const win = wagerTx({ kind: K.Win, amount: "30.00" });
    settle(wallet, win);
    const refund = wagerTx({ kind: K.Refund, amount: "30.00", reference: win.externalTransactionId });
    expect(settle(wallet, refund, found(win))).toEqual({
      kind: "rejected",
      failureCode: FailureCode.ReferenceKindNotAllowed,
    });
  });

  test("amount must equal the reference (no partial reversal)", () => {
    const wallet = openWallet("100.00");
    const bet = processedBet(wallet);
    const refund = wagerTx({ kind: K.Refund, amount: "10.00", reference: bet.externalTransactionId });
    expect(settle(wallet, refund, found(bet))).toEqual({
      kind: "rejected",
      failureCode: FailureCode.AmountMismatch,
    });
  });

  test("reference of another player/wallet is rejected", () => {
    const wallet = openWallet("100.00");
    const otherWallet = openWallet("100.00", { id: "wallet-2", playerId: "player-2" });
    const foreignBet = processedBet(otherWallet, { walletId: "wallet-2", playerId: "player-2" });
    const refund = wagerTx({ kind: K.Refund, amount: "30.00", reference: foreignBet.externalTransactionId });
    expect(settle(wallet, refund, found(foreignBet))).toEqual({
      kind: "rejected",
      failureCode: FailureCode.ReferenceContextMismatch,
    });
  });

  test("reference that was rejected cannot be refunded", () => {
    const wallet = openWallet("10.00");
    const bet = wagerTx({ amount: "30.00" });
    settle(wallet, bet);
    expect(bet.status).toBe(S.Rejected);
    const refund = wagerTx({ kind: K.Refund, amount: "30.00", reference: bet.externalTransactionId });
    expect(settle(wallet, refund, found(bet))).toEqual({
      kind: "rejected",
      failureCode: FailureCode.ReferenceNotProcessed,
    });
  });
});

describe("ROLLBACK", () => {
  test("of a BET credits it back", () => {
    const wallet = openWallet("100.00");
    const bet = processedBet(wallet);
    const rollback = wagerTx({ kind: K.Rollback, amount: "30.00", reference: bet.externalTransactionId });
    const outcome = settle(wallet, rollback, found(bet));
    expect(outcome.kind === "processed" && outcome.journal?.walletEntry.direction).toBe(
      LedgerDirection.Credit,
    );
    expect(wallet.balance.amount).toBe("100.00");
  });

  test("of a WIN debits it back", () => {
    const wallet = openWallet("0.00");
    const win = wagerTx({ kind: K.Win, amount: "50.00" });
    settle(wallet, win);
    const rollback = wagerTx({ kind: K.Rollback, amount: "50.00", reference: win.externalTransactionId });
    const outcome = settle(wallet, rollback, found(win));
    expect(outcome.kind === "processed" && outcome.journal?.walletEntry.direction).toBe(
      LedgerDirection.Debit,
    );
    expect(wallet.balance.amount).toBe("0.00");
  });

  test("that would make the balance negative is rejected with a distinct code", () => {
    const wallet = openWallet("0.00");
    const win = wagerTx({ kind: K.Win, amount: "50.00" });
    settle(wallet, win);
    settle(wallet, wagerTx({ amount: "40.00" }));
    const rollback = wagerTx({ kind: K.Rollback, amount: "50.00", reference: win.externalTransactionId });
    expect(settle(wallet, rollback, found(win))).toEqual({
      kind: "rejected",
      failureCode: FailureCode.ReversalInsufficientFunds,
    });
    expect(wallet.balance.amount).toBe("10.00");
  });

  test("of a ROLLBACK or a LOSS is not allowed", () => {
    const wallet = openWallet("100.00");
    const loss = wagerTx({ kind: K.Loss, amount: "0.00" });
    settle(wallet, loss);
    const rollback = wagerTx({ kind: K.Rollback, amount: "0.01", reference: loss.externalTransactionId });
    expect(settle(wallet, rollback, found(loss))).toEqual({
      kind: "rejected",
      failureCode: FailureCode.ReferenceKindNotAllowed,
    });
  });
});

describe("out-of-order references", () => {
  test("missing reference parks the transaction as PENDING_REFERENCE", () => {
    const wallet = openWallet("100.00");
    const refund = wagerTx({ kind: K.Refund, amount: "30.00", reference: "bet-not-yet" });
    expect(settle(wallet, refund, { found: false })).toEqual({ kind: "pending-reference", firstTime: true });
    expect(refund.status).toBe(S.PendingReference);
    expect(wallet.version).toBe(1);
  });

  test("a reference that is itself still pending keeps the dependent waiting", () => {
    const wallet = openWallet("100.00");
    const refund = wagerTx({ kind: K.Refund, amount: "30.00", reference: "bet-x" });
    settle(wallet, refund, { found: false });
    const rollback = wagerTx({ kind: K.Rollback, amount: "30.00", reference: refund.externalTransactionId });
    expect(settle(wallet, rollback, found(refund)).kind).toBe("pending-reference");
  });

  test("is rejected with REFERENCE_NOT_FOUND once the attempt limit is exhausted", () => {
    const wallet = openWallet("100.00");
    const refund = wagerTx({ kind: K.Refund, amount: "30.00", reference: "never" });
    expect(settle(wallet, refund, { found: false })).toEqual({ kind: "pending-reference", firstTime: true });
    expect(settle(wallet, refund, { found: false })).toEqual({ kind: "pending-reference", firstTime: false });
    expect(settle(wallet, refund, { found: false })).toEqual({
      kind: "rejected",
      failureCode: FailureCode.ReferenceNotFound,
    });
    expect(refund.status).toBe(S.Rejected);
  });

  test("the reference arriving later lets the pending transaction settle", () => {
    const wallet = openWallet("100.00");
    const refund = wagerTx({ kind: K.Refund, amount: "30.00", reference: "late-bet" });
    settle(wallet, refund, { found: false });
    const bet = processedBet(wallet, { externalTransactionId: "late-bet" });
    expect(settle(wallet, refund, found(bet)).kind).toBe("processed");
    expect(refund.status).toBe(S.Processed);
    expect(wallet.balance.amount).toBe("100.00");
  });
});
