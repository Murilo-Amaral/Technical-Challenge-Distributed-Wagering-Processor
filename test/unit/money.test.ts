import { describe, expect, test } from "bun:test";
import { CurrencyMismatchError, InvalidMoneyError } from "../../src/wagering/domain/errors";
import { Money } from "../../src/wagering/domain/money";

const brl = (amount: string) => Money.from({ amount, currency: "BRL" });

describe("Money", () => {
  test("serializes with a fixed scale of 2", () => {
    expect(brl("25").amount).toBe("25.00");
    expect(brl("25.5").amount).toBe("25.50");
    expect(brl("0.05").toJSON()).toEqual({ amount: "0.05", currency: "BRL" });
    expect(brl("1000.00").toString()).toBe("1000.00 BRL");
  });

  test("arithmetic is exact (no floating point drift) and immutable", () => {
    const a = brl("0.10");
    const b = brl("0.20");
    const sum = a.add(b);
    expect(sum.amount).toBe("0.30");
    expect(a.amount).toBe("0.10");
    expect(brl("100.00").subtract(brl("80.00")).amount).toBe("20.00");
    expect(brl("10.00").subtract(brl("10.01")).amount).toBe("-0.01");
    expect(brl("12.34").negate().amount).toBe("-12.34");
    expect(brl("999999999999999999.99").add(brl("0.01")).amount).toBe("1000000000000000000.00");
  });

  test("never rounds: more than 2 decimal places is rejected", () => {
    expect(() => brl("1.005")).toThrow(InvalidMoneyError);
    expect(() => brl("0.001")).toThrow(InvalidMoneyError);
  });

  test.each([
    ["NaN"],
    ["Infinity"],
    ["-Infinity"],
    ["1e3"],
    ["1E-2"],
    [""],
    [" "],
    ["-1.00"],
    ["+1.00"],
    ["01.00"],
    ["1."],
    [".5"],
    ["1,00"],
    [" 1.00"],
    ["0x10"],
  ])("rejects invalid amount %p", (amount) => {
    expect(() => brl(amount)).toThrow(InvalidMoneyError);
  });

  test("rejects non-string amounts (numbers are not money)", () => {
    expect(() => Money.from({ amount: 25 as unknown as string, currency: "BRL" })).toThrow(InvalidMoneyError);
  });

  test("rejects amounts beyond NUMERIC(20,2) precision", () => {
    expect(() => brl("1234567890123456789.00")).toThrow(InvalidMoneyError);
  });

  test.each([["brl"], ["BR"], ["BRLL"], [""], ["12A"]])("rejects invalid currency %p", (currency) => {
    expect(() => Money.from({ amount: "1.00", currency })).toThrow(InvalidMoneyError);
  });

  test("operations across currencies throw a domain error", () => {
    const usd = Money.from({ amount: "1.00", currency: "USD" });
    expect(() => brl("1.00").add(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl("1.00").subtract(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl("1.00").isLessThan(usd)).toThrow(CurrencyMismatchError);
    expect(brl("1.00").equals(usd)).toBe(false);
  });

  test("predicates", () => {
    expect(Money.zero("BRL").isZero()).toBe(true);
    expect(brl("0.01").isPositive()).toBe(true);
    expect(brl("0.01").negate().isNegative()).toBe(true);
    expect(brl("1.00").isLessThan(brl("1.01"))).toBe(true);
    expect(brl("1.00").equals(brl("1"))).toBe(true);
  });

  test("rehydrates signed stored values exactly", () => {
    expect(Money.fromStored("-5.10", "BRL").amount).toBe("-5.10");
    expect(Money.fromStored("975.00", "BRL").equals(brl("975"))).toBe(true);
    expect(() => Money.fromStored("1.2.3", "BRL")).toThrow(InvalidMoneyError);
  });
});
