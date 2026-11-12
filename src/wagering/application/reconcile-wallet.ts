import type { Money } from "../domain/money";
import { NotFoundError } from "./errors";
import type { AppLogger } from "./logger";
import type { Metrics } from "./metrics";
import type { UnitOfWork } from "./ports";

export interface ReconciliationReport {
  walletId: string;
  storedBalance: Money;
  calculatedBalance: Money;
  difference: Money;
  consistent: boolean;
  checkedEntries: number;
}

/**
 * Compares the materialized balance with the balance rebuilt from the ledger (Σ credits − Σ debits).
 * Both reads run on one REPEATABLE READ snapshot so a concurrent commit cannot produce a false divergence.
 * Divergences are never corrected here: they are logged, counted and reported.
 */
export class ReconcileWallet {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly metrics: Metrics,
    private readonly logger: AppLogger,
  ) {}

  async execute(walletId: string, correlationId: string): Promise<ReconciliationReport> {
    const report = await this.uow.run(
      async (ctx) => {
        const wallet = await ctx.wallets.findById(walletId);
        if (!wallet) throw new NotFoundError("WALLET_NOT_FOUND", `Wallet ${walletId} not found`);
        const totals = await ctx.ledger.walletTotals(walletId, wallet.currency);
        const difference = wallet.balance.subtract(totals.calculatedBalance);
        return {
          walletId,
          storedBalance: wallet.balance,
          calculatedBalance: totals.calculatedBalance,
          difference,
          consistent: difference.isZero(),
          checkedEntries: totals.entries,
        };
      },
      { name: "reconcile_wallet", isolation: "REPEATABLE READ" },
    );
    this.metrics.reconciliation({ consistent: report.consistent });
    if (!report.consistent) {
      this.logger.error("wallet balance diverges from ledger", {
        correlationId,
        walletId,
        difference: report.difference.amount,
        checkedEntries: report.checkedEntries,
      });
    }
    return report;
  }
}
