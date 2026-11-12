import type { MigrationInterface, QueryRunner } from "typeorm";

export class CreateInboxOutbox1761000000004 implements MigrationInterface {
  name = "CreateInboxOutbox1761000000004";

  async up(q: QueryRunner): Promise<void> {
    // Inbox: persistent de-duplication per (consumer, messageId), written in the same SQL transaction as the effect.
    await q.query(`
      CREATE TABLE inbox_messages (
        consumer_name  varchar(64)   NOT NULL,
        message_id     varchar(256)  NOT NULL,
        payload_hash   char(64)      NOT NULL,
        received_at    timestamptz   NOT NULL,
        processed_at   timestamptz,
        CONSTRAINT pk_inbox_messages PRIMARY KEY (consumer_name, message_id)
      )`);

    // Outbox: integration events committed atomically with the change, published later by a worker.
    // locked_until/locked_by implement a lease so several publishers can work concurrently (SKIP LOCKED) and a
    // crashed publisher's batch is taken over after the lease expires.
    await q.query(`
      CREATE TABLE outbox_messages (
        id               uuid          PRIMARY KEY,
        aggregate_id     uuid          NOT NULL,
        partition_key    varchar(128)  NOT NULL,
        event_type       varchar(64)   NOT NULL,
        payload          jsonb         NOT NULL,
        occurred_at      timestamptz   NOT NULL,
        attempts         integer       NOT NULL DEFAULT 0,
        next_attempt_at  timestamptz   NOT NULL,
        published_at     timestamptz,
        locked_until     timestamptz,
        locked_by        varchar(128),
        last_error       text,
        CONSTRAINT ck_outbox_attempts CHECK (attempts >= 0)
      )`);
    await q.query(`CREATE INDEX ix_outbox_due ON outbox_messages (next_attempt_at, occurred_at)
                   WHERE published_at IS NULL`);

    await q.query(`
      CREATE FUNCTION outbox_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF (NEW.id, NEW.aggregate_id, NEW.partition_key, NEW.event_type, NEW.payload, NEW.occurred_at)
           IS DISTINCT FROM
           (OLD.id, OLD.aggregate_id, OLD.partition_key, OLD.event_type, OLD.payload, OLD.occurred_at) THEN
          RAISE EXCEPTION 'outbox event % is immutable', OLD.id USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        IF OLD.published_at IS NOT NULL AND NEW.published_at IS DISTINCT FROM OLD.published_at THEN
          RAISE EXCEPTION 'outbox event % was already published', OLD.id USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        RETURN NEW;
      END $$`);
    await q.query(`CREATE TRIGGER trg_outbox_guard BEFORE UPDATE ON outbox_messages
                   FOR EACH ROW EXECUTE FUNCTION outbox_guard()`);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query("DROP TABLE outbox_messages");
    await q.query("DROP FUNCTION outbox_guard()");
    await q.query("DROP TABLE inbox_messages");
  }
}
