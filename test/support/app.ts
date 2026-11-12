import { type Application, createApplication } from "../../src/bootstrap/application";
import { loadConfig } from "../../src/config/app-config";
import { TEST_DATABASE_URL } from "./db";

export const TEST_SQS_ENDPOINT = process.env.TEST_SQS_ENDPOINT ?? "http://localhost:4566";

/** Starts the real application (Nest + PostgreSQL + LocalStack) on a random port. */
export async function startTestApp(
  env: Record<string, string> = {},
): Promise<Application & { baseUrl: string }> {
  const config = loadConfig({
    NODE_ENV: "test",
    LOG_LEVEL: "silent",
    DATABASE_URL: TEST_DATABASE_URL,
    SQS_ENDPOINT: TEST_SQS_ENDPOINT,
    AWS_REGION: "us-east-1",
    AWS_ACCESS_KEY_ID: "test",
    AWS_SECRET_ACCESS_KEY: "test",
    WORKERS: "",
    ...env,
  });
  process.env.AWS_ACCESS_KEY_ID ??= "test";
  process.env.AWS_SECRET_ACCESS_KEY ??= "test";
  const application = await createApplication(config);
  await application.app.listen(0);
  const address = application.app.getHttpServer().address() as { port: number };
  return { ...application, baseUrl: `http://127.0.0.1:${address.port}` };
}
