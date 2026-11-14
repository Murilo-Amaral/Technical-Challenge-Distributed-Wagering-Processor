/**
 * Black-box acceptance test: bun run test:acceptance
 *
 * Exercises the challenge requirements only through the external interfaces of a running stack
 * (`docker compose up -d --build --wait`): HTTP API, SQS queues and, read-only, the database for the final invariants.
 * Every run uses fresh ids, so it can be repeated against the same stack.
 *
 * Auth: with KEYCLOAK_ADMIN_PASSWORD set, real Keycloak client_credentials tokens are used and the auth rules are
 * checked; without it the stack is assumed to run with COMPOSE_AUTH_MODE=disabled and those checks are skipped.
 *
 * Env: API_URL (http://localhost:3000), KEYCLOAK_URL (http://localhost:8080), SQS_ENDPOINT (http://localhost:4566),
 *      DATABASE_URL (postgres://wagering:wagering@localhost:5432/wagering), WAGER_QUEUE_NAME, WAGER_DLQ_NAME.
 */
import {
  DeleteMessageBatchCommand,
  GetQueueUrlCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";
import { Client } from "pg";

const API = process.env.API_URL ?? "http://localhost:3000";
const KC = process.env.KEYCLOAK_URL ?? "http://localhost:8080";
const ADMIN_PASSWORD = process.env.KEYCLOAK_ADMIN_PASSWORD;
const AUTH = Boolean(ADMIN_PASSWORD);

const sqs = new SQSClient({
  region: process.env.AWS_REGION ?? "us-east-1",
  endpoint: process.env.SQS_ENDPOINT ?? "http://localhost:4566",
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? "test",
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? "test",
  },
});
const db = new Client({
  connectionString: process.env.DATABASE_URL ?? "postgres://wagering:wagering@localhost:5432/wagering",
});

// ---- tiny harness ---------------------------------------------------------------------------------------------

type Result = { section: string; name: string; ok: boolean; detail?: string };
const results: Result[] = [];
let section = "";
const check = (name: string, ok: boolean, detail?: string) => results.push({ section, name, ok, detail });
const skip = (name: string) => results.push({ section, name: `${name} (skipped: auth disabled)`, ok: true });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(probe: () => Promise<boolean>, timeoutMs = 30_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probe()) return true;
    await sleep(300);
  }
  return false;
}

// ---- auth -------------------------------------------------------------------------------------------------------

const form = (data: Record<string, string>) => ({
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams(data),
});

async function clientToken(adminToken: string, clientId: string): Promise<string> {
  const auth = { headers: { authorization: `Bearer ${adminToken}` } };
  const [client] = (await (
    await fetch(`${KC}/admin/realms/wagering/clients?clientId=${clientId}`, auth)
  ).json()) as Array<{
    id: string;
  }>;
  const { value } = (await (
    await fetch(`${KC}/admin/realms/wagering/clients/${client!.id}/client-secret`, auth)
  ).json()) as {
    value: string;
  };
  const res = await fetch(
    `${KC}/realms/wagering/protocol/openid-connect/token`,
    form({ grant_type: "client_credentials", client_id: clientId, client_secret: value }),
  );
  return ((await res.json()) as { access_token: string }).access_token;
}

// ---- preflight: fail with a clear message when the stack is not running -----------------------------------------

async function reachable(url: string): Promise<boolean> {
  return fetch(url, { signal: AbortSignal.timeout(3000) })
    .then(() => true)
    .catch(() => false);
}
if (!(await reachable(`${API}/health/live`))) {
  console.error(`API not reachable at ${API}. Start the stack first: docker compose up -d --build --wait`);
  process.exit(2);
}
if (AUTH && !(await reachable(`${KC}/realms/wagering`))) {
  console.error(`Keycloak not reachable at ${KC} (KEYCLOAK_ADMIN_PASSWORD is set, so auth checks need it).`);
  process.exit(2);
}

