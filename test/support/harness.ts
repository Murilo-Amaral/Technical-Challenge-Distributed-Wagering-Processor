import type { DataSource } from "typeorm";
import { CreateWallet } from "../../src/wagering/application/create-wallet";
import type { AppLogger } from "../../src/wagering/application/logger";
import { silentLogger } from "../../src/wagering/application/logger";
import { type Metrics, noopMetrics } from "../../src/wagering/application/metrics";
import type { Clock, UnitOfWork } from "../../src/wagering/application/ports";
import { ProcessPendingReferences } from "../../src/wagering/application/process-pending-references";
import { WageringQueries } from "../../src/wagering/application/queries";
import { ReconcileWallet } from "../../src/wagering/application/reconcile-wallet";
import { SubmitWagerTransaction } from "../../src/wagering/application/submit-wager-transaction";
import { WagerProcessor } from "../../src/wagering/application/wager-processor";
import { parseCreateWalletCommand, parseWagerCommand } from "../../src/wagering/application/wager-request";
import { ExponentialBackoff } from "../../src/wagering/domain/retry-policy";
import { TypeOrmUnitOfWork } from "../../src/wagering/infrastructure/persistence/typeorm-unit-of-work";
import { UuidV7Generator } from "../../src/wagering/infrastructure/system";

/** A controllable clock so backoff/TTL behaviour is deterministic in tests. */
export class TestClock implements Clock {
  private offsetMs = 0;
  now(): Date {
    return new Date(Date.now() + this.offsetMs);
  }
  advance(ms: number): void {
    this.offsetMs += ms;
  }
}

export interface HarnessOptions {
  uow?: UnitOfWork;
  metrics?: Metrics;
  logger?: AppLogger;
  referenceMaxAttempts?: number;
}

export function buildHarness(ds: DataSource, options: HarnessOptions = {}) {
  const metrics = options.metrics ?? noopMetrics;
  const logger = options.logger ?? silentLogger;
  const clock = new TestClock();
  const ids = new UuidV7Generator();
  const uow =
    options.uow ??
    new TypeOrmUnitOfWork(ds, { lockTimeoutMs: 10_000, statementTimeoutMs: 30_000, maxRetries: 5 }, metrics);
  const referencePolicy = ExponentialBackoff.of({
    baseDelayMs: 1000,
    maxDelayMs: 10_000,
    maxAttempts: options.referenceMaxAttempts ?? 3,
  });
  const processor = new WagerProcessor(ids, referencePolicy, metrics, logger);
  return {
    ds,
    clock,
    uow,
    submit: new SubmitWagerTransaction(uow, processor, clock, ids, metrics, logger),
    createWallet: new CreateWallet(uow, clock, ids, logger),
    pending: new ProcessPendingReferences(uow, processor, clock, metrics, logger, 100),
    reconcile: new ReconcileWallet(uow, metrics, logger),
    queries: new WageringQueries(uow),
  };
}

export type Harness = ReturnType<typeof buildHarness>;

export async function openWallet(h: Harness, amount = "100.00", currency = "BRL") {
  return h.createWallet.execute(
    parseCreateWalletCommand({ playerId: crypto.randomUUID(), initialBalance: { amount, currency } }),
    "test",
  );
}

export interface WagerInput {
  walletId: string;
  playerId: string;
  kind?: string;
  amount?: string;
  currency?: string;
  externalTransactionId?: string;
  reference?: string;
  roundId?: string;
  providerId?: string;
  idempotencyKey?: string;
}

export function wagerBody(input: WagerInput) {
  const providerId = input.providerId ?? "provider-a";
  const externalTransactionId = input.externalTransactionId ?? `ext-${crypto.randomUUID()}`;
  return {
    body: {
      providerId,
      externalTransactionId,
      playerId: input.playerId,
      walletId: input.walletId,
      roundId: input.roundId ?? "round-1",
      gameId: "fortune-chimp",
      kind: input.kind ?? "BET",
      money: { amount: input.amount ?? "10.00", currency: input.currency ?? "BRL" },
      ...(input.reference ? { referenceExternalTransactionId: input.reference } : {}),
    },
    idempotencyKey: input.idempotencyKey ?? `${providerId}:${externalTransactionId}`,
  };
}

export async function submit(h: Harness, input: WagerInput, source: "http" | "sqs" = "http") {
  const { body, idempotencyKey } = wagerBody(input);
  return h.submit.execute(parseWagerCommand(body, idempotencyKey), { source, correlationId: "test" });
}

/** The final invariant of every test: materialized balance == balance rebuilt from the ledger, for every wallet. */
export async function assertLedgerInvariant(ds: DataSource): Promise<number> {
  const rows: Array<{
    id: string;
    balance: string;
    rebuilt: string;
    version: number;
    last_version: number | null;
  }> = await ds.query(`
      SELECT w.id, w.balance::text AS balance, w.version,
             COALESCE(SUM(CASE WHEN e.direction = 'CREDIT' THEN e.amount ELSE -e.amount END), 0)::numeric(20,2)::text AS rebuilt,
             MAX(e.wallet_version) AS last_version
        FROM wallets w
        LEFT JOIN ledger_entries e ON e.wallet_id = w.id AND e.account = 'WALLET'
       GROUP BY w.id`);
  const broken = rows.filter(
    (r) => r.balance !== r.rebuilt || (r.last_version !== null && r.last_version !== r.version),
  );
  if (broken.length > 0) {
    throw new Error(`Ledger invariant violated: ${JSON.stringify(broken.slice(0, 5))}`);
  }
  const [unbalanced] = await ds.query(`
    SELECT count(*)::int AS n FROM (
      SELECT transaction_id FROM ledger_entries GROUP BY transaction_id
      HAVING SUM(CASE WHEN direction = 'DEBIT' THEN amount ELSE -amount END) <> 0) j`);
  if (unbalanced.n !== 0) throw new Error(`${unbalanced.n} unbalanced journals`);
  return rows.length;
}
