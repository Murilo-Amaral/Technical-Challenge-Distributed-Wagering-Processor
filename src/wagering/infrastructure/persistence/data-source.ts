import { DataSource } from "typeorm";
import { migrations } from "./migrations";
import { entitySchemas } from "./schemas";

export interface DataSourceOptions {
  url: string;
  poolSize: number;
  applicationName?: string;
  /**
   * Client-side timeout per query. statement_timeout runs on the server and cannot fire when the server is frozen or
   * unreachable with the TCP connection still open; this turns that case into a (transient) error.
   */
  queryTimeoutMs?: number;
}

export function createDataSource(opts: DataSourceOptions): DataSource {
  return new DataSource({
    type: "postgres",
    url: opts.url,
    entities: entitySchemas,
    migrations,
    migrationsTableName: "schema_migrations",
    migrationsTransactionMode: "each",
    synchronize: false,
    logging: false,
    extra: {
      max: opts.poolSize,
      application_name: opts.applicationName ?? "wagering",
      connectionTimeoutMillis: 5000,
      ...(opts.queryTimeoutMs ? { query_timeout: opts.queryTimeoutMs } : {}),
    },
  });
}
