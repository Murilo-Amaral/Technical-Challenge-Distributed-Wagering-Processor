import type { EntityManager } from "typeorm";
import { ConcurrencyConflictError, UniqueViolationError } from "../../application/errors";
import type {
  InboxReceipt,
  InboxRepository,
  LedgerPage,
  LedgerRepository,
  LedgerTotals,
  OutboxRepository,
  OutboxStats,
  PendingReferenceCandidate,
  TransactionContext,
  WagerTransactionRepository,
  WalletRepository,
} from "../../application/ports";
import type { InboxMessage } from "../../domain/inbox-message";
import type { LedgerJournal } from "../../domain/ledger";
import { Money } from "../../domain/money";
import type { OutboxMessage } from "../../domain/outbox-message";
import {
  REVERSAL_KINDS,
  type WagerTransaction,
  WagerTransactionStatus,
} from "../../domain/wager-transaction";
import type { Wallet } from "../../domain/wallet";
import { decodeLedgerCursor, encodeLedgerCursor } from "./ledger-cursor";
import {
  inboxToDomain,
  outboxToDomain,
  transactionToDomain,
  transactionToRecord,
  walletEntryToDomain,
  walletToDomain,
  walletToRecord,
} from "./mappers";
import { isUniqueViolation, violatedConstraint } from "./pg-errors";
import {
  InboxMessageSchema,
  LedgerEntrySchema,
  LedgerJournalSchema,
  type OutboxMessageRecord,
  OutboxMessageSchema,
  WagerTransactionSchema,
  WalletSchema,
} from "./schemas";

async function translateUnique<T>(op: () => Promise<T>): Promise<T> {
  try {
    return await op();
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new UniqueViolationError(violatedConstraint(error));
    }
    throw error;
  }
}

export class TypeOrmWalletRepository implements WalletRepository {
  constructor(private readonly m: EntityManager) {}

  async insert(wallet: Wallet): Promise<void> {
    await translateUnique(() => this.m.insert(WalletSchema, walletToRecord(wallet)));
  }

  async findById(id: string): Promise<Wallet | undefined> {
    const r = await this.m.findOneBy(WalletSchema, { id });
    return r ? walletToDomain(r) : undefined;
  }

  async lockById(id: string): Promise<Wallet | undefined> {
    const r = await this.m
      .createQueryBuilder(WalletSchema, "w")
      .setLock("pessimistic_write")
      .where("w.id = :id", { id })
      .getOne();
    return r ? walletToDomain(r) : undefined;
  }

  async saveBalance(wallet: Wallet, expectedVersion: number): Promise<void> {
    const result = await this.m
      .createQueryBuilder()
      .update(WalletSchema)
      .set({ balance: wallet.balance.amount, version: wallet.version, updatedAt: wallet.updatedAt })
      .where("id = :id AND version = :expectedVersion", { id: wallet.id, expectedVersion })
      .execute();
    if (result.affected !== 1) {
      throw new ConcurrencyConflictError(
        `Wallet ${wallet.id} changed concurrently (expected v${expectedVersion})`,
      );
    }
  }
}

export class TypeOrmWagerTransactionRepository implements WagerTransactionRepository {
  constructor(private readonly m: EntityManager) {}

  async insert(tx: WagerTransaction): Promise<void> {
    await translateUnique(() => this.m.insert(WagerTransactionSchema, transactionToRecord(tx)));
  }

  async update(tx: WagerTransaction): Promise<void> {
    const r = transactionToRecord(tx);
    await translateUnique(() =>
      this.m.update(
        WagerTransactionSchema,
        { id: tx.id },
        {
          status: r.status,
          referenceTransactionId: r.referenceTransactionId,
          failureCode: r.failureCode,
          resultBalanceAmount: r.resultBalanceAmount,
          resultBalanceCurrency: r.resultBalanceCurrency,
          referenceAttempts: r.referenceAttempts,
          nextReferenceAttemptAt: r.nextReferenceAttemptAt,
          processedAt: r.processedAt,
          updatedAt: r.updatedAt,
        },
      ),
    );
  }

  async findById(id: string): Promise<WagerTransaction | undefined> {
    const r = await this.m.findOneBy(WagerTransactionSchema, { id });
    return r ? transactionToDomain(r) : undefined;
  }

  async lockById(id: string): Promise<WagerTransaction | undefined> {
    const r = await this.m
      .createQueryBuilder(WagerTransactionSchema, "t")
      .setLock("pessimistic_write")
      .where("t.id = :id", { id })
      .getOne();
    return r ? transactionToDomain(r) : undefined;
  }

  async findByIdempotencyKey(idempotencyKey: string): Promise<WagerTransaction | undefined> {
    const r = await this.m.findOneBy(WagerTransactionSchema, { idempotencyKey });
    return r ? transactionToDomain(r) : undefined;
  }

