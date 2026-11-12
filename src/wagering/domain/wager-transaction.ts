import { InvalidTransactionStateError, InvalidWagerTransactionError } from "./errors";
import type { FailureCode } from "./failure-code";
import { LedgerDirection, oppositeDirection } from "./ledger";
import type { Money } from "./money";
import type { ExponentialBackoff } from "./retry-policy";

export enum WagerTransactionKind {
  /** Internal: opening credit of a wallet. Never accepted from the API or the queue. */
  Opening = "OPENING",
  Bet = "BET",
  Win = "WIN",
  Loss = "LOSS",
  Refund = "REFUND",
  Rollback = "ROLLBACK",
}

export enum WagerTransactionStatus {
  Pending = "PENDING",
  PendingReference = "PENDING_REFERENCE",
  Processed = "PROCESSED",
  Rejected = "REJECTED",
  Failed = "FAILED",
}

const S = WagerTransactionStatus;

/**
 * The state machine. Terminal states have no outgoing transitions.
 * PENDING_REFERENCE -> PENDING_REFERENCE is the "rescheduled, still waiting" self-loop.
 * The same table is enforced by a trigger in the database (see migrations).
 */
export const WAGER_TRANSITIONS: Readonly<Record<WagerTransactionStatus, readonly WagerTransactionStatus[]>> =
  {
    [S.Pending]: [S.Processed, S.PendingReference, S.Rejected, S.Failed],
    [S.PendingReference]: [S.PendingReference, S.Processed, S.Rejected, S.Failed],
    [S.Processed]: [],
    [S.Rejected]: [],
    [S.Failed]: [],
  };

export const canTransition = (from: WagerTransactionStatus, to: WagerTransactionStatus): boolean =>
  WAGER_TRANSITIONS[from].includes(to);

/** Which reference kinds each operation may point to. */
const ALLOWED_REFERENCE_KINDS: Readonly<
  Partial<Record<WagerTransactionKind, readonly WagerTransactionKind[]>>
> = {
  [WagerTransactionKind.Win]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Loss]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Refund]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Rollback]: [
    WagerTransactionKind.Bet,
    WagerTransactionKind.Win,
    WagerTransactionKind.Refund,
  ],
};

export const REVERSAL_KINDS: readonly WagerTransactionKind[] = [
  WagerTransactionKind.Refund,
  WagerTransactionKind.Rollback,
];

export interface CreateWagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string | undefined;
  createdAt: Date;
}

export interface WagerTransactionState extends CreateWagerTransactionProps {
  status: WagerTransactionStatus;
  referenceTransactionId?: string | undefined;
  failureCode?: FailureCode | undefined;
  processedAt?: Date | undefined;
  /** Balance observed when the transaction reached its current status (returned on replays). */
  resultBalance?: Money | undefined;
  referenceAttempts: number;
  nextReferenceAttemptAt?: Date | undefined;
  updatedAt: Date;
}

export class WagerTransaction {
  private constructor(
    public readonly id: string,
    public readonly providerId: string,
    public readonly externalTransactionId: string,
    public readonly idempotencyKey: string,
    public readonly payloadHash: string,
    public readonly walletId: string,
    public readonly playerId: string,
    public readonly roundId: string,
    public readonly gameId: string,
    public readonly kind: WagerTransactionKind,
    public readonly money: Money,
    /** Provider-side id of the referenced transaction — not the internal id. */
    public readonly referenceExternalTransactionId: string | undefined,
    public readonly createdAt: Date,
    private _status: WagerTransactionStatus,
    private _referenceTransactionId: string | undefined,
    private _failureCode: FailureCode | undefined,
    private _processedAt: Date | undefined,
    private _resultBalance: Money | undefined,
    private _referenceAttempts: number,
    private _nextReferenceAttemptAt: Date | undefined,
    private _updatedAt: Date,
  ) {}

  /** Born PENDING. Validates the reference requirement per kind and the amount sign. */
  static create(props: CreateWagerTransactionProps): WagerTransaction {
    const reference = props.referenceExternalTransactionId?.trim() || undefined;
    const requiresReference = REVERSAL_KINDS.includes(props.kind);
    if (requiresReference && !reference) {
      throw new InvalidWagerTransactionError(`${props.kind} requires referenceExternalTransactionId`);
    }
    if (props.kind === WagerTransactionKind.Bet && reference) {
      throw new InvalidWagerTransactionError("BET cannot reference another transaction");
    }
    if (props.money.isNegative()) {
      throw new InvalidWagerTransactionError("Amount cannot be negative");
    }
    if (props.money.isZero() && props.kind !== WagerTransactionKind.Loss) {
      throw new InvalidWagerTransactionError(`${props.kind} amount must be greater than zero`);
    }
    return new WagerTransaction(
      props.id,
      props.providerId,
      props.externalTransactionId,
      props.idempotencyKey,
      props.payloadHash,
      props.walletId,
      props.playerId,
      props.roundId,
      props.gameId,
      props.kind,
      props.money,
      reference,
      props.createdAt,
      S.Pending,
      undefined,
      undefined,
      undefined,
      undefined,
      0,
      undefined,
      props.createdAt,
    );
  }

