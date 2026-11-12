import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Application } from "../../src/bootstrap/application";
import { startTestApp } from "../support/app";
import { resetDatabase } from "../support/db";

/**
 * Against the real Keycloak from docker compose. Runs only when KEYCLOAK_ADMIN_PASSWORD is set and Keycloak answers;
 * otherwise skipped (the same rules are covered with a local OIDC issuer in http-auth.test.ts).
 */
const KC = process.env.KEYCLOAK_URL ?? "http://localhost:8080";
const ADMIN_PASSWORD = process.env.KEYCLOAK_ADMIN_PASSWORD;

const reachable = ADMIN_PASSWORD
  ? await fetch(`${KC}/realms/wagering/.well-known/openid-configuration`, {
      signal: AbortSignal.timeout(2000),
    })
      .then((r) => r.ok)
      .catch(() => false)
  : false;

const form = (data: Record<string, string>) => ({
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams(data),
});

async function clientToken(clientId: string): Promise<string> {
  const admin = (await (
    await fetch(
      `${KC}/realms/master/protocol/openid-connect/token`,
      form({ grant_type: "password", client_id: "admin-cli", username: "admin", password: ADMIN_PASSWORD! }),
    )
  ).json()) as { access_token: string };
  const auth = { headers: { authorization: `Bearer ${admin.access_token}` } };
  const [client] = (await (
    await fetch(`${KC}/admin/realms/wagering/clients?clientId=${clientId}`, auth)
  ).json()) as Array<{
    id: string;
  }>;
  const { value } = (await (
    await fetch(`${KC}/admin/realms/wagering/clients/${client!.id}/client-secret`, auth)
  ).json()) as {
    value: string;
  };
  const token = (await (
    await fetch(
      `${KC}/realms/wagering/protocol/openid-connect/token`,
      form({ grant_type: "client_credentials", client_id: clientId, client_secret: value }),
    )
  ).json()) as { access_token: string };
  return token.access_token;
}

describe.skipIf(!reachable)("Keycloak end-to-end", () => {
  let app: Application & { baseUrl: string };

  beforeAll(async () => {
    await resetDatabase();
    app = await startTestApp({
      AUTH_MODE: "keycloak",
      OIDC_ISSUER_URL: `${KC}/realms/wagering`,
      OIDC_AUDIENCE: "wagering-api",
    });
  });

  afterAll(async () => {
    await app?.close();
  });

  test("client_credentials tokens from Keycloak drive roles and provider identity", async () => {
    const [providerA, providerB, operator] = await Promise.all(
      ["provider-a", "provider-b", "backoffice"].map(clientToken),
    );
    const call = (path: string, token: string, init: RequestInit = {}) =>
      fetch(`${app.baseUrl}${path}`, {
        ...init,
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
          ...(init.headers ?? {}),
        },
      });

    const walletBody = JSON.stringify({
      playerId: crypto.randomUUID(),
      initialBalance: { amount: "50.00", currency: "BRL" },
    });
    expect((await call("/wallets", providerA!, { method: "POST", body: walletBody })).status).toBe(403);
    const created = await call("/wallets", operator!, { method: "POST", body: walletBody });
    expect(created.status).toBe(201);
    const wallet = (await created.json()) as { id: string; playerId: string };

    const bet = JSON.stringify({
      providerId: "provider-a",
      externalTransactionId: "kc-e2e-1",
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: "r",
      gameId: "g",
      kind: "BET",
      money: { amount: "5.00", currency: "BRL" },
    });
    const headers = { "Idempotency-Key": "provider-a:kc-e2e-1" };
    expect(
      (await call("/wagering/transactions", providerB!, { method: "POST", body: bet, headers })).status,
    ).toBe(403);
    expect(
      (await call("/wagering/transactions", providerA!, { method: "POST", body: bet, headers })).status,
    ).toBe(201);
  });
});
