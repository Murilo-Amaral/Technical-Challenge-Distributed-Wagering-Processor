import type { OutboxMessage } from "../domain/outbox-message";

export interface PublishResult {
  succeeded: string[];
  failed: Array<{ id: string; error: string }>;
}

/** Port to the message broker. Implementations must be safe to call again with the same messages. */
export interface EventPublisher {
  publish(messages: OutboxMessage[]): Promise<PublishResult>;
}

export const EVENT_PUBLISHER = Symbol("EVENT_PUBLISHER");
