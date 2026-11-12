import { Money } from "../../src/wagering/domain/money";
import { computePayloadHash } from "../../src/wagering/domain/payload-hash";
import { ExponentialBackoff } from "../../src/wagering/domain/retry-policy";
import { WagerTransaction, WagerTransactionKind } from "../../src/wagering/domain/wager-transaction";
import { Wallet } from "../../src/wagering/domain/wallet";

export const brl = (amount: string) => Money.from({ amount, currency: "BRL" });
export const T0 = new Date("2026-07-29T15:00:00.000Z");

let seq = 0;
export const nextId = (prefix = "id") => `${prefix}-${++seq}`;

export const referencePolicy = ExponentialBackoff.of({
  baseDelayMs: 1000,
  maxDelayMs: 60_000,
  maxAttempts: 3,
});

export const openWallet = (initial = "100.00", overrides: { id?: string; playerId?: string } = {}) =>
  Wallet.open({
    id: overrides.id ?? "wallet-1",
    playerId: overrides.playerId ?? "player-1",
    initialBalance: brl(initial),
    openingTransactionId: nextId("tx"),
    openingLedgerEntryId: nextId("le"),
    at: T0,
  }).wallet;

export interface TxOverrides {
  kind?: WagerTransactionKind;
  amount?: string;
  currency?: string;
  externalTransactionId?: string;
  reference?: string;
  walletId?: string;
  playerId?: string;
  roundId?: string;
  providerId?: string;
}

export const wagerTx = (o: TxOverrides = {}) => {
  const fields = {
    providerId: o.providerId ?? "provider-a",
    externalTransactionId: o.externalTransactionId ?? nextId("ext"),
    playerId: o.playerId ?? "player-1",
    walletId: o.walletId ?? "wallet-1",
    roundId: o.roundId ?? "round-1",
    gameId: "fortune-chimp",
    kind: o.kind ?? WagerTransactionKind.Bet,
    money: Money.from({ amount: o.amount ?? "10.00", currency: o.currency ?? "BRL" }),
    referenceExternalTransactionId: o.reference,
  };
  return WagerTransaction.create({
    ...fields,
    id: nextId("tx"),
    idempotencyKey: `${fields.providerId}:${fields.externalTransactionId}`,
    payloadHash: computePayloadHash({ ...fields, money: fields.money.toJSON() }),
    createdAt: T0,
  });
};

export const ids = () => ({ ledgerEntryId: nextId("le"), systemEntryId: nextId("se") });
