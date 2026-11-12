import "reflect-metadata";
import { GetQueueAttributesCommand, type SQSClient } from "@aws-sdk/client-sqs";
import type { DataSource } from "typeorm";
import type { AppConfig } from "../config/app-config";
import { CreateWallet } from "../wagering/application/create-wallet";
import type { AppLogger } from "../wagering/application/logger";
import { ProcessPendingReferences } from "../wagering/application/process-pending-references";
import { PublishOutbox } from "../wagering/application/publish-outbox";
import { WageringQueries } from "../wagering/application/queries";
import { ReconcileWallet } from "../wagering/application/reconcile-wallet";
import { SubmitWagerTransaction } from "../wagering/application/submit-wager-transaction";
import { WagerProcessor } from "../wagering/application/wager-processor";
import { ExponentialBackoff } from "../wagering/domain/retry-policy";
import {
  createSqsClient,
  ensureQueues,
  type QueueUrls,
  resolveQueues,
} from "../wagering/infrastructure/messaging/sqs";
import { SqsEventPublisher } from "../wagering/infrastructure/messaging/sqs-event-publisher";
import { SqsWagerConsumer } from "../wagering/infrastructure/messaging/sqs-wager-consumer";
import { PinoAppLogger } from "../wagering/infrastructure/observability/pino-logger";
import { PrometheusMetrics } from "../wagering/infrastructure/observability/prometheus-metrics";
import { createDataSource } from "../wagering/infrastructure/persistence/data-source";
import { TypeOrmUnitOfWork } from "../wagering/infrastructure/persistence/typeorm-unit-of-work";
import { SystemClock, UuidV7Generator } from "../wagering/infrastructure/system";
import { PeriodicRunner, type PeriodicTask } from "../wagering/infrastructure/workers";
import {
  DisabledTokenVerifier,
  OidcTokenVerifier,
  type TokenVerifier,
} from "../wagering/interface/http/auth/token-verifier";
import type { ReadinessProbe } from "../wagering/interface/http/health.controller";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Retries a startup dependency (PostgreSQL / SQS may come up after the app). */
async function withStartupRetry<T>(
  name: string,
  logger: AppLogger,
  fn: () => Promise<T>,
  attempts = 30,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (attempt >= attempts) throw error;
      logger.warn(`${name} not reachable yet, retrying`, { attempt, error: String(error) });
      await sleep(Math.min(5000, 250 * 2 ** attempt));
    }
  }
}

/**
 * Composition root: builds every adapter and use case once. The Nest module only exposes these instances, which keeps
 * the application layer free of framework decorators.
 */
