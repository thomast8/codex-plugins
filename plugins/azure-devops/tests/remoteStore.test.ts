import { describe, expect, it } from "vitest";

import { encryptSecret, decryptSecret, sha256 } from "../src/crypto.js";
import { SqliteRemoteStore } from "../src/remoteStore.js";

const key = Buffer.from("12345678901234567890123456789012", "utf8");

describe("remote storage", () => {
  it("encrypts and decrypts stored token payloads", () => {
    const encrypted = encryptSecret("secret-token", key);

    expect(encrypted).not.toContain("secret-token");
    expect(decryptSecret(encrypted, key)).toBe("secret-token");
  });

  it("persists settings, tokens, OAuth codes, and bearer token hashes", () => {
    const store = new SqliteRemoteStore(":memory:");
    store.upsertUser({
      id: "user-1",
      microsoftSubject: "subject-1",
      displayName: "Ada"
    });
    store.saveSettings("user-1", {
      orgUrl: "https://dev.azure.com/example",
      project: "Project",
      repositories: ["repo-a"],
      requestTimeoutMs: 30000,
      maxPages: 20
    });
    store.saveMicrosoftTokens({
      userId: "user-1",
      encryptedAccessToken: encryptSecret("access", key),
      encryptedRefreshToken: encryptSecret("refresh", key),
      expiresAt: Date.now() + 1000,
      scope: "scope"
    });
    store.saveOAuthCode({
      codeHash: sha256("code"),
      userId: "user-1",
      clientId: "client-1",
      redirectUri: "https://client.example/callback",
      codeChallenge: "challenge",
      expiresAt: Date.now() + 1000
    });
    store.saveMcpToken({
      tokenHash: sha256("bearer"),
      userId: "user-1",
      clientId: "client-1",
      expiresAt: Date.now() + 1000
    });

    expect(store.getUserByMicrosoftSubject("subject-1")?.id).toBe("user-1");
    expect(store.getSettings("user-1")?.repositories).toEqual(["repo-a"]);
    expect(
      decryptSecret(
        store.getMicrosoftTokens("user-1")?.encryptedAccessToken ?? "",
        key
      )
    ).toBe("access");
    expect(store.consumeOAuthCode(sha256("code"))?.clientId).toBe("client-1");
    expect(store.consumeOAuthCode(sha256("code"))).toBeUndefined();
    expect(store.getMcpToken(sha256("bearer"))?.userId).toBe("user-1");
    store.close();
  });
});
