import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Application } from "../../src/bootstrap/application";
import { startTestApp } from "../support/app";
import { resetDatabase } from "../support/db";

let app: Application & { baseUrl: string };

const json = async (path: string, init: RequestInit = {}) => {
  const res = await fetch(`${app.baseUrl}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
  const text = await res.text();
  return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : undefined };
};

const createWallet = async (amount = "1000.00") =>
  (
    await json("/wallets", {
      method: "POST",
      body: JSON.stringify({ playerId: crypto.randomUUID(), initialBalance: { amount, currency: "BRL" } }),
    })
  ).body as { id: string; playerId: string };

const wager = (w: { id: string; playerId: string }, extra: Record<string, unknown> = {}) => ({
  providerId: "provider-a",
  externalTransactionId: `tx-${crypto.randomUUID()}`,
  playerId: w.playerId,
  walletId: w.id,
  roundId: "round-987",
  gameId: "fortune-chimp",
  kind: "BET",
  money: { amount: "25.00", currency: "BRL" },
  ...extra,
});

const submit = (body: Record<string, unknown>, key = `${body.providerId}:${body.externalTransactionId}`) =>
  json("/wagering/transactions", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Idempotency-Key": key },
  });

beforeAll(async () => {
  await resetDatabase();
  app = await startTestApp({ AUTH_MODE: "disabled" });
});

afterAll(async () => {
  await app?.close();
});

describe("HTTP API", () => {
  test("health endpoints are open; readiness checks PostgreSQL and SQS", async () => {
    expect((await json("/health/live")).status).toBe(200);
    const ready = await json("/health/ready");
    expect(ready.status).toBe(200);
    expect(ready.body.checks).toEqual({ postgres: "up", sqs: "up" });
  });

  test("POST /wallets returns the contract and duplicates are 409", async () => {
    const playerId = crypto.randomUUID();
    const body = JSON.stringify({ playerId, initialBalance: { amount: "1000.00", currency: "BRL" } });
    const created = await json("/wallets", { method: "POST", body });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      playerId,
      balance: { amount: "1000.00", currency: "BRL" },
      version: 1,
    });
    const dup = await json("/wallets", { method: "POST", body });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe("WALLET_ALREADY_EXISTS");
  });

  test("status codes are distinct per situation", async () => {
    const w = await createWallet("100.00");
    const bet = wager(w);

    const created = await submit(bet);
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      status: "PROCESSED",
      balance: { amount: "75.00" },
      idempotentReplay: false,
    });

    const replay = await submit(bet);
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual({ ...created.body, idempotentReplay: true });

    const conflict = await submit({ ...bet, money: { amount: "25.01", currency: "BRL" } });
    expect(conflict.status).toBe(409);
    expect(conflict.body.error).toMatchObject({ code: "IDEMPOTENCY_KEY_CONFLICT", retryable: false });

    const rejected = await submit(wager(w, { money: { amount: "500.00", currency: "BRL" } }));
    expect(rejected.status).toBe(422);
    expect(rejected.body).toMatchObject({ status: "REJECTED", failureCode: "INSUFFICIENT_FUNDS" });

    const pending = await submit(wager(w, { kind: "REFUND", referenceExternalTransactionId: "unknown-bet" }));
    expect(pending.status).toBe(202);
    expect(pending.body.status).toBe("PENDING_REFERENCE");

    const invalid = await submit(wager(w, { money: { amount: "1e2", currency: "BRL" } }));
    expect(invalid.status).toBe(400);
    expect(invalid.body.error.code).toBe("VALIDATION_ERROR");

    const noKey = await json("/wagering/transactions", { method: "POST", body: JSON.stringify(wager(w)) });
    expect(noKey.status).toBe(400);

    const opening = await submit(wager(w, { kind: "OPENING" }));
    expect(opening.status).toBe(400);

    const unknownWallet = await submit(wager({ id: Bun.randomUUIDv7(), playerId: w.playerId }));
    expect(unknownWallet.status).toBe(404);
    expect(unknownWallet.body.error.code).toBe("WALLET_NOT_FOUND");

    const malformed = await json("/wagering/transactions", {
      method: "POST",
      body: "{oops",
      headers: { "Idempotency-Key": "x" },
    });
    expect(malformed.status).toBe(400);
  });

  test("queries and reconciliation", async () => {
    const w = await createWallet("50.00");
    const bet = wager(w, { money: { amount: "20.00", currency: "BRL" } });
    const created = await submit(bet);
    const byId = await json(`/wagering/transactions/${created.body.transactionId}`);
    expect(byId.status).toBe(200);
    expect(byId.body).toMatchObject({ kind: "BET", status: "PROCESSED", balance: { amount: "30.00" } });
    const byExternal = await json(`/providers/provider-a/wagering/transactions/${bet.externalTransactionId}`);
    expect(byExternal.body.id).toBe(created.body.transactionId);
    expect((await json(`/wallets/${w.id}`)).body).toMatchObject({ balance: { amount: "30.00" }, version: 2 });

    const page = await json(`/wallets/${w.id}/ledger?limit=1`);
    expect(page.body.items).toHaveLength(1);
    expect(typeof page.body.nextCursor).toBe("string");
    const next = await json(`/wallets/${w.id}/ledger?limit=1&cursor=${page.body.nextCursor}`);
    expect(next.body.items[0].direction).toBe("CREDIT");
    expect(next.body.nextCursor).toBeNull();

    const recon = await json(`/wallets/${w.id}/reconciliation`, { method: "POST" });
    expect(recon.body).toEqual({
      walletId: w.id,
      storedBalance: { amount: "30.00", currency: "BRL" },
      calculatedBalance: { amount: "30.00", currency: "BRL" },
      difference: { amount: "0.00", currency: "BRL" },
      consistent: true,
      checkedEntries: 2,
    });
    expect((await json("/wallets/not-a-uuid")).status).toBe(400);
    expect((await json(`/wallets/${Bun.randomUUIDv7()}`)).status).toBe(404);
  });

  test("metrics are exposed in Prometheus format and a correlation id is echoed", async () => {
    const res = await fetch(`${app.baseUrl}/metrics`, { headers: { "x-correlation-id": "corr-123" } });
    expect(res.headers.get("x-correlation-id")).toBe("corr-123");
    const text = await res.text();
    expect(text).toContain("wagering_transactions_total");
    expect(text).toContain("wagering_processing_duration_seconds_bucket");
  });
});
