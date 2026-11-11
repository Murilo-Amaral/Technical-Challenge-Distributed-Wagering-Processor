import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { DataSource } from "typeorm";
import { parseWagerCommand } from "../../src/wagering/application/wager-request";
import { openTestDataSource, resetDatabase } from "../support/db";
import {
  assertLedgerInvariant,
  buildHarness,
  type Harness,
  openWallet,
  submit,
  wagerBody,
} from "../support/harness";

/**
 * Real parallelism: every call below runs in its own SQL transaction on its own pooled connection, so the
 * database (not JS scheduling) decides the interleaving.
 */
let ds: DataSource;
let h: Harness;

beforeAll(async () => {
  await resetDatabase();
  ds = await openTestDataSource(30);
  h = buildHarness(ds);
});

afterAll(async () => {
  await assertLedgerInvariant(ds);
  await ds?.destroy();
});

describe("concurrency", () => {
  test("the same BET sent 50 times in parallel debits exactly once", async () => {
    const w = await openWallet(h, "1000.00");
    const { body, idempotencyKey } = wagerBody({ walletId: w.id, playerId: w.playerId, amount: "25.00" });
    const results = await Promise.all(
      Array.from({ length: 50 }, () =>
        h.submit.execute(parseWagerCommand(body, idempotencyKey), { source: "http", correlationId: "c" }),
      ),
    );
    const fresh = results.filter((r) => r.type === "result" && !r.idempotentReplay);
    expect(fresh).toHaveLength(1);
    expect(new Set(results.map((r) => (r.type === "result" ? r.transaction.id : "")))).toHaveProperty(
      "size",
      1,
    );
    const wallet = await h.queries.wallet(w.id);
    expect(wallet.balance.amount).toBe("975.00");
    expect(wallet.version).toBe(2);
    const [{ debits }] = await ds.query(
      "SELECT count(*)::int AS debits FROM ledger_entries WHERE wallet_id = $1 AND direction = 'DEBIT'",
      [w.id],
    );
    expect(debits).toBe(1);
  });

  test("mandatory scenario: balance 100.00, two parallel BETs of 80.00", async () => {
    const w = await openWallet(h, "100.00");
    const [a, b] = await Promise.all([
      submit(h, { walletId: w.id, playerId: w.playerId, amount: "80.00" }),
      submit(h, { walletId: w.id, playerId: w.playerId, amount: "80.00" }),
    ]);
    const statuses = [a, b].map((r) => (r.type === "result" ? r.transaction.status : "?")).sort();
    expect<unknown>(statuses).toEqual(["PROCESSED", "REJECTED"]);
    const rejected = [a, b].find((r) => r.type === "result" && r.transaction.status === "REJECTED");
    expect<unknown>(rejected?.type === "result" && rejected.transaction.failureCode).toBe(
      "INSUFFICIENT_FUNDS",
    );
    expect((await h.queries.wallet(w.id)).balance.amount).toBe("20.00");
    const [{ debits }] = await ds.query(
      "SELECT count(*)::int AS debits FROM ledger_entries WHERE wallet_id = $1 AND direction = 'DEBIT'",
      [w.id],
    );
    expect(debits).toBe(1);

    // Retrying both requests changes nothing.
    await Promise.all(
      [a, b].map((r) => (r.type === "result" ? h.queries.transaction(r.transaction.id) : null)),
    );
    expect((await h.queries.wallet(w.id)).balance.amount).toBe("20.00");
  });

  test("hot wallet: 200 mixed parallel operations never go negative and never lose updates", async () => {
    const w = await openWallet(h, "100.00");
    const ops = Array.from({ length: 200 }, (_, i) =>
      submit(h, {
        walletId: w.id,
        playerId: w.playerId,
        kind: i % 3 === 0 ? "WIN" : "BET",
        amount: i % 3 === 0 ? "5.00" : "7.00",
      }),
    );
    const results = await Promise.all(ops);
    let expected = 10_000n; // cents
    for (const r of results) {
      if (r.type !== "result" || r.transaction.status !== "PROCESSED") continue;
      const cents = BigInt(r.transaction.money.amount.replace(".", ""));
      expected += r.transaction.kind === "WIN" ? cents : -cents;
    }
    const wallet = await h.queries.wallet(w.id);
    expect(BigInt(wallet.balance.amount.replace(".", ""))).toBe(expected);
    expect(wallet.balance.isNegative()).toBe(false);
    const processed = results.filter(
      (r) => r.type === "result" && r.transaction.status === "PROCESSED",
    ).length;
    expect(wallet.version).toBe(1 + processed);
  });

  test("distinct wallets are processed in parallel (no global lock)", async () => {
    const wallets = await Promise.all(Array.from({ length: 20 }, () => openWallet(h, "50.00")));
    const started = performance.now();
    await Promise.all(
      wallets.flatMap((w) =>
        Array.from({ length: 5 }, () => submit(h, { walletId: w.id, playerId: w.playerId, amount: "10.00" })),
      ),
    );
    const elapsed = performance.now() - started;
    for (const w of wallets) {
      expect((await h.queries.wallet(w.id)).balance.amount).toBe("0.00");
    }
    // Lock waits are only per wallet; a global lock would serialize all 100 transactions.
    const [{ n }] = await ds.query(
      "SELECT count(*)::int AS n FROM ledger_entries WHERE wallet_id = ANY($1) AND direction = 'DEBIT'",
      [wallets.map((w) => w.id)],
    );
    expect(n).toBe(100);
    expect(elapsed).toBeLessThan(30_000);
  });

  test("concurrent REFUND and ROLLBACK of the same BET: exactly one reversal wins", async () => {
    const w = await openWallet(h, "100.00");
    await submit(h, {
      walletId: w.id,
      playerId: w.playerId,
      externalTransactionId: "race-bet",
      amount: "40.00",
    });
    const results = await Promise.all([
      submit(h, {
        walletId: w.id,
        playerId: w.playerId,
        kind: "REFUND",
        amount: "40.00",
        reference: "race-bet",
      }),
      submit(h, {
        walletId: w.id,
        playerId: w.playerId,
        kind: "ROLLBACK",
        amount: "40.00",
        reference: "race-bet",
      }),
      submit(h, {
        walletId: w.id,
        playerId: w.playerId,
        kind: "REFUND",
        amount: "40.00",
        reference: "race-bet",
      }),
    ]);
    const processed = results.filter((r) => r.type === "result" && r.transaction.status === "PROCESSED");
    expect(processed).toHaveLength(1);
    expect((await h.queries.wallet(w.id)).balance.amount).toBe("100.00");
  });
});
