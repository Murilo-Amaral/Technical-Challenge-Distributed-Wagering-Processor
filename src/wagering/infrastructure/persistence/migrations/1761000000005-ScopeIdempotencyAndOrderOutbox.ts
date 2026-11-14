import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * - Idempotency keys are scoped to the provider: UNIQUE(provider_id, idempotency_key) replaces the global unique, so a
 *   provider can neither pre-empt nor probe another provider's keys.
 * - Index supporting the per-partition ordering check of the outbox claim (oldest unpublished event per wallet first).
 */
export class ScopeIdempotencyAndOrderOutbox1761000000005 implements MigrationInterface {
  name = "ScopeIdempotencyAndOrderOutbox1761000000005";

  async up(q: QueryRunner): Promise<void> {
    await q.query("ALTER TABLE wager_transactions DROP CONSTRAINT uq_wager_idempotency_key");
    await q.query(`ALTER TABLE wager_transactions
                   ADD CONSTRAINT uq_wager_provider_idempotency_key UNIQUE (provider_id, idempotency_key)`);
    await q.query(`CREATE INDEX ix_outbox_partition_pending ON outbox_messages (partition_key, occurred_at, id)
                   WHERE published_at IS NULL`);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query("DROP INDEX ix_outbox_partition_pending");
    // Fails if two providers already used the same key: that data cannot be represented by the old global unique.
    await q.query("ALTER TABLE wager_transactions DROP CONSTRAINT uq_wager_provider_idempotency_key");
    await q.query(
      "ALTER TABLE wager_transactions ADD CONSTRAINT uq_wager_idempotency_key UNIQUE (idempotency_key)",
    );
  }
}
