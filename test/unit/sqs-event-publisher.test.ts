import { describe, expect, test } from "bun:test";
import type { SQSClient } from "@aws-sdk/client-sqs";
import { OutboxMessage } from "../../src/wagering/domain/outbox-message";
import { SqsEventPublisher } from "../../src/wagering/infrastructure/messaging/sqs-event-publisher";

const message = (id: string, partitionKey: string) =>
  OutboxMessage.rehydrate({
    id,
    aggregateId: id,
    partitionKey,
    eventType: "E",
    payload: { id },
    occurredAt: new Date(0),
    attempts: 0,
  });

type Entries = Array<{ Id: string; MessageBody: string; MessageGroupId: string }>;

/** Fake SQS: rejects the entries whose payload id is in `failIds`, records every call. */
const fakeSqs = (failIds: Set<string>) => {
  const calls: string[][] = [];
  const sent: string[] = [];
  const sqs = {
    send: async (cmd: { input: { Entries: Entries } }) => {
      const ids = cmd.input.Entries.map((e) => (JSON.parse(e.MessageBody) as { id: string }).id);
      calls.push(ids);
      const ok = cmd.input.Entries.filter((_, i) => !failIds.has(ids[i]!));
      sent.push(...ok.map((e) => (JSON.parse(e.MessageBody) as { id: string }).id));
      return {
        Successful: ok.map((e) => ({ Id: e.Id })),
        Failed: cmd.input.Entries.filter((_, i) => failIds.has(ids[i]!)).map((e) => ({
          Id: e.Id,
          Code: "Throttled",
        })),
      };
    },
  } as unknown as SQSClient;
  return { sqs, calls, sent };
};

describe("SqsEventPublisher ordering", () => {
  test("a batch call never carries two events of the same partition", async () => {
    const { sqs, calls } = fakeSqs(new Set());
    const msgs = [message("w1-a", "w1"), message("w1-b", "w1"), message("w2-a", "w2"), message("w1-c", "w1")];
    const result = await new SqsEventPublisher(sqs, "url").publish(msgs);
    expect(calls).toEqual([["w1-a", "w2-a"], ["w1-b"], ["w1-c"]]);
    expect(result.succeeded).toEqual(["w1-a", "w2-a", "w1-b", "w1-c"]);
  });

  test("after a failed event, later events of the same partition are held back; other partitions still go", async () => {
    const { sqs, sent } = fakeSqs(new Set(["w1-a"]));
    const msgs = [message("w1-a", "w1"), message("w1-b", "w1"), message("w2-a", "w2"), message("w2-b", "w2")];
    const result = await new SqsEventPublisher(sqs, "url").publish(msgs);
    expect(sent).toEqual(["w2-a", "w2-b"]);
    expect(result.failed.map((f) => f.id).sort()).toEqual(["w1-a", "w1-b"]);
  });
});
