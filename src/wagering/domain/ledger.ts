import { InvalidLedgerEntryError } from "./errors";
import { Money, type MoneyProps } from "./money";

export enum LedgerDirection {
  Debit = "DEBIT",
  Credit = "CREDIT",
}

export const oppositeDirection = (direction: LedgerDirection): LedgerDirection =>
  direction === LedgerDirection.Debit ? LedgerDirection.Credit : LedgerDirection.Debit;

/** Contra accounts of the double-entry ledger. Their balance is never materialized (no hot row). */
export enum SystemAccount {
  /** Funds that entered the platform when a wallet was opened (OPENING). */
  Funding = "FUNDING",
  /** The house/game side of every wager movement (BET, WIN, REFUND, ROLLBACK). */
  House = "HOUSE",
}

export interface CreateLedgerEntryProps {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  /** Wallet version after this movement. Unique per wallet: one entry per balance change. */
  walletVersion: number;
  createdAt: Date;
}

export type LedgerEntryState = CreateLedgerEntryProps;

/**
 * Wallet side of a ledger journal. Structurally immutable: readonly fields only, no transition methods.
 * `create` validates the arithmetic: balanceBefore ± money === balanceAfter.
 */
export class WalletLedgerEntry {
  private constructor(
    public readonly id: string,
    public readonly walletId: string,
    public readonly transactionId: string,
    public readonly direction: LedgerDirection,
    public readonly money: Money,
    public readonly balanceBefore: Money,
    public readonly balanceAfter: Money,
    public readonly walletVersion: number,
    public readonly createdAt: Date,
  ) {}

  static create(props: CreateLedgerEntryProps): WalletLedgerEntry {
    const entry = WalletLedgerEntry.rehydrate(props);
    if (!entry.money.isPositive()) {
      throw new InvalidLedgerEntryError("Ledger entry amount must be positive");
    }
    if (entry.balanceAfter.isNegative()) {
      throw new InvalidLedgerEntryError("Ledger entry cannot produce a negative balance");
    }
    if (!entry.isBalanced()) {
      throw new InvalidLedgerEntryError(
        `Unbalanced ledger entry: ${entry.balanceBefore} ${entry.direction} ${entry.money} != ${entry.balanceAfter}`,
      );
    }
    return entry;
  }

  static rehydrate(state: LedgerEntryState): WalletLedgerEntry {
    return new WalletLedgerEntry(
      state.id,
      state.walletId,
      state.transactionId,
      state.direction,
      state.money,
      state.balanceBefore,
      state.balanceAfter,
      state.walletVersion,
      state.createdAt,
    );
  }

  isBalanced(): boolean {
    const expected =
      this.direction === LedgerDirection.Credit
        ? this.balanceBefore.add(this.money)
        : this.balanceBefore.subtract(this.money);
    return expected.equals(this.balanceAfter);
  }

  /** Signed effect on the wallet balance (+ credit / - debit). */
  signedAmount(): Money {
    return this.direction === LedgerDirection.Credit ? this.money : this.money.negate();
  }

  toJSON(): {
    id: string;
    transactionId: string;
    direction: LedgerDirection;
    money: MoneyProps;
    balanceBefore: MoneyProps;
    balanceAfter: MoneyProps;
    walletVersion: number;
    createdAt: string;
  } {
    return {
      id: this.id,
      transactionId: this.transactionId,
      direction: this.direction,
      money: this.money.toJSON(),
      balanceBefore: this.balanceBefore.toJSON(),
      balanceAfter: this.balanceAfter.toJSON(),
      walletVersion: this.walletVersion,
      createdAt: this.createdAt.toISOString(),
    };
  }
}

export interface SystemLedgerEntryState {
  id: string;
  transactionId: string;
  account: SystemAccount;
  direction: LedgerDirection;
  money: Money;
  createdAt: Date;
}

/** Contra posting on a system account (immutable). */
export class SystemLedgerEntry {
  private constructor(
    public readonly id: string,
    public readonly transactionId: string,
    public readonly account: SystemAccount,
    public readonly direction: LedgerDirection,
    public readonly money: Money,
    public readonly createdAt: Date,
  ) {}

  static rehydrate(state: SystemLedgerEntryState): SystemLedgerEntry {
    return new SystemLedgerEntry(
      state.id,
      state.transactionId,
      state.account,
      state.direction,
      state.money,
      state.createdAt,
    );
  }
}

/**
 * Double-entry journal: one balanced pair of postings per financial transaction.
 * The wallet posting and the contra posting always have opposite directions and the same amount,
 * so the sum of debits equals the sum of credits.
 */
export class LedgerJournal {
  private constructor(
    public readonly transactionId: string,
    public readonly walletEntry: WalletLedgerEntry,
    public readonly systemEntry: SystemLedgerEntry,
  ) {}

  static create(props: {
    walletEntry: WalletLedgerEntry;
    systemEntryId: string;
    contraAccount: SystemAccount;
  }): LedgerJournal {
    const { walletEntry } = props;
    const systemEntry = SystemLedgerEntry.rehydrate({
      id: props.systemEntryId,
      transactionId: walletEntry.transactionId,
      account: props.contraAccount,
      direction: oppositeDirection(walletEntry.direction),
      money: walletEntry.money,
      createdAt: walletEntry.createdAt,
    });
    const journal = new LedgerJournal(walletEntry.transactionId, walletEntry, systemEntry);
    if (!journal.isBalanced()) {
      throw new InvalidLedgerEntryError("Journal debits and credits differ");
    }
    return journal;
  }

  isBalanced(): boolean {
    const postings = [this.walletEntry, this.systemEntry];
    const total = (direction: LedgerDirection) =>
      postings
        .filter((p) => p.direction === direction)
        .reduce((acc, p) => acc.add(p.money), Money.zero(this.walletEntry.money.currency));
    return total(LedgerDirection.Debit).equals(total(LedgerDirection.Credit));
  }
}
