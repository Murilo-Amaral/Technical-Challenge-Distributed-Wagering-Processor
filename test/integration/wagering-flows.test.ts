import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { DataSource } from "typeorm";
import {
  IdempotencyConflictError,
  NotFoundError,
  ValidationError,
  WalletAlreadyExistsError,
} from "../../src/wagering/application/errors";
import type { TransactionContext, UnitOfWork } from "../../src/wagering/application/ports";
import { parseCreateWalletCommand, parseWagerCommand } from "../../src/wagering/application/wager-request";
import { openTestDataSource, resetDatabase } from "../support/db";
import {
  assertLedgerInvariant,
  buildHarness,
  type Harness,
  openWallet,
  submit,
  wagerBody,
} from "../support/harness";

let ds: DataSource;
let h: Harness;

beforeAll(async () => {
  await resetDatabase();
  ds = await openTestDataSource(20);
  h = buildHarness(ds);
});

afterAll(async () => {
  await assertLedgerInvariant(ds);
  await ds?.destroy();
});

const outboxTypes = async (aggregateIds: string[]) =>
  (
    await ds.query(
      "SELECT event_type FROM outbox_messages WHERE aggregate_id = ANY($1) ORDER BY occurred_at, event_type",
      [aggregateIds],
    )
  ).map((r: { event_type: string }) => r.event_type);

describe("wallet creation", () => {
  test("positive initial balance creates OPENING transaction, balanced journal and events atomically", async () => {
    const wallet = await openWallet(h, "1000.00");
    expect(wallet.version).toBe(1);
    const [opening] = await ds.query(
      "SELECT kind, status, provider_id FROM wager_transactions WHERE wallet_id = $1",
      [wallet.id],
    );
    expect(opening).toEqual({ kind: "OPENING", status: "PROCESSED", provider_id: "internal" });
    const entries = await ds.query(
      "SELECT e.account, e.direction, e.amount FROM ledger_entries e JOIN wager_transactions t ON t.id = e.transaction_id WHERE t.wallet_id = $1 ORDER BY e.account DESC",
      [wallet.id],
    );
    expect(entries).toEqual([
      { account: "WALLET", direction: "CREDIT", amount: "1000.00" },
      { account: "FUNDING", direction: "DEBIT", amount: "1000.00" },
    ]);
    const events = await ds.query(
      "SELECT event_type FROM outbox_messages WHERE payload->'data'->>'walletId' = $1",
      [wallet.id],
    );
    expect(events.map((e: { event_type: string }) => e.event_type).sort()).toEqual([
      "WagerTransactionProcessed",
      "WalletBalanceChanged",
    ]);
  });

  test("zero initial balance: no OPENING, no ledger, version 1", async () => {
    const wallet = await openWallet(h, "0.00");
    const [{ n }] = await ds.query("SELECT count(*)::int AS n FROM wager_transactions WHERE wallet_id = $1", [
      wallet.id,
    ]);
    expect(n).toBe(0);
    expect(wallet.version).toBe(1);
  });

  test("duplicate wallet for the same player + currency is a conflict; another currency is fine", async () => {
    const playerId = crypto.randomUUID();
    const cmd = (currency: string) =>
      parseCreateWalletCommand({ playerId, initialBalance: { amount: "1.00", currency } });
    await h.createWallet.execute(cmd("BRL"), "t");
    await expect(h.createWallet.execute(cmd("BRL"), "t")).rejects.toBeInstanceOf(WalletAlreadyExistsError);
    const usd = await h.createWallet.execute(cmd("USD"), "t");
    expect(usd.currency).toBe("USD");
  });
});

