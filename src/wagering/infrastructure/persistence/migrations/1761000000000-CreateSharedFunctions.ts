import type { MigrationInterface, QueryRunner } from "typeorm";

export class CreateSharedFunctions1761000000000 implements MigrationInterface {
  name = "CreateSharedFunctions1761000000000";

  async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE FUNCTION forbid_truncate() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'TRUNCATE is not allowed on %', TG_TABLE_NAME USING ERRCODE = 'integrity_constraint_violation';
      END $$`);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query("DROP FUNCTION forbid_truncate()");
  }
}
