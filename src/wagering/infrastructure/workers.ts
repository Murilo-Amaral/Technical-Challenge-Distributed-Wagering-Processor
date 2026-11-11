import type { AppLogger } from "../application/logger";

export interface PeriodicTask {
  name: string;
  intervalMs: number;
  /** Returns the amount of work done; when > 0 the next step runs immediately (drain mode). */
  step(): Promise<number>;
}

/** Runs periodic tasks (outbox relay, pending references) with graceful stop. */
export class PeriodicRunner {
  private stopped = true;
  private readonly loops: Promise<void>[] = [];
  private readonly wakeups = new Set<() => void>();

  constructor(
    private readonly tasks: PeriodicTask[],
    private readonly logger: AppLogger,
  ) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    for (const task of this.tasks) this.loops.push(this.loop(task));
    if (this.tasks.length)
      this.logger.info("background workers started", { tasks: this.tasks.map((t) => t.name) });
  }

  /** Lets the current step finish (it holds no long transaction) and stops scheduling new ones. */
  async stop(): Promise<void> {
    this.stopped = true;
    for (const wake of this.wakeups) wake();
    await Promise.allSettled(this.loops);
    this.loops.length = 0;
  }

  private async loop(task: PeriodicTask): Promise<void> {
    while (!this.stopped) {
      let worked = 0;
      try {
        worked = await task.step();
      } catch (error) {
        this.logger.warn("background task failed; will retry", { task: task.name, error: String(error) });
      }
      if (worked === 0 && !this.stopped) await this.sleep(task.intervalMs);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.wakeups.delete(done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.wakeups.add(done);
    });
  }
}
