import { SendMessageBatchCommand, type SQSClient } from "@aws-sdk/client-sqs";
import type { EventPublisher, PublishResult } from "../../application/event-publisher";
import type { OutboxMessage } from "../../domain/outbox-message";

const SQS_BATCH_LIMIT = 10;

/**
 * Publishes outbox events to the events FIFO queue.
 * - MessageGroupId = partition key (walletId): per-wallet ordering for consumers;
 * - MessageDeduplicationId = eventId: SQS drops re-publications inside its 5-minute window, and consumers can
 *   always de-duplicate by eventId beyond it.
 */
export class SqsEventPublisher implements EventPublisher {
  constructor(
    private readonly sqs: SQSClient,
    private readonly queueUrl: string,
  ) {}

  async publish(messages: OutboxMessage[]): Promise<PublishResult> {
    const result: PublishResult = { succeeded: [], failed: [] };
    // Once an event of a partition fails, its later events are held back so they are not published ahead of it.
    const blocked = new Set<string>();
    let pending = [...messages];
    while (pending.length > 0) {
      // At most one event per partition per batch call: SQS may accept a later entry of a group and reject an earlier
      // one in the same call, which would publish them out of order.
      const chunk: OutboxMessage[] = [];
      const seen = new Set<string>();
      const rest: OutboxMessage[] = [];
      for (const m of pending) {
        if (blocked.has(m.partitionKey)) {
          result.failed.push({ id: m.id, error: "held back: an earlier event of this partition failed" });
        } else if (chunk.length < SQS_BATCH_LIMIT && !seen.has(m.partitionKey)) {
          chunk.push(m);
          seen.add(m.partitionKey);
        } else {
          rest.push(m);
          seen.add(m.partitionKey);
        }
      }
      pending = rest;
      if (chunk.length === 0) continue;
      try {
        const response = await this.sqs.send(
          new SendMessageBatchCommand({
            QueueUrl: this.queueUrl,
            Entries: chunk.map((m, index) => ({
              Id: String(index),
              MessageBody: JSON.stringify(m.payload),
              MessageGroupId: m.partitionKey,
              MessageDeduplicationId: m.id,
              MessageAttributes: { eventType: { DataType: "String", StringValue: m.eventType } },
            })),
          }),
        );
        for (const ok of response.Successful ?? []) result.succeeded.push(chunk[Number(ok.Id)]!.id);
        for (const ko of response.Failed ?? []) {
          const m = chunk[Number(ko.Id)]!;
          blocked.add(m.partitionKey);
          result.failed.push({ id: m.id, error: `${ko.Code}: ${ko.Message ?? ""}` });
        }
      } catch (error) {
        for (const m of chunk) {
          blocked.add(m.partitionKey);
          result.failed.push({ id: m.id, error: error instanceof Error ? error.message : String(error) });
        }
      }
    }
    return result;
  }
}
