import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { DataSource, EntityManager } from "typeorm";
import { expectPgError, openTestDataSource, resetDatabase } from "../support/db";

let ds: DataSource;
const uuid = () => Bun.randomUUIDv7();
const tx = <T>(fn: (m: EntityManager) => Promise<T>) => ds.transaction(fn);

async function insertWallet(m: EntityManager, balance = "0.00", version = 1, playerId = uuid()) {
  const id = uuid();
  await m.query(
    `INSERT INTO wallets (id, player_id, currency, balance, version, created_at, updated_at)
     VALUES ($1, $2, 'BRL', $3, $4, now(), now())`,
    [id, playerId, balance, version],
  );
  return id;
}

async function insertWager(
  m: EntityManager,
  walletId: string,
  o: { kind?: string; status?: string; ref?: string | null; refId?: string | null; amount?: string } = {},
) {
  const id = uuid();
  const ext = uuid();
  const status = o.status ?? "PROCESSED";
  await m.query(
    `INSERT INTO wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id,
       player_id, round_id, game_id, kind, amount, currency, reference_external_transaction_id, reference_transaction_id,
       status, failure_code, next_reference_attempt_at, processed_at, created_at, updated_at)
     VALUES ($1, 'provider-a', $2, $3, repeat('a', 64), $4, 'p', 'r', 'g', $5, $6, 'BRL', $7, $8, $9::varchar,
       CASE WHEN $9::varchar IN ('REJECTED','FAILED') THEN 'INSUFFICIENT_FUNDS' END,
       CASE WHEN $9::varchar = 'PENDING_REFERENCE' THEN now() END,
       CASE WHEN $9::varchar = 'PROCESSED' THEN now() END, now(), now())`,
    [
      id,
      ext,
      `provider-a:${ext}`,
      walletId,
      o.kind ?? "BET",
      o.amount ?? "10.00",
      o.ref ?? null,
      o.refId ?? null,
      status,
    ],
  );
  return id;
}

/** Valid journal: wallet posting + contra posting, plus the matching wallet update. */
async function postCredit(
  m: EntityManager,
  walletId: string,
  before: string,
  after: string,
  version: number,
) {
  const txId = await insertWager(m, walletId, { kind: "WIN" });
  const amount = (Number(after) - Number(before)).toFixed(2); // test helper only, values are small literals
  await m.query(
    "INSERT INTO ledger_journals (transaction_id, currency, created_at) VALUES ($1, 'BRL', now())",
    [txId],
  );
  await m.query(
    `INSERT INTO ledger_entries (id, transaction_id, account, wallet_id, direction, amount, currency, balance_before,
       balance_after, wallet_version, created_at)
     VALUES ($1, $2, 'WALLET', $3, 'CREDIT', $4, 'BRL', $5, $6, $7, now()),
            ($8, $2, 'HOUSE', NULL, 'DEBIT', $4, 'BRL', NULL, NULL, NULL, now())`,
    [uuid(), txId, walletId, amount, before, after, version, uuid()],
  );
  await m.query("UPDATE wallets SET balance = $2, version = $3, updated_at = now() WHERE id = $1", [
    walletId,
    after,
    version,
  ]);
  return txId;
}

beforeAll(async () => {
  await resetDatabase();
  ds = await openTestDataSource(5);
});

afterAll(async () => {
  await ds?.destroy();
});

describe("migrations", () => {
  test("are reversible: down to zero and up again", async () => {
    const before = await ds.query("SELECT count(*)::int AS n FROM schema_migrations");
    const total = before[0].n as number;
    expect(total).toBeGreaterThanOrEqual(5);
    for (let i = 0; i < total; i++) await ds.undoLastMigration({ transaction: "each" });
    const tables = await ds.query(
      "SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public' AND table_name <> 'schema_migrations'",
    );
    expect(tables[0].n).toBe(0);
    await ds.runMigrations({ transaction: "each" });
    const after = await ds.query("SELECT count(*)::int AS n FROM schema_migrations");
    expect(after[0].n).toBe(total);
  });
});

