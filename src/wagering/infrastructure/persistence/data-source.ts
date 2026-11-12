import { DataSource } from "typeorm";
import { migrations } from "./migrations";
import { entitySchemas } from "./schemas";

export interface DataSourceOptions {
  url: string;
  poolSize: number;
  applicationName?: string;
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
    },
  });
}