describe("submit wager transaction", () => {
  test("BET then idempotent replay returns the original result, including the balance observed then", async () => {
    const w = await openWallet(h, "1000.00");
    const input = { walletId: w.id, playerId: w.playerId, amount: "25.00" };
    const { body, idempotencyKey } = wagerBody(input);
    const first = await h.submit.execute(parseWagerCommand(body, idempotencyKey), {
      source: "http",
      correlationId: "c",
    });
    expect(first.type === "result" && first.transaction.resultBalance?.amount).toBe("975.00");

    await submit(h, { walletId: w.id, playerId: w.playerId, amount: "100.00" });
    const replay = await h.submit.execute(parseWagerCommand(body, idempotencyKey), {
      source: "http",
      correlationId: "c",
    });
    expect(replay.type).toBe("result");
    if (replay.type !== "result" || first.type !== "result") return;
    expect(replay.idempotentReplay).toBe(true);
    expect(replay.transaction.id).toBe(first.transaction.id);
    expect(replay.transaction.resultBalance?.amount).toBe("975.00");
    expect((await h.queries.wallet(w.id)).balance.amount).toBe("875.00");
  });

  test("same idempotency key with a divergent payload is a conflict, not a replay", async () => {
    const w = await openWallet(h);
    const { body, idempotencyKey } = wagerBody({ walletId: w.id, playerId: w.playerId, amount: "10.00" });
    await h.submit.execute(parseWagerCommand(body, idempotencyKey), { source: "http", correlationId: "c" });
    const changed = { ...body, money: { amount: "10.01", currency: "BRL" } };
    const error = await h.submit
      .execute(parseWagerCommand(changed, idempotencyKey), { source: "http", correlationId: "c" })
      .catch((e) => e);
    expect(error).toBeInstanceOf(IdempotencyConflictError);
    expect<unknown>(error.code).toBe("IDEMPOTENCY_KEY_CONFLICT");
    expect((await h.queries.wallet(w.id)).balance.amount).toBe("90.00");
  });

  test("reusing a provider externalTransactionId under another key with another payload is a conflict", async () => {
    const w = await openWallet(h);
    const first = wagerBody({ walletId: w.id, playerId: w.playerId, externalTransactionId: "dup-ext" });
    await h.submit.execute(parseWagerCommand(first.body, first.idempotencyKey), {
      source: "http",
      correlationId: "c",
    });
    const other = { ...first.body, money: { amount: "11.00", currency: "BRL" } };
    const error = await h.submit
      .execute(parseWagerCommand(other, "another-key"), { source: "http", correlationId: "c" })
      .catch((e) => e);
    expect<unknown>(error.code).toBe("EXTERNAL_TRANSACTION_ID_CONFLICT");
  });

  test("reusing a key with an unknown walletId is a conflict, not WALLET_NOT_FOUND", async () => {
    const w = await openWallet(h);
    const first = wagerBody({ walletId: w.id, playerId: w.playerId });
    await h.submit.execute(parseWagerCommand(first.body, first.idempotencyKey), {
      source: "http",
      correlationId: "c",
    });
    const typo = { ...first.body, walletId: Bun.randomUUIDv7() };
    const error = await h.submit
      .execute(parseWagerCommand(typo, first.idempotencyKey), { source: "http", correlationId: "c" })
      .catch((e) => e);
    expect(error).toBeInstanceOf(IdempotencyConflictError);
    expect(error.code).toBe("IDEMPOTENCY_KEY_CONFLICT");
  });

  test("idempotency keys are scoped to the provider", async () => {
    const w = await openWallet(h);
    const key = "shared-key-123";
    const a = wagerBody({
      walletId: w.id,
      playerId: w.playerId,
      providerId: "provider-a",
      idempotencyKey: key,
    });
    const b = wagerBody({
      walletId: w.id,
      playerId: w.playerId,
      providerId: "provider-b",
      idempotencyKey: key,
    });
    const ra = await h.submit.execute(parseWagerCommand(a.body, key), { source: "http", correlationId: "c" });
    const rb = await h.submit.execute(parseWagerCommand(b.body, key), { source: "http", correlationId: "c" });
    expect(ra.type === "result" && rb.type === "result" && ra.transaction.id !== rb.transaction.id).toBe(
      true,
    );
    expect(rb.type === "result" && rb.idempotentReplay).toBe(false);
    expect((await h.queries.wallet(w.id)).balance.amount).toBe("80.00");
  });

  test("insufficient funds is persisted as REJECTED with no ledger entry and a Rejected event", async () => {
    const w = await openWallet(h, "5.00");
    const result = await submit(h, { walletId: w.id, playerId: w.playerId, amount: "5.01" });
    expect<unknown>(result.type === "result" && result.transaction.status).toBe("REJECTED");
    if (result.type !== "result") return;
    expect<unknown>(result.transaction.failureCode).toBe("INSUFFICIENT_FUNDS");
    const [{ n }] = await ds.query(
      "SELECT count(*)::int AS n FROM ledger_entries WHERE transaction_id = $1",
      [result.transaction.id],
    );
    expect(n).toBe(0);
    expect(await outboxTypes([result.transaction.id])).toEqual(["WagerTransactionRejected"]);
  });

  test("currency conflict is rejected and auditable", async () => {
    const w = await openWallet(h);
    const result = await submit(h, { walletId: w.id, playerId: w.playerId, currency: "USD" });
    expect<unknown>(result.type === "result" && result.transaction.failureCode).toBe("CURRENCY_MISMATCH");
  });

  test("unknown wallet -> WALLET_NOT_FOUND, nothing persisted", async () => {
    const walletId = Bun.randomUUIDv7();
    await expect(submit(h, { walletId, playerId: "p" })).rejects.toBeInstanceOf(NotFoundError);
  });

  test("OPENING and malformed payloads are rejected before touching the database", () => {
    const { body, idempotencyKey } = wagerBody({
      walletId: Bun.randomUUIDv7(),
      playerId: "p",
      kind: "OPENING",
    });
    expect(() => parseWagerCommand(body, idempotencyKey)).toThrow(ValidationError);
    expect(() =>
      parseWagerCommand({ ...body, kind: "BET", money: { amount: "1e2", currency: "BRL" } }, "k"),
    ).toThrow(ValidationError);
    expect(() => parseWagerCommand({ ...body, kind: "BET" }, "")).toThrow(ValidationError);
  });

  test("full round: BET, WIN referencing it, LOSS, REFUND and ROLLBACK", async () => {
    const w = await openWallet(h, "100.00");
    const p = { walletId: w.id, playerId: w.playerId };
    await submit(h, { ...p, externalTransactionId: "r-bet", amount: "30.00" });
    const win = await submit(h, { ...p, kind: "WIN", amount: "50.00", reference: "r-bet" });
    expect<unknown>(win.type === "result" && win.transaction.status).toBe("PROCESSED");
    const loss = await submit(h, { ...p, kind: "LOSS", amount: "0.00", roundId: "round-2" });
    expect<unknown>(loss.type === "result" && loss.transaction.status).toBe("PROCESSED");
    expect((await h.queries.wallet(w.id)).version).toBe(3); // opening v1 + BET v2 + WIN v3; LOSS does not bump

    await submit(h, { ...p, externalTransactionId: "r-bet-2", amount: "20.00" });
    const refund = await submit(h, { ...p, kind: "REFUND", amount: "20.00", reference: "r-bet-2" });
    expect<unknown>(refund.type === "result" && refund.transaction.status).toBe("PROCESSED");
    const refundAgain = await submit(h, { ...p, kind: "ROLLBACK", amount: "20.00", reference: "r-bet-2" });
    expect<unknown>(refundAgain.type === "result" && refundAgain.transaction.failureCode).toBe(
      "REFERENCE_ALREADY_REVERSED",
    );

    const winId = win.type === "result" ? win.transaction.externalTransactionId : "";
    const rollbackWin = await submit(h, { ...p, kind: "ROLLBACK", amount: "50.00", reference: winId });
    expect<unknown>(rollbackWin.type === "result" && rollbackWin.transaction.status).toBe("PROCESSED");
    expect((await h.queries.wallet(w.id)).balance.amount).toBe("70.00");
    const report = await h.reconcile.execute(w.id, "t");
    expect(report.consistent).toBe(true);
    expect(report.checkedEntries).toBe(6);
  });

  test("ROLLBACK of a WIN that would make the balance negative is rejected with REVERSAL_INSUFFICIENT_FUNDS", async () => {
    const w = await openWallet(h, "0.00");
    const p = { walletId: w.id, playerId: w.playerId };
    await submit(h, { ...p, kind: "WIN", externalTransactionId: "neg-win", amount: "50.00" });
    await submit(h, { ...p, amount: "45.00" });
    const rollback = await submit(h, { ...p, kind: "ROLLBACK", amount: "50.00", reference: "neg-win" });
    expect<unknown>(rollback.type === "result" && rollback.transaction.failureCode).toBe(
      "REVERSAL_INSUFFICIENT_FUNDS",
    );
    expect((await h.queries.wallet(w.id)).balance.amount).toBe("5.00");
  });
});

