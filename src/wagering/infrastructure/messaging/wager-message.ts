import { z } from "zod";
import { ValidationError } from "../../application/errors";
import { parseWagerCommand, type WagerCommand } from "../../application/wager-request";

export const WAGER_MESSAGE_TYPE = "WagerTransactionRequested";

const envelopeSchema = z.object({
  messageId: z.string().min(1).max(256),
  type: z.literal(WAGER_MESSAGE_TYPE),
  occurredAt: z.iso.datetime(),
  data: z.record(z.string(), z.unknown()),
});

export interface WagerMessage {
  messageId: string;
  occurredAt: string;
  command: WagerCommand;
}

/** Parses the queue envelope; `data` goes through exactly the same validation as the HTTP body. */
export function parseWagerMessage(body: string | undefined): WagerMessage {
  let raw: unknown;
  try {
    raw = JSON.parse(body ?? "");
  } catch {
    throw new ValidationError("Message body is not valid JSON");
  }
  const parsed = envelopeSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ValidationError(
      "Invalid message envelope",
      parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    );
  }
  const { idempotencyKey, ...business } = parsed.data.data;
  return {
    messageId: parsed.data.messageId,
    occurredAt: parsed.data.occurredAt,
    command: parseWagerCommand(business, idempotencyKey),
  };
}

/** Peeks the messageId for logging even when the rest of the envelope is invalid. */
export function peekMessageId(body: string | undefined): string | undefined {
  try {
    const id = (JSON.parse(body ?? "") as { messageId?: unknown }).messageId;
    return typeof id === "string" ? id.slice(0, 256) : undefined;
  } catch {
    return undefined;
  }
}