let OPERATOR: string | undefined;
let PROVIDER_A: string | undefined;
let PROVIDER_B: string | undefined;
if (AUTH) {
  const admin = (await (
    await fetch(
      `${KC}/realms/master/protocol/openid-connect/token`,
      form({ grant_type: "password", client_id: "admin-cli", username: "admin", password: ADMIN_PASSWORD! }),
    )
  ).json()) as { access_token: string };
  [OPERATOR, PROVIDER_A, PROVIDER_B] = await Promise.all(
    ["backoffice", "provider-a", "provider-b"].map((c) => clientToken(admin.access_token, c)),
  );
}

// ---- API helpers ------------------------------------------------------------------------------------------------

interface Reply {
  status: number;
  // biome-ignore lint/suspicious/noExplicitAny: JSON bodies of a black-box API
  body: any;
  headers: Headers;
}

async function call(
  method: string,
  path: string,
  token?: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<Reply> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const isJson = res.headers.get("content-type")?.includes("json");
  return { status: res.status, body: text && isJson ? JSON.parse(text) : text, headers: res.headers };
}

interface WalletRef {
  id: string;
  playerId: string;
  version: number;
}

const run = Date.now().toString(36);
let seq = 0;

const createWallet = async (amount: string): Promise<WalletRef> =>
  (
    await call("POST", "/wallets", OPERATOR, {
      playerId: `acc-${run}-${crypto.randomUUID().slice(0, 8)}`,
      initialBalance: { amount, currency: "BRL" },
    })
  ).body;

const op = (w: WalletRef, kind: string, amount: string, extra: Record<string, unknown> = {}) => ({
  providerId: "provider-a",
  externalTransactionId: `acc-${run}-${++seq}`,
  playerId: w.playerId,
  walletId: w.id,
  roundId: "r1",
  gameId: "fortune-chimp",
  kind,
  money: { amount, currency: "BRL" },
  ...extra,
});

const submit = (body: Record<string, unknown>, token = PROVIDER_A) =>
  call("POST", "/wagering/transactions", token, body, {
    "Idempotency-Key": `${body.providerId}:${body.externalTransactionId}`,
  });

const balanceOf = async (walletId: string) =>
  (await call("GET", `/wallets/${walletId}`, OPERATOR)).body.balance.amount;

// ---- scenarios --------------------------------------------------------------------------------------------------

await db.connect();
const wallets: WalletRef[] = [];
const track = (w: WalletRef) => {
  wallets.push(w);
  return w;
};

section = "§9/§12 health";
check("GET /health/live is open (200)", (await call("GET", "/health/live")).status === 200);
const ready = await call("GET", "/health/ready");
check(
  "GET /health/ready is open, PostgreSQL and SQS up",
  ready.status === 200 && ready.body.checks?.postgres === "up" && ready.body.checks?.sqs === "up",
);

section = "§2 authentication";
if (AUTH) {
  check("no token -> 401", (await call("GET", `/wallets/${crypto.randomUUID()}`)).status === 401);
  check(
    "provider cannot create wallets -> 403",
    (
      await call("POST", "/wallets", PROVIDER_A, {
        playerId: "x",
        initialBalance: { amount: "1.00", currency: "BRL" },
      })
    ).status === 403,
  );
} else {
  skip("no token -> 401");
  skip("provider cannot create wallets -> 403");
}

section = "§9 wallets";
const w100 = track(await createWallet("100.00"));
check(
  "POST /wallets -> version 1, balance 100.00",
  w100.version === 1 && (await balanceOf(w100.id)) === "100.00",
);
const duplicate = await call("POST", "/wallets", OPERATOR, {
  playerId: w100.playerId,
  initialBalance: { amount: "1.00", currency: "BRL" },
});
check(
  "duplicate player + currency -> 409 WALLET_ALREADY_EXISTS",
  duplicate.status === 409 && duplicate.body.error?.code === "WALLET_ALREADY_EXISTS",
);
const opening = await db.query(
  "SELECT t.kind, e.direction FROM wager_transactions t JOIN ledger_entries e ON e.transaction_id = t.id AND e.account = 'WALLET' WHERE t.wallet_id = $1",
  [w100.id],
);
check(
  "initial balance creates OPENING + CREDIT ledger entry",
  opening.rows.length === 1 && opening.rows[0].kind === "OPENING" && opening.rows[0].direction === "CREDIT",
);

