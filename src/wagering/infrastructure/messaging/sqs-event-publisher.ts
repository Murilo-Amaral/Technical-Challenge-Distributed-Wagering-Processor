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
    const pending = [...messages];
    while (pending.length > 0) {
      const chunk: OutboxMessage[] = [];
      while (pending.length > 0 && chunk.length < SQS_BATCH_LIMIT) {
        const m = pending.shift()!;
        if (blocked.has(m.partitionKey)) {
          result.failed.push({ id: m.id, error: "held back: an earlier event of this partition failed" });
        } else {
          chunk.push(m);
        }
      }
      if (chunk.length === 0) break;
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
