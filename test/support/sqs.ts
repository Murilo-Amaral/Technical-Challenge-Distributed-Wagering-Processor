import {
  DeleteMessageBatchCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  type Message,
  ReceiveMessageCommand,
  SendMessageCommand,
  type SQSClient,
} from "@aws-sdk/client-sqs";
import {
  createSqsClient,
  ensureQueues,
  type QueueUrls,
} from "../../src/wagering/infrastructure/messaging/sqs";
import { TEST_SQS_ENDPOINT } from "./app";

process.env.AWS_ACCESS_KEY_ID ??= "test";
process.env.AWS_SECRET_ACCESS_KEY ??= "test";

export interface TestQueues extends QueueUrls {
  names: { WAGER_QUEUE_NAME: string; WAGER_DLQ_NAME: string; EVENTS_QUEUE_NAME: string };
}

/** Isolated FIFO queues per test file (random suffix) so suites never see each other's messages. */
export async function createTestQueues(
  sqs: SQSClient,
  opts: { visibilityTimeoutSeconds?: number; maxReceiveCount?: number } = {},
): Promise<TestQueues> {
  const suffix = crypto.randomUUID().slice(0, 8);
  const names = {
    WAGER_QUEUE_NAME: `wager-transactions-${suffix}.fifo`,
    WAGER_DLQ_NAME: `wager-transactions-dlq-${suffix}.fifo`,
    EVENTS_QUEUE_NAME: `wagering-events-${suffix}.fifo`,
  };
  const urls = await ensureQueues(sqs, {
    wagerQueueName: names.WAGER_QUEUE_NAME,
    wagerDlqName: names.WAGER_DLQ_NAME,
    eventsQueueName: names.EVENTS_QUEUE_NAME,
    visibilityTimeoutSeconds: opts.visibilityTimeoutSeconds ?? 30,
    maxReceiveCount: opts.maxReceiveCount ?? 5,
  });
  return { ...urls, names };
}

export async function deleteTestQueues(sqs: SQSClient, q: QueueUrls): Promise<void> {
  for (const url of [q.wagerQueueUrl, q.wagerDlqUrl, q.eventsQueueUrl]) {
    await sqs.send(new DeleteQueueCommand({ QueueUrl: url })).catch(() => {});
  }
}

export const testSqsClient = () => createSqsClient({ region: "us-east-1", endpoint: TEST_SQS_ENDPOINT });

export function wagerEnvelope(messageId: string, data: Record<string, unknown>) {
  return { messageId, type: "WagerTransactionRequested", occurredAt: new Date().toISOString(), data };
}

/** Sends a provider message. dedupId defaults to a random value so a redelivery is not swallowed by SQS. */
export async function sendWager(
  sqs: SQSClient,
  queueUrl: string,
  envelope: { messageId: string; data: Record<string, unknown> } | string,
  opts: { groupId?: string; dedupId?: string } = {},
): Promise<void> {
  const body = typeof envelope === "string" ? envelope : JSON.stringify(envelope);
  const groupId =
    opts.groupId ??
    (typeof envelope === "string" ? "g" : String((envelope.data as { walletId?: string }).walletId ?? "g"));
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: body,
      MessageGroupId: groupId,
      MessageDeduplicationId: opts.dedupId ?? crypto.randomUUID(),
    }),
  );
}

/**
 * Drains a queue: receives and deletes what is visible, up to `max`. Deleting matters on FIFO queues: an
 * unacknowledged message locks its whole message group.
 */
export async function receiveAll(
  sqs: SQSClient,
  queueUrl: string,
  max = 100,
  waitSeconds = 1,
): Promise<Message[]> {
  const out: Message[] = [];
  while (out.length < max) {
    const res = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: waitSeconds,
        VisibilityTimeout: 60,
        MessageAttributeNames: ["All"],
      }),
    );
    if (!res.Messages?.length) break;
    out.push(...res.Messages);
    await sqs.send(
      new DeleteMessageBatchCommand({
        QueueUrl: queueUrl,
        Entries: res.Messages.map((m, i) => ({ Id: String(i), ReceiptHandle: m.ReceiptHandle! })),
      }),
    );
  }
  return out;
}

export async function approximateCount(sqs: SQSClient, queueUrl: string): Promise<number> {
  const { Attributes } = await sqs.send(
    new GetQueueAttributesCommand({
      QueueUrl: queueUrl,
      AttributeNames: ["ApproximateNumberOfMessages", "ApproximateNumberOfMessagesNotVisible"],
    }),
  );
  return (
    Number(Attributes?.ApproximateNumberOfMessages ?? 0) +
    Number(Attributes?.ApproximateNumberOfMessagesNotVisible ?? 0)
  );
}

export async function waitFor<T>(
  probe: () => Promise<T | undefined | false>,
  { timeoutMs = 20_000, intervalMs = 200, label = "condition" } = {},
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value as T;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
