import {
  CreateQueueCommand,
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  QueueAttributeName,
  SQSClient,
} from "@aws-sdk/client-sqs";

export interface SqsSettings {
  region: string;
  endpoint?: string | undefined;
}

export function createSqsClient(settings: SqsSettings): SQSClient {
  return new SQSClient({
    region: settings.region,
    ...(settings.endpoint ? { endpoint: settings.endpoint } : {}),
    maxAttempts: 3,
  });
}

export interface QueueTopology {
  wagerQueueName: string;
  wagerDlqName: string;
  eventsQueueName: string;
  visibilityTimeoutSeconds: number;
  maxReceiveCount: number;
}

export interface QueueUrls {
  wagerQueueUrl: string;
  wagerDlqUrl: string;
  eventsQueueUrl: string;
}

async function getUrl(client: SQSClient, name: string): Promise<string> {
  const { QueueUrl } = await client.send(new GetQueueUrlCommand({ QueueName: name }));
  if (!QueueUrl) throw new Error(`Queue ${name} not found`);
  return QueueUrl;
}

async function createOrGet(
  client: SQSClient,
  name: string,
  attributes: Record<string, string>,
): Promise<string> {
  try {
    const { QueueUrl } = await client.send(
      new CreateQueueCommand({ QueueName: name, Attributes: attributes }),
    );
    return QueueUrl!;
  } catch (error) {
    // Exists with different attributes (e.g. created by the LocalStack init script): reuse it.
    if ((error as { name?: string }).name === "QueueNameExists" || /already exists/i.test(String(error))) {
      return getUrl(client, name);
    }
    throw error;
  }
}

/** Creates the FIFO queues idempotently: main queue with a redrive policy to its DLQ, plus the events queue. */
export async function ensureQueues(client: SQSClient, t: QueueTopology): Promise<QueueUrls> {
  const wagerDlqUrl = await createOrGet(client, t.wagerDlqName, {
    FifoQueue: "true",
    MessageRetentionPeriod: "1209600",
  });
  const { Attributes } = await client.send(
    new GetQueueAttributesCommand({ QueueUrl: wagerDlqUrl, AttributeNames: [QueueAttributeName.QueueArn] }),
  );
  const wagerQueueUrl = await createOrGet(client, t.wagerQueueName, {
    FifoQueue: "true",
    ContentBasedDeduplication: "true",
    VisibilityTimeout: String(t.visibilityTimeoutSeconds),
    RedrivePolicy: JSON.stringify({
      deadLetterTargetArn: Attributes?.QueueArn,
      maxReceiveCount: t.maxReceiveCount,
    }),
  });
  const eventsQueueUrl = await createOrGet(client, t.eventsQueueName, { FifoQueue: "true" });
  return { wagerQueueUrl, wagerDlqUrl, eventsQueueUrl };
}

export async function resolveQueues(client: SQSClient, t: QueueTopology): Promise<QueueUrls> {
  return {
    wagerQueueUrl: await getUrl(client, t.wagerQueueName),
    wagerDlqUrl: await getUrl(client, t.wagerDlqName),
    eventsQueueUrl: await getUrl(client, t.eventsQueueName),
  };
}
