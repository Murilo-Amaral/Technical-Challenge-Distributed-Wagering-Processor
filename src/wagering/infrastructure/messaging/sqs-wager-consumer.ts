import {
  ChangeMessageVisibilityBatchCommand,
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  type Message,
  MessageSystemAttributeName,
  ReceiveMessageCommand,
  SendMessageCommand,
  type SQSClient,
} from "@aws-sdk/client-sqs";
import { IdempotencyConflictError, NotFoundError, ValidationError } from "../../application/errors";
import type { AppLogger } from "../../application/logger";
import type { Metrics } from "../../application/metrics";
import type { SubmitWagerTransaction } from "../../application/submit-wager-transaction";
import { DomainError } from "../../domain/errors";
import { parseWagerMessage, peekMessageId } from "./wager-message";

export interface ConsumerSettings {
  queueUrl: string;
  dlqUrl: string;
  consumerName: string;
  visibilityTimeoutSeconds: number;
  waitTimeSeconds: number;
  /** Receives allowed before a failing message is moved to the DLQ (mirrors the queue redrive policy). */
  maxReceives: number;
  retryBaseSeconds: number;
  retryMaxSeconds: number;
  shutdownGraceMs: number;
  /** Test-only fault injection, e.g. "crash-after-commit-before-ack". */
  faultInjection?: string | undefined;
}

type Decision =
  | { action: "ack"; outcome: string }
  | { action: "dlq"; reason: string }
  | { action: "retry"; reason: string };

const MAX_IN_FLIGHT_BATCHES = 4;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * SQS consumer for wager-transactions.fifo.
 *
 * - messages of the same MessageGroupId (wallet) are processed sequentially, groups in parallel;
 * - it calls the same SubmitWagerTransaction use case as HTTP, with inbox de-duplication by (consumerName, messageId)
 *   inside the same SQL transaction;
 * - the message is deleted (ack) only after the use case committed;
 * - business outcomes (PROCESSED / REJECTED / PENDING_REFERENCE / replay / duplicate) are acked;
 *   transient failures are retried with exponential backoff through the visibility timeout;
 *   permanent failures and exhausted retries go to the DLQ with the reason as a message attribute;
 * - on stop (SIGTERM) it stops polling, lets in-flight messages finish and gives the visibility of the
 *   not-yet-started ones (and of anything the last poll returned) back to the queue.
 */
export class SqsWagerConsumer {
  private stopping = false;
  private loop: Promise<void> | undefined;
  private readonly inFlight = new Set<Promise<void>>();

  constructor(
    private readonly sqs: SQSClient,
    private readonly submit: SubmitWagerTransaction,
    private readonly metrics: Metrics,
    private readonly logger: AppLogger,
    private readonly settings: ConsumerSettings,
  ) {}

  start(): void {
    if (this.loop) return;
    this.stopping = false;
    this.loop = this.run();
    this.logger.info("sqs consumer started", { queueUrl: this.settings.queueUrl });
  }

  async stop(): Promise<void> {
    if (!this.loop) return;
    // The current long poll is NOT aborted: an aborted ReceiveMessage may already have taken messages server-side,
    // leaving them invisible (and blocking their FIFO group) until the visibility timeout. It returns within
    // waitTimeSeconds and anything it brings back is released immediately.
    this.stopping = true;
    const graceful = Promise.allSettled([this.loop, ...this.inFlight]);
    const timedOut = await Promise.race([
      graceful.then(() => false),
      sleep(this.settings.shutdownGraceMs).then(() => true),
    ]);
    if (timedOut) this.logger.warn("consumer shutdown grace period elapsed with messages in flight");
    this.loop = undefined;
    this.logger.info("sqs consumer stopped");
  }

  private async run(): Promise<void> {
    while (!this.stopping) {
      let messages: Message[] = [];
      try {
        const response = await this.sqs.send(
          new ReceiveMessageCommand({
            QueueUrl: this.settings.queueUrl,
            MaxNumberOfMessages: 10,
            WaitTimeSeconds: this.settings.waitTimeSeconds,
            VisibilityTimeout: this.settings.visibilityTimeoutSeconds,
            MessageSystemAttributeNames: [
              MessageSystemAttributeName.ApproximateReceiveCount,
              MessageSystemAttributeName.MessageGroupId,
            ],
          }),
        );
        messages = response.Messages ?? [];
        if (this.stopping) {
          await this.release(messages);
          break;
        }
      } catch (error) {
        if (this.stopping) break;
        this.logger.warn("sqs receive failed; backing off", { error: String(error) });
        await sleep(1000);
        continue;
      }
      if (messages.length === 0) continue;
      // Not awaited: other groups keep flowing while a slow group drains. SQS FIFO never hands out a group that still
      // has in-flight messages, so per-wallet ordering is preserved. In-flight batches are bounded.
      const batch = this.processBatch(messages).finally(() => this.inFlight.delete(batch));
      this.inFlight.add(batch);
      if (this.inFlight.size >= MAX_IN_FLIGHT_BATCHES) await Promise.race(this.inFlight);
    }
  }

  /** Sequential per message group, parallel across groups. */
  private async processBatch(messages: Message[]): Promise<void> {
    const groups = new Map<string, Message[]>();
    for (const m of messages) {
      const group = m.Attributes?.MessageGroupId ?? m.MessageId ?? "default";
      groups.set(group, [...(groups.get(group) ?? []), m]);
    }
    await Promise.all(
      [...groups.values()].map(async (group) => {
        for (let i = 0; i < group.length; i++) {
          if (this.stopping) {
            await this.release(group.slice(i));
            return;
          }
          await this.handle(group[i]!);
        }
      }),
    );
  }

