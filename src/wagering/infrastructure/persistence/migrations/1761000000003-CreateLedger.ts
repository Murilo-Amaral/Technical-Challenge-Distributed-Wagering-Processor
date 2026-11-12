import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Double-entry, append-only ledger.
 *
 * ledger_journals: one journal per financial transaction.
 * ledger_entries:  the postings. Each journal has exactly one WALLET posting and one contra posting on a system
 *                  account (HOUSE / FUNDING), with opposite directions and equal amounts.
 *
 * Guarantees enforced here:
 * - append-only: UPDATE / DELETE / TRUNCATE raise;
 * - wallet postings: balance_after = balance_before ± amount, never negative, currency = wallet currency;
 * - one wallet posting per transaction, one posting per wallet version;
 * - chain: a wallet posting starts from the balance where the previous one ended;
 * - (deferred, at commit) every journal is balanced and the wallet's materialized balance/version equals its
 *   latest posting, so a balance change without ledger (or vice versa) cannot be committed.
 */
export class CreateLedger1761000000003 implements MigrationInterface {
  name = "CreateLedger1761000000003";

  async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE ledger_journals (
        transaction_id  uuid         PRIMARY KEY REFERENCES wager_transactions(id),
        currency        char(3)      NOT NULL,
        created_at      timestamptz  NOT NULL
      )`);

    await q.query(`
      CREATE TABLE ledger_entries (
        id              uuid           PRIMARY KEY,
        sequence        bigint         GENERATED ALWAYS AS IDENTITY,
        transaction_id  uuid           NOT NULL REFERENCES ledger_journals(transaction_id),
        account         varchar(16)    NOT NULL,
        wallet_id       uuid,
        direction       varchar(6)     NOT NULL,
        amount          numeric(20,2)  NOT NULL,
        currency        char(3)        NOT NULL,
        balance_before  numeric(20,2),
        balance_after   numeric(20,2),
        wallet_version  integer,
        created_at      timestamptz    NOT NULL,
        CONSTRAINT uq_ledger_sequence UNIQUE (sequence),
        CONSTRAINT ck_ledger_account CHECK (account IN ('WALLET','HOUSE','FUNDING')),
        CONSTRAINT ck_ledger_direction CHECK (direction IN ('DEBIT','CREDIT')),
        CONSTRAINT ck_ledger_amount_positive CHECK (amount > 0),
        CONSTRAINT ck_ledger_wallet_shape CHECK (
          (account = 'WALLET' AND wallet_id IS NOT NULL AND balance_before IS NOT NULL
             AND balance_after IS NOT NULL AND wallet_version IS NOT NULL)
          OR
          (account <> 'WALLET' AND wallet_id IS NULL AND balance_before IS NULL
             AND balance_after IS NULL AND wallet_version IS NULL)),
        CONSTRAINT ck_ledger_balances_non_negative CHECK (balance_before >= 0 AND balance_after >= 0),
        CONSTRAINT ck_ledger_arithmetic CHECK (
          account <> 'WALLET' OR
          balance_after = balance_before + CASE WHEN direction = 'CREDIT' THEN amount ELSE -amount END),
        CONSTRAINT fk_ledger_wallet_currency FOREIGN KEY (wallet_id, currency) REFERENCES wallets(id, currency),
        CONSTRAINT uq_ledger_one_posting_per_account UNIQUE (transaction_id, account),
        CONSTRAINT uq_ledger_wallet_version UNIQUE (wallet_id, wallet_version)
      )`);
    await q.query(`CREATE INDEX ix_ledger_wallet_sequence ON ledger_entries (wallet_id, sequence)
                   WHERE account = 'WALLET'`);

    // ---- append-only ------------------------------------------------------------------------------
    await q.query(`
      CREATE FUNCTION ledger_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION '% is append-only: % is not allowed', TG_TABLE_NAME, TG_OP
          USING ERRCODE = 'integrity_constraint_violation';
      END $$`);
    for (const table of ["ledger_journals", "ledger_entries"]) {
      await q.query(`CREATE TRIGGER trg_${table}_append_only BEFORE UPDATE OR DELETE ON ${table}
                     FOR EACH ROW EXECUTE FUNCTION ledger_append_only()`);
      await q.query(`CREATE TRIGGER trg_${table}_no_truncate BEFORE TRUNCATE ON ${table}
                     FOR EACH STATEMENT EXECUTE FUNCTION forbid_truncate()`);
    }

    // ---- chain: each wallet posting continues from the previous one -------------------------------
    await q.query(`
      CREATE FUNCTION ledger_entries_chain() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE prev RECORD;
      BEGIN
        IF NEW.account <> 'WALLET' THEN
          RETURN NEW;
        END IF;
        SELECT wallet_version, balance_after INTO prev
          FROM ledger_entries
         WHERE wallet_id = NEW.wallet_id AND account = 'WALLET'
         ORDER BY wallet_version DESC
         LIMIT 1;
        IF FOUND THEN
          IF NEW.wallet_version <= prev.wallet_version OR NEW.balance_before <> prev.balance_after THEN
            RAISE EXCEPTION 'ledger chain broken for wallet % (prev v% %, new v% before %)',
              NEW.wallet_id, prev.wallet_version, prev.balance_after, NEW.wallet_version, NEW.balance_before
              USING ERRCODE = 'integrity_constraint_violation';
          END IF;
        ELSIF NEW.balance_before <> 0 THEN
          RAISE EXCEPTION 'first ledger entry of wallet % must start from zero', NEW.wallet_id
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        RETURN NEW;
      END $$`);
    await q.query(`CREATE TRIGGER trg_ledger_entries_chain BEFORE INSERT ON ledger_entries
                   FOR EACH ROW EXECUTE FUNCTION ledger_entries_chain()`);

    // ---- deferred: journals are balanced ----------------------------------------------------------
    await q.query(`
      CREATE FUNCTION ledger_journal_balanced() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE s RECORD;
      BEGIN
        SELECT count(*) AS postings,
               count(*) FILTER (WHERE account = 'WALLET') AS wallet_postings,
               COALESCE(sum(amount) FILTER (WHERE direction = 'DEBIT'), 0) AS debits,
               COALESCE(sum(amount) FILTER (WHERE direction = 'CREDIT'), 0) AS credits,
               count(DISTINCT currency) AS currencies,
               bool_and(currency = NEW.currency) AS same_currency
          INTO s
          FROM ledger_entries WHERE transaction_id = NEW.transaction_id;
        IF s.postings <> 2 OR s.wallet_postings <> 1 OR s.debits <> s.credits OR NOT s.same_currency THEN
          RAISE EXCEPTION 'journal % is not balanced (postings %, debits %, credits %)',
            NEW.transaction_id, s.postings, s.debits, s.credits USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        RETURN NULL;
      END $$`);
    await q.query(`CREATE CONSTRAINT TRIGGER trg_ledger_journal_balanced AFTER INSERT ON ledger_journals
                   DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ledger_journal_balanced()`);

    // ---- deferred: materialized balance == latest ledger posting ----------------------------------
    await q.query(`
      CREATE FUNCTION wallet_matches_ledger() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE w RECORD; e RECORD; wid uuid;
      BEGIN
        -- NEW has different shapes per table, so the field must be read inside separate branches.
        IF TG_TABLE_NAME = 'wallets' THEN
          wid := NEW.id;
        ELSE
          wid := NEW.wallet_id;
        END IF;
        IF wid IS NULL THEN
          RETURN NULL;
        END IF;
        SELECT balance, version INTO w FROM wallets WHERE id = wid;
        SELECT balance_after, wallet_version INTO e
          FROM ledger_entries WHERE wallet_id = wid AND account = 'WALLET'
         ORDER BY wallet_version DESC LIMIT 1;
        IF FOUND THEN
          IF w.balance <> e.balance_after OR w.version <> e.wallet_version THEN
            RAISE EXCEPTION 'wallet % (balance %, v%) diverges from ledger (balance %, v%)',
              wid, w.balance, w.version, e.balance_after, e.wallet_version
              USING ERRCODE = 'integrity_constraint_violation';
          END IF;
        ELSIF w.balance <> 0 OR w.version <> 1 THEN
          RAISE EXCEPTION 'wallet % has balance % without ledger entries', wid, w.balance
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        RETURN NULL;
      END $$`);
    await q.query(`CREATE CONSTRAINT TRIGGER trg_wallets_match_ledger AFTER INSERT OR UPDATE ON wallets
                   DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION wallet_matches_ledger()`);
    await q.query(`CREATE CONSTRAINT TRIGGER trg_ledger_entries_match_wallet AFTER INSERT ON ledger_entries
                   DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION wallet_matches_ledger()`);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query("DROP TRIGGER trg_wallets_match_ledger ON wallets");
    await q.query("DROP TABLE ledger_entries");
    await q.query("DROP TABLE ledger_journals");
    await q.query("DROP FUNCTION wallet_matches_ledger()");
    await q.query("DROP FUNCTION ledger_journal_balanced()");
    await q.query("DROP FUNCTION ledger_entries_chain()");
    await q.query("DROP FUNCTION ledger_append_only()");
  }
}
