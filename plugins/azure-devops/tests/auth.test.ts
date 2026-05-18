import { describe, expect, it, vi } from "vitest";

import {
  AZURE_DEVOPS_RESOURCE_ID,
  ChainedAuthProvider,
  OAuthFirstAuthProvider,
  createAuthProvider,
  createAzureCliTokenFetcher
} from "../src/auth.js";
import { AdoError } from "../src/errors.js";

describe("ChainedAuthProvider", () => {
  const baseConfig = {
    orgUrl: "https://dev.azure.com/example",
    project: "Example",
    apiVersion: "7.1" as const,
    requestTimeoutMs: 30000,
    maxPages: 10
  };

  it("prefers local Microsoft OAuth tokens before fallback auth", async () => {
    const fallback = {
      getAuthHeader: vi.fn(async () => ({
        scheme: "Bearer" as const,
        authorization: "Bearer az-token",
        source: "azure-cli" as const
      }))
    };
    const provider = new OAuthFirstAuthProvider({
      oauthTokenFetcher: async () => "oauth-token",
      fallback
    });

    await expect(provider.getAuthHeader()).resolves.toEqual({
      scheme: "Bearer",
      authorization: "Bearer oauth-token",
      source: "oauth"
    });
    expect(fallback.getAuthHeader).not.toHaveBeenCalled();
  });

  it("prefers Azure CLI tokens over configured PAT credentials", async () => {
    const tokenFetcher = vi.fn(async () => "entra-token");
    const provider = new ChainedAuthProvider({
      tokenFetcher,
      pat: "pat-token"
    });

    await expect(provider.getAuthHeader()).resolves.toEqual({
      scheme: "Bearer",
      authorization: "Bearer entra-token",
      source: "azure-cli"
    });
    expect(tokenFetcher).toHaveBeenCalledOnce();
  });

  it("prefers Azure CLI tokens over fetched PAT credentials", async () => {
    const tokenFetcher = vi.fn(async () => "entra-token");
    const patFetcher = vi.fn(async () => "keychain-pat");
    const provider = new ChainedAuthProvider({
      tokenFetcher,
      patFetcher
    });

    await expect(provider.getAuthHeader()).resolves.toEqual({
      scheme: "Bearer",
      authorization: "Bearer entra-token",
      source: "azure-cli"
    });
    expect(tokenFetcher).toHaveBeenCalledOnce();
    expect(patFetcher).not.toHaveBeenCalled();
  });

  it("uses Azure CLI when no PAT is configured", async () => {
    const provider = new ChainedAuthProvider({
      tokenFetcher: async () => "entra-token"
    });

    await expect(provider.getAuthHeader()).resolves.toEqual({
      scheme: "Bearer",
      authorization: "Bearer entra-token",
      source: "azure-cli"
    });
  });

  it("falls back when local Microsoft OAuth state is stale", async () => {
    const oauthTokenFetcher = vi.fn(async () => {
      throw new AdoError("Refresh token is stale.", {
        kind: "authentication"
      });
    });
    const tokenFetcher = vi.fn(async () => "az-token");
    const patFetcher = vi.fn(async () => "pat-token");
    const provider = new OAuthFirstAuthProvider({
      oauthTokenFetcher,
      fallback: new ChainedAuthProvider({
        tokenFetcher,
        patFetcher
      })
    });

    await expect(provider.getAuthHeader()).resolves.toEqual({
      scheme: "Bearer",
      authorization: "Bearer az-token",
      source: "azure-cli"
    });
    expect(oauthTokenFetcher).toHaveBeenCalledOnce();
    expect(tokenFetcher).toHaveBeenCalledOnce();
    expect(patFetcher).not.toHaveBeenCalled();
  });

  it("does not hide unexpected local Microsoft OAuth errors", async () => {
    const error = new Error("Token store crashed.");
    const fallback = {
      getAuthHeader: vi.fn(async () => ({
        scheme: "Bearer" as const,
        authorization: "Bearer az-token",
        source: "azure-cli" as const
      }))
    };
    const provider = new OAuthFirstAuthProvider({
      oauthTokenFetcher: async () => {
        throw error;
      },
      fallback
    });

    await expect(provider.getAuthHeader()).rejects.toBe(error);
    expect(fallback.getAuthHeader).not.toHaveBeenCalled();
  });

  it("falls back to configured PAT when Azure CLI token is unavailable", async () => {
    const tokenFetcher = vi.fn(async () => undefined);
    const provider = new ChainedAuthProvider({
      tokenFetcher,
      pat: "pat-token"
    });

    const header = await provider.getAuthHeader();

    expect(header.scheme).toBe("Basic");
    expect(header.source).toBe("pat");
    expect(header.authorization).toBe(
      `Basic ${Buffer.from(":pat-token").toString("base64")}`
    );
    expect(tokenFetcher).toHaveBeenCalledOnce();
  });

  it("falls back to fetched PAT when Azure CLI token is unavailable", async () => {
    const tokenFetcher = vi.fn(async () => undefined);
    const patFetcher = vi.fn(async () => "keychain-pat");
    const provider = new ChainedAuthProvider({
      tokenFetcher,
      patFetcher
    });

    const header = await provider.getAuthHeader();

    expect(header.scheme).toBe("Basic");
    expect(header.source).toBe("pat");
    expect(header.authorization).toBe(
      `Basic ${Buffer.from(":keychain-pat").toString("base64")}`
    );
    expect(tokenFetcher).toHaveBeenCalledOnce();
    expect(patFetcher).toHaveBeenCalledOnce();
  });

  it("raises an auth error when no credential works", async () => {
    const provider = new ChainedAuthProvider({
      tokenFetcher: async () => undefined
    });

    await expect(provider.getAuthHeader()).rejects.toMatchObject({
      kind: "authentication",
      message: expect.stringContaining("ADO_PAT")
    });
  });

  it("wires production auth order as OAuth, Azure CLI, then PAT", async () => {
    const calls: string[] = [];
    const provider = createAuthProvider(
      { ...baseConfig, pat: "pat-token" },
      {
        oauthTokenFetcher: vi.fn(async () => {
          calls.push("oauth");
          return undefined;
        }),
        azureCliTokenFetcher: vi.fn(async () => {
          calls.push("azure-cli");
          return "az-token";
        }),
        patFetcher: vi.fn(async () => {
          calls.push("keychain-pat");
          return "keychain-pat";
        })
      }
    );

    await expect(provider.getAuthHeader()).resolves.toEqual({
      scheme: "Bearer",
      authorization: "Bearer az-token",
      source: "azure-cli"
    });
    expect(calls).toEqual(["oauth", "azure-cli"]);
  });

  it("uses factory PAT fallback only after OAuth and Azure CLI are unavailable", async () => {
    const calls: string[] = [];
    const provider = createAuthProvider(
      baseConfig,
      {
        oauthTokenFetcher: vi.fn(async () => {
          calls.push("oauth");
          return undefined;
        }),
        azureCliTokenFetcher: vi.fn(async () => {
          calls.push("azure-cli");
          return undefined;
        }),
        patFetcher: vi.fn(async () => {
          calls.push("keychain-pat");
          return "keychain-pat";
        })
      }
    );

    const header = await provider.getAuthHeader();

    expect(header.scheme).toBe("Basic");
    expect(header.source).toBe("pat");
    expect(calls).toEqual(["oauth", "azure-cli", "keychain-pat"]);
  });
});

describe("createAzureCliTokenFetcher", () => {
  it("requests an Azure DevOps resource token with Azure CLI", async () => {
    const execFile = vi.fn(async () => ({
      stdout: " az-token \n",
      stderr: ""
    }));

    await expect(createAzureCliTokenFetcher(execFile)()).resolves.toBe("az-token");
    expect(execFile).toHaveBeenCalledWith(
      "az",
      [
        "account",
        "get-access-token",
        "--resource",
        AZURE_DEVOPS_RESOURCE_ID,
        "--query",
        "accessToken",
        "--output",
        "tsv"
      ],
      { timeout: 15000 }
    );
  });

  it("returns undefined for empty Azure CLI output", async () => {
    const execFile = vi.fn(async () => ({
      stdout: "\n",
      stderr: ""
    }));

    await expect(createAzureCliTokenFetcher(execFile)()).resolves.toBeUndefined();
  });

  it("returns undefined when Azure CLI cannot provide a token", async () => {
    const execFile = vi.fn(async () => {
      throw new Error("not logged in");
    });

    await expect(createAzureCliTokenFetcher(execFile)()).resolves.toBeUndefined();
  });
});
