import { ProviderForbiddenError } from "../../../application/errors";
import { type Principal, Roles } from "./principal";

/**
 * ProviderIdentityPolicy: a provider may only act on its own transactions. The providerId in the payload must equal
 * the identity bound to the authenticated client. Operators (back-office) may act on any provider.
 * Queue messages are an internal trusted channel (no token), but their providerId still goes through the same
 * domain validations (reference resolution is scoped by provider).
 */
export function assertActsAsProvider(principal: Principal, providerId: string): void {
  if (principal.anonymous || principal.roles.has(Roles.Operator)) return;
  if (principal.providerId !== undefined && principal.providerId === providerId) return;
  throw new ProviderForbiddenError("Authenticated client is not allowed to act for this provider");
}
