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

describe("SqsEventPublisher ordering", () => {
  test("after a failed chunk, later events of the same partition are held back; other partitions still go", async () => {
    let call = 0;
    const sent: string[] = [];
    const sqs = {
      send: async (cmd: { input: { Entries: Array<{ Id: string; MessageBody: string }> } }) => {
        call++;
        if (call === 1) throw new Error("throttled");
        for (const e of cmd.input.Entries) sent.push((JSON.parse(e.MessageBody) as { id: string }).id);
        return { Successful: cmd.input.Entries.map((e) => ({ Id: e.Id })) };
      },
    } as unknown as SQSClient;
    // First chunk (10 msgs) has w1 and w2; second chunk has w1 (must wait) and w3 (independent).
    const first = Array.from({ length: 10 }, (_, i) => message(`a${i}`, i % 2 === 0 ? "w1" : "w2"));
    const second = [message("b0", "w1"), message("b1", "w3")];
    const result = await new SqsEventPublisher(sqs, "url").publish([...first, ...second]);
    expect(sent).toEqual(["b1"]);
    expect(result.succeeded).toEqual(["b1"]);
    expect(result.failed.map((f) => f.id)).toContain("b0");
    expect(result.failed).toHaveLength(11);
  });
});
