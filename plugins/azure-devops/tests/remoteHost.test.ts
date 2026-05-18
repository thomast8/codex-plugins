import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { encryptSecret, sha256, signValue } from "../src/crypto.js";
import { createRemoteHost } from "../src/remoteHost.js";
import { RemoteServiceConfig } from "../src/remoteConfig.js";
import { codeChallengeS256 } from "../src/remoteOAuth.js";
import { SqliteRemoteStore } from "../src/remoteStore.js";

const key = Buffer.from("12345678901234567890123456789012", "utf8");

function testConfig(): RemoteServiceConfig {
  return {
    publicBaseUrl: "http://127.0.0.1:0",
    microsoftClientId: "client",
    microsoftClientSecret: "secret",
    microsoftTenant: "organizations",
    sessionSecret: "session",
    tokenEncryptionKey: key.toString("utf8"),
    sqlitePath: ":memory:",
    port: 0,
    azureDevOpsScope: "499b84ac-1321-427f-aa17-267ca6975798/.default",
    codexTokenTtlSeconds: 3600,
    sessionTtlSeconds: 3600,
    defaultRequestTimeoutMs: 30000,
    defaultMaxPages: 20,
    allowedOAuthRedirectOrigins: []
  };
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(0, "127.0.0.1");
  });
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

function unsignedIdToken(payload: Record<string, unknown>): string {
  return [
    Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url"),
    Buffer.from(JSON.stringify(payload)).toString("base64url"),
    ""
  ].join(".");
}

async function cookieSessionId(response: Response): Promise<string> {
  const cookie = response.headers.get("set-cookie");
  expect(cookie).toBeTruthy();
  const match = cookie?.match(/ado_plugin_session=([^;]+)/);
  expect(match?.[1]).toBeTruthy();
  return decodeURIComponent(match?.[1] ?? "");
}

async function completeMicrosoftLogin(options: {
  baseUrl: string;
  config: RemoteServiceConfig;
  sessionCookie: string;
}): Promise<string> {
  const login = await fetch(`${options.baseUrl}/login?returnTo=%2Fsettings`, {
    redirect: "manual",
    headers: { Cookie: `ado_plugin_session=${options.sessionCookie}` }
  });
  expect(login.status).toBe(302);
  const location = login.headers.get("location");
  expect(location).toBeTruthy();
  const microsoftUrl = new URL(location ?? "");
  const state = microsoftUrl.searchParams.get("state");
  expect(microsoftUrl.origin).toBe("https://login.microsoftonline.com");
  expect(microsoftUrl.searchParams.get("client_id")).toBe(
    options.config.microsoftClientId
  );
  expect(microsoftUrl.searchParams.get("scope")).toContain(
    options.config.azureDevOpsScope
  );
  expect(state).toBeTruthy();

  const callback = await fetch(
    `${options.baseUrl}/auth/microsoft/callback?code=microsoft-code&state=${state}`,
    {
      redirect: "manual",
      headers: { Cookie: `ado_plugin_session=${options.sessionCookie}` }
    }
  );
  expect(callback.status).toBe(302);
  expect(callback.headers.get("location")).toBe("/settings");
  return options.sessionCookie;
}

