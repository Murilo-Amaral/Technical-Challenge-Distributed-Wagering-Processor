/**
 * Migration CLI: bun run scripts/migrate.ts <up|down|status> [--all]
 * Uses DATABASE_URL. `down` reverts the last migration (or every migration with --all).
 */
import "reflect-metadata";
import { createDataSource } from "../src/wagering/infrastructure/persistence/data-source";

const command = process.argv[2] ?? "up";
const url = process.env.DATABASE_URL ?? "postgres://wagering:wagering@localhost:5432/wagering";
const ds = await createDataSource({ url, poolSize: 2, applicationName: "wagering-migrate" }).initialize();

try {
  if (command === "up") {
    const applied = await ds.runMigrations({ transaction: "each" });
    console.log(
      applied.length ? `Applied: ${applied.map((m) => m.name).join(", ")}` : "Schema is up to date",
    );
  } else if (command === "down") {
    const all = process.argv.includes("--all");
    do {
      await ds.undoLastMigration({ transaction: "each" });
    } while (all && (await ds.query("SELECT count(*)::int AS n FROM schema_migrations"))[0].n > 0);
    console.log(all ? "Reverted all migrations" : "Reverted last migration");
  } else if (command === "status") {
    const pending = await ds.showMigrations();
    console.log(pending ? "There are pending migrations" : "Schema is up to date");
  } else {
    throw new Error(`Unknown command ${command}`);
  }
} finally {
  await ds.destroy();
}
