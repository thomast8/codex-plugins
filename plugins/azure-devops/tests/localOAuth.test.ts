import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  createLocalOAuthAccessTokenFetcher,
  getLocalOAuthStatus,
  runLocalOAuthLogin
} from "../src/localOAuth.js";

function unsignedIdToken(payload: Record<string, unknown>): string {
  return [
    Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url"),
    Buffer.from(JSON.stringify(payload)).toString("base64url"),
    ""
  ].join(".");
}

describe("local Microsoft OAuth login", () => {
  it("completes browser PKCE login and stores an encrypted token", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ado-local-oauth-"));
    const env: NodeJS.ProcessEnv = {
      AZURE_DEVOPS_OAUTH_CLIENT_ID: "client-id",
      CODEX_AZURE_DEVOPS_OAUTH_DIR: dir
    };
    const fetchImpl: typeof fetch = async (input, init) => {
      expect(input.toString()).toContain("/oauth2/v2.0/token");
      const body = new URLSearchParams(String(init?.body ?? ""));
      expect(body.get("client_id")).toBe("client-id");
      expect(body.get("grant_type")).toBe("authorization_code");
      expect(body.get("code")).toBe("code-1");
      expect(body.get("redirect_uri")).toMatch(
        /^http:\/\/localhost:\d+\/auth\/callback$/
      );
      expect(body.get("code_verifier")).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(body.get("scope")).toContain(
        "499b84ac-1321-427f-aa17-267ca6975798/.default"
      );
      return new Response(
        JSON.stringify({
          access_token: "access-token",
          refresh_token: "refresh-token",
          expires_in: 3600,
          scope: "scope",
          id_token: unsignedIdToken({ oid: "oid-1", name: "Ada" })
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" }
        }
      );
    };

    const result = await runLocalOAuthLogin({
      env,
      fetchImpl,
      browserOpener: async (url) => {
        const authUrl = new URL(url);
        const redirectUri = authUrl.searchParams.get("redirect_uri");
        const state = authUrl.searchParams.get("state");
        expect(redirectUri).toBeTruthy();
        expect(state).toBeTruthy();
        expect(authUrl.searchParams.get("client_id")).toBe("client-id");
        expect(authUrl.searchParams.get("response_type")).toBe("code");
        expect(authUrl.searchParams.get("scope")).toContain(
          "499b84ac-1321-427f-aa17-267ca6975798/.default"
        );
        expect(authUrl.searchParams.get("code_challenge")).toMatch(
          /^[A-Za-z0-9_-]+$/
        );
        expect(authUrl.searchParams.get("code_challenge_method")).toBe("S256");
        await fetch(`${redirectUri}?code=code-1&state=${state}`);
      }
    });

    expect(result).toMatchObject({
      auth: {
        mode: "microsoft-oauth",
        status: "connected",
        user: "Ada",
        source: "browser"
      }
    });
    expect(getLocalOAuthStatus(env)).toMatchObject({
      status: "connected",
      user: "Ada"
    });
    await expect(
      createLocalOAuthAccessTokenFetcher(env)()
    ).resolves.toBe("access-token");
    await expect(
      createLocalOAuthAccessTokenFetcher({
        CODEX_AZURE_DEVOPS_OAUTH_DIR: dir
      })()
    ).resolves.toBe("access-token");
    expect(fs.readFileSync(path.join(dir, "oauth.json"), "utf8")).not.toContain(
      "access-token"
    );
  });
});
