import os from "node:os";
import path from "node:path";

import { AdoError } from "./errors.js";
import { normalizeHostedOrgUrl } from "./validation.js";

export const AZURE_DEVOPS_RESOURCE_ID =
  "499b84ac-1321-427f-aa17-267ca6975798";

export const DEFAULT_AZURE_DEVOPS_SCOPE =
  `${AZURE_DEVOPS_RESOURCE_ID}/.default`;

export interface RemoteServiceConfig {
  publicBaseUrl: string;
  microsoftClientId: string;
  microsoftClientSecret: string;
  microsoftTenant: string;
  sessionSecret: string;
  tokenEncryptionKey: string;
  sqlitePath: string;
  port: number;
  azureDevOpsScope: string;
  codexTokenTtlSeconds: number;
  sessionTtlSeconds: number;
  defaultOrgUrl?: string;
  defaultProject?: string;
  defaultRepositories?: string[];
  defaultRequestTimeoutMs: number;
  defaultMaxPages: number;
  allowedOAuthRedirectOrigins: string[];
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (value === undefined || value.trim() === "") {
    throw new AdoError(`${name} is required for hosted Azure DevOps mode.`, {
      kind: "configuration"
    });
  }
  return value.trim();
}

function optionalInteger(
  env: NodeJS.ProcessEnv,
  name: string,
  defaultValue: number
): number {
  const value = env[name];
  if (value === undefined || value.trim() === "") {
    return defaultValue;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new AdoError(`${name} must be a positive integer.`, {
      kind: "configuration"
    });
  }
  return parsed;
}

function normalizePublicBaseUrl(value: string): string {
  const url = new URL(value);
  const isLoopbackHttp =
    url.protocol === "http:" &&
    ["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !isLoopbackHttp) {
    throw new AdoError(
      "PUBLIC_BASE_URL must use HTTPS unless it points at localhost for tests.",
      {
        kind: "configuration"
      }
    );
  }
  url.hash = "";
  url.search = "";
  return url.toString().replace(/\/$/, "");
}

function optionalString(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name];
  return value === undefined || value.trim() === "" ? undefined : value.trim();
}

function optionalRepositoryAllowlist(value: string | undefined): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  const repositories = value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  return repositories.length === 0 ? undefined : repositories;
}

function optionalOriginAllowlist(value: string | undefined): string[] {
  if (value === undefined || value.trim() === "") {
    return [];
  }
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
    .map((item) => new URL(item).origin);
}

export function defaultSqlitePath(): string {
  return path.join(os.homedir(), ".codex-azure-devops-plugin", "remote.sqlite");
}

export function loadRemoteServiceConfig(
  env: NodeJS.ProcessEnv = process.env
): RemoteServiceConfig {
  const config: RemoteServiceConfig = {
    publicBaseUrl: normalizePublicBaseUrl(required(env, "PUBLIC_BASE_URL")),
    microsoftClientId: required(env, "MICROSOFT_ENTRA_CLIENT_ID"),
    microsoftClientSecret: required(env, "MICROSOFT_ENTRA_CLIENT_SECRET"),
    microsoftTenant: env.MICROSOFT_ENTRA_TENANT?.trim() || "organizations",
    sessionSecret: required(env, "SESSION_SECRET"),
    tokenEncryptionKey: required(env, "TOKEN_ENCRYPTION_KEY"),
    sqlitePath: env.SQLITE_PATH?.trim() || defaultSqlitePath(),
    port: optionalInteger(env, "PORT", 8787),
    azureDevOpsScope: env.AZURE_DEVOPS_SCOPE?.trim() || DEFAULT_AZURE_DEVOPS_SCOPE,
    codexTokenTtlSeconds: optionalInteger(
      env,
      "CODEX_TOKEN_TTL_SECONDS",
      60 * 60 * 8
    ),
    sessionTtlSeconds: optionalInteger(
      env,
      "SESSION_TTL_SECONDS",
      60 * 60 * 24 * 14
    ),
    defaultRequestTimeoutMs: optionalInteger(
      env,
      "ADO_REQUEST_TIMEOUT_MS",
      30000
    ),
    defaultMaxPages: optionalInteger(env, "ADO_MAX_PAGES", 20),
    allowedOAuthRedirectOrigins: optionalOriginAllowlist(
      env.CODEX_OAUTH_REDIRECT_ORIGINS
    )
  };
  const defaultOrgUrl = optionalString(env, "ADO_ORG_URL");
  const defaultProject = optionalString(env, "ADO_PROJECT");
  const defaultRepositories = optionalRepositoryAllowlist(env.ADO_REPOSITORIES);
  if (defaultOrgUrl !== undefined) {
    config.defaultOrgUrl = normalizeHostedOrgUrl(defaultOrgUrl);
  }
  if (defaultProject !== undefined) {
    config.defaultProject = defaultProject;
  }
  if (defaultRepositories !== undefined) {
    config.defaultRepositories = defaultRepositories;
  }
  return config;
}

export function microsoftAuthorizeUrl(config: RemoteServiceConfig): string {
  return `https://login.microsoftonline.com/${encodeURIComponent(
    config.microsoftTenant
  )}/oauth2/v2.0/authorize`;
}

export function microsoftTokenUrl(config: RemoteServiceConfig): string {
  return `https://login.microsoftonline.com/${encodeURIComponent(
    config.microsoftTenant
  )}/oauth2/v2.0/token`;
}