  /** Visible again immediately so another instance can pick them up. */
  private async release(messages: Message[]): Promise<void> {
    if (messages.length === 0) return;
    try {
      await this.sqs.send(
        new ChangeMessageVisibilityBatchCommand({
          QueueUrl: this.settings.queueUrl,
          Entries: messages.map((m, i) => ({
            Id: String(i),
            ReceiptHandle: m.ReceiptHandle!,
            VisibilityTimeout: 0,
          })),
        }),
      );
      this.logger.info("released unstarted messages on shutdown", { count: messages.length });
    } catch (error) {
      this.logger.warn("could not release messages; they will reappear after the visibility timeout", {
        error: String(error),
      });
    }
  }

  async handle(message: Message): Promise<void> {
    const receiveCount = Number(message.Attributes?.ApproximateReceiveCount ?? "1");
    const messageId = peekMessageId(message.Body);
    const log = this.logger.child({ messageId, sqsMessageId: message.MessageId, receiveCount });
    const decision = await this.decide(message, log);

    try {
      switch (decision.action) {
        case "ack":
          if (this.settings.faultInjection === "crash-after-commit-before-ack") {
            log.warn("FAULT INJECTION: killing the process after commit, before ack");
            process.kill(process.pid, "SIGKILL");
            await sleep(60_000);
          }
          await this.ack(message);
          log.info("message acknowledged", { outcome: decision.outcome });
          break;
        case "retry":
          if (receiveCount >= this.settings.maxReceives) {
            await this.deadLetter(message, `retries_exhausted:${decision.reason}`, log);
          } else {
            const delay = Math.min(
              this.settings.retryBaseSeconds * 2 ** (receiveCount - 1),
              this.settings.retryMaxSeconds,
            );
            this.metrics.retry({ component: "sqs_consumer", reason: decision.reason });
            await this.sqs.send(
              new ChangeMessageVisibilityCommand({
                QueueUrl: this.settings.queueUrl,
                ReceiptHandle: message.ReceiptHandle!,
                VisibilityTimeout: delay,
              }),
            );
            log.warn("transient failure; message will be retried", {
              reason: decision.reason,
              delaySeconds: delay,
            });
          }
          break;
        case "dlq":
          await this.deadLetter(message, decision.reason, log);
          break;
      }
    } catch (error) {
      // Ack/visibility/DLQ calls failed: the message simply becomes visible again and is reprocessed; the inbox makes
      // that reprocessing a no-op if the effect was already committed.
      log.error("failed to settle message with SQS", { error: String(error), action: decision.action });
    }
  }

  private async decide(message: Message, log: AppLogger): Promise<Decision> {
    let parsed: ReturnType<typeof parseWagerMessage>;
    try {
      parsed = parseWagerMessage(message.Body);
    } catch (error) {
      log.warn("invalid message", { error: error instanceof Error ? error.message : String(error) });
      return { action: "dlq", reason: "invalid_payload" };
    }
    const { command } = parsed;
    try {
      const result = await this.submit.execute(command, {
        source: "sqs",
        correlationId: parsed.messageId,
        causationId: parsed.messageId,
        inbox: {
          consumerName: this.settings.consumerName,
          messageId: parsed.messageId,
          payloadHash: command.payloadHash,
        },
      });
      if (result.type === "duplicate-message") {
        return result.payloadMismatch
          ? { action: "dlq", reason: "message_id_reused_with_different_payload" }
          : { action: "ack", outcome: "duplicate" };
      }
      return { action: "ack", outcome: result.idempotentReplay ? "replay" : result.transaction.status };
    } catch (error) {
      if (error instanceof IdempotencyConflictError)
        return { action: "dlq", reason: error.code.toLowerCase() };
      if (error instanceof NotFoundError) return { action: "dlq", reason: error.code.toLowerCase() };
      if (error instanceof ValidationError || error instanceof DomainError)
        return { action: "dlq", reason: "invalid_payload" };
      log.warn("processing failed", {
        transient: true,
        error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
        walletId: command.walletId,
        providerId: command.providerId,
      });
      return { action: "retry", reason: error instanceof Error ? error.name : "unknown" };
    }
  }

  private async ack(message: Message): Promise<void> {
    await this.sqs.send(
      new DeleteMessageCommand({ QueueUrl: this.settings.queueUrl, ReceiptHandle: message.ReceiptHandle! }),
    );
  }

  private async deadLetter(message: Message, reason: string, log: AppLogger): Promise<void> {
    await this.sqs.send(
      new SendMessageCommand({
        QueueUrl: this.settings.dlqUrl,
        MessageBody: message.Body ?? "",
        MessageGroupId: message.Attributes?.MessageGroupId ?? "dlq",
        MessageDeduplicationId: message.MessageId,
        MessageAttributes: {
          reason: { DataType: "String", StringValue: reason },
          sourceMessageId: { DataType: "String", StringValue: message.MessageId ?? "unknown" },
        },
      }),
    );
    await this.ack(message);
    this.metrics.dlqMessage({ reason: reason.split(":")[0]! });
    log.error("message moved to DLQ", { reason });
  }
}
