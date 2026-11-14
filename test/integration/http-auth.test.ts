import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { exportJWK, generateKeyPair, type JWK, SignJWT } from "jose";
import type { Application } from "../../src/bootstrap/application";
import { startTestApp } from "../support/app";
import { resetDatabase } from "../support/db";

/**
 * AUTH_MODE=keycloak against a local OIDC issuer: real RS256 keys and a real JWKS endpoint, so signature, issuer,
 * audience, expiry, roles and the provider_id claim are verified exactly as with Keycloak (which issues the same
 * token shape, see infra/keycloak/realm-wagering.json).
 */
const ISSUER = "http://issuer.test/realms/wagering";
let app: Application & { baseUrl: string };
let jwksServer: ReturnType<typeof Bun.serve>;
let privateKey: CryptoKey;
let foreignKey: CryptoKey;

const token = async (
  claims: Record<string, unknown>,
  opts: { key?: CryptoKey; audience?: string; issuer?: string; exp?: string } = {},
) =>
  new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .setIssuer(opts.issuer ?? ISSUER)
    .setAudience(opts.audience ?? "wagering-api")
    .setSubject("service-account")
    .setIssuedAt()
    .setExpirationTime(opts.exp ?? "5m")
    .sign(opts.key ?? privateKey);

const providerToken = (providerId: string, opts = {}) =>
  token({ provider_id: providerId, realm_access: { roles: ["wagering-provider"] } }, opts);
const operatorToken = () => token({ realm_access: { roles: ["wagering-operator"] } });

const call = (path: string, bearer: string | undefined, init: RequestInit = {}) =>
  fetch(`${app.baseUrl}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      ...(init.headers ?? {}),
    },
  });

beforeAll(async () => {
  await resetDatabase();
  const pair = await generateKeyPair("RS256");
  privateKey = pair.privateKey;
  foreignKey = (await generateKeyPair("RS256")).privateKey;
  const jwk: JWK = { ...(await exportJWK(pair.publicKey)), kid: "test-key", alg: "RS256", use: "sig" };
  jwksServer = Bun.serve({ port: 0, fetch: () => Response.json({ keys: [jwk] }) });
  app = await startTestApp({
    AUTH_MODE: "keycloak",
    OIDC_ISSUER_URL: ISSUER,
    OIDC_JWKS_URL: `http://127.0.0.1:${jwksServer.port}/certs`,
    OIDC_AUDIENCE: "wagering-api",
  });
});

afterAll(async () => {
  await app?.close();
  jwksServer?.stop(true);
});

describe("OIDC authentication (Keycloak mode)", () => {
  test("health stays open without a token", async () => {
    expect((await call("/health/live", undefined)).status).toBe(200);
  });

  test("missing, forged, expired or wrong-audience tokens are 401", async () => {
    expect((await call("/wallets/00000000-0000-7000-8000-000000000000", undefined)).status).toBe(401);
    expect((await call("/wallets/x", await providerToken("provider-a", { key: foreignKey }))).status).toBe(
      401,
    );
    expect((await call("/wallets/x", await providerToken("provider-a", { audience: "other" }))).status).toBe(
      401,
    );
    expect(
      (await call("/wallets/x", await providerToken("provider-a", { issuer: "http://evil" }))).status,
    ).toBe(401);
    expect((await call("/wallets/x", await providerToken("provider-a", { exp: "-1m" }))).status).toBe(401);
  });

  test("an unreachable JWKS endpoint is a retryable 503, not 401", async () => {
    const down = await startTestApp({
      AUTH_MODE: "keycloak",
      OIDC_ISSUER_URL: ISSUER,
      OIDC_JWKS_URL: "http://127.0.0.1:1/certs",
      OIDC_AUDIENCE: "wagering-api",
    });
    try {
      const res = await fetch(`${down.baseUrl}/wallets/00000000-0000-7000-8000-000000000000`, {
        headers: { authorization: `Bearer ${await operatorToken()}` },
      });
      expect(res.status).toBe(503);
    } finally {
      await down.close();
    }
  });

  test("roles: providers cannot manage wallets, operators can", async () => {
    const body = JSON.stringify({
      playerId: crypto.randomUUID(),
      initialBalance: { amount: "10.00", currency: "BRL" },
    });
    const asProvider = await call("/wallets", await providerToken("provider-a"), { method: "POST", body });
    expect(asProvider.status).toBe(403);
    const asOperator = await call("/wallets", await operatorToken(), { method: "POST", body });
    expect(asOperator.status).toBe(201);
  });

  test("a provider can only submit and read transactions of its own providerId", async () => {
    const wallet = (await (
      await call("/wallets", await operatorToken(), {
        method: "POST",
        body: JSON.stringify({
          playerId: crypto.randomUUID(),
          initialBalance: { amount: "100.00", currency: "BRL" },
        }),
      })
    ).json()) as { id: string; playerId: string };
    const bet = {
      providerId: "provider-a",
      externalTransactionId: "auth-bet-1",
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: "r",
      gameId: "g",
      kind: "BET",
      money: { amount: "10.00", currency: "BRL" },
    };
    const headers = { "Idempotency-Key": "provider-a:auth-bet-1" };
    const impostor = await call("/wagering/transactions", await providerToken("provider-b"), {
      method: "POST",
      body: JSON.stringify(bet),
      headers,
    });
    expect(impostor.status).toBe(403);
    expect(((await impostor.json()) as { error: { code: string } }).error.code).toBe("PROVIDER_FORBIDDEN");

    const owner = await call("/wagering/transactions", await providerToken("provider-a"), {
      method: "POST",
      body: JSON.stringify(bet),
      headers,
    });
    expect(owner.status).toBe(201);
    const { transactionId } = (await owner.json()) as { transactionId: string };

    // Another provider gets the same answer as for a missing id (no existence probing).
    expect(
      (await call(`/wagering/transactions/${transactionId}`, await providerToken("provider-b"))).status,
    ).toBe(404);
    expect(
      (await call(`/wagering/transactions/${transactionId}`, await providerToken("provider-a"))).status,
    ).toBe(200);
    expect(
      (
        await call(
          "/providers/provider-a/wagering/transactions/auth-bet-1",
          await providerToken("provider-b"),
        )
      ).status,
    ).toBe(403);
  });
});
