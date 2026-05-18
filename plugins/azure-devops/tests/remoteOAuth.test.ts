import { describe, expect, it } from "vitest";

import { encryptSecret } from "../src/crypto.js";
import {
  codeChallengeS256,
  parseMicrosoftIdentity,
  parseMicrosoftTokenResponse,
  RemoteAdoAuthProvider
} from "../src/remoteOAuth.js";
import { RemoteServiceConfig } from "../src/remoteConfig.js";
import { SqliteRemoteStore } from "../src/remoteStore.js";

const key = Buffer.from("12345678901234567890123456789012", "utf8");

const config: RemoteServiceConfig = {
  publicBaseUrl: "https://plugin.example",
  microsoftClientId: "client",
  microsoftClientSecret: "secret",
  microsoftTenant: "organizations",
  sessionSecret: "session",
  tokenEncryptionKey: key.toString("utf8"),
  sqlitePath: ":memory:",
  port: 8787,
  azureDevOpsScope: "499b84ac-1321-427f-aa17-267ca6975798/.default",
  codexTokenTtlSeconds: 3600,
  sessionTtlSeconds: 3600,
  defaultRequestTimeoutMs: 30000,
  defaultMaxPages: 20,
  allowedOAuthRedirectOrigins: []
};

function unsignedIdToken(payload: Record<string, unknown>): string {
  return [
    Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url"),
    Buffer.from(JSON.stringify(payload)).toString("base64url"),
    ""
  ].join(".");
}

describe("remote OAuth helpers", () => {
  it("parses Microsoft token responses and identity claims", () => {
    const response = parseMicrosoftTokenResponse({
      access_token: "access",
      refresh_token: "refresh",
      expires_in: 3600,
      scope: "scope",
      id_token: unsignedIdToken({ oid: "oid-1", name: "Ada" })
    });

    expect(response.accessToken).toBe("access");
    expect(parseMicrosoftIdentity(response.idToken ?? "")).toEqual({
      subject: "oid-1",
      displayName: "Ada"
    });
  });

  it("computes S256 PKCE challenges", () => {
    expect(codeChallengeS256("verifier")).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("returns encrypted bearer tokens for Azure DevOps requests", async () => {
    const store = new SqliteRemoteStore(":memory:");
    store.saveMicrosoftTokens({
      userId: "user-1",
      encryptedAccessToken: encryptSecret("access-token", key),
      encryptedRefreshToken: encryptSecret("refresh-token", key),
      expiresAt: Date.now() + 120000,
      scope: "scope"
    });
    const provider = new RemoteAdoAuthProvider({
      config,
      encryptionKey: key,
      store,
      userId: "user-1"
    });

    await expect(provider.getAuthHeader()).resolves.toMatchObject({
      authorization: "Bearer access-token",
      source: "oauth"
    });
    store.close();
  });
});
