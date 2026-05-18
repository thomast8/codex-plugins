import fs from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

import { AdoError } from "./errors.js";
import { getLocalOAuthStatus } from "./localOAuth.js";
import type { LocalOAuthStatus } from "./localOAuth.js";
import { normalizeOrgUrl } from "./validation.js";

export interface StoredAdoConfig {
  orgUrl: string;
  project: string;
  repositories?: string[] | undefined;
  requestTimeoutMs?: number | undefined;
  maxPages?: number | undefined;
}

export interface SetupStatus {
  configured: boolean;
  configFile: string;
  orgUrl?: string | undefined;
  project?: string | undefined;
  repositories?: string[] | undefined;
  environmentOverrides: string[];
  auth: {
    mode: "microsoft-oauth";
    status: LocalOAuthStatus["status"];
    loginTool: "ado_login";
    clientConfigured: boolean;
    user?: string;
    tenant?: string;
    scope?: string;
    expiresAt?: string;
    tokenFile?: string;
    localFallback: {
      azureCli: "development-fallback";
      patEnvironmentConfigured: boolean;
      patKeychainConfigured: boolean;
      patKeychainService: string;
      keychainSupported: boolean;
    };
  };
  nextSteps: string[];
}

export function defaultConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.CODEX_AZURE_DEVOPS_CONFIG_FILE;
  if (override !== undefined && override.trim() !== "") {
    return path.resolve(override);
  }
  return path.join(os.homedir(), ".Codex", "plugins", "azure-devops", "config.json");
}

function parseRepositoryList(value: string[] | undefined): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  const repositories = value
    .map((repository) => repository.trim())
    .filter((repository) => repository.length > 0);
  return repositories.length === 0 ? undefined : repositories;
}

function parsePositiveInteger(
  value: number | undefined,
  field: string
): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isInteger(value) || value <= 0) {
    throw new AdoError(`${field} must be a positive integer.`, {
      kind: "configuration"
    });
  }
  return value;
}

export function normalizeStoredConfig(input: StoredAdoConfig): StoredAdoConfig {
  if (input.project.trim() === "") {
    throw new AdoError("project is required.", { kind: "configuration" });
  }

  const config: StoredAdoConfig = {
    orgUrl: normalizeOrgUrl(input.orgUrl),
    project: input.project.trim()
  };

  const repositories = parseRepositoryList(input.repositories);
  if (repositories !== undefined) {
    config.repositories = repositories;
  }

  const requestTimeoutMs = parsePositiveInteger(
    input.requestTimeoutMs,
    "requestTimeoutMs"
  );
  if (requestTimeoutMs !== undefined) {
    config.requestTimeoutMs = requestTimeoutMs;
  }

  const maxPages = parsePositiveInteger(input.maxPages, "maxPages");
  if (maxPages !== undefined) {
    config.maxPages = maxPages;
  }

  return config;
}

function isStoredConfig(value: unknown): value is StoredAdoConfig {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.orgUrl === "string" &&
    typeof candidate.project === "string"
  );
}

