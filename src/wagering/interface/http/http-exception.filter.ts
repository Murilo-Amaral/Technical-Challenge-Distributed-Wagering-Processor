import { type ArgumentsHost, Catch, type ExceptionFilter, Inject } from "@nestjs/common";
import type { Response } from "express";
import { APP_LOGGER, type AppLogger } from "../../application/logger";
import type { AuthenticatedRequest } from "./auth/auth.guard";
import { mapError } from "./error-mapping";

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  constructor(@Inject(APP_LOGGER) private readonly logger: AppLogger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<AuthenticatedRequest>();
    const response = http.getResponse<Response>();
    const mapped = mapError(exception);
    const fields = {
      correlationId: request.correlationId,
      method: request.method,
      path: request.route?.path ?? request.path,
      status: mapped.status,
      code: mapped.body.error.code,
    };
    if (mapped.status >= 500) {
      this.logger.error("request failed", {
        ...fields,
        error: exception instanceof Error ? `${exception.name}: ${exception.message}` : String(exception),
      });
    } else {
      this.logger.info("request rejected", fields);
    }
    for (const [name, value] of Object.entries(mapped.headers ?? {})) response.setHeader(name, value);
    response.status(mapped.status).json(mapped.body);
  }
}
