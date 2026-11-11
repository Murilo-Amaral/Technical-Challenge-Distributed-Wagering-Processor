import type { IntegrationEvent } from "./events/integration-event";
import type { ExponentialBackoff } from "./retry-policy";

export interface OutboxMessageState {
  id: string;
  aggregateId: string;
  partitionKey: string;
  eventType: string;
  payload: Readonly<Record<string, unknown>>;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt?: Date | undefined;
  publishedAt?: Date | undefined;
  lastError?: string | undefined;
}

/** An integration event waiting to be published, written in the same SQL transaction as the change. */
export class OutboxMessage {
  private constructor(
    public readonly id: string,
    public readonly aggregateId: string,
    public readonly partitionKey: string,
    public readonly eventType: string,
    public readonly payload: Readonly<Record<string, unknown>>,
    public readonly occurredAt: Date,
    private _attempts: number,
    private _nextAttemptAt: Date | undefined,
    private _publishedAt: Date | undefined,
    private _lastError: string | undefined,
  ) {}

  static enqueue(event: IntegrationEvent<unknown>): OutboxMessage {
    return new OutboxMessage(
      event.eventId,
      event.aggregateId,
      event.partitionKey,
      event.eventType,
      event.toJSON() as unknown as Record<string, unknown>,
      event.occurredAt,
      0,
      event.occurredAt,
      undefined,
      undefined,
    );
  }

  static rehydrate(state: OutboxMessageState): OutboxMessage {
    return new OutboxMessage(
      state.id,
      state.aggregateId,
      state.partitionKey,
      state.eventType,
      state.payload,
      state.occurredAt,
      state.attempts,
      state.nextAttemptAt,
      state.publishedAt,
      state.lastError,
    );
  }

  get attempts(): number {
    return this._attempts;
  }
  get nextAttemptAt(): Date | undefined {
    return this._nextAttemptAt;
  }
  get publishedAt(): Date | undefined {
    return this._publishedAt;
  }
  get lastError(): string | undefined {
    return this._lastError;
  }

  isPending(): boolean {
    return this._publishedAt === undefined;
  }

  isDue(now: Date): boolean {
    return this.isPending() && (this._nextAttemptAt === undefined || this._nextAttemptAt <= now);
  }

  markPublished(at: Date): void {
    if (!this.isPending()) {
      return;
    }
    this._attempts += 1;
    this._publishedAt = at;
    this._nextAttemptAt = undefined;
  }

  /** Increments attempts and computes the next nextAttemptAt (exponential backoff). Never gives up. */
  scheduleRetry(now: Date, policy: ExponentialBackoff, error?: string): void {
    this._attempts += 1;
    this._nextAttemptAt = policy.nextAttemptAt(this._attempts, now);
    this._lastError = error?.slice(0, 500);
  }
}
