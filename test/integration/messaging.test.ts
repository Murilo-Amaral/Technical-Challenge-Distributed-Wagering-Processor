import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { SQSClient } from "@aws-sdk/client-sqs";
import type { DataSource } from "typeorm";
import { TransientInfrastructureError } from "../../src/wagering/application/errors";
import type { EventPublisher } from "../../src/wagering/application/event-publisher";
import { silentLogger } from "../../src/wagering/application/logger";
import { noopMetrics } from "../../src/wagering/application/metrics";
import { PublishOutbox } from "../../src/wagering/application/publish-outbox";
import type { SubmitWagerTransaction } from "../../src/wagering/application/submit-wager-transaction";
import { ExponentialBackoff } from "../../src/wagering/domain/retry-policy";
import { SqsEventPublisher } from "../../src/wagering/infrastructure/messaging/sqs-event-publisher";
import {
  type ConsumerSettings,
  SqsWagerConsumer,
} from "../../src/wagering/infrastructure/messaging/sqs-wager-consumer";
import { SystemClock } from "../../src/wagering/infrastructure/system";
import { openTestDataSource, resetDatabase } from "../support/db";
import { assertLedgerInvariant, buildHarness, type Harness, openWallet, wagerBody } from "../support/harness";
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

let ds: DataSource;
let h: Harness;
let sqs: SQSClient;
let queues: TestQueues;

const settings = (overrides: Partial<ConsumerSettings> = {}): ConsumerSettings => ({
  queueUrl: queues.wagerQueueUrl,
  dlqUrl: queues.wagerDlqUrl,
  consumerName: "wager-transactions-consumer",
  visibilityTimeoutSeconds: 30,
  waitTimeSeconds: 1,
  maxReceives: 3,
  retryBaseSeconds: 1,
  retryMaxSeconds: 2,
  shutdownGraceMs: 10_000,
  maxInFlightBatches: 2,
  ...overrides,
});

const consumerWith = (submit: SubmitWagerTransaction, overrides: Partial<ConsumerSettings> = {}) =>
  new SqsWagerConsumer(sqs, submit, noopMetrics, silentLogger, settings(overrides));

const messageData = (w: { id: string; playerId: string }, extra: Record<string, unknown> = {}) => {
  const { body, idempotencyKey } = wagerBody({
    walletId: w.id,
    playerId: w.playerId,
    amount: "10.00",
    ...extra,
  });
  return { ...body, idempotencyKey };
};

const balanceOf = async (walletId: string) => (await h.queries.wallet(walletId)).balance.amount;

beforeAll(async () => {
  await resetDatabase();
  ds = await openTestDataSource(20);
  h = buildHarness(ds);
  sqs = testSqsClient();
  queues = await createTestQueues(sqs);
});

afterAll(async () => {
  await assertLedgerInvariant(ds);
  await deleteTestQueues(sqs, queues);
  await ds?.destroy();
});