export async function buildContainer(config: AppConfig) {
  const logger = PinoAppLogger.create(config.LOG_LEVEL, { service: "wagering", instance: config.instanceId });
  const metrics = new PrometheusMetrics();
  const clock = new SystemClock();
  const ids = new UuidV7Generator();

  const dataSource: DataSource = await withStartupRetry("PostgreSQL", logger, () =>
    createDataSource({
      url: config.DATABASE_URL,
      poolSize: config.DB_POOL_SIZE,
      applicationName: `wagering-${config.instanceId}`,
      queryTimeoutMs: config.DB_STATEMENT_TIMEOUT_MS + 5000,
    }).initialize(),
  );

  const sqs: SQSClient = createSqsClient({ region: config.AWS_REGION, endpoint: config.SQS_ENDPOINT });
  const topology = {
    wagerQueueName: config.WAGER_QUEUE_NAME,
    wagerDlqName: config.WAGER_DLQ_NAME,
    eventsQueueName: config.EVENTS_QUEUE_NAME,
    visibilityTimeoutSeconds: config.CONSUMER_VISIBILITY_TIMEOUT_S,
    maxReceiveCount: config.CONSUMER_MAX_RECEIVES,
  };
  const queues: QueueUrls = await withStartupRetry("SQS", logger, () =>
    config.SQS_CREATE_QUEUES ? ensureQueues(sqs, topology) : resolveQueues(sqs, topology),
  );

  const uow = new TypeOrmUnitOfWork(
    dataSource,
    {
      lockTimeoutMs: config.DB_LOCK_TIMEOUT_MS,
      statementTimeoutMs: config.DB_STATEMENT_TIMEOUT_MS,
      maxRetries: config.TX_MAX_RETRIES,
    },
    metrics,
  );
  const referencePolicy = ExponentialBackoff.of({
    baseDelayMs: config.PENDING_REF_BASE_DELAY_MS,
    maxDelayMs: config.PENDING_REF_MAX_DELAY_MS,
    maxAttempts: config.PENDING_REF_MAX_ATTEMPTS,
  });
  const processor = new WagerProcessor(ids, referencePolicy, metrics, logger);

  const tokenVerifier: TokenVerifier =
    config.AUTH_MODE === "keycloak"
      ? new OidcTokenVerifier({
          issuer: config.OIDC_ISSUER_URL,
          audience: config.OIDC_AUDIENCE,
          jwksUrl: config.OIDC_JWKS_URL ?? `${config.OIDC_ISSUER_URL}/protocol/openid-connect/certs`,
          providerClaim: config.OIDC_PROVIDER_CLAIM,
        })
      : new DisabledTokenVerifier();
  if (config.AUTH_MODE === "disabled") {
    logger.warn("AUTH_MODE=disabled: HTTP endpoints accept unauthenticated requests (development only)");
  }

  const readinessProbes: ReadinessProbe[] = [
    { name: "postgres", check: async () => void (await dataSource.query("SELECT 1")) },
    {
      name: "sqs",
      check: async () =>
        void (await sqs.send(
          new GetQueueAttributesCommand({ QueueUrl: queues.wagerQueueUrl, AttributeNames: ["QueueArn"] }),
        )),
    },
  ];

  const submitWagerTransaction = new SubmitWagerTransaction(uow, processor, clock, ids, metrics, logger);
  const processPendingReferences = new ProcessPendingReferences(
    uow,
    processor,
    clock,
    metrics,
    logger,
    config.PENDING_REF_BATCH_SIZE,
  );
  const publishOutbox = new PublishOutbox(
    uow,
    new SqsEventPublisher(sqs, queues.eventsQueueUrl),
    clock,
    metrics,
    logger,
    {
      batchSize: config.OUTBOX_BATCH_SIZE,
      leaseMs: config.OUTBOX_LEASE_MS,
      owner: config.instanceId,
      retryPolicy: ExponentialBackoff.of({
        baseDelayMs: config.OUTBOX_RETRY_BASE_MS,
        maxDelayMs: config.OUTBOX_RETRY_MAX_MS,
        maxAttempts: Number.MAX_SAFE_INTEGER,
      }),
    },
  );

  const consumer = config.workers.has("consumer")
    ? new SqsWagerConsumer(sqs, submitWagerTransaction, metrics, logger, {
        queueUrl: queues.wagerQueueUrl,
        dlqUrl: queues.wagerDlqUrl,
        consumerName: config.CONSUMER_NAME,
        visibilityTimeoutSeconds: config.CONSUMER_VISIBILITY_TIMEOUT_S,
        waitTimeSeconds: config.CONSUMER_WAIT_TIME_S,
        maxReceives: config.CONSUMER_MAX_RECEIVES,
        retryBaseSeconds: config.CONSUMER_RETRY_BASE_S,
        retryMaxSeconds: config.CONSUMER_RETRY_MAX_S,
        shutdownGraceMs: config.SHUTDOWN_GRACE_MS,
        maxInFlightBatches:
          config.CONSUMER_MAX_IN_FLIGHT_BATCHES ?? Math.max(1, Math.floor(config.DB_POOL_SIZE / 10)),
        faultInjection: config.FAULT_INJECTION,
      })
    : undefined;

  const tasks: PeriodicTask[] = [];
  if (config.workers.has("outbox")) {
    tasks.push({
      name: "outbox-relay",
      intervalMs: config.OUTBOX_POLL_MS,
      step: () => publishOutbox.runOnce(),
    });
    tasks.push({
      name: "outbox-lag",
      intervalMs: 5000,
      step: async () => {
        await publishOutbox.refreshLag();
        return 0;
      },
    });
  }
  if (config.workers.has("pending-references")) {
    tasks.push({
      name: "pending-references",
      intervalMs: config.PENDING_REF_POLL_MS,
      step: () => processPendingReferences.runOnce(),
    });
  }
  const runner = new PeriodicRunner(tasks, logger);

  const workers = {
    start(): void {
      consumer?.start();
      runner.start();
    },
    async stop(): Promise<void> {
      await Promise.all([consumer?.stop(), runner.stop()]);
    },
  };

  return {
    config,
    logger,
    metrics,
    clock,
    ids,
    dataSource,
    sqs,
    queues,
    uow,
    processor,
    tokenVerifier,
    readinessProbes,
    submitWagerTransaction,
    publishOutbox,
    workers,
    createWallet: new CreateWallet(uow, clock, ids, logger),
    reconcileWallet: new ReconcileWallet(uow, metrics, logger),
    queries: new WageringQueries(uow),
    processPendingReferences,
  };
}

export type Container = Awaited<ReturnType<typeof buildContainer>>;
