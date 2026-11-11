/**
 * Load test: bun run test:load
 *
 * Methodology (see docs/LOAD_TEST.md):
 *  - 3 real service instances (HTTP + consumer + outbox relay + pending worker) on the same PostgreSQL / LocalStack;
 *  - N wallets + 1 hot wallet; a closed-loop generator with C concurrent virtual users for D seconds, round-robin
 *    across instances; mix: 70% BET, 15% WIN, 10% exact replays (idempotency), 5% BET on the hot wallet;
 *  - latency measured client side per request; outbox lag sampled from the database every second;
 *  - lock conflicts and retries scraped from each instance's /metrics at the end;
 *  - final correctness check: wallet balance == ledger for every wallet, journals balanced.
 *
 * Env: LOAD_DURATION_S (30), LOAD_CONCURRENCY (48), LOAD_WALLETS (200), LOAD_INSTANCES (3), DATABASE_URL (test db).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { openTestDataSource, resetDatabase } from "../test/support/db";
import { assertLedgerInvariant } from "../test/support/harness";
import { type Instance, postJson, spawnInstance, stopInstance } from "../test/support/instances";
import { createTestQueues, deleteTestQueues, testSqsClient } from "../test/support/sqs";

const DURATION_S = Number(process.env.LOAD_DURATION_S ?? 30);
const CONCURRENCY = Number(process.env.LOAD_CONCURRENCY ?? 48);
const WALLETS = Number(process.env.LOAD_WALLETS ?? 200);
const INSTANCES = Number(process.env.LOAD_INSTANCES ?? 3);

const percentile = (sorted: number[], p: number) =>
  sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]! : 0;
const amount = (min: number, max: number) =>
  `${Math.floor(min + Math.random() * (max - min))}.${String(Math.floor(Math.random() * 100)).padStart(2, "0")}`;

await resetDatabase();
const ds = await openTestDataSource(4);
const sqs = testSqsClient();
const queues = await createTestQueues(sqs);
const instances: Instance[] = [];

try {
  console.log(`starting ${INSTANCES} instances...`);
  for (let i = 0; i < INSTANCES; i++) {
    instances.push(
      await spawnInstance(`load-${i + 1}`, { ...queues.names, DB_POOL_SIZE: "16", LOG_LEVEL: "error" }),
    );
  }

  console.log(`creating ${WALLETS} wallets + 1 hot wallet...`);
  const create = async () =>
    (
      await postJson(instances[0]!.baseUrl, "/wallets", {
        playerId: crypto.randomUUID(),
        initialBalance: { amount: "1000000.00", currency: "BRL" },
      })
    ).body as { id: string; playerId: string };
  const wallets: Array<{ id: string; playerId: string }> = [];
  for (let i = 0; i < WALLETS; i += 20)
    wallets.push(...(await Promise.all(Array.from({ length: Math.min(20, WALLETS - i) }, create))));
  const hot = (
    await postJson(instances[0]!.baseUrl, "/wallets", {
      playerId: crypto.randomUUID(),
      initialBalance: { amount: "50000.00", currency: "BRL" },
    })
  ).body as { id: string; playerId: string };

  const latencies: number[] = [];
  const statuses = new Map<string, number>();
  const sent: Array<{ body: Record<string, unknown>; key: string }> = [];
  let requests = 0;
  let networkErrors = 0;
  const lagSamples: number[] = [];
  let maxPending = 0;

  const sampler = setInterval(async () => {
    const [row] = await ds.query(
      `SELECT count(*)::int AS pending, COALESCE(EXTRACT(EPOCH FROM now() - min(occurred_at)), 0)::float8 AS lag
         FROM outbox_messages WHERE published_at IS NULL`,
    );
    lagSamples.push(row.lag);
    maxPending = Math.max(maxPending, row.pending);
  }, 1000);

  const deadline = Date.now() + DURATION_S * 1000;
  let rr = 0;
  const vu = async () => {
    while (Date.now() < deadline) {
      const roll = Math.random();
      let request: { body: Record<string, unknown>; key: string };
      if (roll < 0.1 && sent.length > 0) {
        request = sent[Math.floor(Math.random() * sent.length)]!; // exact replay
      } else {
        const onHot = roll > 0.95;
        const w = onHot ? hot : wallets[Math.floor(Math.random() * wallets.length)]!;
        const externalTransactionId = `load-${crypto.randomUUID()}`;
        const kind = !onHot && roll < 0.25 ? "WIN" : "BET";
        request = {
          key: `provider-a:${externalTransactionId}`,
          body: {
            providerId: "provider-a",
            externalTransactionId,
            playerId: w.playerId,
            walletId: w.id,
            roundId: `round-${Math.floor(Math.random() * 1000)}`,
            gameId: "fortune-chimp",
            kind,
            money: { amount: amount(1, 50), currency: "BRL" },
          },
        };
        if (sent.length < 5000) sent.push(request);
      }
      const instance = instances[rr++ % instances.length]!;
      const started = performance.now();
      try {
        const res = await fetch(`${instance.baseUrl}/wagering/transactions`, {
          method: "POST",
          headers: { "content-type": "application/json", "Idempotency-Key": request.key },
          body: JSON.stringify(request.body),
        });
        await res.arrayBuffer();
        latencies.push(performance.now() - started);
        statuses.set(String(res.status), (statuses.get(String(res.status)) ?? 0) + 1);
      } catch {
        networkErrors++;
      }
      requests++;
    }
  };

  console.log(`running ${CONCURRENCY} virtual users for ${DURATION_S}s...`);
  const startedAt = performance.now();
  await Promise.all(Array.from({ length: CONCURRENCY }, vu));
  const elapsedS = (performance.now() - startedAt) / 1000;

  const drainStarted = performance.now();
  for (;;) {
    const [{ n }] = await ds.query(
      "SELECT count(*)::int AS n FROM outbox_messages WHERE published_at IS NULL",
    );
    if (n === 0) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  const drainS = (performance.now() - drainStarted) / 1000;
  clearInterval(sampler);

  const scraped = await Promise.all(
    instances.map((i) => fetch(`${i.baseUrl}/metrics`).then((r) => r.text())),
  );
  const sumMetric = (name: string) =>
    scraped
      .flatMap((text) => text.split("\n"))
      .filter((line) => line.startsWith(name))
      .reduce((acc, line) => acc + Number(line.split(" ").at(-1)), 0);

  const walletsChecked = await assertLedgerInvariant(ds);
  const sorted = [...latencies].sort((a, b) => a - b);
  const lagSorted = [...lagSamples].sort((a, b) => a - b);
  const serverErrors = [...statuses.entries()]
    .filter(([s]) => Number(s) >= 500)
    .reduce((a, [, n]) => a + n, 0);

  const result = {
    environment: {
      cpus: navigator.hardwareConcurrency,
      bun: Bun.version,
      platform: process.platform,
      instances: INSTANCES,
      note: "load generator, 3 service instances, PostgreSQL 16 and LocalStack share the same host",
    },
    parameters: { durationS: DURATION_S, concurrency: CONCURRENCY, wallets: WALLETS },
    requests,
    throughputRps: Number((requests / elapsedS).toFixed(1)),
    latencyMs: {
      p50: Number(percentile(sorted, 50).toFixed(1)),
      p95: Number(percentile(sorted, 95).toFixed(1)),
      p99: Number(percentile(sorted, 99).toFixed(1)),
      max: Number((sorted.at(-1) ?? 0).toFixed(1)),
    },
    statusCodes: Object.fromEntries([...statuses.entries()].sort()),
    errorRate: Number(((serverErrors + networkErrors) / Math.max(1, requests)).toFixed(5)),
    networkErrors,
    lockConflicts: sumMetric("wagering_lock_conflicts_total"),
    transactionRetries: sumMetric("wagering_retries_total"),
    idempotentReplays: sumMetric(
      'wagering_duplicates_detected_total{source="http",type="idempotent_replay"}',
    ),
    outbox: {
      lagP95S: Number(percentile(lagSorted, 95).toFixed(2)),
      lagMaxS: Number((lagSorted.at(-1) ?? 0).toFixed(2)),
      maxPending,
      drainAfterLoadS: Number(drainS.toFixed(2)),
    },
    correctness: { walletsChecked, ledgerInvariant: "ok" },
  };

  mkdirSync("load-results", { recursive: true });
  const file = `load-results/load-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  writeFileSync(file, `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result, null, 2));
  console.log(`saved ${file}`);
} finally {
  await Promise.all(instances.map((i) => stopInstance(i)));
  await deleteTestQueues(sqs, queues);
  await ds.destroy();
}
