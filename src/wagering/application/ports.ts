import type { InboxMessage } from "../domain/inbox-message";
import type { LedgerJournal, WalletLedgerEntry } from "../domain/ledger";
import type { Money } from "../domain/money";
import type { OutboxMessage } from "../domain/outbox-message";
import type { WagerTransaction } from "../domain/wager-transaction";
import type { Wallet } from "../domain/wallet";

export interface WalletRepository {
  /** @throws UniqueViolationError(constraint "uq_wallets_player_currency") on duplicates. */
  insert(wallet: Wallet): Promise<void>;
  findById(id: string): Promise<Wallet | undefined>;
  /** SELECT ... FOR UPDATE on this wallet only: the per-wallet serialization point. */
  lockById(id: string): Promise<Wallet | undefined>;
  /**
   * Conditional write: UPDATE ... WHERE id = ? AND version = expectedVersion.
   * @throws ConcurrencyConflictError when no row matched (lost update prevented).
   */
  saveBalance(wallet: Wallet, expectedVersion: number): Promise<void>;
}

export interface PendingReferenceCandidate {
  id: string;
  walletId: string;
}

export interface WagerTransactionRepository {
  insert(tx: WagerTransaction): Promise<void>;
  /** Persists status-related columns (the DB trigger rejects any other change). */
  update(tx: WagerTransaction): Promise<void>;
  findById(id: string): Promise<WagerTransaction | undefined>;
  lockById(id: string): Promise<WagerTransaction | undefined>;
  findByIdempotencyKey(key: string): Promise<WagerTransaction | undefined>;
  findByProviderExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | undefined>;
  hasProcessedReversal(referenceTransactionId: string): Promise<boolean>;
  /** PENDING_REFERENCE transactions of one wallet that wait for (providerId, externalTransactionId). */
  findPendingDependents(
    walletId: string,
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction[]>;
  findDuePendingReferences(now: Date, limit: number): Promise<PendingReferenceCandidate[]>;
}

export interface LedgerPage {
  entries: WalletLedgerEntry[];
  nextCursor: string | undefined;
}

export interface LedgerTotals {
  /** Balance rebuilt from the ledger: Σ credits − Σ debits of the wallet postings. */
  calculatedBalance: Money;
  entries: number;
}

export interface LedgerRepository {
  append(journal: LedgerJournal): Promise<void>;
  listWalletEntries(walletId: string, cursor: string | undefined, limit: number): Promise<LedgerPage>;
  walletTotals(walletId: string, currency: string): Promise<LedgerTotals>;
}

export type InboxReceipt = { duplicate: false } | { duplicate: true; existing: InboxMessage };

export interface InboxRepository {
  /** INSERT ... ON CONFLICT DO NOTHING. Concurrent deliveries of the same message serialize on the PK. */
  receive(message: InboxMessage): Promise<InboxReceipt>;
  markProcessed(message: InboxMessage): Promise<void>;
}

export interface OutboxStats {
  pending: number;
  oldestPendingAgeSeconds: number;
}

export interface OutboxRepository {
  enqueue(messages: OutboxMessage[]): Promise<void>;
  /** Leases up to `limit` due messages (FOR UPDATE SKIP LOCKED); expired leases are taken over. */
  claimDue(now: Date, limit: number, leaseMs: number, owner: string): Promise<OutboxMessage[]>;
  markPublished(message: OutboxMessage): Promise<void>;
  saveRetry(message: OutboxMessage): Promise<void>;
  stats(): Promise<OutboxStats>;
}

/** Repositories bound to one SQL transaction. */
export interface TransactionContext {
  wallets: WalletRepository;
  transactions: WagerTransactionRepository;
  ledger: LedgerRepository;
  inbox: InboxRepository;
  outbox: OutboxRepository;
}

export interface UnitOfWorkOptions {
  /** Label used in logs/metrics. */
  name: string;
}

export interface UnitOfWork {
  /**
   * Runs `work` in one SQL transaction (READ COMMITTED + lock_timeout). Transient failures (deadlock, lock timeout,
   * serialization, connection loss) roll back and are retried a bounded number of times; when retries are exhausted a
   * TransientInfrastructureError is thrown.
   */
  run<T>(work: (ctx: TransactionContext) => Promise<T>, options: UnitOfWorkOptions): Promise<T>;
}

export interface Clock {
  now(): Date;
}

export interface IdGenerator {
  /** Time-ordered UUID (v7). */
  next(): string;
}

export const UNIT_OF_WORK = Symbol("UNIT_OF_WORK");
export const CLOCK = Symbol("CLOCK");
export const ID_GENERATOR = Symbol("ID_GENERATOR");
