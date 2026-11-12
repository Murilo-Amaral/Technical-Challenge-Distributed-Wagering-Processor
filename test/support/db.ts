import "reflect-metadata";
import type { DataSource } from "typeorm";
import { createDataSource } from "../../src/wagering/infrastructure/persistence/data-source";

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://wagering:wagering@localhost:5432/wagering_test";

/** Drops and recreates the public schema, then applies every migration (the ledger forbids TRUNCATE by design). */
export async function resetDatabase(url = TEST_DATABASE_URL): Promise<void> {
  const ds = await createDataSource({ url, poolSize: 1, applicationName: "test-reset" }).initialize();
  try {
    await ds.query("DROP SCHEMA public CASCADE");
    await ds.query("CREATE SCHEMA public");
    await ds.runMigrations({ transaction: "each" });
  } finally {
    await ds.destroy();
  }
}

export async function openTestDataSource(poolSize = 20): Promise<DataSource> {
  return createDataSource({ url: TEST_DATABASE_URL, poolSize, applicationName: "test" }).initialize();
}

/** Asserts that `fn` fails with a PostgreSQL error whose message or constraint matches. */
export async function expectPgError(fn: () => Promise<unknown>, match: RegExp): Promise<void> {
  let failure: unknown;
  try {
    await fn();
  } catch (error) {
    failure = error;
  }
  if (!failure) throw new Error(`Expected a database error matching ${match}`);
  const e = failure as { message?: string; driverError?: { constraint?: string; message?: string } };
  const text = `${e.message ?? ""} ${e.driverError?.constraint ?? ""}`;
  if (!match.test(text)) throw new Error(`Expected error matching ${match}, got: ${text}`);
}
