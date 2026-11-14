import type { Subprocess } from "bun";
import { TEST_SQS_ENDPOINT } from "./app";
import { TEST_DATABASE_URL } from "./db";

export interface Instance {
  name: string;
  baseUrl: string;
  process: Subprocess;
  exited: Promise<number | null>;
}

const LOG_DIR = process.env.TEST_INSTANCE_LOG_DIR;

/**
 * Starts a real service process (bun run src/main.ts) and waits until it reports ready. The port is random, so a
 * startup exit (e.g. port already taken) is retried on another port.
 */
export async function spawnInstance(
  name: string,
  env: Record<string, string>,
  attempts = 3,
): Promise<Instance> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await spawnOnce(name, env);
    } catch (error) {
      if (attempt >= attempts || !String(error).includes("exited during startup")) throw error;
    }
  }
}

async function spawnOnce(name: string, env: Record<string, string>): Promise<Instance> {
  const port = 20_000 + Math.floor(Math.random() * 20_000);
  const proc = Bun.spawn(["bun", "run", "src/main.ts"], {
    env: {
      ...process.env,
      NODE_ENV: "test",
      PORT: String(port),
      INSTANCE_ID: name,
      LOG_LEVEL: LOG_DIR ? "info" : "error",
      DATABASE_URL: TEST_DATABASE_URL,
      DB_POOL_SIZE: "8",
      SQS_ENDPOINT: TEST_SQS_ENDPOINT,
      AWS_REGION: "us-east-1",
      AWS_ACCESS_KEY_ID: "test",
      AWS_SECRET_ACCESS_KEY: "test",
      AUTH_MODE: "disabled",
      WORKERS: "consumer,outbox,pending-references",
      CONSUMER_WAIT_TIME_S: "1",
      OUTBOX_POLL_MS: "200",
      PENDING_REF_POLL_MS: "300",
      PENDING_REF_BASE_DELAY_MS: "500",
      SHUTDOWN_GRACE_MS: "10000",
      ...env,
    },
    stdout: LOG_DIR ? Bun.file(`${LOG_DIR}/${name}.log`) : "ignore",
    stderr: LOG_DIR ? Bun.file(`${LOG_DIR}/${name}.err.log`) : "ignore",
  });
  const instance: Instance = {
    name,
    baseUrl: `http://127.0.0.1:${port}`,
    process: proc,
    exited: proc.exited,
  };
  const deadline = Date.now() + 30_000;
  for (;;) {
    if (proc.exitCode !== null) throw new Error(`${name} exited during startup (${proc.exitCode})`);
    const ok = await fetch(`${instance.baseUrl}/health/ready`)
      .then((r) => r.ok)
      .catch(() => false);
    if (ok) return instance;
    if (Date.now() > deadline) {
      proc.kill("SIGKILL");
      throw new Error(`${name} did not become ready`);
    }
    await new Promise((r) => setTimeout(r, 200));
  }
}

export async function stopInstance(
  instance: Instance,
  signal: NodeJS.Signals = "SIGTERM",
): Promise<number | null> {
  if (instance.process.exitCode === null) instance.process.kill(signal);
  return instance.exited;
}

export async function postJson(
  baseUrl: string,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}
