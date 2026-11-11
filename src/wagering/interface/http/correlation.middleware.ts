import { randomUUID } from "node:crypto";
import type { NextFunction, Response } from "express";
import type { AuthenticatedRequest } from "./auth/auth.guard";

const VALID = /^[A-Za-z0-9._:-]{1,128}$/;

/** Propagates X-Correlation-Id (or creates one) so every log line and event of a request can be correlated. */
export function correlationMiddleware(req: AuthenticatedRequest, res: Response, next: NextFunction): void {
  const incoming = req.header("x-correlation-id");
  const correlationId = incoming && VALID.test(incoming) ? incoming : randomUUID();
  req.correlationId = correlationId;
  res.setHeader("X-Correlation-Id", correlationId);
  next();
}
