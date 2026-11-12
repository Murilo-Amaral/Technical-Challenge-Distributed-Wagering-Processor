import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Wallets: one row per (player, currency), materialized balance that can never be negative.
 * The version rule (bump only when the balance changes) and immutable columns are enforced by a trigger.
 */
export class CreateWallets1761000000001 implements MigrationInterface {
  name = "CreateWallets1761000000001";

  async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE wallets (
        id          uuid           PRIMARY KEY,
        player_id   varchar(64)    NOT NULL,
        currency    char(3)        NOT NULL,
        balance     numeric(20,2)  NOT NULL,
        version     integer        NOT NULL,
        created_at  timestamptz    NOT NULL,
        updated_at  timestamptz    NOT NULL,
        CONSTRAINT ck_wallets_currency CHECK (currency ~ '^[A-Z]{3}$'),
        CONSTRAINT ck_wallets_balance_non_negative CHECK (balance >= 0),
        CONSTRAINT ck_wallets_version_positive CHECK (version >= 1),
        CONSTRAINT uq_wallets_player_currency UNIQUE (player_id, currency),
        -- target of composite FKs that force ledger entries to use the wallet currency
        CONSTRAINT uq_wallets_id_currency UNIQUE (id, currency)
      )`);

    await q.query(`
      CREATE FUNCTION wallets_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION 'wallets are never deleted (wallet %)', OLD.id USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        IF NEW.id <> OLD.id OR NEW.player_id <> OLD.player_id OR NEW.currency <> OLD.currency
           OR NEW.created_at <> OLD.created_at THEN
          RAISE EXCEPTION 'immutable wallet columns changed (wallet %)', OLD.id USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        IF NEW.balance <> OLD.balance AND NEW.version <> OLD.version + 1 THEN
          RAISE EXCEPTION 'balance change must increment version by exactly 1 (wallet %)', OLD.id
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        IF NEW.balance = OLD.balance AND NEW.version <> OLD.version THEN
          RAISE EXCEPTION 'version may only change together with the balance (wallet %)', OLD.id
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
      END $$`);
    await q.query(`CREATE TRIGGER trg_wallets_guard BEFORE UPDATE OR DELETE ON wallets
                   FOR EACH ROW EXECUTE FUNCTION wallets_guard()`);
    await q.query(`CREATE TRIGGER trg_wallets_no_truncate BEFORE TRUNCATE ON wallets
                   FOR EACH STATEMENT EXECUTE FUNCTION forbid_truncate()`);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query("DROP TABLE wallets");
    await q.query("DROP FUNCTION wallets_guard()");
  }
}