describe("atomicity", () => {
  test("a failure after ledger/balance writes rolls back wallet, transaction, ledger, inbox and outbox together", async () => {
    const w = await openWallet(h, "100.00");
    const failingUow: UnitOfWork = {
      run: (work, options) =>
        h.uow.run(async (ctx: TransactionContext) => {
          const outbox = {
            ...ctx.outbox,
            enqueue: async () => {
              throw new Error("simulated crash before commit");
            },
          };
          return work({ ...ctx, outbox });
        }, options),
    };
    const broken = buildHarness(ds, { uow: failingUow });
    const { body, idempotencyKey } = wagerBody({ walletId: w.id, playerId: w.playerId, amount: "40.00" });
    const command = parseWagerCommand(body, idempotencyKey);
    await expect(
      broken.submit.execute(command, {
        source: "sqs",
        correlationId: "c",
        inbox: { consumerName: "atomicity", messageId: "m-atomic", payloadHash: command.payloadHash },
      }),
    ).rejects.toThrow("simulated crash before commit");

    const wallet = await h.queries.wallet(w.id);
    expect(wallet.balance.amount).toBe("100.00");
    expect(wallet.version).toBe(1);
    const [counts] = await ds.query(
      `SELECT (SELECT count(*)::int FROM wager_transactions WHERE idempotency_key = $1) AS txs,
              (SELECT count(*)::int FROM inbox_messages WHERE message_id = 'm-atomic') AS inbox,
              (SELECT count(*)::int FROM ledger_entries WHERE wallet_id = $2) AS entries`,
      [idempotencyKey, w.id],
    );
    expect(counts).toEqual({ txs: 0, inbox: 0, entries: 1 });

    // The same message is then processed normally exactly once.
    const ok = await h.submit.execute(command, {
      source: "sqs",
      correlationId: "c",
      inbox: { consumerName: "atomicity", messageId: "m-atomic", payloadHash: command.payloadHash },
    });
    expect(ok.type).toBe("result");
    const dup = await h.submit.execute(command, {
      source: "sqs",
      correlationId: "c",
      inbox: { consumerName: "atomicity", messageId: "m-atomic", payloadHash: command.payloadHash },
    });
    expect(dup.type).toBe("duplicate-message");
    expect((await h.queries.wallet(w.id)).balance.amount).toBe("60.00");
  });
});