  async findByProviderExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | undefined> {
    const r = await this.m.findOneBy(WagerTransactionSchema, { providerId, externalTransactionId });
    return r ? transactionToDomain(r) : undefined;
  }

  async hasProcessedReversal(referenceTransactionId: string): Promise<boolean> {
    const count = await this.m
      .createQueryBuilder(WagerTransactionSchema, "t")
      .where("t.reference_transaction_id = :referenceTransactionId", { referenceTransactionId })
      .andWhere("t.kind IN (:...kinds)", { kinds: REVERSAL_KINDS })
      .andWhere("t.status = :status", { status: WagerTransactionStatus.Processed })
      .getCount();
    return count > 0;
  }

  async findPendingDependents(
    walletId: string,
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction[]> {
    const rows = await this.m
      .createQueryBuilder(WagerTransactionSchema, "t")
      .setLock("pessimistic_write")
      .where("t.status = :status", { status: WagerTransactionStatus.PendingReference })
      .andWhere("t.provider_id = :providerId", { providerId })
      .andWhere("t.reference_external_transaction_id = :externalTransactionId", { externalTransactionId })
      .andWhere("t.wallet_id = :walletId", { walletId })
      .orderBy("t.created_at", "ASC")
      .getMany();
    return rows.map(transactionToDomain);
  }

  async findDuePendingReferences(now: Date, limit: number): Promise<PendingReferenceCandidate[]> {
    const rows = await this.m
      .createQueryBuilder(WagerTransactionSchema, "t")
      .select(["t.id", "t.walletId"])
      .where("t.status = :status", { status: WagerTransactionStatus.PendingReference })
      .andWhere("t.next_reference_attempt_at <= :now", { now })
      .orderBy("t.next_reference_attempt_at", "ASC")
      .limit(limit)
      .getMany();
    return rows.map((r) => ({ id: r.id, walletId: r.walletId }));
  }
}

export class TypeOrmLedgerRepository implements LedgerRepository {
  constructor(private readonly m: EntityManager) {}

  async append(journal: LedgerJournal): Promise<void> {
    const { walletEntry: w, systemEntry: s } = journal;
    await this.m.insert(LedgerJournalSchema, {
      transactionId: journal.transactionId,
      currency: w.money.currency,
      createdAt: w.createdAt,
    });
    await this.m.insert(LedgerEntrySchema, [
      {
        id: w.id,
        transactionId: w.transactionId,
        account: "WALLET",
        walletId: w.walletId,
        direction: w.direction,
        amount: w.money.amount,
        currency: w.money.currency,
        balanceBefore: w.balanceBefore.amount,
        balanceAfter: w.balanceAfter.amount,
        walletVersion: w.walletVersion,
        createdAt: w.createdAt,
      },
      {
        id: s.id,
        transactionId: s.transactionId,
        account: s.account,
        walletId: null,
        direction: s.direction,
        amount: s.money.amount,
        currency: s.money.currency,
        balanceBefore: null,
        balanceAfter: null,
        walletVersion: null,
        createdAt: s.createdAt,
      },
    ]);
  }

  async listWalletEntries(walletId: string, cursor: string | undefined, limit: number): Promise<LedgerPage> {
    const qb = this.m
      .createQueryBuilder(LedgerEntrySchema, "e")
      .where("e.wallet_id = :walletId", { walletId })
      .andWhere("e.account = 'WALLET'")
      .orderBy("e.sequence", "DESC")
      .limit(limit + 1);
    const before = cursor ? decodeLedgerCursor(cursor) : undefined;
    if (before !== undefined) {
      qb.andWhere("e.sequence < :before", { before });
    }
    const rows = await qb.getMany();
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      entries: page.map(walletEntryToDomain),
      nextCursor: rows.length > limit && last?.sequence ? encodeLedgerCursor(last.sequence) : undefined,
    };
  }

  async walletTotals(walletId: string, currency: string): Promise<LedgerTotals> {
    // SUM over NUMERIC is exact in PostgreSQL; the result is read as a string and parsed into Money.
    const row = await this.m
      .createQueryBuilder(LedgerEntrySchema, "e")
      .select(
        "COALESCE(SUM(CASE WHEN e.direction = 'CREDIT' THEN e.amount ELSE -e.amount END), 0)::numeric(20,2)",
        "net",
      )
      .addSelect("COUNT(*)::int", "entries")
      .where("e.wallet_id = :walletId", { walletId })
      .andWhere("e.account = 'WALLET'")
      .getRawOne<{ net: string; entries: number }>();
    return {
      calculatedBalance: Money.fromStored(row?.net ?? "0.00", currency),
      entries: row?.entries ?? 0,
    };
  }
}

export class TypeOrmInboxRepository implements InboxRepository {
  constructor(private readonly m: EntityManager) {}

