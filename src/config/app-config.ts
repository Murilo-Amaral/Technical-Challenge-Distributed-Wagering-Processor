import { z } from "zod";

const bool = z.enum(["true", "false", "1", "0"]).transform((v) => v === "true" || v === "1");
const int = (def: number) => z.coerce.number().int().positive().default(def);

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  INSTANCE_ID: z.string().min(1).optional(),
  PORT: z.coerce.number().int().min(0).default(3000),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),

  DATABASE_URL: z.string().url().default("postgres://wagering:wagering@localhost:5432/wagering"),
  DB_POOL_SIZE: int(10),
  DB_LOCK_TIMEOUT_MS: int(5000),
  DB_STATEMENT_TIMEOUT_MS: int(15000),
  TX_MAX_RETRIES: int(3),

  AWS_REGION: z.string().default("us-east-1"),
  SQS_ENDPOINT: z.string().url().optional(),
  SQS_CREATE_QUEUES: bool.default(true),
  WAGER_QUEUE_NAME: z.string().default("wager-transactions.fifo"),
  WAGER_DLQ_NAME: z.string().default("wager-transactions-dlq.fifo"),
  EVENTS_QUEUE_NAME: z.string().default("wagering-events.fifo"),
  CONSUMER_NAME: z.string().default("wager-transactions-consumer"),
  CONSUMER_VISIBILITY_TIMEOUT_S: int(30),
  CONSUMER_WAIT_TIME_S: z.coerce.number().int().min(0).max(20).default(10),
  CONSUMER_MAX_RECEIVES: int(5),
  CONSUMER_RETRY_BASE_S: int(2),
  CONSUMER_RETRY_MAX_S: int(60),

  WORKERS: z.string().default("consumer,outbox,pending-references"),
  OUTBOX_POLL_MS: int(500),
  OUTBOX_BATCH_SIZE: int(50),
  OUTBOX_LEASE_MS: int(30000),
  OUTBOX_RETRY_BASE_MS: int(1000),
  OUTBOX_RETRY_MAX_MS: int(300000),

  PENDING_REF_POLL_MS: int(1000),
  PENDING_REF_BATCH_SIZE: int(50),
  PENDING_REF_BASE_DELAY_MS: int(2000),
  PENDING_REF_MAX_DELAY_MS: int(120000),
  PENDING_REF_MAX_ATTEMPTS: int(10),

  SHUTDOWN_GRACE_MS: int(20000),

  AUTH_MODE: z.enum(["keycloak", "disabled"]).default("disabled"),
  OIDC_ISSUER_URL: z.string().url().default("http://localhost:8080/realms/wagering"),
  OIDC_JWKS_URL: z.string().url().optional(),
  OIDC_AUDIENCE: z.string().default("wagering-api"),
  /** Claim that carries the provider identity in the access token. */
  OIDC_PROVIDER_CLAIM: z.string().default("provider_id"),

  /** Test-only fault injection. Refused when NODE_ENV=production. */
  FAULT_INJECTION: z.string().optional(),
});

export type AppConfig = z.infer<typeof schema> & { workers: Set<string>; instanceId: string };

export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    throw new Error(
      `Invalid configuration: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
    );
  }
  const cfg = parsed.data;
  if (cfg.NODE_ENV === "production" && cfg.FAULT_INJECTION) {
    throw new Error("FAULT_INJECTION is not allowed in production");
  }
  return {
    ...cfg,
    workers: new Set(
      cfg.WORKERS.split(",")
        .map((w) => w.trim())
        .filter(Boolean),
    ),
    instanceId: cfg.INSTANCE_ID ?? `${process.env.HOSTNAME ?? "local"}-${process.pid}`,
  };
}

export const APP_CONFIG = Symbol("APP_CONFIG");