describe("out-of-order references", () => {
  test("REFUND before its BET waits as PENDING_REFERENCE and settles as soon as the BET arrives", async () => {
    const w = await openWallet(h, "100.00");
    const p = { walletId: w.id, playerId: w.playerId };
    const refund = await submit(h, { ...p, kind: "REFUND", amount: "30.00", reference: "late-bet" });
    expect<unknown>(refund.type === "result" && refund.transaction.status).toBe("PENDING_REFERENCE");
    const refundId = refund.type === "result" ? refund.transaction.id : "";
    expect(await outboxTypes([refundId])).toEqual(["WagerTransactionPendingReference"]);

    await submit(h, { ...p, externalTransactionId: "late-bet", amount: "30.00" });
    const settled = await h.queries.transaction(refundId);
    expect<unknown>(settled.status).toBe("PROCESSED");
    expect((await h.queries.wallet(w.id)).balance.amount).toBe("100.00");
    expect(await outboxTypes([refundId])).toEqual([
      "WagerTransactionPendingReference",
      "WagerTransactionProcessed",
    ]);
  });

  test("ROLLBACK of a REFUND of a BET, delivered in reverse order, settles as a chain", async () => {
    const w = await openWallet(h, "100.00");
    const p = { walletId: w.id, playerId: w.playerId };
    await submit(h, { ...p, kind: "ROLLBACK", amount: "10.00", reference: "chain-refund" });
    await submit(h, {
      ...p,
      kind: "REFUND",
      amount: "10.00",
      reference: "chain-bet",
      externalTransactionId: "chain-refund",
    });
    await submit(h, { ...p, amount: "10.00", externalTransactionId: "chain-bet" });
    const statuses = await ds.query(
      "SELECT kind, status FROM wager_transactions WHERE wallet_id = $1 ORDER BY created_at",
      [w.id],
    );
    expect<unknown>(statuses.map((s: { status: string }) => s.status)).toEqual([
      "PROCESSED",
      "PROCESSED",
      "PROCESSED",
      "PROCESSED",
    ]);
    expect((await h.queries.wallet(w.id)).balance.amount).toBe("90.00");
  });

  test("worker retries with backoff and rejects with REFERENCE_NOT_FOUND when the limit is exhausted", async () => {
    const w = await openWallet(h, "100.00");
    const refund = await submit(h, {
      walletId: w.id,
      playerId: w.playerId,
      kind: "REFUND",
      amount: "5.00",
      reference: "never",
    });
    const id = refund.type === "result" ? refund.transaction.id : "";

    expect(await h.pending.runOnce()).toBe(0); // not due yet (1s backoff): nothing handled, the runner may sleep
    expect((await h.queries.transaction(id)).referenceAttempts).toBe(1);
    h.clock.advance(1_100);
    expect(await h.pending.runOnce()).toBeGreaterThanOrEqual(1); // attempt 2 -> rescheduled +2s
    const second = await h.queries.transaction(id);
    expect<unknown>(second.status).toBe("PENDING_REFERENCE");
    expect(second.referenceAttempts).toBe(2);
    h.clock.advance(2_100);
    await h.pending.runOnce(); // attempt 3 == max -> rejected
    const final = await h.queries.transaction(id);
    expect<unknown>(final.status).toBe("REJECTED");
    expect<unknown>(final.failureCode).toBe("REFERENCE_NOT_FOUND");
    expect(await outboxTypes([id])).toEqual(["WagerTransactionPendingReference", "WagerTransactionRejected"]);
  });
});

