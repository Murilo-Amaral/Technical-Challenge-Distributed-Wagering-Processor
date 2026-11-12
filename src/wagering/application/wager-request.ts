import { z } from "zod";
import { InvalidMoneyError } from "../domain/errors";
import { Money } from "../domain/money";
import { computePayloadHash } from "../domain/payload-hash";
import { WagerTransactionKind } from "../domain/wager-transaction";
import { ValidationError } from "./errors";

/** A validated wager request: the input of SubmitWagerTransaction, shared by HTTP and SQS. */
export interface WagerCommand {
  idempotencyKey: string;
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId: string | undefined;
  payloadHash: string;
}

const token = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .regex(/^[A-Za-z0-9._:-]+$/, "only letters, digits and . _ : - are allowed");

export const SUBMITTABLE_KINDS = [
  WagerTransactionKind.Bet,
  WagerTransactionKind.Win,
  WagerTransactionKind.Loss,
  WagerTransactionKind.Refund,
  WagerTransactionKind.Rollback,
] as const;

const moneySchema = z.object({ amount: z.string(), currency: z.string() });

const bodySchema = z
  .object({
    providerId: token(64),
    externalTransactionId: token(128),
    playerId: token(64),
    walletId: z.uuid(),
    roundId: token(128),
    gameId: token(128),
    kind: z.string(),
    money: moneySchema,
    referenceExternalTransactionId: token(128).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.kind === WagerTransactionKind.Opening) {
      ctx.addIssue({
        code: "custom",
        path: ["kind"],
        message: "OPENING is internal and cannot be submitted",
      });
    } else if (!(SUBMITTABLE_KINDS as readonly string[]).includes(v.kind)) {
      ctx.addIssue({
        code: "custom",
        path: ["kind"],
        message: `must be one of ${SUBMITTABLE_KINDS.join(", ")}`,
      });
    }
    const needsReference = v.kind === WagerTransactionKind.Refund || v.kind === WagerTransactionKind.Rollback;
    if (needsReference && !v.referenceExternalTransactionId) {
      ctx.addIssue({
        code: "custom",
        path: ["referenceExternalTransactionId"],
        message: `required for ${v.kind}`,
      });
    }
    if (v.kind === WagerTransactionKind.Bet && v.referenceExternalTransactionId) {
      ctx.addIssue({
        code: "custom",
        path: ["referenceExternalTransactionId"],
        message: "not allowed for BET",
      });
    }
  });

const idempotencyKeySchema = z.string().trim().min(1).max(256);

const issuesOf = (error: z.ZodError) =>
  error.issues.map((issue) => ({ path: issue.path.join(".") || "(root)", message: issue.message }));

/**
 * Parses and validates the business payload plus the idempotency key (HTTP header or SQS data field).
 * The payload hash is computed on the normalized business fields only.
 */
export function parseWagerCommand(raw: unknown, idempotencyKey: unknown): WagerCommand {
  const key = idempotencyKeySchema.safeParse(idempotencyKey);
  const body = bodySchema.safeParse(raw);
  const issues = [
    ...(key.success ? [] : [{ path: "idempotencyKey", message: "required, 1-256 characters" }]),
    ...(body.success ? [] : issuesOf(body.error)),
  ];
  if (!key.success || !body.success) {
    throw new ValidationError("Invalid wager transaction request", issues);
  }
  const v = body.data;
  let money: Money;
  try {
    money = Money.from(v.money);
  } catch (error) {
    if (error instanceof InvalidMoneyError) {
      throw new ValidationError("Invalid wager transaction request", [
        { path: "money", message: error.message },
      ]);
    }
    throw error;
  }
  if (money.isZero() && v.kind !== WagerTransactionKind.Loss) {
    throw new ValidationError("Invalid wager transaction request", [
      { path: "money.amount", message: "must be greater than zero" },
    ]);
  }
  const kind = v.kind as WagerTransactionKind;
  const fields = {
    providerId: v.providerId,
    externalTransactionId: v.externalTransactionId,
    playerId: v.playerId,
    walletId: v.walletId,
    roundId: v.roundId,
    gameId: v.gameId,
    kind,
    money: money.toJSON(),
    referenceExternalTransactionId: v.referenceExternalTransactionId,
  };
  return {
    ...fields,
    idempotencyKey: key.data,
    money,
    payloadHash: computePayloadHash(fields),
  };
}

const createWalletSchema = z.object({
  playerId: token(64),
  initialBalance: moneySchema,
});

export interface CreateWalletCommand {
  playerId: string;
  initialBalance: Money;
}

export function parseCreateWalletCommand(raw: unknown): CreateWalletCommand {
  const parsed = createWalletSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ValidationError("Invalid wallet request", issuesOf(parsed.error));
  }
  try {
    return { playerId: parsed.data.playerId, initialBalance: Money.from(parsed.data.initialBalance) };
  } catch (error) {
    if (error instanceof InvalidMoneyError) {
      throw new ValidationError("Invalid wallet request", [
        { path: "initialBalance", message: error.message },
      ]);
    }
    throw error;
  }
}