describe("wallets", () => {
  test("balance can never be negative", async () => {
    await expectPgError(() => tx((m) => insertWallet(m, "-0.01")), /ck_wallets_balance_non_negative/);
  });

  test("one wallet per player + currency", async () => {
    const player = uuid();
    await tx((m) => insertWallet(m, "0.00", 1, player));
    await expectPgError(() => tx((m) => insertWallet(m, "0.00", 1, player)), /uq_wallets_player_currency/);
  });

  test("a positive balance without ledger cannot be committed", async () => {
    await expectPgError(() => tx((m) => insertWallet(m, "10.00")), /without ledger entries/);
  });

  test("balance change must bump version exactly once and be backed by the ledger", async () => {
    const walletId = await tx((m) => insertWallet(m));
    await expectPgError(
      () => tx((m) => m.query("UPDATE wallets SET balance = 5 WHERE id = $1", [walletId])),
      /increment version/,
    );
    await expectPgError(
      () => tx((m) => m.query("UPDATE wallets SET version = 2 WHERE id = $1", [walletId])),
      /version may only change/,
    );
    await expectPgError(
      () => tx((m) => m.query("UPDATE wallets SET balance = 5, version = 2 WHERE id = $1", [walletId])),
      /diverges from ledger|without ledger/,
    );
    await tx((m) => postCredit(m, walletId, "0.00", "5.00", 2));
    const [w] = await ds.query("SELECT balance, version FROM wallets WHERE id = $1", [walletId]);
    expect(w).toEqual({ balance: "5.00", version: 2 });
  });

  test("wallets cannot be deleted", async () => {
    const walletId = await tx((m) => insertWallet(m));
    await expectPgError(
      () => tx((m) => m.query("DELETE FROM wallets WHERE id = $1", [walletId])),
      /never deleted/,
    );
  });
});

describe("ledger", () => {
  test("is append-only (UPDATE, DELETE, TRUNCATE rejected)", async () => {
    const walletId = await tx((m) => insertWallet(m));
    await tx((m) => postCredit(m, walletId, "0.00", "7.00", 2));
    await expectPgError(
      () => tx((m) => m.query("UPDATE ledger_entries SET amount = 1 WHERE wallet_id = $1", [walletId])),
      /append-only/,
    );
    await expectPgError(
      () => tx((m) => m.query("DELETE FROM ledger_entries WHERE wallet_id = $1", [walletId])),
      /append-only/,
    );
    await expectPgError(
      () => tx((m) => m.query("TRUNCATE ledger_entries CASCADE")),
      /TRUNCATE is not allowed/,
    );
  });

  test("wallet posting arithmetic is checked by the schema", async () => {
    const walletId = await tx((m) => insertWallet(m));
    await expectPgError(
      () =>
        tx(async (m) => {
          const txId = await insertWager(m, walletId, { kind: "WIN" });
          await m.query("INSERT INTO ledger_journals VALUES ($1, 'BRL', now())", [txId]);
          await m.query(
            `INSERT INTO ledger_entries (id, transaction_id, account, wallet_id, direction, amount, currency,
               balance_before, balance_after, wallet_version, created_at)
             VALUES ($1, $2, 'WALLET', $3, 'CREDIT', 10, 'BRL', 0, 9.99, 2, now())`,
            [uuid(), txId, walletId],
          );
        }),
      /ck_ledger_arithmetic/,
    );
  });

  test("chain must continue from the previous balance", async () => {
    const walletId = await tx((m) => insertWallet(m));
    await tx((m) => postCredit(m, walletId, "0.00", "10.00", 2));
    await expectPgError(() => tx((m) => postCredit(m, walletId, "3.00", "4.00", 3)), /chain broken/);
  });

  test("journals must be balanced (double entry)", async () => {
    const walletId = await tx((m) => insertWallet(m));
    await expectPgError(
      () =>
        tx(async (m) => {
          const txId = await insertWager(m, walletId, { kind: "WIN" });
          await m.query("INSERT INTO ledger_journals VALUES ($1, 'BRL', now())", [txId]);
          await m.query(
            `INSERT INTO ledger_entries (id, transaction_id, account, wallet_id, direction, amount, currency,
               balance_before, balance_after, wallet_version, created_at)
             VALUES ($1, $2, 'WALLET', $3, 'CREDIT', 10, 'BRL', 0, 10, 2, now())`,
            [uuid(), txId, walletId],
          );
          await m.query("UPDATE wallets SET balance = 10, version = 2 WHERE id = $1", [walletId]);
        }),
      /not balanced/,
    );
  });

  test("at most one wallet posting per transaction", async () => {
    const walletId = await tx((m) => insertWallet(m));
    const txId = await tx((m) => postCredit(m, walletId, "0.00", "10.00", 2));
    await expectPgError(
      () =>
        tx((m) =>
          m.query(
            `INSERT INTO ledger_entries (id, transaction_id, account, wallet_id, direction, amount, currency,
               balance_before, balance_after, wallet_version, created_at)
             VALUES ($1, $2, 'WALLET', $3, 'CREDIT', 1, 'BRL', 10, 11, 3, now())`,
            [uuid(), txId, walletId],
          ),
        ),
      /uq_ledger_one_posting_per_account/,
    );
  });
});

