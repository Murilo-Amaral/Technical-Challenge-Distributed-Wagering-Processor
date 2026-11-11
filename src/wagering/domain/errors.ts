/**
 * Domain errors. They never depend on HTTP or transport concerns; the interface layer maps them.
 */
export abstract class DomainError extends Error {
  abstract readonly code: string;

  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class InvalidMoneyError extends DomainError {
  readonly code = "INVALID_MONEY";
}

export class CurrencyMismatchError extends DomainError {
  readonly code = "CURRENCY_MISMATCH";

  constructor(expected: string, actual: string) {
    super(`Currency mismatch: expected ${expected}, got ${actual}`);
  }
}

export class InsufficientFundsError extends DomainError {
  readonly code = "INSUFFICIENT_FUNDS";
}

export class InvalidLedgerEntryError extends DomainError {
  readonly code = "INVALID_LEDGER_ENTRY";
}

export class InvalidWagerTransactionError extends DomainError {
  readonly code = "INVALID_WAGER_TRANSACTION";
}

/**
 * Thrown when code tries to move a transaction through a transition the state machine does not allow
 * (e.g. touching a terminal transaction). This is a programming error, never a business path.
 */
export class InvalidTransactionStateError extends DomainError {
  readonly code = "INVALID_TRANSACTION_STATE";
}
