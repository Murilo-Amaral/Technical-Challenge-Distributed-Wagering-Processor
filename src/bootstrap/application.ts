import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import type { AppConfig } from "../config/app-config";
import { WageringModule } from "../wagering/wagering.module";
import { buildContainer, type Container } from "./container";

export interface Application {
  app: NestExpressApplication;
  container: Container;
  /** Graceful stop: HTTP server, then background workers, then pools. */
  close(): Promise<void>;
}

export async function createApplication(config: AppConfig): Promise<Application> {
  const container = await buildContainer(config);
  const app = await NestFactory.create<NestExpressApplication>(WageringModule.forRoot(container), {
    logger: false,
    bodyParser: false,
  });
  app.useBodyParser("json", { limit: "64kb" });
  let closed = false;
  return {
    app,
    container,
    async close() {
      if (closed) return;
      closed = true;
      await app.close();
      await container.dataSource.destroy().catch(() => {});
      container.sqs.destroy();
    },
  };
}
