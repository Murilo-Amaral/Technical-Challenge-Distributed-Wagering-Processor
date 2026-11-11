import "reflect-metadata";
import { createApplication } from "./bootstrap/application";
import { loadConfig } from "./config/app-config";

const config = loadConfig();
const application = await createApplication(config);
await application.app.listen(config.PORT);
application.container.logger.info("wagering service started", {
  port: config.PORT,
  workers: [...config.workers],
});

let shuttingDown = false;
const shutdown = async (signal: string) => {
  if (shuttingDown) return;
  shuttingDown = true;
  application.container.logger.info("shutdown requested", { signal });
  try {
    await application.close();
    process.exit(0);
  } catch (error) {
    application.container.logger.error("shutdown failed", { error: String(error) });
    process.exit(1);
  }
};
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
