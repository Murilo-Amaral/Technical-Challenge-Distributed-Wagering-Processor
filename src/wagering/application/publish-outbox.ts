import type { ExponentialBackoff } from "../domain/retry-policy";
import type { EventPublisher } from "./event-publisher";
import type { AppLogger } from "./logger";
import type { Metrics } from "./metrics";
import type { Clock, UnitOfWork } from "./ports";

export interface PublishOutboxSettings {
  batchSize: number;
  leaseMs: number;
  owner: string;
  retryPolicy: ExponentialBackoff;
}

/**
 * Outbox relay. Three short steps, none of them holding a DB transaction open while talking to the broker:
 *   1. lease a batch (UPDATE ... FOR UPDATE SKIP LOCKED) and commit — concurrent publishers get disjoint batches;
 *   2. publish to the broker;
 *   3. mark published / schedule retry.
 * If the process dies between 2 and 3 the lease expires and another instance re-publishes: delivery is
 * at-least-once, and consumers de-duplicate by eventId (also the SQS FIFO MessageDeduplicationId).
 */
export class PublishOutbox {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly publisher: EventPublisher,
    private readonly clock: Clock,
    private readonly metrics: Metrics,
    private readonly logger: AppLogger,
    private readonly settings: PublishOutboxSettings,
  ) {}

  /** @returns number of messages published in this step. */
  async runOnce(): Promise<number> {
    const claimed = await this.uow.run(
      (ctx) =>
        ctx.outbox.claimDue(
          this.clock.now(),
          this.settings.batchSize,
          this.settings.leaseMs,
          this.settings.owner,
        ),
      { name: "outbox_claim" },
    );
    if (claimed.length === 0) {
      return 0;
    }

    const result = await this.publisher.publish(claimed).catch((error: unknown) => ({
      succeeded: [] as string[],
      failed: claimed.map((m) => ({
        id: m.id,
        error: error instanceof Error ? error.message : String(error),
      })),
    }));

    const now = this.clock.now();
    const succeeded = new Set(result.succeeded);
    const errors = new Map(result.failed.map((f) => [f.id, f.error]));
    for (const message of claimed) {
      if (succeeded.has(message.id)) {
        message.markPublished(now);
      } else {
        message.scheduleRetry(
          now,
          this.settings.retryPolicy,
          errors.get(message.id) ?? "not acknowledged by broker",
        );
      }
    }

    await this.uow.run(
      async (ctx) => {
        for (const message of claimed) {
          if (message.publishedAt) await ctx.outbox.markPublished(message);
          else await ctx.outbox.saveRetry(message);
        }
      },
      { name: "outbox_complete" },
    );

    this.metrics.outboxPublished(succeeded.size);
    if (errors.size > 0) {
      this.metrics.outboxPublishFailed();
      this.metrics.retry({ component: "outbox", reason: "publish_failed" });
      this.logger.warn("outbox publish failed for some events; scheduled for retry", { failed: errors.size });
    }
    return succeeded.size;
  }

  async refreshLag(): Promise<void> {
    const stats = await this.uow.run((ctx) => ctx.outbox.stats(), { name: "outbox_stats" });
    this.metrics.outboxState(stats.pending, stats.oldestPendingAgeSeconds);
  }
}
