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
  receiveAll,
  sendWager,
  type TestQueues,
  testSqsClient,
  wagerEnvelope,
  waitFor,
} from "../support/sqs";

/**
 * Real processes: every instance is `bun run src/main.ts` with HTTP + SQS consumer + outbox relay + pending-reference
 * worker, all sharing one PostgreSQL and one set of SQS queues.
 */
let ds: DataSource;
let sqs: SQSClient;
let queues: TestQueues;
const running: Instance[] = [];

const spawn = async (name: string, env: Record<string, string> = {}) => {
  const instance = await spawnInstance(name, { ...queues.names, ...env });
  running.push(instance);
  return instance;
};

const createWallet = async (instance: Instance, amount: string) => {
  const res = await postJson(instance.baseUrl, "/wallets", {
    playerId: crypto.randomUUID(),
    initialBalance: { amount, currency: "BRL" },
  });
  expect(res.status).toBe(201);
  return res.body as { id: string; playerId: string };
};

const bet = (
  w: { id: string; playerId: string },
  amount: string,
  externalTransactionId = `ext-${crypto.randomUUID()}`,
  kind = "BET",
  extra = {},
) => ({
  providerId: "provider-a",
  externalTransactionId,
  playerId: w.playerId,
  walletId: w.id,
  roundId: "round-1",
  gameId: "fortune-chimp",
  kind,
  money: { amount, currency: "BRL" },
  ...extra,
});

const submit = (instance: Instance, body: ReturnType<typeof bet>) =>
  postJson(instance.baseUrl, "/wagering/transactions", body, {
    "Idempotency-Key": `${body.providerId}:${body.externalTransactionId}`,
  });

const balance = async (walletId: string) =>
  (await ds.query("SELECT balance::text AS b FROM wallets WHERE id = $1", [walletId]))[0].b as string;

const outboxDrained = async () =>
  (await ds.query("SELECT count(*)::int AS n FROM outbox_messages WHERE published_at IS NULL"))[0].n === 0;

beforeAll(async () => {
  await resetDatabase();
  ds = await openTestDataSource(10);
  sqs = testSqsClient();
  queues = await createTestQueues(sqs, { visibilityTimeoutSeconds: 3 });
});

afterAll(async () => {
  await Promise.all(running.map((i) => stopInstance(i, "SIGKILL")));
  await assertLedgerInvariant(ds);
  await deleteTestQueues(sqs, queues);
  await ds?.destroy();
});