  async receive(message: InboxMessage): Promise<InboxReceipt> {
    const result = await this.m
      .createQueryBuilder()
      .insert()
      .into(InboxMessageSchema)
      .values({
        consumerName: message.consumerName,
        messageId: message.messageId,
        payloadHash: message.payloadHash,
        receivedAt: message.receivedAt,
        processedAt: null,
      })
      .orIgnore()
      .returning(["messageId"])
      .execute();
    if ((result.raw as unknown[]).length > 0) {
      return { duplicate: false };
    }
    const existing = await this.m.findOneByOrFail(InboxMessageSchema, {
      consumerName: message.consumerName,
      messageId: message.messageId,
    });
    return { duplicate: true, existing: inboxToDomain(existing) };
  }

  async markProcessed(message: InboxMessage): Promise<void> {
    await this.m.update(
      InboxMessageSchema,
      { consumerName: message.consumerName, messageId: message.messageId },
      { processedAt: message.processedAt ?? null },
    );
  }
}

export class TypeOrmOutboxRepository implements OutboxRepository {
  constructor(private readonly m: EntityManager) {}

  async enqueue(messages: OutboxMessage[]): Promise<void> {
    if (messages.length === 0) return;
    await this.m.insert(
      OutboxMessageSchema,
      messages.map((o) => ({
        id: o.id,
        aggregateId: o.aggregateId,
        partitionKey: o.partitionKey,
        eventType: o.eventType,
        // jsonb column: TypeORM's deep-partial typing does not model arbitrary JSON objects.
        payload: o.payload as never,
        occurredAt: o.occurredAt,
        attempts: o.attempts,
        nextAttemptAt: o.nextAttemptAt ?? o.occurredAt,
        publishedAt: null,
        lockedUntil: null,
        lockedBy: null,
        lastError: null,
      })),
    );
  }

  async claimDue(now: Date, limit: number, leaseMs: number, owner: string): Promise<OutboxMessage[]> {
    const result: unknown = await this.m.query(
      `UPDATE outbox_messages o
          SET locked_until = $1::timestamptz + make_interval(secs => $3::double precision / 1000),
              locked_by = $4
        WHERE o.id IN (
              SELECT id FROM outbox_messages
               WHERE published_at IS NULL
                 AND next_attempt_at <= $1
                 AND (locked_until IS NULL OR locked_until < $1)
               ORDER BY next_attempt_at, occurred_at
               LIMIT $2
               FOR UPDATE SKIP LOCKED)
      RETURNING o.*`,
      [now, limit, leaseMs, owner],
    );
    // For UPDATE ... RETURNING the TypeORM postgres driver returns [rows, affectedCount].
    const rows = (Array.isArray(result) && Array.isArray(result[0]) ? result[0] : result) as Array<
      Record<string, unknown>
    >;
    return rows
      .map(
        (r): OutboxMessageRecord => ({
          id: r.id as string,
          aggregateId: r.aggregate_id as string,
          partitionKey: r.partition_key as string,
          eventType: r.event_type as string,
          payload: r.payload as Record<string, unknown>,
          occurredAt: r.occurred_at as Date,
          attempts: r.attempts as number,
          nextAttemptAt: r.next_attempt_at as Date,
          publishedAt: (r.published_at as Date | null) ?? null,
          lockedUntil: (r.locked_until as Date | null) ?? null,
          lockedBy: (r.locked_by as string | null) ?? null,
          lastError: (r.last_error as string | null) ?? null,
        }),
      )
      .sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime())
      .map(outboxToDomain);
  }

  async markPublished(message: OutboxMessage): Promise<void> {
    await this.m.query(
      `UPDATE outbox_messages
          SET published_at = $2, attempts = $3, locked_until = NULL, locked_by = NULL
        WHERE id = $1 AND published_at IS NULL`,
      [message.id, message.publishedAt, message.attempts],
    );
  }

  async saveRetry(message: OutboxMessage): Promise<void> {
    await this.m.query(
      `UPDATE outbox_messages
          SET attempts = $2, next_attempt_at = $3, last_error = $4, locked_until = NULL, locked_by = NULL
        WHERE id = $1 AND published_at IS NULL`,
      [message.id, message.attempts, message.nextAttemptAt, message.lastError ?? null],
    );
  }

  async stats(): Promise<OutboxStats> {
    const [row] = await this.m.query(
      `SELECT count(*)::int AS pending,
              COALESCE(EXTRACT(EPOCH FROM (now() - min(occurred_at))), 0)::float8 AS age
         FROM outbox_messages WHERE published_at IS NULL`,
    );
    return { pending: row?.pending ?? 0, oldestPendingAgeSeconds: Math.max(0, row?.age ?? 0) };
  }
}

export const transactionContext = (m: EntityManager): TransactionContext => ({
  wallets: new TypeOrmWalletRepository(m),
  transactions: new TypeOrmWagerTransactionRepository(m),
  ledger: new TypeOrmLedgerRepository(m),
  inbox: new TypeOrmInboxRepository(m),
  outbox: new TypeOrmOutboxRepository(m),
});
