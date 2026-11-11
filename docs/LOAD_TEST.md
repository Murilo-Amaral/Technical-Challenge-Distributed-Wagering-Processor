# Load test

`bun run test:load` (script: `scripts/load-test.ts`). Requires `bun run infra:up`. Results are written to
`load-results/*.json` (git-ignored).

## Methodology

- **Topology:** 3 real service processes (`bun run src/main.ts`). Each runs HTTP, the SQS consumer, the outbox relay and
  the pending-reference worker. All share one PostgreSQL 16 and one LocalStack SQS. Each instance has `DB_POOL_SIZE=16`.
- **Data:** 200 wallets with 1,000,000.00 BRL each, plus one *hot wallet* with 50,000.00 BRL.
- **Generator:** closed loop, `C` concurrent virtual users for `D` seconds, round-robin across the instances, via
  `POST /wagering/transactions`.
- **Request mix:**
  - 70% BET and 15% WIN on random wallets, with random amounts between 1.00 and 50.99;
  - 10% exact replays of earlier requests (idempotency path);
  - 5% BET on the hot wallet (row-lock contention).
- **Measurements:**
  - latency per request, measured on the client;
  - status codes;
  - outbox lag (age of the oldest unpublished event), sampled from the database every second;
  - lock conflicts and transaction retries, scraped from each instance's `/metrics` at the end.
- **Correctness gate:** after the run, every wallet's balance must equal the balance rebuilt from its ledger, and every
  journal must be balanced. Both runs below passed.

Parameters: `LOAD_DURATION_S`, `LOAD_CONCURRENCY`, `LOAD_WALLETS`, `LOAD_INSTANCES`.

## Environment

Cloud sandbox: 4 vCPU, 15 GB RAM, Linux, Bun 1.4.4, PostgreSQL 16 (alpine) and LocalStack 3.8 in Docker.
**The load generator, the 3 instances, PostgreSQL and LocalStack all share the same 4 vCPUs.** The numbers therefore
describe this box, not a production capacity estimate.

## Results

| Run | VUs | Duration | Requests | Throughput | p50 | p95 | p99 | max | 5xx / network errors | Lock conflicts | Outbox lag p95 / max | Peak pending | Drain after load |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| A | 16 | 20 s | 5,503 | **274.6 req/s** | 51 ms | 117 ms | 177 ms | 392 ms | 0 / 0 | 0 | 0.48 s / 0.48 s | 242 | 0.2 s |
| B | 48 | 30 s | 9,863 | **325.0 req/s** | 90 ms | 313 ms | 1,607 ms | 5,006 ms | 0 / 0 | 0 | 9.2 s / 9.2 s | 5,828 | 3.6 s |

Status codes: run A had 4,951 × 201 and 552 × 200 (replays); run B had 8,905 × 201 and 958 × 200. No 422 appears
because every wallet holds a large balance.

## Analysis

- **Correctness holds under load:** zero errors, every replay answered 200 with the original result, ledger invariant
  OK on all 201 wallets.
- **Saturation point:** going from 16 to 48 VUs adds only about 18% throughput, while p99 grows 9× and max reaches about
  5 s. The box is CPU-bound: generator, 3 Bun processes, PostgreSQL and LocalStack compete for 4 vCPUs. The 5 s max
  lines up with the pool's `connectionTimeoutMillis`: requests waited for a connection, because 48 VUs plus the
  background workers compete for 3 × 16 connections. They waited but did not fail.
- **Hot wallet:** writers of one wallet are serialized by its row lock (by design). With 5% of the traffic on it, no
  `lock_timeout` (5 s) fired, so there were zero lock conflicts and zero retries. Waits show up as tail latency
  instead.
- **Outbox lag is the first resource to fall behind:** each relay publishes up to 50 events per step, in batches of 10,
  sent in order. At 48 VUs, events were produced faster than three relays published them: peak of 5,828 pending,
  about 9 s of lag. The backlog drained 3.6 s after the load stopped and no event was lost.
  - Knobs: `OUTBOX_BATCH_SIZE`, `OUTBOX_POLL_MS`, more relay instances.
  - A future option: publish the 10-message batches of *different* wallets in parallel, which keeps per-wallet
    ordering.
- **What this test does not measure:** network latency between services, a real AWS SQS, a tuned PostgreSQL
  (`shared_buffers`, `synchronous_commit`) and the SQS ingestion path. The SQS path is exercised for correctness in
  `test/concurrency/multi-instance.test.ts`, not for throughput.
