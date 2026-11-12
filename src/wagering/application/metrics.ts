/** Metrics port. The Prometheus adapter lives in infrastructure/observability. */
export interface Metrics {
  transactionFinished(labels: { status: string; kind: string; source: string }): void;
  duplicateDetected(labels: { source: string; type: "idempotent_replay" | "inbox" | "conflict" }): void;
  retry(labels: { component: string; reason: string }): void;
  lockConflict(labels: { component: string; reason: string }): void;
  dlqMessage(labels: { reason: string }): void;
  processingDuration(labels: { source: string; outcome: string }, seconds: number): void;
  outboxPublished(count: number): void;
  outboxPublishFailed(): void;
  outboxState(pending: number, oldestAgeSeconds: number): void;
  reconciliation(labels: { consistent: boolean }): void;
}

export const METRICS = Symbol("METRICS");

export const noopMetrics: Metrics = {
  transactionFinished: () => {},
  duplicateDetected: () => {},
  retry: () => {},
  lockConflict: () => {},
  dlqMessage: () => {},
  processingDuration: () => {},
  outboxPublished: () => {},
  outboxPublishFailed: () => {},
  outboxState: () => {},
  reconciliation: () => {},
};