describe("multiple instances", () => {
  test("three instances: hot wallet over HTTP and SQS, duplicates, 100/80/80 and outbox publishing", async () => {
    const instances = await Promise.all([spawn("inst-1"), spawn("inst-2"), spawn("inst-3")]);

    // Mandatory scenario, each bet on a different instance.
    const w100 = await createWallet(instances[0]!, "100.00");
    const [r1, r2] = await Promise.all([
      submit(instances[1]!, bet(w100, "80.00")),
      submit(instances[2]!, bet(w100, "80.00")),
    ]);
    expect([r1.body.status, r2.body.status].sort()).toEqual(["PROCESSED", "REJECTED"]);
    expect(await balance(w100.id)).toBe("20.00");

    // The same bet 50 times across the three instances -> one debit.
    const wDup = await createWallet(instances[0]!, "1000.00");
    const same = bet(wDup, "25.00");
    const dupResults = await Promise.all(
      Array.from({ length: 50 }, (_, i) => submit(instances[i % 3]!, same)),
    );
    expect(new Set(dupResults.map((r) => r.body.transactionId)).size).toBe(1);
    expect(dupResults.filter((r) => r.status === 201)).toHaveLength(1);
    expect(await balance(wDup.id)).toBe("975.00");

    // Hot wallet: HTTP on every instance + SQS messages consumed by every instance, plus redeliveries.
    const hot = await createWallet(instances[0]!, "500.00");
    const httpOps = Array.from({ length: 60 }, (_, i) =>
      submit(
        instances[i % 3]!,
        bet(hot, i % 4 === 0 ? "9.00" : "7.00", undefined, i % 4 === 0 ? "WIN" : "BET"),
      ),
    );
    const sqsBodies = Array.from({ length: 40 }, () => bet(hot, "3.00"));
    const sqsOps = sqsBodies.flatMap((b, i) => {
      const envelope = wagerEnvelope(`hot-${i}`, {
        ...b,
        idempotencyKey: `${b.providerId}:${b.externalTransactionId}`,
      });
      // Every message is delivered twice (at-least-once).
      return [sendWager(sqs, queues.wagerQueueUrl, envelope), sendWager(sqs, queues.wagerQueueUrl, envelope)];
    });
    await Promise.all([...httpOps, ...sqsOps]);
    await waitFor(async () => (await approximateCount(sqs, queues.wagerQueueUrl)) === 0, {
      label: "queue drained",
      timeoutMs: 60_000,
    });

    const [{ processed_ops }] = await ds.query(
      `SELECT count(*)::int AS processed_ops FROM wager_transactions WHERE wallet_id = $1 AND kind <> 'OPENING'`,
      [hot.id],
    );
    expect(processed_ops).toBe(100); // 60 HTTP + 40 distinct SQS operations, despite 80 deliveries
    const [{ inbox }] = await ds.query(
      "SELECT count(*)::int AS inbox FROM inbox_messages WHERE message_id LIKE 'hot-%'",
    );
    expect(inbox).toBe(40);
    const [{ expected }] = await ds.query(
      `SELECT (500 + COALESCE(SUM(CASE WHEN kind = 'WIN' THEN amount ELSE -amount END), 0))::numeric(20,2)::text AS expected
         FROM wager_transactions WHERE wallet_id = $1 AND status = 'PROCESSED' AND kind IN ('BET','WIN')`,
      [hot.id],
    );
    expect(await balance(hot.id)).toBe(expected);

    // Three concurrent outbox relays: every event published, none twice.
    await waitFor(outboxDrained, { label: "outbox drained", timeoutMs: 30_000 });
    const [{ total }] = await ds.query("SELECT count(*)::int AS total FROM outbox_messages");
    const delivered = await receiveAll(sqs, queues.eventsQueueUrl, total + 50, 2);
    const ids = delivered.map((m) => (JSON.parse(m.Body!) as { eventId: string }).eventId);
    expect(new Set(ids).size).toBe(total);
    expect(ids).toHaveLength(total);

    await Promise.all(instances.map((i) => stopInstance(i)));
    await assertLedgerInvariant(ds);
  });

  test("worker killed after commit and before ack: redelivery is absorbed by the inbox", async () => {
    const seed = await spawn("seed", { WORKERS: "" });
    const w = await createWallet(seed, "100.00");
    await stopInstance(seed);

    const doomed = await spawn("doomed", {
      FAULT_INJECTION: "crash-after-commit-before-ack",
      WORKERS: "consumer",
      CONSUMER_VISIBILITY_TIMEOUT_S: "3",
    });
    const b = bet(w, "30.00");
    await sendWager(
      sqs,
      queues.wagerQueueUrl,
      wagerEnvelope("crash-msg", { ...b, idempotencyKey: `provider-a:${b.externalTransactionId}` }),
    );
    const exit = await doomed.exited;
    expect(doomed.process.signalCode).toBe("SIGKILL");
    expect(exit).not.toBe(0);
    // Committed before dying...
    expect(await balance(w.id)).toBe("70.00");
    // ...but not acknowledged: the message is still in the queue.
    expect(await approximateCount(sqs, queues.wagerQueueUrl)).toBe(1);

    const survivor = await spawn("survivor", { WORKERS: "consumer" });
    await waitFor(async () => (await approximateCount(sqs, queues.wagerQueueUrl)) === 0, {
      label: "redelivered and acked",
      timeoutMs: 30_000,
    });
    expect(await balance(w.id)).toBe("70.00");
    const [{ n }] = await ds.query(
      "SELECT count(*)::int AS n FROM wager_transactions WHERE wallet_id = $1 AND kind = 'BET'",
      [w.id],
    );
    expect(n).toBe(1);
    await stopInstance(survivor);
  });

  test("restart under load: graceful SIGTERM, new instances finish the work, final state is consistent", async () => {
    const first = await Promise.all([spawn("r1"), spawn("r2"), spawn("r3")]);
    const wallets = await Promise.all(Array.from({ length: 8 }, () => createWallet(first[0]!, "200.00")));
    const bodies = wallets.flatMap((w) => Array.from({ length: 10 }, () => bet(w, "5.00")));
    await Promise.all(
      bodies.map((b, i) =>
        sendWager(
          sqs,
          queues.wagerQueueUrl,
          wagerEnvelope(`restart-${i}`, { ...b, idempotencyKey: `provider-a:${b.externalTransactionId}` }),
        ),
      ),
    );
    // Out-of-order pair through the queue as well: ROLLBACK first, then its BET.
    const ooo = wallets[0]!;
    const late = bet(ooo, "11.00", "ooo-bet");
    const rollback = bet(ooo, "11.00", "ooo-rollback", "ROLLBACK", {
      referenceExternalTransactionId: "ooo-bet",
    });
    await sendWager(
      sqs,
      queues.wagerQueueUrl,
      wagerEnvelope("ooo-1", { ...rollback, idempotencyKey: "provider-a:ooo-rollback" }),
    );
    await sendWager(
      sqs,
      queues.wagerQueueUrl,
      wagerEnvelope("ooo-2", { ...late, idempotencyKey: "provider-a:ooo-bet" }),
    );

    await new Promise((r) => setTimeout(r, 300)); // let them start chewing
    const exitCodes = await Promise.all(first.map((i) => stopInstance(i, "SIGTERM")));
    expect(exitCodes).toEqual([0, 0, 0]);

    const second = await Promise.all([spawn("r4"), spawn("r5"), spawn("r6")]);
    await waitFor(async () => (await approximateCount(sqs, queues.wagerQueueUrl)) === 0, {
      label: "queue drained after restart",
      timeoutMs: 60_000,
    });
    await waitFor(outboxDrained, { label: "outbox drained after restart", timeoutMs: 30_000 });

    const [{ n }] = await ds.query(
      "SELECT count(*)::int AS n FROM wager_transactions WHERE idempotency_key = ANY($1) AND status = 'PROCESSED'",
      [bodies.map((b) => `provider-a:${b.externalTransactionId}`)],
    );
    expect(n).toBe(80);
    for (const w of wallets.slice(1)) expect(await balance(w.id)).toBe("150.00");
    const statuses = await ds.query(
      "SELECT external_transaction_id, status FROM wager_transactions WHERE external_transaction_id IN ('ooo-bet','ooo-rollback') ORDER BY 1",
    );
    expect(statuses).toEqual([
      { external_transaction_id: "ooo-bet", status: "PROCESSED" },
      { external_transaction_id: "ooo-rollback", status: "PROCESSED" },
    ]);
    expect(await balance(ooo.id)).toBe("150.00"); // bet and its rollback cancel out
    await Promise.all(second.map((i) => stopInstance(i)));
    await assertLedgerInvariant(ds);
  });
});