describe("SQS consumer", () => {
  test("processes a message through the same use case, records the inbox and acks after commit", async () => {
    const w = await openWallet(h, "100.00");
    const consumer = consumerWith(h.submit);
    consumer.start();
    try {
      await sendWager(sqs, queues.wagerQueueUrl, wagerEnvelope("msg-1", messageData(w)));
      await waitFor(async () => (await balanceOf(w.id)) === "90.00", { label: "bet applied" });
      await waitFor(async () => (await approximateCount(sqs, queues.wagerQueueUrl)) === 0, { label: "ack" });
      const [inbox] = await ds.query("SELECT processed_at FROM inbox_messages WHERE message_id = 'msg-1'");
      expect(inbox.processed_at).not.toBeNull();
    } finally {
      await consumer.stop();
    }
  });

  test("redelivery of the same messageId and a new messageId with the same idempotency key apply once", async () => {
    const w = await openWallet(h, "100.00");
    const data = messageData(w);
    const consumer = consumerWith(h.submit);
    consumer.start();
    try {
      for (let i = 0; i < 3; i++)
        await sendWager(sqs, queues.wagerQueueUrl, wagerEnvelope("msg-redeliver", data));
      await sendWager(sqs, queues.wagerQueueUrl, wagerEnvelope("msg-other-id", data));
      await waitFor(async () => (await approximateCount(sqs, queues.wagerQueueUrl)) === 0, {
        label: "all acked",
      });
      expect(await balanceOf(w.id)).toBe("90.00");
      const [{ n }] = await ds.query(
        "SELECT count(*)::int AS n FROM inbox_messages WHERE message_id LIKE 'msg-%'",
      );
      expect(n).toBeGreaterThanOrEqual(2);
    } finally {
      await consumer.stop();
    }
  });

  test("business rejections are acked (terminal) and stay auditable", async () => {
    const w = await openWallet(h, "5.00");
    const consumer = consumerWith(h.submit);
    consumer.start();
    try {
      await sendWager(
        sqs,
        queues.wagerQueueUrl,
        wagerEnvelope("msg-poor", messageData(w, { amount: "50.00" })),
      );
      await waitFor(async () => (await approximateCount(sqs, queues.wagerQueueUrl)) === 0, { label: "ack" });
      const [row] = await ds.query(
        "SELECT status, failure_code FROM wager_transactions WHERE wallet_id = $1 AND kind = 'BET'",
        [w.id],
      );
      expect(row).toEqual({ status: "REJECTED", failure_code: "INSUFFICIENT_FUNDS" });
    } finally {
      await consumer.stop();
    }
  });

  test("permanent errors go straight to the DLQ with a reason", async () => {
    const w = await openWallet(h, "100.00");
    const consumer = consumerWith(h.submit);
    consumer.start();
    try {
      await sendWager(sqs, queues.wagerQueueUrl, "{ not json", { groupId: "poison" });
      await sendWager(
        sqs,
        queues.wagerQueueUrl,
        wagerEnvelope("msg-opening", messageData(w, { kind: "OPENING" })),
      );
      const conflictData = messageData(w);
      await sendWager(sqs, queues.wagerQueueUrl, wagerEnvelope("msg-c1", conflictData));
      await waitFor(async () => (await balanceOf(w.id)) === "90.00", { label: "first applied" });
      await sendWager(
        sqs,
        queues.wagerQueueUrl,
        wagerEnvelope("msg-c2", { ...conflictData, money: { amount: "99.00", currency: "BRL" } }),
      );
      const dead: Awaited<ReturnType<typeof receiveAll>> = [];
      await waitFor(
        async () => {
          dead.push(...(await receiveAll(sqs, queues.wagerDlqUrl, 10, 1)));
          return dead.length >= 3;
        },
        { label: "dlq" },
      );
      const reasons = dead.map((m) => m.MessageAttributes?.reason?.StringValue).sort();
      expect(reasons).toEqual(["idempotency_key_conflict", "invalid_payload", "invalid_payload"]);
      expect(await balanceOf(w.id)).toBe("90.00");
    } finally {
      await consumer.stop();
    }
  });

  test("transient failures are retried with backoff, then dead-lettered when the limit is exhausted", async () => {
    let calls = 0;
    const alwaysDown = {
      execute: async () => {
        calls++;
        throw new TransientInfrastructureError("database unavailable");
      },
    } as unknown as SubmitWagerTransaction;
    const dlqQueues = await createTestQueues(sqs, { maxReceiveCount: 10 });
    const consumer = new SqsWagerConsumer(sqs, alwaysDown, noopMetrics, silentLogger, {
      ...settings(),
      queueUrl: dlqQueues.wagerQueueUrl,
      dlqUrl: dlqQueues.wagerDlqUrl,
    });
    consumer.start();
    try {
      const w = { id: Bun.randomUUIDv7(), playerId: "p" };
      await sendWager(sqs, dlqQueues.wagerQueueUrl, wagerEnvelope("msg-transient", messageData(w)));
      const dead = await waitFor(
        async () => {
          const msgs = await receiveAll(sqs, dlqQueues.wagerDlqUrl, 1, 1);
          return msgs.length ? msgs : undefined;
        },
        { label: "dead-lettered after retries", timeoutMs: 30_000 },
      );
      expect(dead[0]?.MessageAttributes?.reason?.StringValue).toBe(
        "retries_exhausted:TransientInfrastructureError",
      );
      expect(calls).toBe(3);
    } finally {
      await consumer.stop();
      await deleteTestQueues(sqs, dlqQueues);
    }
  });

  test("a transient failure followed by recovery applies the operation exactly once", async () => {
    const w = await openWallet(h, "100.00");
    let failuresLeft = 1;
    const flaky = {
      execute: async (...args: Parameters<SubmitWagerTransaction["execute"]>) => {
        if (failuresLeft-- > 0) throw new TransientInfrastructureError("blip");
        return h.submit.execute(...args);
      },
    } as unknown as SubmitWagerTransaction;
    const consumer = consumerWith(flaky);
    consumer.start();
    try {
      await sendWager(sqs, queues.wagerQueueUrl, wagerEnvelope("msg-flaky", messageData(w)));
      await waitFor(async () => (await balanceOf(w.id)) === "90.00", {
        label: "applied after retry",
        timeoutMs: 15_000,
      });
      await waitFor(async () => (await approximateCount(sqs, queues.wagerQueueUrl)) === 0, { label: "ack" });
    } finally {
      await consumer.stop();
    }
  });

  test("stop() lets the in-flight message finish and returns the rest of the group to the queue", async () => {
    const w = await openWallet(h, "100.00");
    let started = 0;
    const slow = {
      execute: async (...args: Parameters<SubmitWagerTransaction["execute"]>) => {
        started++;
        await new Promise((r) => setTimeout(r, 1500));
        return h.submit.execute(...args);
      },
    } as unknown as SubmitWagerTransaction;
    const consumer = consumerWith(slow);
    for (let i = 0; i < 3; i++) {
      await sendWager(sqs, queues.wagerQueueUrl, wagerEnvelope(`msg-sigterm-${i}`, messageData(w)), {
        groupId: w.id,
      });
    }
    consumer.start();
    await waitFor(async () => started > 0, { label: "first message started" });
    await consumer.stop();
    expect(started).toBe(1);
    expect(await balanceOf(w.id)).toBe("90.00"); // the in-flight one completed and committed
    // The other two were released (visibility 0): a new consumer processes them right away.
    const next = consumerWith(h.submit);
    next.start();
    try {
      await waitFor(async () => (await balanceOf(w.id)) === "70.00", {
        label: "released messages processed",
        timeoutMs: 10_000,
      });
    } finally {
      await next.stop();
    }
  });
});

