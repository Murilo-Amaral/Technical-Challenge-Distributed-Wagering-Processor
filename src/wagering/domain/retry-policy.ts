export interface RetryPolicyProps {
  /** Delay before the first retry, in milliseconds. */
  baseDelayMs: number;
  /** Upper bound for a single delay, in milliseconds. */
  maxDelayMs: number;
  /** Total attempts allowed (the first attempt included). */
  maxAttempts: number;
}

/** Deterministic exponential backoff: base * 2^(attempt-1), capped at maxDelayMs. */
export class ExponentialBackoff {
  private constructor(private readonly props: RetryPolicyProps) {}

  static of(props: RetryPolicyProps): ExponentialBackoff {
    if (props.baseDelayMs <= 0 || props.maxDelayMs < props.baseDelayMs || props.maxAttempts < 1) {
      throw new Error("Invalid retry policy");
    }
    return new ExponentialBackoff({ ...props });
  }

  get maxAttempts(): number {
    return this.props.maxAttempts;
  }

  /** Delay to wait after `attempt` attempts have already failed (attempt >= 1). */
  delayAfter(attempt: number): number {
    const exponent = Math.max(0, attempt - 1);
    return Math.min(this.props.baseDelayMs * 2 ** exponent, this.props.maxDelayMs);
  }

  nextAttemptAt(attempt: number, now: Date): Date {
    return new Date(now.getTime() + this.delayAfter(attempt));
  }

  isExhausted(attempts: number): boolean {
    return attempts >= this.props.maxAttempts;
  }
}