  /** Reconstruction from persistence: does not re-validate transitions. */
  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(
      state.id,
      state.providerId,
      state.externalTransactionId,
      state.idempotencyKey,
      state.payloadHash,
      state.walletId,
      state.playerId,
      state.roundId,
      state.gameId,
      state.kind,
      state.money,
      state.referenceExternalTransactionId,
      state.createdAt,
      state.status,
      state.referenceTransactionId,
      state.failureCode,
      state.processedAt,
      state.resultBalance,
      state.referenceAttempts,
      state.nextReferenceAttemptAt,
      state.updatedAt,
    );
  }

  get status(): WagerTransactionStatus {
    return this._status;
  }
  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }
  get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }
  get processedAt(): Date | undefined {
    return this._processedAt;
  }
  get resultBalance(): Money | undefined {
    return this._resultBalance;
  }
  get referenceAttempts(): number {
    return this._referenceAttempts;
  }
  get nextReferenceAttemptAt(): Date | undefined {
    return this._nextReferenceAttemptAt;
  }
  get updatedAt(): Date {
    return this._updatedAt;
  }

  // ---- transitions -------------------------------------------------------------------------------

  markProcessed(referenceTransactionId: string | undefined, at: Date, balanceAfter: Money): void {
    this.transitionTo(S.Processed);
    this._referenceTransactionId = referenceTransactionId;
    this._processedAt = at;
    this._resultBalance = balanceAfter;
    this._nextReferenceAttemptAt = undefined;
    this._updatedAt = at;
  }

  /**
   * Parks the transaction until its reference shows up. Each call counts one resolution attempt and
   * schedules the next one using the backoff policy.
   */
  markPendingReference(at: Date, policy: ExponentialBackoff, observedBalance: Money): void {
    this.transitionTo(S.PendingReference);
    this._referenceAttempts += 1;
    this._nextReferenceAttemptAt = policy.nextAttemptAt(this._referenceAttempts, at);
    this._resultBalance = observedBalance;
    this._updatedAt = at;
  }

  reject(code: FailureCode, at: Date, observedBalance: Money | undefined): void {
    this.transitionTo(S.Rejected);
    this._failureCode = code;
    this._resultBalance = observedBalance;
    this._nextReferenceAttemptAt = undefined;
    this._updatedAt = at;
  }

  fail(code: FailureCode, at: Date): void {
    this.transitionTo(S.Failed);
    this._failureCode = code;
    this._nextReferenceAttemptAt = undefined;
    this._updatedAt = at;
  }

  // ---- domain queries ----------------------------------------------------------------------------

  isTerminal(): boolean {
    return WAGER_TRANSITIONS[this._status].length === 0;
  }

  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  requiresReference(): boolean {
    return REVERSAL_KINDS.includes(this.kind);
  }

  /** True when the transaction must be resolved against another one before being applied. */
  needsReferenceResolution(): boolean {
    return this.referenceExternalTransactionId !== undefined;
  }

  isReversal(): boolean {
    return REVERSAL_KINDS.includes(this.kind);
  }

  canReference(kind: WagerTransactionKind): boolean {
    return ALLOWED_REFERENCE_KINDS[this.kind]?.includes(kind) ?? false;
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  /** Direction of this transaction's effect on the wallet. ROLLBACK inverts its reference. */
  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    switch (this.kind) {
      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
      case WagerTransactionKind.Opening:
        return LedgerDirection.Credit;
      case WagerTransactionKind.Rollback:
        if (!reference) {
          throw new InvalidWagerTransactionError("ROLLBACK direction depends on its reference");
        }
        return oppositeDirection(reference.ledgerDirectionFor());
      case WagerTransactionKind.Loss:
        throw new InvalidWagerTransactionError("LOSS does not move the balance");
    }
  }

  private transitionTo(next: WagerTransactionStatus): void {
    if (!canTransition(this._status, next)) {
      throw new InvalidTransactionStateError(
        `Transaction ${this.id} cannot go from ${this._status} to ${next}`,
      );
    }
    this._status = next;
  }
}
