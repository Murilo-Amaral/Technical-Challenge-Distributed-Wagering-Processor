import { Controller, Get, Header, Inject, Res } from "@nestjs/common";
import type { Response } from "express";
import { Public } from "./auth/auth.guard";

export interface ReadinessProbe {
  name: string;
  check(): Promise<void>;
}

export const READINESS_PROBES = Symbol("READINESS_PROBES");
export const METRICS_REGISTRY = Symbol("METRICS_REGISTRY");

const withTimeout = <T>(promise: Promise<T>, ms: number) =>
  Promise.race([
    promise,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), ms)),
  ]);

@Controller()
@Public()
export class HealthController {
  constructor(
    @Inject(READINESS_PROBES) private readonly probes: ReadinessProbe[],
    @Inject(METRICS_REGISTRY) private readonly registry: { metrics(): Promise<string>; contentType: string },
  ) {}

  /** Liveness: the process and its event loop respond. No dependency checks (a DB outage must not restart pods). */
  @Get("health/live")
  live() {
    return { status: "ok" };
  }

  /** Readiness: PostgreSQL and SQS reachable. */
  @Get("health/ready")
  async ready(@Res({ passthrough: true }) res: Response) {
    const results = await Promise.all(
      this.probes.map(async (probe) => {
        try {
          await withTimeout(probe.check(), 2000);
          return [probe.name, "up"] as const;
        } catch {
          return [probe.name, "down"] as const;
        }
      }),
    );
    const checks = Object.fromEntries(results);
    const ok = results.every(([, state]) => state === "up");
    res.status(ok ? 200 : 503);
    return { status: ok ? "ok" : "unavailable", checks };
  }

  @Get("metrics")
  @Header("Cache-Control", "no-store")
  async metrics(@Res() res: Response) {
    res.setHeader("Content-Type", this.registry.contentType);
    res.send(await this.registry.metrics());
  }
}