describe("remote hosted MCP app", () => {
  let server: Server | undefined;
  let store: SqliteRemoteStore | undefined;

  beforeEach(() => {
    store = new SqliteRemoteStore(":memory:");
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await new Promise<void>((resolve) => {
      if (server === undefined) {
        resolve();
        return;
      }
      server.close(() => resolve());
    });
    store?.close();
  });

  it("serves OAuth metadata and dynamic client registration", async () => {
    const config = testConfig();
    const app = createRemoteHost({ config, store: store!, encryptionKey: key });
    server = createServer(app);
    config.publicBaseUrl = await listen(server);

    const metadata = await fetch(
      `${config.publicBaseUrl}/.well-known/oauth-authorization-server`
    );
    await expect(metadata.json()).resolves.toMatchObject({
      issuer: config.publicBaseUrl,
      authorization_endpoint: `${config.publicBaseUrl}/oauth/authorize`,
      token_endpoint: `${config.publicBaseUrl}/oauth/token`
    });

    const registration = await fetch(`${config.publicBaseUrl}/oauth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        redirect_uris: ["http://127.0.0.1:12345/callback"],
        client_name: "Codex"
      })
    });
    const body = (await registration.json()) as { client_id?: string };
    expect(registration.status).toBe(201);
    expect(body.client_id).toBeDefined();
  });

  it("rejects untrusted OAuth redirect URI registration", async () => {
    const config = testConfig();
    const app = createRemoteHost({ config, store: store!, encryptionKey: key });
    server = createServer(app);
    config.publicBaseUrl = await listen(server);

    const registration = await fetch(`${config.publicBaseUrl}/oauth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        redirect_uris: ["https://evil.example/callback"],
        client_name: "Not Codex"
      })
    });

    expect(registration.status).toBe(400);
    await expect(registration.json()).resolves.toMatchObject({
      error: "invalid_client_metadata"
    });
  });

  it("renders hosted settings UI and saves form input", async () => {
    const config = testConfig();
    store?.upsertUser({
      id: "user-1",
      microsoftSubject: "subject-1",
      displayName: "Ada"
    });
    store?.upsertSession({
      id: "session-1",
      userId: "user-1",
      expiresAt: Date.now() + 120000
    });
    const app = createRemoteHost({ config, store: store!, encryptionKey: key });
    server = createServer(app);
    config.publicBaseUrl = await listen(server);

    const settings = await fetch(`${config.publicBaseUrl}/settings`, {
      headers: {
        Cookie: `ado_plugin_session=${signValue(
          "session-1",
          config.sessionSecret
        )}`
      }
    });
    expect(settings.status).toBe(200);
    await expect(settings.text()).resolves.toContain("Azure DevOps");

    const save = await fetch(`${config.publicBaseUrl}/settings`, {
      method: "POST",
      headers: {
        Cookie: `ado_plugin_session=${signValue(
          "session-1",
          config.sessionSecret
        )}`,
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: new URLSearchParams({
        orgUrl: "https://dev.azure.com/example",
        project: "Project",
        repositories: "repo-a, repo-b",
        requestTimeoutMs: "30000",
        maxPages: "20"
      })
    });
    expect(save.status).toBe(200);
    await expect(save.text()).resolves.toContain("Settings saved.");
    expect(store?.getSettings("user-1")?.repositories).toEqual([
      "repo-a",
      "repo-b"
    ]);
  });

  it("redirects hosted settings to Microsoft login before a session exists", async () => {
    const config = testConfig();
    const app = createRemoteHost({ config, store: store!, encryptionKey: key });
    server = createServer(app);
    config.publicBaseUrl = await listen(server);

    const settings = await fetch(`${config.publicBaseUrl}/settings`, {
      redirect: "manual"
    });

    expect(settings.status).toBe(302);
    expect(settings.headers.get("location")).toBe(
      "/login?returnTo=%2Fsettings"
    );
  });

  it("completes hosted browser OAuth and MCP token exchange", async () => {
    const config = testConfig();
    config.defaultOrgUrl = "https://dev.azure.com/example";
    config.defaultProject = "Project";
    const realFetch = globalThis.fetch;
    vi.stubGlobal(
      "fetch",
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input.toString();
        if (url.includes("login.microsoftonline.com")) {
          const body = new URLSearchParams(String(init?.body ?? ""));
          expect(body.get("client_id")).toBe("client");
          expect(body.get("client_secret")).toBe("secret");
          expect(body.get("grant_type")).toBe("authorization_code");
          expect(body.get("code")).toBe("microsoft-code");
          return new Response(
            JSON.stringify({
              access_token: "azure-token",
              refresh_token: "refresh-token",
              expires_in: 3600,
              scope: config.azureDevOpsScope,
              id_token: unsignedIdToken({ oid: "oid-1", name: "Ada" })
            }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" }
            }
          );
        }
        return await realFetch(input, init);
      }
    );

    const app = createRemoteHost({ config, store: store!, encryptionKey: key });
    server = createServer(app);
    config.publicBaseUrl = await listen(server);

    const settings = await fetch(`${config.publicBaseUrl}/settings`, {
      redirect: "manual"
    });
    const sessionCookie = await cookieSessionId(settings);
    await completeMicrosoftLogin({
      baseUrl: config.publicBaseUrl,
      config,
      sessionCookie
    });

    const registration = await fetch(`${config.publicBaseUrl}/oauth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        redirect_uris: ["http://127.0.0.1:12345/callback"],
        client_name: "Codex"
      })
    });
    expect(registration.status).toBe(201);
    const registered = (await registration.json()) as { client_id: string };

    const codeVerifier = "verifier";
    const redirectUri = "http://127.0.0.1:12345/callback";
    const authorize = new URL(`${config.publicBaseUrl}/oauth/authorize`);
    authorize.searchParams.set("response_type", "code");
    authorize.searchParams.set("client_id", registered.client_id);
    authorize.searchParams.set("redirect_uri", redirectUri);
    authorize.searchParams.set("state", "client-state");
    authorize.searchParams.set("code_challenge", codeChallengeS256(codeVerifier));
    authorize.searchParams.set("code_challenge_method", "S256");

    const authorizeResponse = await fetch(authorize, {
      redirect: "manual",
      headers: { Cookie: `ado_plugin_session=${sessionCookie}` }
    });
    expect(authorizeResponse.status).toBe(302);
    const callback = new URL(authorizeResponse.headers.get("location") ?? "");
    expect(callback.origin).toBe("http://127.0.0.1:12345");
    expect(callback.searchParams.get("state")).toBe("client-state");
    const code = callback.searchParams.get("code");
    expect(code).toBeTruthy();

    const token = await fetch(`${config.publicBaseUrl}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: code ?? "",
        redirect_uri: redirectUri,
        client_id: registered.client_id,
        code_verifier: codeVerifier
      })
    });
    expect(token.status).toBe(200);
    await expect(token.json()).resolves.toMatchObject({
      token_type: "Bearer",
      scope: "mcp"
    });
  });

  it("exposes remote MCP tools without local configuration tools", async () => {
    const config = testConfig();
    const rawToken = "codex-token";
    store?.upsertUser({
      id: "user-1",
      microsoftSubject: "subject-1",
      displayName: "Ada"
    });
    store?.saveSettings("user-1", {
      orgUrl: "https://dev.azure.com/example",
      project: "Project",
      requestTimeoutMs: 30000,
      maxPages: 20
    });
    store?.saveMicrosoftTokens({
      userId: "user-1",
      encryptedAccessToken: encryptSecret("azure-token", key),
      expiresAt: Date.now() + 120000,
      scope: config.azureDevOpsScope
    });
    store?.saveMcpToken({
      tokenHash: sha256(rawToken),
      userId: "user-1",
      clientId: "client-1",
      expiresAt: Date.now() + 120000
    });

    const app = createRemoteHost({ config, store: store!, encryptionKey: key });
    server = createServer(app);
    config.publicBaseUrl = await listen(server);

    const client = new Client({
      name: "remote-contract-test",
      version: "0.1.0"
    });
    const transport = new StreamableHTTPClientTransport(
      new URL(`${config.publicBaseUrl}/mcp`),
      {
        authProvider: {
          async token() {
            return rawToken;
          }
        }
      }
    );
    await client.connect(transport);
    try {
      const tools = await client.listTools();
      const names = tools.tools.map((tool) => tool.name);

      expect(names).toContain("ado_setup_status");
      expect(names).not.toContain("ado_configure_connection");
      expect(names).toContain("ado_list_repositories");

      const status = await client.callTool({
        name: "ado_setup_status",
        arguments: {}
      });
      const [content] = status.content;
      expect(content?.type).toBe("text");
      const text = content?.type === "text" ? content.text : "{}";
      expect(JSON.parse(text)).toMatchObject({
        configured: true,
        authenticated: true,
        configurationSource: "user",
        configurationUrl: `${config.publicBaseUrl}/settings`,
        loginUrl: `${config.publicBaseUrl}/login?returnTo=%2Fsettings`,
        auth: {
          mode: "microsoft-oauth",
          provider: "Microsoft Entra",
          status: "connected"
        }
      });
    } finally {
      await client.close();
    }
  });

  it("uses service-level workspace defaults after OAuth login", async () => {
    const config = testConfig();
    config.defaultOrgUrl = "https://dev.azure.com/example";
    config.defaultProject = "Project";
    config.defaultRepositories = ["repo-a"];
    const rawToken = "codex-token";
    store?.upsertUser({
      id: "user-1",
      microsoftSubject: "subject-1",
      displayName: "Ada"
    });
    store?.saveMicrosoftTokens({
      userId: "user-1",
      encryptedAccessToken: encryptSecret("azure-token", key),
      expiresAt: Date.now() + 120000,
      scope: config.azureDevOpsScope
    });
    store?.saveMcpToken({
      tokenHash: sha256(rawToken),
      userId: "user-1",
      clientId: "client-1",
      expiresAt: Date.now() + 120000
    });

    const app = createRemoteHost({ config, store: store!, encryptionKey: key });
    server = createServer(app);
    config.publicBaseUrl = await listen(server);

    const client = new Client({
      name: "remote-defaults-test",
      version: "0.1.0"
    });
    const transport = new StreamableHTTPClientTransport(
      new URL(`${config.publicBaseUrl}/mcp`),
      {
        authProvider: {
          async token() {
            return rawToken;
          }
        }
      }
    );
    await client.connect(transport);
    try {
      const status = await client.callTool({
        name: "ado_setup_status",
        arguments: {}
      });
      const [content] = status.content;
      expect(content?.type).toBe("text");
      const text = content?.type === "text" ? content.text : "{}";
      expect(JSON.parse(text)).toMatchObject({
        configured: true,
        authenticated: true,
        configurationSource: "service",
        orgUrl: "https://dev.azure.com/example",
        project: "Project",
        repositories: ["repo-a"]
      });
    } finally {
      await client.close();
    }
  });
});
