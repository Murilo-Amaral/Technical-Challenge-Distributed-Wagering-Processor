/** Authenticated caller, derived from the access token issued by the Identity Provider (Keycloak). */
export interface Principal {
  subject: string;
  /** Provider identity bound to the client (claim `provider_id`), when the caller is a game provider. */
  providerId: string | undefined;
  roles: ReadonlySet<string>;
  /** True when AUTH_MODE=disabled (local development / tests). */
  anonymous: boolean;
}

export const Roles = {
  /** Game providers: submit and read their own wager transactions. */
  Provider: "wagering-provider",
  /** Back-office: wallets, ledger, reconciliation, any transaction. */
  Operator: "wagering-operator",
} as const;

export type Role = (typeof Roles)[keyof typeof Roles];