section = "§8 mandatory scenario (100.00, two parallel 80.00 bets)";
const [r1, r2] = await Promise.all([submit(op(w100, "BET", "80.00")), submit(op(w100, "BET", "80.00"))]);
const statuses = [r1.body.status, r2.body.status].sort();
check("exactly one PROCESSED and one REJECTED", statuses[0] === "PROCESSED" && statuses[1] === "REJECTED");
check(
  "rejected with 422 INSUFFICIENT_FUNDS",
  [r1, r2].some((r) => r.status === 422 && r.body.failureCode === "INSUFFICIENT_FUNDS"),
);
check("final balance 20.00", (await balanceOf(w100.id)) === "20.00");
const debits = await db.query(
  "SELECT count(*)::int AS n FROM ledger_entries WHERE wallet_id = $1 AND direction = 'DEBIT'",
  [w100.id],
);
check("exactly one DEBIT entry in the ledger", debits.rows[0].n === 1);

section = "§9 idempotency";
const w1000 = track(await createWallet("1000.00"));
const bet = op(w1000, "BET", "25.00");
const first = await submit(bet);
const replay = await submit(bet);
check(
  "new operation -> 201, balance 975.00",
  first.status === 201 && first.body.balance?.amount === "975.00" && first.body.idempotentReplay === false,
);
check(
  "identical request -> 200, same body, idempotentReplay=true",
  replay.status === 200 &&
    replay.body.idempotentReplay === true &&
    JSON.stringify({ ...replay.body, idempotentReplay: false }) === JSON.stringify(first.body),
);
const conflict = await submit({ ...bet, money: { amount: "25.01", currency: "BRL" } });
check(
  "same key, different payload -> 409 IDEMPOTENCY_KEY_CONFLICT",
  conflict.status === 409 && conflict.body.error?.code === "IDEMPOTENCY_KEY_CONFLICT",
);
check(
  "missing Idempotency-Key -> 400",
  (await call("POST", "/wagering/transactions", PROVIDER_A, op(w1000, "BET", "1.00"))).status === 400,
);

section = "§13.1 same bet 50 times in parallel";
const w50 = track(await createWallet("1000.00"));
const sameBet = op(w50, "BET", "25.00");
const fifty = await Promise.all(Array.from({ length: 50 }, () => submit(sameBet)));
check(
  "one 201, 49 replays (200), a single transaction id",
  fifty.filter((r) => r.status === 201).length === 1 &&
    fifty.filter((r) => r.status === 200).length === 49 &&
    new Set(fifty.map((r) => r.body.transactionId)).size === 1,
);
check("single debit: balance 975.00", (await balanceOf(w50.id)) === "975.00");

