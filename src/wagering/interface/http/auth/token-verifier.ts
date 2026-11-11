import { createRemoteJWKSet, type JWTPayload, jwtVerify } from "jose";
import type { Principal } from "./principal";
import { Roles } from "./principal";

export class UnauthorizedError extends Error {
  readonly code = "UNAUTHORIZED";
}

/** Port: turns a bearer token into a Principal. */
export interface TokenVerifier {
  verify(authorizationHeader: string | undefined): Promise<Principal>;
}

export const TOKEN_VERIFIER = Symbol("TOKEN_VERIFIER");

export interface OidcSettings {
  issuer: string;
  audience: string;
  jwksUrl: string;
  providerClaim: string;
}

/**
 * Validates Keycloak (OIDC) access tokens locally: signature against the realm JWKS (cached and refreshed by jose),
 * issuer, audience and expiry. No call to the IdP per request.
 */
export class OidcTokenVerifier implements TokenVerifier {
  private readonly jwks;

  constructor(private readonly settings: OidcSettings) {
    this.jwks = createRemoteJWKSet(new URL(settings.jwksUrl), {
      cooldownDuration: 30_000,
      timeoutDuration: 5_000,
    });
  }

  async verify(header: string | undefined): Promise<Principal> {
    const token = /^Bearer\s+(\S+)$/i.exec(header ?? "")?.[1];
    if (!token) throw new UnauthorizedError("Missing bearer token");
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(token, this.jwks, {
        issuer: this.settings.issuer,
        audience: this.settings.audience,
        clockTolerance: 5,
      }));
    } catch {
      throw new UnauthorizedError("Invalid or expired token");
    }
    const realmRoles = (payload.realm_access as { roles?: unknown } | undefined)?.roles;
    const roles = new Set(
      Array.isArray(realmRoles) ? realmRoles.filter((r): r is string => typeof r === "string") : [],
    );
    const providerClaim = payload[this.settings.providerClaim];
    return {
      subject: payload.sub ?? "unknown",
      providerId: typeof providerClaim === "string" ? providerClaim : undefined,
      roles,
      anonymous: false,
    };
  }
}

/** AUTH_MODE=disabled: explicit extension point, every caller is an anonymous operator. */
export class DisabledTokenVerifier implements TokenVerifier {
  async verify(): Promise<Principal> {
    return {
      subject: "anonymous",
      providerId: undefined,
      roles: new Set([Roles.Operator, Roles.Provider]),
      anonymous: true,
    };
  }
}
