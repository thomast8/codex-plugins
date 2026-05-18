import { execFile as execFileCallback } from "node:child_process";
import os from "node:os";
import { promisify } from "node:util";

import { AdoConfig } from "./config.js";
import { AdoError } from "./errors.js";
import { createLocalOAuthAccessTokenFetcher } from "./localOAuth.js";

export const AZURE_DEVOPS_RESOURCE_ID =
  "499b84ac-1321-427f-aa17-267ca6975798";

export interface AuthHeader {
  scheme: "Bearer" | "Basic";
  authorization: string;
  source: "azure-cli" | "oauth" | "pat";
}

export interface AuthProvider {
  getAuthHeader(): Promise<AuthHeader>;
}

export type TokenFetcher = () => Promise<string | undefined>;

export interface CreateAuthProviderOptions {
  oauthTokenFetcher?: TokenFetcher | undefined;
  azureCliTokenFetcher?: TokenFetcher | undefined;
  patFetcher?: TokenFetcher | undefined;
}

export type ExecFile = (
  file: string,
  args: string[],
  options: { timeout: number }
) => Promise<{ stdout: string | Buffer; stderr: string | Buffer }>;

const execFileAsync = promisify(execFileCallback) as ExecFile;
const DEFAULT_KEYCHAIN_PAT_SERVICE = "codex-azure-devops-pat";

export function createAzureCliTokenFetcher(
  execFileImpl: ExecFile = execFileAsync
): TokenFetcher {
  return async () => {
    try {
      const { stdout } = await execFileImpl(
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
      const token = stdout.toString("utf8").trim();
      return token.length > 0 ? token : undefined;
    } catch {
      return undefined;
    }
  };
}

export function createKeychainPatFetcher(
  env: NodeJS.ProcessEnv = process.env,
  execFileImpl: ExecFile = execFileAsync
): TokenFetcher {
  return async () => {
    if (process.platform !== "darwin") {
      return undefined;
    }
    const service =
      env.CODEX_AZURE_DEVOPS_PAT_SERVICE?.trim() ||
      DEFAULT_KEYCHAIN_PAT_SERVICE;
    const account = env.USER?.trim() || os.userInfo().username;
    try {
      const { stdout } = await execFileImpl(
        "security",
        ["find-generic-password", "-a", account, "-s", service, "-w"],
        { timeout: 10000 }
      );
      const token = stdout.toString("utf8").trim();
      return token.length > 0 ? token : undefined;
    } catch {
      return undefined;
    }
  };
}

export class ChainedAuthProvider implements AuthProvider {
  private readonly tokenFetcher: TokenFetcher;
  private readonly pat?: string;
  private readonly patFetcher: TokenFetcher | undefined;

  constructor(options: {
    tokenFetcher: TokenFetcher;
    pat?: string | undefined;
    patFetcher?: TokenFetcher | undefined;
  }) {
    this.tokenFetcher = options.tokenFetcher;
    if (options.pat !== undefined && options.pat.trim() !== "") {
      this.pat = options.pat.trim();
    }
    this.patFetcher = options.patFetcher;
  }

  async getAuthHeader(): Promise<AuthHeader> {
    const entraToken = await this.tokenFetcher();
    if (entraToken !== undefined) {
      return {
        scheme: "Bearer",
        authorization: `Bearer ${entraToken}`,
        source: "azure-cli"
      };
    }

    const pat = this.pat ?? (await this.patFetcher?.());
    if (pat !== undefined && pat.trim() !== "") {
      const encoded = Buffer.from(`:${pat.trim()}`, "utf8").toString("base64");
      return {
        scheme: "Basic",
        authorization: `Basic ${encoded}`,
        source: "pat"
      };
    }

    throw new AdoError(
      "Azure DevOps authentication is required. For local testing, set ADO_PAT or AZURE_DEVOPS_EXT_PAT outside the repository.",
      { kind: "authentication" }
    );
  }
}

export class OAuthFirstAuthProvider implements AuthProvider {
  private readonly oauthTokenFetcher: TokenFetcher;
  private readonly fallback: AuthProvider;

  constructor(options: {
    oauthTokenFetcher: TokenFetcher;
    fallback: AuthProvider;
  }) {
    this.oauthTokenFetcher = options.oauthTokenFetcher;
    this.fallback = options.fallback;
  }

  async getAuthHeader(): Promise<AuthHeader> {
    try {
      const oauthToken = await this.oauthTokenFetcher();
      if (oauthToken !== undefined) {
        return {
          scheme: "Bearer",
          authorization: `Bearer ${oauthToken}`,
          source: "oauth"
        };
      }
    } catch (error) {
      if (!(error instanceof AdoError)) {
        throw error;
      }
    }
    return await this.fallback.getAuthHeader();
  }
}

export class BearerTokenAuthProvider implements AuthProvider {
  private readonly tokenFetcher: TokenFetcher;

  constructor(tokenFetcher: TokenFetcher) {
    this.tokenFetcher = tokenFetcher;
  }

  async getAuthHeader(): Promise<AuthHeader> {
    const token = await this.tokenFetcher();
    if (token === undefined || token.trim() === "") {
      throw new AdoError("Azure DevOps OAuth token is missing.", {
        kind: "authentication"
      });
    }

    return {
      scheme: "Bearer",
      authorization: `Bearer ${token.trim()}`,
      source: "oauth"
    };
  }
}

export function createAuthProvider(
  config: AdoConfig,
  options: CreateAuthProviderOptions = {}
): AuthProvider {
  const fallback = new ChainedAuthProvider({
    tokenFetcher: options.azureCliTokenFetcher ?? createAzureCliTokenFetcher(),
    pat: config.pat,
    patFetcher: options.patFetcher ?? createKeychainPatFetcher()
  });
  return new OAuthFirstAuthProvider({
    oauthTokenFetcher:
      options.oauthTokenFetcher ?? createLocalOAuthAccessTokenFetcher(),
    fallback
  });
}
