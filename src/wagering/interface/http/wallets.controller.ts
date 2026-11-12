import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, Req } from "@nestjs/common";
import { CreateWallet } from "../../application/create-wallet";
import { WageringQueries } from "../../application/queries";
import { ReconcileWallet } from "../../application/reconcile-wallet";
import { parseCreateWalletCommand } from "../../application/wager-request";
import { type AuthenticatedRequest, RequireRoles } from "./auth/auth.guard";
import { Roles } from "./auth/principal";
import { limitParam, uuidParam } from "./params";
import { presentLedgerEntry, presentReconciliation, presentWallet } from "./presenters";

@Controller("wallets")
@RequireRoles(Roles.Operator)
export class WalletsController {
  constructor(
    @Inject(CreateWallet) private readonly createWallet: CreateWallet,
    @Inject(WageringQueries) private readonly queries: WageringQueries,
    @Inject(ReconcileWallet) private readonly reconcile: ReconcileWallet,
  ) {}

  @Post()
  @HttpCode(201)
  async create(@Body() body: unknown, @Req() req: AuthenticatedRequest) {
    const wallet = await this.createWallet.execute(parseCreateWalletCommand(body), req.correlationId ?? "");
    const { id, playerId, balance, version } = presentWallet(wallet);
    return { id, playerId, balance, version };
  }

  @Get(":walletId")
  async get(@Param("walletId") walletId: string) {
    return presentWallet(await this.queries.wallet(uuidParam(walletId, "walletId")));
  }

  @Get(":walletId/ledger")
  async ledger(
    @Param("walletId") walletId: string,
    @Query("cursor") cursor: string | undefined,
    @Query("limit") limit: string | undefined,
  ) {
    const page = await this.queries.ledger(
      uuidParam(walletId, "walletId"),
      cursor || undefined,
      limitParam(limit),
    );
    return { items: page.entries.map(presentLedgerEntry), nextCursor: page.nextCursor ?? null };
  }

  @Post(":walletId/reconciliation")
  @HttpCode(200)
  async reconciliation(@Param("walletId") walletId: string, @Req() req: AuthenticatedRequest) {
    return presentReconciliation(
      await this.reconcile.execute(uuidParam(walletId, "walletId"), req.correlationId ?? ""),
    );
  }
}