export function readStoredConfig(
  configPath = defaultConfigPath()
): StoredAdoConfig | undefined {
  if (!fs.existsSync(configPath)) {
    return undefined;
  }

  const raw = fs.readFileSync(configPath, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  if (!isStoredConfig(parsed)) {
    throw new AdoError("Azure DevOps config file is invalid.", {
      kind: "configuration",
      details: { configPath }
    });
  }
  return normalizeStoredConfig(parsed);
}

export function writeStoredConfig(
  input: StoredAdoConfig,
  configPath = defaultConfigPath()
): StoredAdoConfig {
  const config = normalizeStoredConfig(input);
  fs.mkdirSync(path.dirname(configPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(`${configPath}.tmp`, `${JSON.stringify(config, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600
  });
  fs.renameSync(`${configPath}.tmp`, configPath);
  fs.chmodSync(configPath, 0o600);
  return config;
}

function environmentOverrides(env: NodeJS.ProcessEnv): string[] {
  return [
    "ADO_ORG_URL",
    "ADO_PROJECT",
    "ADO_REPOSITORIES",
    "ADO_REQUEST_TIMEOUT_MS",
    "ADO_MAX_PAGES",
    "ADO_PAT",
    "AZURE_DEVOPS_EXT_PAT"
  ].filter((name) => {
    const value = env[name];
    return value !== undefined && value.trim() !== "";
  });
}

function keychainPatService(env: NodeJS.ProcessEnv): string {
  return (
    env.CODEX_AZURE_DEVOPS_PAT_SERVICE?.trim() || "codex-azure-devops-pat"
  );
}

function keychainPatConfigured(env: NodeJS.ProcessEnv): boolean {
  if (process.platform !== "darwin") {
    return false;
  }
  const account = env.USER?.trim() || os.userInfo().username;
  try {
    execFileSync(
      "security",
      [
        "find-generic-password",
        "-a",
        account,
        "-s",
        keychainPatService(env)
      ],
      { stdio: "ignore", timeout: 5000 }
    );
    return true;
  } catch {
    return false;
  }
}

export function getSetupStatus(
  env: NodeJS.ProcessEnv = process.env,
  configPath = defaultConfigPath(env)
): SetupStatus {
  const oauth = getLocalOAuthStatus(env);
  const stored = readStoredConfig(configPath);
  const orgUrl = env.ADO_ORG_URL?.trim() || stored?.orgUrl;
  const project = env.ADO_PROJECT?.trim() || stored?.project;
  const repositories =
    env.ADO_REPOSITORIES === undefined
      ? stored?.repositories
      : env.ADO_REPOSITORIES.split(",")
          .map((item) => item.trim())
          .filter((item) => item.length > 0);
  const configured = orgUrl !== undefined && project !== undefined;
  const patEnvironmentConfigured =
    (env.ADO_PAT !== undefined && env.ADO_PAT.trim() !== "") ||
    (env.AZURE_DEVOPS_EXT_PAT !== undefined &&
      env.AZURE_DEVOPS_EXT_PAT.trim() !== "");
  const patKeychainConfigured = keychainPatConfigured(env);
  const patConfigured = patEnvironmentConfigured || patKeychainConfigured;

  const nextSteps: string[] = [];
  if (oauth.status !== "connected") {
    nextSteps.push(
      patConfigured
        ? "PAT authentication is configured for local/private testing."
        : "For local testing, store a PAT in macOS Keychain or set ADO_PAT outside the repository."
    );
  }
  if (!configured) {
    nextSteps.push(
      "Configure the Azure DevOps organization and project with ado_configure_connection, or use the hosted HTTP plugin's admin configuration."
    );
  }
  if (oauth.status !== "connected" && !patConfigured) {
    nextSteps.push(
      "Microsoft OAuth remains the hosted connector target; PAT is the temporary local/private default."
    );
  }
  if (configured) {
    nextSteps.push("Run ado_test_connection to verify live Azure DevOps access.");
  }

  const status: SetupStatus = {
    configured,
    configFile: configPath,
    environmentOverrides: environmentOverrides(env),
    auth: {
      mode: "microsoft-oauth",
      status: oauth.status,
      loginTool: "ado_login",
      clientConfigured: oauth.clientConfigured,
      localFallback: {
        azureCli: "development-fallback",
        patEnvironmentConfigured,
        patKeychainConfigured,
        patKeychainService: keychainPatService(env),
        keychainSupported: process.platform === "darwin"
      }
    },
    nextSteps
  };

  if (oauth.user !== undefined) {
    status.auth.user = oauth.user;
  }
  if (oauth.tenant !== undefined) {
    status.auth.tenant = oauth.tenant;
  }
  if (oauth.scope !== undefined) {
    status.auth.scope = oauth.scope;
  }
  if (oauth.expiresAt !== undefined) {
    status.auth.expiresAt = oauth.expiresAt;
  }
  if (oauth.tokenFile !== undefined) {
    status.auth.tokenFile = oauth.tokenFile;
  }

  if (orgUrl !== undefined) {
    status.orgUrl = orgUrl;
  }
  if (project !== undefined) {
    status.project = project;
  }
  if (repositories !== undefined && repositories.length > 0) {
    status.repositories = repositories;
  }

  return status;
}
