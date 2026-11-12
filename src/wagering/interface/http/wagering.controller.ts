import { Body, Controller, Get, Headers, Inject, Param, Post, Req, Res } from "@nestjs/common";
import type { Response } from "express";
import { WageringQueries } from "../../application/queries";
import { SubmitWagerTransaction } from "../../application/submit-wager-transaction";
import { parseWagerCommand } from "../../application/wager-request";
import { type AuthenticatedRequest, RequireRoles } from "./auth/auth.guard";
import { Roles } from "./auth/principal";
import { assertActsAsProvider } from "./auth/provider-identity";
import { tokenParam, uuidParam } from "./params";
import { presentSubmission, presentTransaction, submissionStatus } from "./presenters";

@Controller()
@RequireRoles(Roles.Provider, Roles.Operator)
export class WageringController {
  constructor(
    @Inject(SubmitWagerTransaction) private readonly submit: SubmitWagerTransaction,
    @Inject(WageringQueries) private readonly queries: WageringQueries,
  ) {}

  @Post("wagering/transactions")
  async create(
    @Body() body: unknown,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Req() req: AuthenticatedRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    const command = parseWagerCommand(body, idempotencyKey);
    assertActsAsProvider(req.principal!, command.providerId);
    const result = await this.submit.execute(command, {
      source: "http",
      correlationId: req.correlationId ?? "",
    });
    if (result.type !== "result") {
      throw new Error("HTTP submissions never go through the inbox");
    }
    res.status(submissionStatus(result.transaction, result.idempotentReplay));
    return presentSubmission(result.transaction, result.idempotentReplay);
  }

  @Get("wagering/transactions/:transactionId")
  async get(@Param("transactionId") transactionId: string, @Req() req: AuthenticatedRequest) {
    const tx = await this.queries.transaction(uuidParam(transactionId, "transactionId"));
    assertActsAsProvider(req.principal!, tx.providerId);
    return presentTransaction(tx);
  }

  @Get("providers/:providerId/wagering/transactions/:externalTransactionId")
  async getByExternalId(
    @Param("providerId") providerId: string,
    @Param("externalTransactionId") externalTransactionId: string,
    @Req() req: AuthenticatedRequest,
  ) {
    assertActsAsProvider(req.principal!, tokenParam(providerId, "providerId"));
    return presentTransaction(
      await this.queries.transactionByExternalId(
        providerId,
        tokenParam(externalTransactionId, "externalTransactionId"),
      ),
    );
  }
}