describe("transactional outbox relay", () => {
  const publishOutbox = (publisher: EventPublisher, owner: string, leaseMs = 30_000) =>
    new PublishOutbox(h.uow, publisher, new SystemClock(), noopMetrics, silentLogger, {
      batchSize: 25,
      leaseMs,
      owner,
      retryPolicy: ExponentialBackoff.of({
        baseDelayMs: 200,
        maxDelayMs: 1000,
        maxAttempts: Number.MAX_SAFE_INTEGER,
      }),
    });

  const pendingCount = async () =>
    (await ds.query("SELECT count(*)::int AS n FROM outbox_messages WHERE published_at IS NULL"))[0]
      .n as number;

  test("two concurrent publishers drain the same outbox without publishing an event twice", async () => {
    // Drain anything left by previous tests first.
    const publisher = new SqsEventPublisher(sqs, queues.eventsQueueUrl);
    while ((await publishOutbox(publisher, "pre").runOnce()) > 0) {}
    await receiveAll(sqs, queues.eventsQueueUrl, 500, 1);

    for (let i = 0; i < 15; i++) await openWallet(h, "10.00"); // 2 events each
    expect(await pendingCount()).toBe(30);

    const sentIds: string[] = [];
    const recording = (): EventPublisher => ({
      publish: async (messages) => {
        sentIds.push(...messages.map((m) => m.id));
        await new Promise((r) => setTimeout(r, 50));
        return publisher.publish(messages);
      },
    });
    const a = publishOutbox(recording(), "publisher-a");
    const b = publishOutbox(recording(), "publisher-b");
    const drain = async (p: PublishOutbox) => {
      while ((await p.runOnce()) > 0) {}
    };
    await Promise.all([drain(a), drain(b), drain(a), drain(b)]);

    expect(await pendingCount()).toBe(0);
    expect(sentIds).toHaveLength(30);
    expect(new Set(sentIds).size).toBe(30);
    const delivered = await receiveAll(sqs, queues.eventsQueueUrl, 100, 2);
    const eventIds = delivered.map((m) => (JSON.parse(m.Body!) as { eventId: string }).eventId);
    expect(new Set(eventIds).size).toBe(30);
  });

  test("a publisher that dies after claiming is taken over when its lease expires (duplicate-safe)", async () => {
    await openWallet(h, "10.00");
    const publisher = new SqsEventPublisher(sqs, queues.eventsQueueUrl);
    // "Crashes" right after publishing, before marking published.
    const crashing: EventPublisher = {
      publish: async (messages) => {
        await publisher.publish(messages);
        throw new Error("process died");
      },
    };
    const doomed = new PublishOutbox(
      {
        run: async (work, options) => {
          if (options.name === "outbox_complete") throw new Error("process died before completing");
          return h.uow.run(work, options);
        },
      },
      crashing,
      new SystemClock(),
      noopMetrics,
      silentLogger,
      {
        batchSize: 25,
        leaseMs: 1000,
        owner: "doomed",
        retryPolicy: ExponentialBackoff.of({ baseDelayMs: 100, maxDelayMs: 100, maxAttempts: 1e9 }),
      },
    );
    await expect(doomed.runOnce()).rejects.toThrow();
    expect(await pendingCount()).toBe(2);

    const rescuer = publishOutbox(publisher, "rescuer");
    expect(await rescuer.runOnce()).toBe(0); // still leased by the dead publisher
    await new Promise((r) => setTimeout(r, 1100));
    expect(await rescuer.runOnce()).toBe(2);
    expect(await pendingCount()).toBe(0);

    // The broker de-duplicates the second publication by MessageDeduplicationId = eventId.
    const delivered = await receiveAll(sqs, queues.eventsQueueUrl, 100, 2);
    const ids = delivered.map((m) => (JSON.parse(m.Body!) as { eventId: string }).eventId);
    expect(ids).toHaveLength(new Set(ids).size);
  });

  test("claim keeps per-wallet order: a newer event waits while an older one of the same wallet is backing off", async () => {
    const publisher = new SqsEventPublisher(sqs, queues.eventsQueueUrl);
    while ((await publishOutbox(publisher, "pre-order").runOnce()) > 0) {}
    await openWallet(h, "10.00"); // 2 events on the same wallet partition
    const [older, newer] = await ds.query(
      "SELECT id FROM outbox_messages WHERE published_at IS NULL ORDER BY occurred_at, id",
    );
    const ours = (ids: string[]) => ids.filter((id) => id === older.id || id === newer.id);
    const claim = async () =>
      (await h.uow.run((ctx) => ctx.outbox.claimDue(new Date(), 50, 1000, "order-test"), { name: "t" })).map(
        (m) => m.id,
      );
    const release = () =>
      // Times come from the application clock (as in production), never from the database clock.
      ds.query("UPDATE outbox_messages SET next_attempt_at = $2, locked_until = NULL WHERE id = ANY($1)", [
        [older.id, newer.id],
        new Date(Date.now() - 1000),
      ]);

    // The older one failed and is backing off; the newer one is due but must wait.
    await ds.query("UPDATE outbox_messages SET next_attempt_at = $2 WHERE id = $1", [
      older.id,
      new Date(Date.now() + 3_600_000),
    ]);
    expect(ours(await claim())).toEqual([]);
    await release();
    expect(ours(await claim())).toEqual([older.id, newer.id]);
    await release();
    while ((await publishOutbox(publisher, "post-order").runOnce()) > 0) {}
  });

  test("broker failures schedule a retry with backoff and never lose the event", async () => {
    await openWallet(h, "10.00");
    const down: EventPublisher = { publish: async () => Promise.reject(new Error("SQS unavailable")) };
    expect(await publishOutbox(down, "down").runOnce()).toBe(0);
    const [row] = await ds.query(
      "SELECT attempts, next_attempt_at > now() AS deferred, last_error FROM outbox_messages WHERE published_at IS NULL LIMIT 1",
    );
    expect(row).toMatchObject({ attempts: 1, deferred: true, last_error: "SQS unavailable" });
    await new Promise((r) => setTimeout(r, 300));
    expect(await publishOutbox(new SqsEventPublisher(sqs, queues.eventsQueueUrl), "up").runOnce()).toBe(2);
    expect(await pendingCount()).toBe(0);
  });
});
