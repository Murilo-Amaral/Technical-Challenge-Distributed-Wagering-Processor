import type { WagerTransaction } from "../domain/wager-transaction";
import type { Wallet } from "../domain/wallet";
import { NotFoundError } from "./errors";
import type { LedgerPage, UnitOfWork } from "./ports";

export class WageringQueries {
  constructor(private readonly uow: UnitOfWork) {}

  async wallet(walletId: string): Promise<Wallet> {
    const wallet = await this.uow.run((ctx) => ctx.wallets.findById(walletId), { name: "get_wallet" });
    if (!wallet) throw new NotFoundError("WALLET_NOT_FOUND", `Wallet ${walletId} not found`);
    return wallet;
  }

  async ledger(walletId: string, cursor: string | undefined, limit: number): Promise<LedgerPage> {
    return this.uow.run(
      async (ctx) => {
        const wallet = await ctx.wallets.findById(walletId);
        if (!wallet) throw new NotFoundError("WALLET_NOT_FOUND", `Wallet ${walletId} not found`);
        return ctx.ledger.listWalletEntries(walletId, cursor, limit);
      },
      { name: "get_ledger" },
    );
  }

  async transaction(transactionId: string): Promise<WagerTransaction> {
    const tx = await this.uow.run((ctx) => ctx.transactions.findById(transactionId), {
      name: "get_transaction",
    });
    if (!tx) throw new NotFoundError("TRANSACTION_NOT_FOUND", `Transaction ${transactionId} not found`);
    return tx;
  }

  async transactionByExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction> {
    const tx = await this.uow.run(
      (ctx) => ctx.transactions.findByProviderExternalId(providerId, externalTransactionId),
      {
        name: "get_transaction_by_external_id",
      },
    );
    if (!tx) throw new NotFoundError("TRANSACTION_NOT_FOUND", "Transaction not found");
    return tx;
  }
}
