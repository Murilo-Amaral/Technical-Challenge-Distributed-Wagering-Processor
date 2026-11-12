/**
 * Stable, machine-readable reasons persisted on REJECTED / FAILED transactions.
 * The provider can decide what to do from the code alone (see ARCHITECTURE.md, "Failure codes").
 */
export enum FailureCode {
  /** BET larger than the available balance. Retrying the same payload will not help unless funds change. */
  InsufficientFunds = "INSUFFICIENT_FUNDS",
  /** A ROLLBACK of a credit (WIN/REFUND) would make the balance negative. Needs operational follow-up. */
  ReversalInsufficientFunds = "REVERSAL_INSUFFICIENT_FUNDS",
  /** Operation currency differs from the wallet currency. Fix the payload. */
  CurrencyMismatch = "CURRENCY_MISMATCH",
  /** playerId does not own walletId. Fix the payload. */
  PlayerWalletMismatch = "PLAYER_WALLET_MISMATCH",
  /** Referenced transaction never arrived within the retry window. */
  ReferenceNotFound = "REFERENCE_NOT_FOUND",
  /** Reference has a kind this operation cannot point to (e.g. REFUND of a WIN). */
  ReferenceKindNotAllowed = "REFERENCE_KIND_NOT_ALLOWED",
  /** Reference belongs to another player, wallet, currency or round. */
  ReferenceContextMismatch = "REFERENCE_CONTEXT_MISMATCH",
  /** Reference exists but was REJECTED/FAILED, so there is nothing to reverse or settle. */
  ReferenceNotProcessed = "REFERENCE_NOT_PROCESSED",
  /** Reference was already reversed (by a REFUND or a ROLLBACK). */
  ReferenceAlreadyReversed = "REFERENCE_ALREADY_REVERSED",
  /** REFUND/ROLLBACK amount differs from the reference amount (partial reversal is out of scope). */
  AmountMismatch = "AMOUNT_MISMATCH",
  /** Permanent processing error (status FAILED). Kept for audit; requires manual investigation. */
  ProcessingFailed = "PROCESSING_FAILED",
}
