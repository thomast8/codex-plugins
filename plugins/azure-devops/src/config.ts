import { AdoError } from "./errors.js";
import {
  defaultConfigPath,
  readStoredConfig,
  StoredAdoConfig
} from "./configStore.js";
export { normalizeOrgUrl } from "./validation.js";
import { normalizeOrgUrl } from "./validation.js";

export interface AdoConfig {
  orgUrl: string;
  project: string;
  apiVersion: "7.1";
  repositories?: string[];
  pat?: string;
  requestTimeoutMs: number;
  maxPages: number;
}

function readPositiveInteger(
  env: NodeJS.ProcessEnv,
  name: string,
  defaultValue: number
): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") {
    return defaultValue;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new AdoError(`${name} must be a positive integer.`, {
      kind: "configuration"
    });
  }
  return parsed;
}

function parseRepositoryAllowlist(value: string | undefined): string[] {
  if (value === undefined) {
    return [];
  }
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function readConfiguredPositiveInteger(
  env: NodeJS.ProcessEnv,
  name: string,
  storedValue: number | undefined,
  defaultValue: number
): number {
  if (env[name] !== undefined && env[name]?.trim() !== "") {
    return readPositiveInteger(env, name, defaultValue);
  }
  return storedValue ?? defaultValue;
}

function configuredString(
  envValue: string | undefined,
  storedValue: string | undefined
): string | undefined {
  if (envValue !== undefined && envValue.trim() !== "") {
    return envValue;
  }
  return storedValue;
}

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  storedConfig: StoredAdoConfig | undefined = readStoredConfig(
    defaultConfigPath(env)
  )
): AdoConfig {
  const rawOrgUrl = configuredString(env.ADO_ORG_URL, storedConfig?.orgUrl);
  const rawProject = configuredString(env.ADO_PROJECT, storedConfig?.project);

  if (rawOrgUrl === undefined || rawOrgUrl.trim() === "") {
    throw new AdoError(
      "Azure DevOps is not configured. Run ado_configure_connection from Codex, or set ADO_ORG_URL.",
      { kind: "configuration" }
    );
  }

  if (rawProject === undefined || rawProject.trim() === "") {
    throw new AdoError(
      "Azure DevOps project is not configured. Run ado_configure_connection from Codex, or set ADO_PROJECT.",
      { kind: "configuration" }
    );
  }

  const config: AdoConfig = {
    orgUrl: normalizeOrgUrl(rawOrgUrl),
    project: rawProject.trim(),
    apiVersion: "7.1",
    requestTimeoutMs: readConfiguredPositiveInteger(
      env,
      "ADO_REQUEST_TIMEOUT_MS",
      storedConfig?.requestTimeoutMs,
      30000
    ),
    maxPages: readConfiguredPositiveInteger(
      env,
      "ADO_MAX_PAGES",
      storedConfig?.maxPages,
      20
    )
  };

  const repositories = parseRepositoryAllowlist(env.ADO_REPOSITORIES);
  if (repositories.length > 0) {
    config.repositories = repositories;
  } else if (storedConfig?.repositories !== undefined) {
    config.repositories = storedConfig.repositories;
  }

  const pat = env.ADO_PAT ?? env.AZURE_DEVOPS_EXT_PAT;
  if (pat !== undefined && pat.trim() !== "") {
    config.pat = pat.trim();
  }

  return config;
}
