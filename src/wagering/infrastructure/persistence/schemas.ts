import { EntitySchema } from "typeorm";

/**
 * Persistence records. They are deliberately separate from the domain classes (which have private constructors,
 * private state and no ORM knowledge); repositories map record <-> aggregate. NUMERIC columns are read as strings
 * and rehydrated as Money, so money never passes through a JS number.
 */
export interface WalletRecord {
  id: string;
  playerId: string;
  currency: string;
  balance: string;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export const WalletSchema = new EntitySchema<WalletRecord>({
  name: "WalletRecord",
  tableName: "wallets",
  columns: {
    id: { type: "uuid", primary: true },
    playerId: { name: "player_id", type: "varchar" },
    currency: { type: "char", length: 3 },
    balance: { type: "numeric", precision: 20, scale: 2 },
    version: { type: "integer" },
    createdAt: { name: "created_at", type: "timestamptz" },
    updatedAt: { name: "updated_at", type: "timestamptz" },
  },
});

export interface WagerTransactionRecord {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: string;
  amount: string;
  currency: string;
  referenceExternalTransactionId: string | null;
  referenceTransactionId: string | null;
  status: string;
  failureCode: string | null;
  resultBalanceAmount: string | null;
  resultBalanceCurrency: string | null;
  referenceAttempts: number;
  nextReferenceAttemptAt: Date | null;
  processedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export const WagerTransactionSchema = new EntitySchema<WagerTransactionRecord>({
  name: "WagerTransactionRecord",
  tableName: "wager_transactions",
  columns: {
    id: { type: "uuid", primary: true },
    providerId: { name: "provider_id", type: "varchar" },
    externalTransactionId: { name: "external_transaction_id", type: "varchar" },
    idempotencyKey: { name: "idempotency_key", type: "varchar" },
    payloadHash: { name: "payload_hash", type: "char", length: 64 },
    walletId: { name: "wallet_id", type: "uuid" },
    playerId: { name: "player_id", type: "varchar" },
    roundId: { name: "round_id", type: "varchar" },
    gameId: { name: "game_id", type: "varchar" },
    kind: { type: "varchar" },
    amount: { type: "numeric", precision: 20, scale: 2 },
    currency: { type: "char", length: 3 },
    referenceExternalTransactionId: {
      name: "reference_external_transaction_id",
      type: "varchar",
      nullable: true,
    },
    referenceTransactionId: { name: "reference_transaction_id", type: "uuid", nullable: true },
    status: { type: "varchar" },
    failureCode: { name: "failure_code", type: "varchar", nullable: true },
    resultBalanceAmount: {
      name: "result_balance_amount",
      type: "numeric",
      precision: 20,
      scale: 2,
      nullable: true,
    },
    resultBalanceCurrency: { name: "result_balance_currency", type: "char", length: 3, nullable: true },
    referenceAttempts: { name: "reference_attempts", type: "integer" },
    nextReferenceAttemptAt: { name: "next_reference_attempt_at", type: "timestamptz", nullable: true },
    processedAt: { name: "processed_at", type: "timestamptz", nullable: true },
    createdAt: { name: "created_at", type: "timestamptz" },
    updatedAt: { name: "updated_at", type: "timestamptz" },
  },
});

export interface LedgerJournalRecord {
  transactionId: string;
  currency: string;
  createdAt: Date;
}

export const LedgerJournalSchema = new EntitySchema<LedgerJournalRecord>({
  name: "LedgerJournalRecord",
  tableName: "ledger_journals",
  columns: {
    transactionId: { name: "transaction_id", type: "uuid", primary: true },
    currency: { type: "char", length: 3 },
    createdAt: { name: "created_at", type: "timestamptz" },
  },
});

export interface LedgerEntryRecord {
  id: string;
  /** bigint identity, read as string. Insert-only (GENERATED ALWAYS). */
  sequence?: string;
  transactionId: string;
  account: string;
  walletId: string | null;
  direction: string;
  amount: string;
  currency: string;
  balanceBefore: string | null;
  balanceAfter: string | null;
  walletVersion: number | null;
  createdAt: Date;
}

export const LedgerEntrySchema = new EntitySchema<LedgerEntryRecord>({
  name: "LedgerEntryRecord",
  tableName: "ledger_entries",
  columns: {
    id: { type: "uuid", primary: true },
    sequence: { type: "bigint", insert: false, update: false, nullable: true },
    transactionId: { name: "transaction_id", type: "uuid" },
    account: { type: "varchar" },
    walletId: { name: "wallet_id", type: "uuid", nullable: true },
    direction: { type: "varchar" },
    amount: { type: "numeric", precision: 20, scale: 2 },
    currency: { type: "char", length: 3 },
    balanceBefore: { name: "balance_before", type: "numeric", precision: 20, scale: 2, nullable: true },
    balanceAfter: { name: "balance_after", type: "numeric", precision: 20, scale: 2, nullable: true },
    walletVersion: { name: "wallet_version", type: "integer", nullable: true },
    createdAt: { name: "created_at", type: "timestamptz" },
  },
});

export interface InboxMessageRecord {
  consumerName: string;
  messageId: string;
  payloadHash: string;
  receivedAt: Date;
  processedAt: Date | null;
}

export const InboxMessageSchema = new EntitySchema<InboxMessageRecord>({
  name: "InboxMessageRecord",
  tableName: "inbox_messages",
  columns: {
    consumerName: { name: "consumer_name", type: "varchar", primary: true },
    messageId: { name: "message_id", type: "varchar", primary: true },
    payloadHash: { name: "payload_hash", type: "char", length: 64 },
    receivedAt: { name: "received_at", type: "timestamptz" },
    processedAt: { name: "processed_at", type: "timestamptz", nullable: true },
  },
});

export interface OutboxMessageRecord {
  id: string;
  aggregateId: string;
  partitionKey: string;
  eventType: string;
  payload: Record<string, unknown>;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt: Date;
  publishedAt: Date | null;
  lockedUntil: Date | null;
  lockedBy: string | null;
  lastError: string | null;
}

export const OutboxMessageSchema = new EntitySchema<OutboxMessageRecord>({
  name: "OutboxMessageRecord",
  tableName: "outbox_messages",
  columns: {
    id: { type: "uuid", primary: true },
    aggregateId: { name: "aggregate_id", type: "uuid" },
    partitionKey: { name: "partition_key", type: "varchar" },
    eventType: { name: "event_type", type: "varchar" },
    payload: { type: "jsonb" },
    occurredAt: { name: "occurred_at", type: "timestamptz" },
    attempts: { type: "integer" },
    nextAttemptAt: { name: "next_attempt_at", type: "timestamptz" },
    publishedAt: { name: "published_at", type: "timestamptz", nullable: true },
    lockedUntil: { name: "locked_until", type: "timestamptz", nullable: true },
    lockedBy: { name: "locked_by", type: "varchar", nullable: true },
    lastError: { name: "last_error", type: "text", nullable: true },
  },
});

export const entitySchemas = [
  WalletSchema,
  WagerTransactionSchema,
  LedgerJournalSchema,
  LedgerEntrySchema,
  InboxMessageSchema,
  OutboxMessageSchema,
];
