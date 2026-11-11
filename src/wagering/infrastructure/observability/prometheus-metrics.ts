import { Counter, Gauge, Histogram, Registry } from "prom-client";
import type { Metrics } from "../../application/metrics";

/** Prometheus adapter for the Metrics port; exposed at GET /metrics. */
export class PrometheusMetrics implements Metrics {
  readonly registry = new Registry();

  private readonly transactions = new Counter({
    name: "wagering_transactions_total",
    help: "Wager transactions that reached a status, by status/kind/source",
    labelNames: ["status", "kind", "source"],
    registers: [this.registry],
  });
  private readonly duplicates = new Counter({
    name: "wagering_duplicates_detected_total",
    help: "Duplicates detected: idempotent replays, inbox hits and idempotency conflicts",
    labelNames: ["source", "type"],
    registers: [this.registry],
  });
  private readonly retries = new Counter({
    name: "wagering_retries_total",
    help: "Retries by component and reason",
    labelNames: ["component", "reason"],
    registers: [this.registry],
  });
  private readonly lockConflicts = new Counter({
    name: "wagering_lock_conflicts_total",
    help: "Lock timeouts, deadlocks, serialization failures and version conflicts",
    labelNames: ["component", "reason"],
    registers: [this.registry],
  });
  private readonly dlq = new Counter({
    name: "wagering_dlq_messages_total",
    help: "Messages sent to the dead-letter queue",
    labelNames: ["reason"],
    registers: [this.registry],
  });
  private readonly latency = new Histogram({
    name: "wagering_processing_duration_seconds",
    help: "End-to-end processing latency of wager submissions",
    labelNames: ["source", "outcome"],
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [this.registry],
  });
  private readonly published = new Counter({
    name: "wagering_outbox_published_total",
    help: "Outbox events published to the broker",
    registers: [this.registry],
  });
  private readonly publishFailures = new Counter({
    name: "wagering_outbox_publish_failures_total",
    help: "Outbox publish rounds with at least one failed event",
    registers: [this.registry],
  });
  private readonly outboxPending = new Gauge({
    name: "wagering_outbox_pending",
    help: "Unpublished outbox events",
    registers: [this.registry],
  });
  private readonly outboxLag = new Gauge({
    name: "wagering_outbox_lag_seconds",
    help: "Age of the oldest unpublished outbox event",
    registers: [this.registry],
  });
  private readonly reconciliations = new Counter({
    name: "wagering_reconciliations_total",
    help: "Wallet reconciliations by result",
    labelNames: ["consistent"],
    registers: [this.registry],
  });

  transactionFinished(labels: { status: string; kind: string; source: string }): void {
    this.transactions.inc(labels);
  }
  duplicateDetected(labels: { source: string; type: string }): void {
    this.duplicates.inc(labels);
  }
  retry(labels: { component: string; reason: string }): void {
    this.retries.inc(labels);
  }
  lockConflict(labels: { component: string; reason: string }): void {
    this.lockConflicts.inc(labels);
  }
  dlqMessage(labels: { reason: string }): void {
    this.dlq.inc(labels);
  }
  processingDuration(labels: { source: string; outcome: string }, seconds: number): void {
    this.latency.observe(labels, seconds);
  }
  outboxPublished(count: number): void {
    if (count > 0) this.published.inc(count);
  }
  outboxPublishFailed(): void {
    this.publishFailures.inc();
  }
  outboxState(pending: number, oldestAgeSeconds: number): void {
    this.outboxPending.set(pending);
    this.outboxLag.set(oldestAgeSeconds);
  }
  reconciliation(labels: { consistent: boolean }): void {
    this.reconciliations.inc({ consistent: String(labels.consistent) });
  }
}