section = "§7 business rules";
const wr = track(await createWallet("100.00"));
const bet1 = op(wr, "BET", "30.00");
await submit(bet1);
const win = op(wr, "WIN", "50.00", { referenceExternalTransactionId: bet1.externalTransactionId });
check("WIN referencing the BET -> 201", (await submit(win)).status === 201);
const loss = await submit(op(wr, "LOSS", "0.00", { roundId: "r2" }));
const afterLoss = (await call("GET", `/wallets/${wr.id}`, OPERATOR)).body;
check(
  "LOSS -> 201, balance and version unchanged",
  loss.status === 201 && afterLoss.balance.amount === "120.00" && afterLoss.version === 3,
);
const bet2 = op(wr, "BET", "20.00");
await submit(bet2);
const refund = await submit(
  op(wr, "REFUND", "20.00", { referenceExternalTransactionId: bet2.externalTransactionId }),
);
check(
  "REFUND of a BET -> 201, balance restored",
  refund.status === 201 && (await balanceOf(wr.id)) === "120.00",
);
const secondReversal = await submit(
  op(wr, "ROLLBACK", "20.00", { referenceExternalTransactionId: bet2.externalTransactionId }),
);
check(
  "second reversal of the same BET -> 422 REFERENCE_ALREADY_REVERSED",
  secondReversal.status === 422 && secondReversal.body.failureCode === "REFERENCE_ALREADY_REVERSED",
);
const winOnRefunded = await submit(
  op(wr, "WIN", "5.00", { referenceExternalTransactionId: bet2.externalTransactionId }),
);
check(
  "WIN on a refunded BET -> 422 REFERENCE_ALREADY_REVERSED",
  winOnRefunded.status === 422 && winOnRefunded.body.failureCode === "REFERENCE_ALREADY_REVERSED",
);
const partial = await submit(
  op(wr, "REFUND", "10.00", { referenceExternalTransactionId: bet1.externalTransactionId }),
);
check(
  "partial REFUND -> 422 AMOUNT_MISMATCH",
  partial.status === 422 && partial.body.failureCode === "AMOUNT_MISMATCH",
);
const refundOfWin = await submit(
  op(wr, "REFUND", "50.00", { referenceExternalTransactionId: win.externalTransactionId }),
);
check(
  "REFUND of a WIN -> 422 REFERENCE_KIND_NOT_ALLOWED",
  refundOfWin.status === 422 && refundOfWin.body.failureCode === "REFERENCE_KIND_NOT_ALLOWED",
);
const wz = track(await createWallet("0.00"));
const zWin = op(wz, "WIN", "50.00");
await submit(zWin);
await submit(op(wz, "BET", "45.00"));
const negativeRollback = await submit(
  op(wz, "ROLLBACK", "50.00", { referenceExternalTransactionId: zWin.externalTransactionId }),
);
check(
  "ROLLBACK that would go negative -> 422 REVERSAL_INSUFFICIENT_FUNDS, balance kept",
  negativeRollback.status === 422 &&
    negativeRollback.body.failureCode === "REVERSAL_INSUFFICIENT_FUNDS" &&
    (await balanceOf(wz.id)) === "5.00",
);
const usd = await submit({ ...op(wr, "BET", "1.00"), money: { amount: "1.00", currency: "USD" } });
check(
  "currency mismatch -> 422 CURRENCY_MISMATCH",
  usd.status === 422 && usd.body.failureCode === "CURRENCY_MISMATCH",
);
check("OPENING through the API -> 400", (await submit(op(wr, "OPENING", "1.00"))).status === 400);
for (const amount of ["1e2", "NaN", "Infinity", "1.005", "-1.00", ""]) {
  check(
    `invalid amount ${JSON.stringify(amount)} -> 400`,
    (await submit({ ...op(wr, "BET", "1.00"), money: { amount, currency: "BRL" } })).status === 400,
  );
}
check("REFUND without reference -> 400", (await submit(op(wr, "REFUND", "1.00"))).status === 400);
const pending = await submit(op(wr, "REFUND", "7.00", { referenceExternalTransactionId: `missing-${run}` }));
check(
  "missing reference -> 202 PENDING_REFERENCE",
  pending.status === 202 && pending.body.status === "PENDING_REFERENCE",
);

section = "§2 provider identity";
if (AUTH) {
  check(
    "provider-b acting as provider-a -> 403",
    (await submit(op(wr, "BET", "1.00"), PROVIDER_B)).status === 403,
  );
  check(
    "provider-b reading provider-a's transaction -> 404",
    (await call("GET", `/wagering/transactions/${first.body.transactionId}`, PROVIDER_B)).status === 404,
  );
  check(
    "provider-a reading its own transaction by external id -> 200",
    (
      await call(
        "GET",
        `/providers/provider-a/wagering/transactions/${bet.externalTransactionId}`,
        PROVIDER_A,
      )
    ).status === 200,
  );
} else {
  skip("provider-b acting as provider-a -> 403");
  skip("provider-b reading provider-a's transaction -> 404");
  skip("provider-a reading its own transaction by external id -> 200");
}

