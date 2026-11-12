import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { SQSClient } from "@aws-sdk/client-sqs";
import type { DataSource } from "typeorm";
import { openTestDataSource, resetDatabase } from "../support/db";
import { assertLedgerInvariant } from "../support/harness";
import { type Instance, postJson, spawnInstance, stopInstance } from "../support/instances";
import {
  approximateCount,
  createTestQueues,
  deleteTestQueues,
  sendWager,
  type TestQueues,
  testSqsClient,
  wagerEnvelope,
  waitFor,
} from "../support/sqs";

/**
 * Real outages: the PostgreSQL / LocalStack containers are frozen with `docker pause` while a service process runs.
 * Skipped when the docker CLI or the compose containers are not available.
 */
const POSTGRES = process.env.TEST_POSTGRES_CONTAINER ?? "wagering-postgres-1";
const LOCALSTACK = process.env.TEST_LOCALSTACK_CONTAINER ?? "wagering-localstack-1";

const docker = (...args: string[]) => Bun.spawnSync(["docker", ...args], { stdout: "pipe", stderr: "pipe" });
const containersAvailable = (() => {
  try {
    const r = docker("inspect", "-f", "{{.State.Running}}", POSTGRES, LOCALSTACK);
    return (
      r.exitCode === 0 &&
      r.stdout
        .toString()
        .trim()
        .split("\n")
        .every((l) => l === "true")
    );
  } catch {
    return false;
  }
})();

let ds: DataSource;
let sqs: SQSClient;
let queues: TestQueues;
let instance: Instance;

const ready = async () =>
  (await fetch(`${instance.baseUrl}/health/ready`)).json() as Promise<{ checks: Record<string, string> }>;

describe.skipIf(!containersAvailable)("infrastructure outages", () => {
  beforeAll(async () => {
    await resetDatabase();
    ds = await openTestDataSource(5);
    sqs = testSqsClient();
    queues = await createTestQueues(sqs);
    instance = await spawnInstance("outage", {
      ...queues.names,
      DB_LOCK_TIMEOUT_MS: "1000",
      DB_STATEMENT_TIMEOUT_MS: "2000",
      TX_MAX_RETRIES: "1",
    });
  });

  afterAll(async () => {
    docker("unpause", POSTGRES);
    docker("unpause", LOCALSTACK);
    if (instance) await stopInstance(instance);
    if (ds) await assertLedgerInvariant(ds);
    if (queues) await deleteTestQueues(sqs, queues);
    await ds?.destroy();
  });

  test("PostgreSQL down: readiness 503, API answers 503 retryable, recovers on its own", async () => {
    const wallet = (
      await postJson(instance.baseUrl, "/wallets", {
        playerId: crypto.randomUUID(),
        initialBalance: { amount: "100.00", currency: "BRL" },
      })
    ).body as { id: string; playerId: string };
    const body = {
      providerId: "provider-a",
      externalTransactionId: "outage-bet",
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: "r",
      gameId: "g",
      kind: "BET",
      money: { amount: "10.00", currency: "BRL" },
    };
    const headers = { "Idempotency-Key": "provider-a:outage-bet" };

    expect(docker("pause", POSTGRES).exitCode).toBe(0);
    try {
      const health = await fetch(`${instance.baseUrl}/health/ready`);
      expect(health.status).toBe(503);
      expect(((await health.json()) as { checks: Record<string, string> }).checks.postgres).toBe("down");
      expect((await fetch(`${instance.baseUrl}/health/live`)).status).toBe(200); // liveness is unaffected

      const res = await fetch(`${instance.baseUrl}/wagering/transactions`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
      expect(res.status).toBe(503);
      expect(res.headers.get("retry-after")).toBe("1");
      expect(((await res.json()) as { error: { retryable: boolean } }).error.retryable).toBe(true);
    } finally {
      docker("unpause", POSTGRES);
    }

    await waitFor(async () => (await ready()).checks.postgres === "up", {
      label: "postgres back",
      timeoutMs: 30_000,
    });
    const retried = await postJson(instance.baseUrl, "/wagering/transactions", body, headers);
    expect(retried.status).toBe(201);
    const again = await postJson(instance.baseUrl, "/wagering/transactions", body, headers);
    expect(again.status).toBe(200); // replay: the 503 attempt left nothing behind
    const [{ balance }] = await ds.query("SELECT balance::text AS balance FROM wallets WHERE id = $1", [
      wallet.id,
    ]);
    expect(balance).toBe("90.00");
  });

  test("SQS down: readiness reports it, queued work resumes once it is back", async () => {
    const wallet = (
      await postJson(instance.baseUrl, "/wallets", {
        playerId: crypto.randomUUID(),
        initialBalance: { amount: "100.00", currency: "BRL" },
      })
    ).body as { id: string; playerId: string };
    const data = {
      providerId: "provider-a",
      externalTransactionId: "sqs-outage-bet",
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: "r",
      gameId: "g",
      kind: "BET",
      money: { amount: "15.00", currency: "BRL" },
      idempotencyKey: "provider-a:sqs-outage-bet",
    };

    expect(docker("pause", LOCALSTACK).exitCode).toBe(0);
    try {
      await waitFor(async () => (await ready()).checks.sqs === "down", {
        label: "sqs down",
        timeoutMs: 10_000,
      });
      // HTTP keeps working without the broker: events wait in the outbox.
      const http = await postJson(
        instance.baseUrl,
        "/wagering/transactions",
        { ...data, externalTransactionId: "http-during-sqs-outage", idempotencyKey: undefined },
        { "Idempotency-Key": "provider-a:http-during-sqs-outage" },
      );
      expect(http.status).toBe(201);
    } finally {
      docker("unpause", LOCALSTACK);
    }
    await waitFor(async () => (await ready()).checks.sqs === "up", { label: "sqs back", timeoutMs: 30_000 });

    await sendWager(sqs, queues.wagerQueueUrl, wagerEnvelope("sqs-outage-msg", data));
    await waitFor(async () => (await approximateCount(sqs, queues.wagerQueueUrl)) === 0, {
      label: "consumer resumed",
      timeoutMs: 30_000,
    });
    await waitFor(
      async () =>
        (await ds.query("SELECT count(*)::int AS n FROM outbox_messages WHERE published_at IS NULL"))[0].n ===
        0,
      { label: "outbox caught up", timeoutMs: 30_000 },
    );
    const [{ balance }] = await ds.query("SELECT balance::text AS balance FROM wallets WHERE id = $1", [
      wallet.id,
    ]);
    expect(balance).toBe("70.00"); // 100 - 15 (HTTP during the outage) - 15 (queued message)
  });
});
