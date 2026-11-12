import type { FailureCode } from "../../domain/failure-code";
import { InboxMessage } from "../../domain/inbox-message";
import { type LedgerDirection, WalletLedgerEntry } from "../../domain/ledger";
import { Money } from "../../domain/money";
import { OutboxMessage } from "../../domain/outbox-message";
import {
  WagerTransaction,
  type WagerTransactionKind,
  type WagerTransactionStatus,
} from "../../domain/wager-transaction";
import { Wallet } from "../../domain/wallet";
import type {
  InboxMessageRecord,
  LedgerEntryRecord,
  OutboxMessageRecord,
  WagerTransactionRecord,
  WalletRecord,
} from "./schemas";

const undef = <T>(v: T | null): T | undefined => (v === null ? undefined : v);

export const walletToDomain = (r: WalletRecord): Wallet =>
  Wallet.rehydrate({
    id: r.id,
    playerId: r.playerId,
    currency: r.currency,
    balance: Money.fromStored(r.balance, r.currency),
    version: r.version,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  });

export const walletToRecord = (w: Wallet): WalletRecord => ({
  id: w.id,
  playerId: w.playerId,
  currency: w.currency,
  balance: w.balance.amount,
  version: w.version,
  createdAt: w.createdAt,
  updatedAt: w.updatedAt,
});

export const transactionToDomain = (r: WagerTransactionRecord): WagerTransaction =>
  WagerTransaction.rehydrate({
    id: r.id,
    providerId: r.providerId,
    externalTransactionId: r.externalTransactionId,
    idempotencyKey: r.idempotencyKey,
    payloadHash: r.payloadHash,
    walletId: r.walletId,
    playerId: r.playerId,
    roundId: r.roundId,
    gameId: r.gameId,
    kind: r.kind as WagerTransactionKind,
    money: Money.fromStored(r.amount, r.currency),
    referenceExternalTransactionId: undef(r.referenceExternalTransactionId),
    createdAt: r.createdAt,
    status: r.status as WagerTransactionStatus,
    referenceTransactionId: undef(r.referenceTransactionId),
    failureCode: undef(r.failureCode) as FailureCode | undefined,
    processedAt: undef(r.processedAt),
    resultBalance:
      r.resultBalanceAmount !== null && r.resultBalanceCurrency !== null
        ? Money.fromStored(r.resultBalanceAmount, r.resultBalanceCurrency)
        : undefined,
    referenceAttempts: r.referenceAttempts,
    nextReferenceAttemptAt: undef(r.nextReferenceAttemptAt),
    updatedAt: r.updatedAt,
  });

export const transactionToRecord = (t: WagerTransaction): WagerTransactionRecord => ({
  id: t.id,
  providerId: t.providerId,
  externalTransactionId: t.externalTransactionId,
  idempotencyKey: t.idempotencyKey,
  payloadHash: t.payloadHash,
  walletId: t.walletId,
  playerId: t.playerId,
  roundId: t.roundId,
  gameId: t.gameId,
  kind: t.kind,
  amount: t.money.amount,
  currency: t.money.currency,
  referenceExternalTransactionId: t.referenceExternalTransactionId ?? null,
  referenceTransactionId: t.referenceTransactionId ?? null,
  status: t.status,
  failureCode: t.failureCode ?? null,
  resultBalanceAmount: t.resultBalance?.amount ?? null,
  resultBalanceCurrency: t.resultBalance?.currency ?? null,
  referenceAttempts: t.referenceAttempts,
  nextReferenceAttemptAt: t.nextReferenceAttemptAt ?? null,
  processedAt: t.processedAt ?? null,
  createdAt: t.createdAt,
  updatedAt: t.updatedAt,
});

export const walletEntryToDomain = (r: LedgerEntryRecord): WalletLedgerEntry =>
  WalletLedgerEntry.rehydrate({
    id: r.id,
    walletId: r.walletId!,
    transactionId: r.transactionId,
    direction: r.direction as LedgerDirection,
    money: Money.fromStored(r.amount, r.currency),
    balanceBefore: Money.fromStored(r.balanceBefore!, r.currency),
    balanceAfter: Money.fromStored(r.balanceAfter!, r.currency),
    walletVersion: r.walletVersion!,
    createdAt: r.createdAt,
  });

export const inboxToDomain = (r: InboxMessageRecord): InboxMessage =>
  InboxMessage.rehydrate({
    messageId: r.messageId,
    consumerName: r.consumerName,
    payloadHash: r.payloadHash,
    receivedAt: r.receivedAt,
    processedAt: undef(r.processedAt),
  });

export const outboxToDomain = (r: OutboxMessageRecord): OutboxMessage =>
  OutboxMessage.rehydrate({
    id: r.id,
    aggregateId: r.aggregateId,
    partitionKey: r.partitionKey,
    eventType: r.eventType,
    payload: r.payload,
    occurredAt: r.occurredAt,
    attempts: r.attempts,
    nextAttemptAt: r.nextAttemptAt,
    publishedAt: undef(r.publishedAt),
    lastError: undef(r.lastError),
  });
