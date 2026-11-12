import { describe, expect, test } from "bun:test";
import { WalletBalanceChanged } from "../../src/wagering/domain/events/wagering-events";
import { InboxMessage } from "../../src/wagering/domain/inbox-message";
import { OutboxMessage } from "../../src/wagering/domain/outbox-message";
import { canonicalJson, computePayloadHash } from "../../src/wagering/domain/payload-hash";
import { ExponentialBackoff } from "../../src/wagering/domain/retry-policy";
import { brl, nextId, openWallet, T0 } from "../support/domain-builders";

const payload = {
  providerId: "provider-a",
  externalTransactionId: "transaction-123",
  playerId: "p",
  walletId: "w",
  roundId: "round-987",
  gameId: "fortune-chimp",
  kind: "BET",
  money: { amount: "25.00", currency: "BRL" },
};

describe("payload hash / idempotency", () => {
  test("canonical JSON sorts keys recursively and drops undefined", () => {
    expect(canonicalJson({ b: 1, a: { d: undefined, c: [2, 1] } })).toBe('{"a":{"c":[2,1]},"b":1}');
  });

  test("key order does not change the hash", () => {
    const { money: _money, ...rest } = payload;
    const reordered = {
      money: { currency: "BRL", amount: "25.00" },
      ...Object.fromEntries(Object.entries(rest).reverse()),
    } as typeof payload;
    expect(computePayloadHash(reordered)).toBe(computePayloadHash(payload));
  });

  test("same idempotency key with a divergent payload yields a different hash (conflict, not replay)", () => {
    const base = computePayloadHash(payload);
    expect(computePayloadHash({ ...payload, money: { amount: "25.01", currency: "BRL" } })).not.toBe(base);
    expect(computePayloadHash({ ...payload, kind: "WIN" })).not.toBe(base);
    expect(computePayloadHash({ ...payload, referenceExternalTransactionId: "x" })).not.toBe(base);
  });

  test("transport metadata is ignored", () => {
    const withExtras = { ...payload, idempotencyKey: "whatever", messageId: "m1" } as typeof payload;
    expect(computePayloadHash(withExtras)).toBe(computePayloadHash(payload));
  });
});

describe("Inbox / Outbox", () => {
  test("inbox marks processed once", () => {
    const msg = InboxMessage.receive({ messageId: "m", consumerName: "c", payloadHash: "h", receivedAt: T0 });
    expect(msg.isProcessed()).toBe(false);
    msg.markProcessed(T0);
    expect(msg.isProcessed()).toBe(true);
  });

  test("outbox enqueues the serialized envelope and backs off on failure", () => {
    const wallet = openWallet("0.00");
    const entry = wallet.credit({ money: brl("5.00"), transactionId: "t", ledgerEntryId: nextId(), at: T0 });
    const event = WalletBalanceChanged.from(wallet, entry, {
      correlationId: "corr",
      occurredAt: T0,
      newEventId: () => "evt-1",
    });
    const outbox = OutboxMessage.enqueue(event);
    expect(outbox.id).toBe("evt-1");
    expect(outbox.payload).toMatchObject({
      eventType: "WalletBalanceChanged",
      version: 1,
      occurredAt: T0.toISOString(),
      data: { balanceAfter: { amount: "5.00", currency: "BRL" }, walletVersion: 2 },
    });
    expect(outbox.isDue(T0)).toBe(true);
    const policy = ExponentialBackoff.of({ baseDelayMs: 100, maxDelayMs: 1000, maxAttempts: 10 });
    outbox.scheduleRetry(T0, policy, "boom");
    expect(outbox.attempts).toBe(1);
    expect(outbox.isDue(T0)).toBe(false);
    expect(outbox.isDue(new Date(T0.getTime() + 100))).toBe(true);
    outbox.markPublished(T0);
    expect(outbox.isPending()).toBe(false);
  });

  test("backoff is capped", () => {
    const policy = ExponentialBackoff.of({ baseDelayMs: 100, maxDelayMs: 1000, maxAttempts: 3 });
    expect([1, 2, 3, 4, 5].map((n) => policy.delayAfter(n))).toEqual([100, 200, 400, 800, 1000]);
    expect(policy.isExhausted(3)).toBe(true);
  });
});