describe("reconciliation", () => {
  test("reports and does not fix a divergence introduced behind the application's back", async () => {
    const w = await openWallet(h, "50.00");
    await submit(h, { walletId: w.id, playerId: w.playerId, amount: "20.00" });
    expect((await h.reconcile.execute(w.id, "t")).consistent).toBe(true);

    // Simulate corruption by bypassing triggers (superuser-only session setting).
    await ds.transaction(async (m) => {
      await m.query("SET LOCAL session_replication_role = replica");
      await m.query("UPDATE wallets SET balance = balance + 1 WHERE id = $1", [w.id]);
    });
    const report = await h.reconcile.execute(w.id, "t");
    expect(report.consistent).toBe(false);
    expect(report.storedBalance.amount).toBe("31.00");
    expect(report.calculatedBalance.amount).toBe("30.00");
    expect(report.difference.amount).toBe("1.00");
    expect((await h.queries.wallet(w.id)).balance.amount).toBe("31.00"); // not silently corrected

    await ds.transaction(async (m) => {
      await m.query("SET LOCAL session_replication_role = replica");
      await m.query("UPDATE wallets SET balance = balance - 1 WHERE id = $1", [w.id]);
    });
  });
});

describe("ledger pagination", () => {
  test("opaque cursor pages newest-first and is stable while new entries are appended", async () => {
    const w = await openWallet(h, "100.00");
    for (let i = 0; i < 4; i++) await submit(h, { walletId: w.id, playerId: w.playerId, amount: "1.00" });
    const page1 = await h.queries.ledger(w.id, undefined, 2);
    expect(page1.entries.map((e) => e.walletVersion)).toEqual([5, 4]);
    await submit(h, { walletId: w.id, playerId: w.playerId, amount: "1.00" });
    const page2 = await h.queries.ledger(w.id, page1.nextCursor, 2);
    expect(page2.entries.map((e) => e.walletVersion)).toEqual([3, 2]);
    const page3 = await h.queries.ledger(w.id, page2.nextCursor, 2);
    expect(page3.entries.map((e) => e.walletVersion)).toEqual([1]);
    expect(page3.nextCursor).toBeUndefined();
    await expect(h.queries.ledger(w.id, "garbage", 2)).rejects.toBeInstanceOf(ValidationError);
  });
});