section = "§10 SQS consumer";
const queueUrl = async (name: string) =>
  (await sqs.send(new GetQueueUrlCommand({ QueueName: name }))).QueueUrl!;
const wagerQueue = await queueUrl(process.env.WAGER_QUEUE_NAME ?? "wager-transactions.fifo");
const dlq = await queueUrl(process.env.WAGER_DLQ_NAME ?? "wager-transactions-dlq.fifo");
const ws = track(await createWallet("100.00"));
const qBet = op(ws, "BET", "30.00");
const qRollback = op(ws, "ROLLBACK", "30.00", { referenceExternalTransactionId: qBet.externalTransactionId });
const envelope = (messageId: string, data: Record<string, unknown>) =>
  JSON.stringify({
    messageId,
    type: "WagerTransactionRequested",
    occurredAt: new Date().toISOString(),
    data: { ...data, idempotencyKey: `${data.providerId}:${data.externalTransactionId}` },
  });
const send = (body: string, group: string) =>
  sqs.send(
    new SendMessageCommand({
      QueueUrl: wagerQueue,
      MessageBody: body,
      MessageGroupId: group,
      MessageDeduplicationId: crypto.randomUUID(),
    }),
  );
await send(envelope(`acc-rb-${run}`, qRollback), ws.id); // reversal delivered before its reference
await send(envelope(`acc-bet-${run}`, qBet), ws.id);
await send(envelope(`acc-bet-${run}`, qBet), ws.id); // redelivery of the same message
await send(envelope(`acc-bet2-${run}`, qBet), ws.id); // same operation under a new messageId
check(
  "ROLLBACK delivered before its BET: both end PROCESSED",
  await waitFor(
    async () =>
      (
        await db.query(
          "SELECT count(*)::int AS n FROM wager_transactions WHERE wallet_id = $1 AND status = 'PROCESSED' AND kind IN ('BET','ROLLBACK')",
          [ws.id],
        )
      ).rows[0].n === 2,
  ),
);
await sleep(2000);
check("redeliveries applied once (balance back to 100.00)", (await balanceOf(ws.id)) === "100.00");
const inboxRows = await db.query("SELECT count(*)::int AS n FROM inbox_messages WHERE message_id LIKE $1", [
  `acc-%-${run}`,
]);
check("inbox holds one row per distinct messageId (3)", inboxRows.rows[0].n === 3);
const poison = `{ not json ${run}`;
await send(poison, `poison-${run}`);
let dlqReason = "";
await waitFor(async () => {
  const res = await sqs.send(
    new ReceiveMessageCommand({
      QueueUrl: dlq,
      MaxNumberOfMessages: 10,
      WaitTimeSeconds: 1,
      MessageAttributeNames: ["All"],
    }),
  );
  const ours = (res.Messages ?? []).filter((m) => m.Body === poison);
  for (const m of ours) dlqReason = m.MessageAttributes?.reason?.StringValue ?? "";
  if (ours.length) {
    await sqs.send(
      new DeleteMessageBatchCommand({
        QueueUrl: dlq,
        Entries: ours.map((m, i) => ({ Id: String(i), ReceiptHandle: m.ReceiptHandle! })),
      }),
    );
  }
  return dlqReason !== "";
});
check(
  "invalid message -> DLQ with reason invalid_payload",
  dlqReason === "invalid_payload",
  dlqReason || "not found in DLQ",
);

