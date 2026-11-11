import { WagerTransactionProcessed, WalletBalanceChanged } from "../domain/events/wagering-events";
import { LedgerJournal, SystemAccount } from "../domain/ledger";
import { OutboxMessage } from "../domain/outbox-message";
import { computePayloadHash } from "../domain/payload-hash";
import { WagerTransaction, WagerTransactionKind } from "../domain/wager-transaction";
import { Wallet } from "../domain/wallet";
import { UniqueViolationError, WalletAlreadyExistsError } from "./errors";
import type { AppLogger } from "./logger";
import type { Clock, IdGenerator, UnitOfWork } from "./ports";
import type { CreateWalletCommand } from "./wager-request";

export const INTERNAL_PROVIDER = "internal";

/**
 * Opens a wallet. A positive initial balance creates, in the same SQL transaction, an internal OPENING transaction,
 * its double-entry journal (wallet CREDIT / FUNDING DEBIT) and the corresponding outbox events.
 */
export class CreateWallet {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly logger: AppLogger,
  ) {}

  async execute(command: CreateWalletCommand, correlationId: string): Promise<Wallet> {
    try {
      return await this.uow.run(
        async (ctx) => {
          const now = this.clock.now();
          const walletId = this.ids.next();
          const openingTransactionId = this.ids.next();
          const { wallet, openingEntry } = Wallet.open({
            id: walletId,
            playerId: command.playerId,
            initialBalance: command.initialBalance,
            openingTransactionId,
            openingLedgerEntryId: this.ids.next(),
            at: now,
          });
          await ctx.wallets.insert(wallet);

          if (openingEntry) {
            const fields = {
              providerId: INTERNAL_PROVIDER,
              externalTransactionId: `opening:${walletId}`,
              playerId: wallet.playerId,
              walletId,
              roundId: "opening",
              gameId: "internal",
              kind: WagerTransactionKind.Opening,
              money: command.initialBalance.toJSON(),
            };
            const opening = WagerTransaction.create({
              ...fields,
              id: openingTransactionId,
              idempotencyKey: `${INTERNAL_PROVIDER}:opening:${walletId}`,
              payloadHash: computePayloadHash(fields),
              money: command.initialBalance,
              createdAt: now,
            });
            opening.markProcessed(undefined, now, wallet.balance);
            await ctx.transactions.insert(opening);
            await ctx.ledger.append(
              LedgerJournal.create({
                walletEntry: openingEntry,
                systemEntryId: this.ids.next(),
                contraAccount: SystemAccount.Funding,
              }),
            );
            const eventCtx = { correlationId, occurredAt: now, newEventId: () => this.ids.next() };
            await ctx.outbox.enqueue([
              OutboxMessage.enqueue(WalletBalanceChanged.from(wallet, openingEntry, eventCtx)),
              OutboxMessage.enqueue(WagerTransactionProcessed.from(opening, eventCtx)),
            ]);
          }
          this.logger.info("wallet opened", { correlationId, walletId, currency: wallet.currency });
          return wallet;
        },
        { name: "create_wallet" },
      );
    } catch (error) {
      if (error instanceof UniqueViolationError && error.constraint === "uq_wallets_player_currency") {
        throw new WalletAlreadyExistsError(`Player already has a ${command.initialBalance.currency} wallet`);
      }
      throw error;
    }
  }
}
