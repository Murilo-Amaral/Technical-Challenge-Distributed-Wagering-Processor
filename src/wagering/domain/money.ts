import { CurrencyMismatchError, InvalidMoneyError } from "./errors";

/** Wire/persistence contract for money: decimal string with scale 2 + ISO-4217 code. */
export interface MoneyProps {
  amount: string;
  currency: string;
}

const SCALE = 2;
const FACTOR = 10n ** BigInt(SCALE);
/** Mirrors the NUMERIC(20,2) columns: at most 18 integer digits. */
const MAX_INTEGER_DIGITS = 18;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;
/** Non-negative plain decimal: no sign, no exponent, no leading zeros, 0-2 fraction digits. */
const INPUT_PATTERN = /^(0|[1-9]\d*)(?:\.(\d{1,2}))?$/;
/** Signed form, only used when rehydrating values that were already validated and persisted. */
const STORED_PATTERN = /^(-)?(0|[1-9]\d*)(?:\.(\d{1,2}))?$/;

/**
 * Immutable monetary value. Internally an exact integer amount of minor units (`bigint`), so there is
 * never floating point arithmetic and never implicit rounding: inputs with more than 2 decimal places
 * are rejected instead of rounded.
 */
export class Money {
  private constructor(
    private readonly minorUnits: bigint,
    public readonly currency: string,
  ) {}

  /** Parses an input contract value. Rejects negatives, NaN, Infinity, exponents, empty strings and >2 decimals. */
  static from(props: MoneyProps): Money {
    if (props === null || typeof props !== "object") {
      throw new InvalidMoneyError("Money must be an object with amount and currency");
    }
    const currency = Money.parseCurrency(props.currency);
    if (typeof props.amount !== "string") {
      throw new InvalidMoneyError("amount must be a decimal string");
    }
    const match = INPUT_PATTERN.exec(props.amount);
    if (!match) {
      throw new InvalidMoneyError(
        `Invalid amount "${props.amount}": expected a non-negative decimal with up to 2 places`,
      );
    }
    return new Money(Money.toMinor(match[1]!, match[2]), currency);
  }

  /** Rehydrates a persisted (already validated, possibly signed) amount, e.g. NUMERIC(20,2) read as string. */
  static fromStored(amount: string, currency: string): Money {
    const match = STORED_PATTERN.exec(amount);
    if (!match) {
      throw new InvalidMoneyError(`Corrupted stored amount "${amount}"`);
    }
    const minor = Money.toMinor(match[2]!, match[3]);
    return new Money(match[1] ? -minor : minor, Money.parseCurrency(currency));
  }

  static zero(currency: string): Money {
    return new Money(0n, Money.parseCurrency(currency));
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.minorUnits + other.minorUnits, this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.minorUnits - other.minorUnits, this.currency);
  }

  negate(): Money {
    return new Money(-this.minorUnits, this.currency);
  }

  isZero(): boolean {
    return this.minorUnits === 0n;
  }

  isPositive(): boolean {
    return this.minorUnits > 0n;
  }

  isNegative(): boolean {
    return this.minorUnits < 0n;
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.minorUnits < other.minorUnits;
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.minorUnits === other.minorUnits;
  }

  hasSameCurrency(currency: string): boolean {
    return this.currency === currency;
  }

  /** Decimal string with fixed scale 2, e.g. "-0.05", "1000.00". */
  get amount(): string {
    const negative = this.minorUnits < 0n;
    const abs = negative ? -this.minorUnits : this.minorUnits;
    const integer = abs / FACTOR;
    const fraction = (abs % FACTOR).toString().padStart(SCALE, "0");
    return `${negative ? "-" : ""}${integer.toString()}.${fraction}`;
  }

  toJSON(): MoneyProps {
    return { amount: this.amount, currency: this.currency };
  }

  toString(): string {
    return `${this.amount} ${this.currency}`;
  }

  private assertSameCurrency(other: Money): void {
    if (other.currency !== this.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }

  private static parseCurrency(currency: unknown): string {
    if (typeof currency !== "string" || !CURRENCY_PATTERN.test(currency)) {
      throw new InvalidMoneyError(`Invalid currency "${String(currency)}": expected an ISO-4217 code`);
    }
    return currency;
  }

  private static toMinor(integerPart: string, fractionPart: string | undefined): bigint {
    if (integerPart.length > MAX_INTEGER_DIGITS) {
      throw new InvalidMoneyError("amount exceeds the supported precision (18 integer digits)");
    }
    return BigInt(integerPart) * FACTOR + BigInt((fractionPart ?? "").padEnd(SCALE, "0"));
  }
}
