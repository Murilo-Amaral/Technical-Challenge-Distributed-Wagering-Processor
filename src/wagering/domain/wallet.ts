import { CurrencyMismatchError, InsufficientFundsError, InvalidMoneyError } from "./errors";
import { LedgerDirection, WalletLedgerEntry } from "./ledger";
import { Money } from "./money";

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface MovementProps {
  money: Money;
  transactionId: string;
  ledgerEntryId: string;
  at: Date;
}

/**
 * Aggregate root for a player's balance in one currency.
 *
 * Invariants kept here (and again in the database schema):
 * - balance is never negative;
 * - every balance change returns exactly one ledger entry describing it (and only changes do);
 * - version starts at 1 and increments only when the balance changes;
 * - operations must use the wallet currency.
 */
export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    public readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  /**
   * Opens a wallet at version 1. A positive initial balance is recorded as an OPENING credit entry that
   * belongs to version 1 (creation itself is the first version, it does not count as an extra change).
   */
  static open(props: {
    id: string;
    playerId: string;
    initialBalance: Money;
    openingTransactionId: string;
    openingLedgerEntryId: string;
    at: Date;
  }): { wallet: Wallet; openingEntry: WalletLedgerEntry | undefined } {
    if (props.initialBalance.isNegative()) {
      throw new InvalidMoneyError("Initial balance cannot be negative");
    }
    const currency = props.initialBalance.currency;
    const wallet = new Wallet(
      props.id,
      props.playerId,
      currency,
      props.initialBalance,
      1,
      props.at,
      props.at,
    );
    const openingEntry = props.initialBalance.isPositive()
      ? WalletLedgerEntry.create({
          id: props.openingLedgerEntryId,
          walletId: props.id,
          transactionId: props.openingTransactionId,
          direction: LedgerDirection.Credit,
          money: props.initialBalance,
          balanceBefore: Money.zero(currency),
          balanceAfter: props.initialBalance,
          walletVersion: 1,
          createdAt: props.at,
        })
      : undefined;
    return { wallet, openingEntry };
  }

  /** Reconstruction from persistence: does not re-validate transitions. */
  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      state.balance,
      state.version,
      state.createdAt,
      state.updatedAt,
    );
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  canAfford(money: Money): boolean {
    this.assertSameCurrency(money);
    return !this._balance.isLessThan(money);
  }

  /** @throws InsufficientFundsError when the debit would make the balance negative. */
  debit(props: MovementProps): WalletLedgerEntry {
    this.assertSameCurrency(props.money);
    if (!this.canAfford(props.money)) {
      throw new InsufficientFundsError(`Balance ${this._balance} cannot cover ${props.money}`);
    }
    return this.apply(LedgerDirection.Debit, props);
  }

  credit(props: MovementProps): WalletLedgerEntry {
    this.assertSameCurrency(props.money);
    return this.apply(LedgerDirection.Credit, props);
  }

  private apply(direction: LedgerDirection, props: MovementProps): WalletLedgerEntry {
    const before = this._balance;
    const after =
      direction === LedgerDirection.Credit ? before.add(props.money) : before.subtract(props.money);
    const entry = WalletLedgerEntry.create({
      id: props.ledgerEntryId,
      walletId: this.id,
      transactionId: props.transactionId,
      direction,
      money: props.money,
      balanceBefore: before,
      balanceAfter: after,
      walletVersion: this._version + 1,
      createdAt: props.at,
    });
    this._balance = after;
    this._version += 1;
    this._updatedAt = props.at;
    return entry;
  }

  private assertSameCurrency(money: Money): void {
    if (!money.hasSameCurrency(this.currency)) {
      throw new CurrencyMismatchError(this.currency, money.currency);
    }
  }
}