describe("wager transactions", () => {
  test("idempotency key and provider external id are unique", async () => {
    const walletId = await tx((m) => insertWallet(m));
    const id = await tx((m) => insertWager(m, walletId));
    const [row] = await ds.query(
      "SELECT idempotency_key, external_transaction_id FROM wager_transactions WHERE id = $1",
      [id],
    );
    await expectPgError(
      () =>
        tx((m) =>
          m.query(
            `INSERT INTO wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash,
               wallet_id, player_id, round_id, game_id, kind, amount, currency, status, created_at, updated_at)
             VALUES ($1, 'provider-a', 'other', $2, repeat('b',64), $3, 'p', 'r', 'g', 'BET', 1, 'BRL', 'PENDING', now(), now())`,
            [uuid(), row.idempotency_key, walletId],
          ),
        ),
      /uq_wager_idempotency_key/,
    );
  });

  test("terminal status is immutable and transitions follow the state machine", async () => {
    const walletId = await tx((m) => insertWallet(m));
    const processed = await tx((m) => insertWager(m, walletId, { status: "PROCESSED" }));
    await expectPgError(
      () => tx((m) => m.query("UPDATE wager_transactions SET updated_at = now() WHERE id = $1", [processed])),
      /is terminal/,
    );
    const pendingRef = await tx((m) =>
      insertWager(m, walletId, { kind: "REFUND", status: "PENDING_REFERENCE", ref: "missing-bet" }),
    );
    await expectPgError(
      () =>
        tx((m) =>
          m.query(
            "UPDATE wager_transactions SET status = 'PENDING', next_reference_attempt_at = NULL WHERE id = $1",
            [pendingRef],
          ),
        ),
      /invalid transition/,
    );
    await expectPgError(
      () => tx((m) => m.query("UPDATE wager_transactions SET amount = 99 WHERE id = $1", [pendingRef])),
      /immutable/,
    );
  });

  test("REFUND/ROLLBACK must carry a reference; OPENING only from the internal provider", async () => {
    const walletId = await tx((m) => insertWallet(m));
    await expectPgError(
      () => tx((m) => insertWager(m, walletId, { kind: "REFUND" })),
      /ck_wager_reference_required/,
    );
    await expectPgError(
      () => tx((m) => insertWager(m, walletId, { kind: "OPENING" })),
      /ck_wager_opening_internal/,
    );
  });

  test("a transaction can be reversed only once", async () => {
    const walletId = await tx((m) => insertWallet(m));
    const bet = await tx((m) => insertWager(m, walletId));
    await tx((m) => insertWager(m, walletId, { kind: "REFUND", ref: "x", refId: bet, status: "REJECTED" }));
    await tx((m) => insertWager(m, walletId, { kind: "REFUND", ref: "x", refId: bet, status: "PROCESSED" }));
    await expectPgError(
      () =>
        tx((m) => insertWager(m, walletId, { kind: "ROLLBACK", ref: "x", refId: bet, status: "PROCESSED" })),
      /uq_wager_reversed_once/,
    );
  });
});

describe("inbox / outbox", () => {
  test("inbox is unique per consumer + message id", async () => {
    const insert = (consumer: string) =>
      tx((m) =>
        m.query(
          "INSERT INTO inbox_messages (consumer_name, message_id, payload_hash, received_at) VALUES ($1, 'm-1', repeat('a',64), now())",
          [consumer],
        ),
      );
    await insert("consumer-a");
    await insert("consumer-b");
    await expectPgError(() => insert("consumer-a"), /pk_inbox_messages/);
  });

  test("outbox payload is immutable and publication is final", async () => {
    const id = uuid();
    await tx((m) =>
      m.query(
        `INSERT INTO outbox_messages (id, aggregate_id, partition_key, event_type, payload, occurred_at, next_attempt_at)
         VALUES ($1, $1, 'k', 'E', '{"a":1}', now(), now())`,
        [id],
      ),
    );
    await expectPgError(
      () => tx((m) => m.query(`UPDATE outbox_messages SET payload = '{"a":2}' WHERE id = $1`, [id])),
      /immutable/,
    );
    await tx((m) => m.query("UPDATE outbox_messages SET published_at = now() WHERE id = $1", [id]));
    await expectPgError(
      () => tx((m) => m.query("UPDATE outbox_messages SET published_at = NULL WHERE id = $1", [id])),
      /already published/,
    );
  });
});
