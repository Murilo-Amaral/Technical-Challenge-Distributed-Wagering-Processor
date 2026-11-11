import { describe, expect, test } from "bun:test";
import {
  CurrencyMismatchError,
  InsufficientFundsError,
  InvalidLedgerEntryError,
} from "../../src/wagering/domain/errors";
import {
  LedgerDirection,
  LedgerJournal,
  SystemAccount,
  WalletLedgerEntry,
} from "../../src/wagering/domain/ledger";
import { Money } from "../../src/wagering/domain/money";
import { Wallet } from "../../src/wagering/domain/wallet";

const brl = (amount: string) => Money.from({ amount, currency: "BRL" });
const at = new Date("2026-01-01T00:00:00Z");
let seq = 0;
const id = () => `id-${++seq}`;

const open = (initial: string) =>
  Wallet.open({
    id: "w1",
    playerId: "p1",
    initialBalance: brl(initial),
    openingTransactionId: "tx-open",
    openingLedgerEntryId: id(),
    at,
  });

describe("Wallet", () => {
  test("opens at version 1 with an OPENING credit entry when the balance is positive", () => {
    const { wallet, openingEntry } = open("100.00");
    expect(wallet.version).toBe(1);
    expect(wallet.balance.amount).toBe("100.00");
    expect(openingEntry?.direction).toBe(LedgerDirection.Credit);
    expect(openingEntry?.balanceBefore.amount).toBe("0.00");
    expect(openingEntry?.balanceAfter.amount).toBe("100.00");
    expect(openingEntry?.walletVersion).toBe(1);
  });

  test("opens with zero balance and no ledger entry", () => {
    const { wallet, openingEntry } = open("0.00");
    expect(wallet.version).toBe(1);
    expect(openingEntry).toBeUndefined();
  });

  test("debit and credit produce balanced entries and bump the version once per change", () => {
    const { wallet } = open("100.00");
    const debit = wallet.debit({ money: brl("80.00"), transactionId: "t1", ledgerEntryId: id(), at });
    expect(wallet.balance.amount).toBe("20.00");
    expect(wallet.version).toBe(2);
    expect(debit.isBalanced()).toBe(true);
    expect(debit.walletVersion).toBe(2);
    const credit = wallet.credit({ money: brl("5.50"), transactionId: "t2", ledgerEntryId: id(), at });
    expect(wallet.balance.amount).toBe("25.50");
    expect(wallet.version).toBe(3);
    expect(credit.balanceBefore.amount).toBe("20.00");
  });

  test("never goes negative: insufficient funds leaves state untouched", () => {
    const { wallet } = open("100.00");
    expect(() => wallet.debit({ money: brl("100.01"), transactionId: "t", ledgerEntryId: id(), at })).toThrow(
      InsufficientFundsError,
    );
    expect(wallet.balance.amount).toBe("100.00");
    expect(wallet.version).toBe(1);
  });

  test("debiting the whole balance is allowed", () => {
    const { wallet } = open("10.00");
    wallet.debit({ money: brl("10.00"), transactionId: "t", ledgerEntryId: id(), at });
    expect(wallet.balance.isZero()).toBe(true);
  });

  test("rejects operations in another currency", () => {
    const { wallet } = open("10.00");
    const usd = Money.from({ amount: "1.00", currency: "USD" });
    expect(() => wallet.credit({ money: usd, transactionId: "t", ledgerEntryId: id(), at })).toThrow(
      CurrencyMismatchError,
    );
    expect(wallet.version).toBe(1);
  });

  test("ledger entry factory validates the arithmetic", () => {
    expect(() =>
      WalletLedgerEntry.create({
        id: "e",
        walletId: "w",
        transactionId: "t",
        direction: LedgerDirection.Credit,
        money: brl("10.00"),
        balanceBefore: brl("5.00"),
        balanceAfter: brl("14.99"),
        walletVersion: 2,
        createdAt: at,
      }),
    ).toThrow(InvalidLedgerEntryError);
  });

  test("double-entry journal posts the opposite direction on the contra account", () => {
    const { wallet } = open("50.00");
    const entry = wallet.debit({ money: brl("20.00"), transactionId: "t1", ledgerEntryId: id(), at });
    const journal = LedgerJournal.create({
      walletEntry: entry,
      systemEntryId: id(),
      contraAccount: SystemAccount.House,
    });
    expect(journal.systemEntry.direction).toBe(LedgerDirection.Credit);
    expect(journal.systemEntry.money.equals(entry.money)).toBe(true);
    expect(journal.isBalanced()).toBe(true);
  });
});