section = "§9 ledger and reconciliation";
const page1 = await call("GET", `/wallets/${wr.id}/ledger?limit=2`, OPERATOR);
const page2 = await call("GET", `/wallets/${wr.id}/ledger?limit=2&cursor=${page1.body.nextCursor}`, OPERATOR);
check(
  "ledger pages newest-first with an opaque cursor",
  page1.body.items.length === 2 &&
    typeof page1.body.nextCursor === "string" &&
    page2.body.items[0].walletVersion < page1.body.items[1].walletVersion,
);
let consistent = true;
for (const w of wallets) {
  const report = await call("POST", `/wallets/${w.id}/reconciliation`, OPERATOR);
  if (!report.body.consistent || report.body.difference?.amount !== "0.00") consistent = false;
}
check(`reconciliation consistent for all ${wallets.length} wallets of this run`, consistent);

section = "§11 transactional outbox";
check(
  "outbox fully published by the relays",
  await waitFor(
    async () =>
      (await db.query("SELECT count(*)::int AS n FROM outbox_messages WHERE published_at IS NULL")).rows[0]
        .n === 0,
  ),
);
const eventTypes = (
  await db.query(
    "SELECT DISTINCT event_type FROM outbox_messages WHERE payload->'data'->>'walletId' = ANY($1)",
    [wallets.map((w) => w.id)],
  )
).rows.map((r) => r.event_type);
check(
  "all 4 event types produced by this run",
  [
    "WagerTransactionPendingReference",
    "WagerTransactionProcessed",
    "WagerTransactionRejected",
    "WalletBalanceChanged",
  ].every((t) => eventTypes.includes(t)),
  eventTypes.join(","),
);

section = "§12 observability";
const metrics = (await call("GET", "/metrics")).body as string;
for (const name of [
  "wagering_transactions_total",
  "wagering_duplicates_detected_total",
  "wagering_retries_total",
  "wagering_lock_conflicts_total",
  "wagering_dlq_messages_total",
  "wagering_outbox_lag_seconds",
  "wagering_processing_duration_seconds_bucket",
]) {
  check(`metric exposed: ${name}`, metrics.includes(name));
}
const echoed = await call("GET", "/health/live", undefined, undefined, { "x-correlation-id": `acc-${run}` });
check("X-Correlation-Id is echoed", echoed.headers.get("x-correlation-id") === `acc-${run}`);

section = "§13 final invariants (whole database)";
const drift = await db.query(`
  SELECT count(*)::int AS n FROM (
    SELECT w.balance, COALESCE(SUM(CASE WHEN e.direction = 'CREDIT' THEN e.amount ELSE -e.amount END), 0) AS rebuilt
      FROM wallets w LEFT JOIN ledger_entries e ON e.wallet_id = w.id AND e.account = 'WALLET'
     GROUP BY w.id) x
   WHERE balance <> rebuilt`);
const unbalanced = await db.query(`
  SELECT count(*)::int AS n FROM (
    SELECT transaction_id FROM ledger_entries GROUP BY transaction_id
    HAVING SUM(CASE WHEN direction = 'DEBIT' THEN amount ELSE -amount END) <> 0) j`);
const negative = await db.query("SELECT count(*)::int AS n FROM wallets WHERE balance < 0");
check("wallet.balance == balance rebuilt from the ledger (all wallets)", drift.rows[0].n === 0);
check("every journal is balanced (double entry)", unbalanced.rows[0].n === 0);
check("no negative balance", negative.rows[0].n === 0);

await db.end();
sqs.destroy();

// ---- report -----------------------------------------------------------------------------------------------------

let current = "";
for (const r of results) {
  if (r.section !== current) {
    current = r.section;
    console.log(`\n${current}`);
  }
  console.log(`  ${r.ok ? "PASS" : "FAIL"}  ${r.name}${!r.ok && r.detail ? `  (${r.detail})` : ""}`);
}
const failed = results.filter((r) => !r.ok).length;
console.log(
  `\n${results.length - failed}/${results.length} checks passed${AUTH ? "" : " (auth checks skipped)"}`,
);
process.exit(failed ? 1 : 0);
