import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Wager transactions: the idempotency record and audit trail of every accepted operation.
 *
 * - UNIQUE(idempotency_key) and UNIQUE(provider_id, external_transaction_id): persistent idempotency.
 * - Partial unique index: a transaction can be reversed (REFUND/ROLLBACK) by at most one PROCESSED reversal.
 * - Trigger mirroring the domain state machine: terminal rows are immutable, business columns never change.
 */
export class CreateWagerTransactions1761000000002 implements MigrationInterface {
  name = "CreateWagerTransactions1761000000002";

  async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE wager_transactions (
        id                                 uuid           PRIMARY KEY,
        provider_id                        varchar(64)    NOT NULL,
        external_transaction_id            varchar(128)   NOT NULL,
        idempotency_key                    varchar(256)   NOT NULL,
        payload_hash                       char(64)       NOT NULL,
        wallet_id                          uuid           NOT NULL REFERENCES wallets(id),
        player_id                          varchar(64)    NOT NULL,
        round_id                           varchar(128)   NOT NULL,
        game_id                            varchar(128)   NOT NULL,
        kind                               varchar(16)    NOT NULL,
        amount                             numeric(20,2)  NOT NULL,
        currency                           char(3)        NOT NULL,
        reference_external_transaction_id  varchar(128),
        reference_transaction_id           uuid           REFERENCES wager_transactions(id),
        status                             varchar(20)    NOT NULL,
        failure_code                       varchar(64),
        result_balance_amount              numeric(20,2),
        result_balance_currency            char(3),
        reference_attempts                 integer        NOT NULL DEFAULT 0,
        next_reference_attempt_at          timestamptz,
        processed_at                       timestamptz,
        created_at                         timestamptz    NOT NULL,
        updated_at                         timestamptz    NOT NULL,
        CONSTRAINT uq_wager_idempotency_key UNIQUE (idempotency_key),
        CONSTRAINT uq_wager_provider_external_id UNIQUE (provider_id, external_transaction_id),
        CONSTRAINT ck_wager_kind CHECK (kind IN ('OPENING','BET','WIN','LOSS','REFUND','ROLLBACK')),
        CONSTRAINT ck_wager_status CHECK (status IN ('PENDING','PENDING_REFERENCE','PROCESSED','REJECTED','FAILED')),
        CONSTRAINT ck_wager_currency CHECK (currency ~ '^[A-Z]{3}$'),
        CONSTRAINT ck_wager_amount CHECK (amount > 0 OR (kind = 'LOSS' AND amount = 0)),
        CONSTRAINT ck_wager_reference_required
          CHECK (kind NOT IN ('REFUND','ROLLBACK') OR reference_external_transaction_id IS NOT NULL),
        CONSTRAINT ck_wager_bet_without_reference CHECK (kind <> 'BET' OR reference_external_transaction_id IS NULL),
        CONSTRAINT ck_wager_opening_internal CHECK ((kind = 'OPENING') = (provider_id = 'internal')),
        CONSTRAINT ck_wager_processed_at CHECK ((status = 'PROCESSED') = (processed_at IS NOT NULL)),
        CONSTRAINT ck_wager_failure_code CHECK ((status IN ('REJECTED','FAILED')) = (failure_code IS NOT NULL)),
        CONSTRAINT ck_wager_pending_schedule
          CHECK ((status = 'PENDING_REFERENCE') = (next_reference_attempt_at IS NOT NULL)),
        CONSTRAINT ck_wager_reference_attempts CHECK (reference_attempts >= 0),
        CONSTRAINT ck_wager_result_balance CHECK (
          (result_balance_amount IS NULL) = (result_balance_currency IS NULL)
          AND (result_balance_amount IS NULL OR result_balance_amount >= 0))
      )`);

    // Reversal at most once, whatever the reversal kind (REFUND or ROLLBACK). See ARCHITECTURE.md.
    await q.query(`CREATE UNIQUE INDEX uq_wager_reversed_once ON wager_transactions (reference_transaction_id)
                   WHERE kind IN ('REFUND','ROLLBACK') AND status = 'PROCESSED'`);
    await q.query(`CREATE INDEX ix_wager_pending_due ON wager_transactions (next_reference_attempt_at)
                   WHERE status = 'PENDING_REFERENCE'`);
    await q.query(`CREATE INDEX ix_wager_pending_by_reference
                   ON wager_transactions (provider_id, reference_external_transaction_id)
                   WHERE status = 'PENDING_REFERENCE'`);
    await q.query("CREATE INDEX ix_wager_wallet_created ON wager_transactions (wallet_id, created_at)");
    await q.query("CREATE INDEX ix_wager_reference_tx ON wager_transactions (reference_transaction_id)");

    await q.query(`
      CREATE FUNCTION wager_transactions_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION 'wager transactions are never deleted (%)', OLD.id USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        IF OLD.status IN ('PROCESSED','REJECTED','FAILED') THEN
          RAISE EXCEPTION 'transaction % is terminal (%) and cannot change', OLD.id, OLD.status
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        IF NOT (
          (OLD.status = 'PENDING' AND NEW.status IN ('PROCESSED','PENDING_REFERENCE','REJECTED','FAILED')) OR
          (OLD.status = 'PENDING_REFERENCE' AND NEW.status IN ('PENDING_REFERENCE','PROCESSED','REJECTED','FAILED'))
        ) THEN
          RAISE EXCEPTION 'invalid transition % -> % for transaction %', OLD.status, NEW.status, OLD.id
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        IF (NEW.id, NEW.provider_id, NEW.external_transaction_id, NEW.idempotency_key, NEW.payload_hash,
            NEW.wallet_id, NEW.player_id, NEW.round_id, NEW.game_id, NEW.kind, NEW.amount, NEW.currency,
            NEW.reference_external_transaction_id, NEW.created_at)
           IS DISTINCT FROM
           (OLD.id, OLD.provider_id, OLD.external_transaction_id, OLD.idempotency_key, OLD.payload_hash,
            OLD.wallet_id, OLD.player_id, OLD.round_id, OLD.game_id, OLD.kind, OLD.amount, OLD.currency,
            OLD.reference_external_transaction_id, OLD.created_at) THEN
          RAISE EXCEPTION 'business columns of transaction % are immutable', OLD.id
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        IF NEW.reference_attempts < OLD.reference_attempts THEN
          RAISE EXCEPTION 'reference_attempts cannot decrease (%)', OLD.id USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        RETURN NEW;
      END $$`);
    await q.query(`CREATE TRIGGER trg_wager_transactions_guard BEFORE UPDATE OR DELETE ON wager_transactions
                   FOR EACH ROW EXECUTE FUNCTION wager_transactions_guard()`);
    await q.query(`CREATE TRIGGER trg_wager_transactions_no_truncate BEFORE TRUNCATE ON wager_transactions
                   FOR EACH STATEMENT EXECUTE FUNCTION forbid_truncate()`);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query("DROP TABLE wager_transactions");
    await q.query("DROP FUNCTION wager_transactions_guard()");
  }
}
