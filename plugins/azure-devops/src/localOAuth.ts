import { execFile as execFileCallback } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import { createServer, IncomingMessage, ServerResponse } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import {
  decryptSecret,
  encryptSecret,
  parseEncryptionKey,
  randomToken
} from "./crypto.js";
import { AdoError } from "./errors.js";
import { AZURE_DEVOPS_RESOURCE_ID } from "./remoteConfig.js";
import {
  codeChallengeS256,
  parseMicrosoftIdentity,
  parseMicrosoftTokenResponse
} from "./remoteOAuth.js";
import type { MicrosoftTokenResponse } from "./remoteOAuth.js";

const execFileAsync = promisify(execFileCallback);
const DEFAULT_TENANT = "organizations";
const LOCAL_OAUTH_VERSION = 1;
const MIN_FRESH_TOKEN_MS = 60_000;

export type LocalOAuthLoginMode = "browser" | "device";
export type LocalOAuthDeviceAction = "start" | "complete";

export interface LocalOAuthLoginOptions {
  mode?: LocalOAuthLoginMode;
  deviceAction?: LocalOAuthDeviceAction;
  timeoutSeconds?: number;
  openBrowser?: boolean;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  browserOpener?: (url: string) => Promise<void>;
}

export interface LocalOAuthStatus {
  mode: "microsoft-oauth";
  status: "connected" | "expired" | "not-connected" | "not-configured" | "error";
  loginTool: "ado_login";
  clientConfigured: boolean;
  user?: string;
  tenant?: string;
  scope?: string;
  expiresAt?: string;
  tokenFile?: string;
  error?: string;
}

interface LocalOAuthRuntimeConfig {
  clientId: string;
  tenant: string;
  scope: string;
  tokenPath: string;
  keyPath: string;
  pendingDevicePath: string;
}

interface StoredLocalOAuthTokens {
  version: 1;
  clientId: string;
  tenant: string;
  userId: string;
  displayName?: string;
  encryptedAccessToken: string;
  encryptedRefreshToken?: string;
  expiresAt: number;
  scope: string;
}

interface PendingDeviceLogin {
  version: 1;
  clientId: string;
  tenant: string;
  scope: string;
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresAt: number;
  intervalSeconds: number;
}

interface DeviceAuthorizationResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval?: number;
  message?: string;
}

function localOAuthDirectory(env: NodeJS.ProcessEnv): string {
  const override = env.CODEX_AZURE_DEVOPS_OAUTH_DIR;
  if (override !== undefined && override.trim() !== "") {
    return path.resolve(override);
  }
  return path.join(os.homedir(), ".Codex", "plugins", "azure-devops");
}

function localOAuthTokenPath(env: NodeJS.ProcessEnv): string {
  const override = env.CODEX_AZURE_DEVOPS_OAUTH_FILE;
  if (override !== undefined && override.trim() !== "") {
    return path.resolve(override);
  }
  return path.join(localOAuthDirectory(env), "oauth.json");
}

function localOAuthKeyPath(env: NodeJS.ProcessEnv): string {
  const override = env.CODEX_AZURE_DEVOPS_OAUTH_KEY_FILE;
  if (override !== undefined && override.trim() !== "") {
    return path.resolve(override);
  }
  return path.join(localOAuthDirectory(env), "oauth.key");
}

function pendingDevicePath(env: NodeJS.ProcessEnv): string {
  return path.join(localOAuthDirectory(env), "oauth-device.json");
}

function loopbackHost(env: NodeJS.ProcessEnv): string {
  const host = env.CODEX_AZURE_DEVOPS_OAUTH_HOST?.trim();
  return host === "127.0.0.1" ? host : "localhost";
}

function defaultScope(env: NodeJS.ProcessEnv): string {
  return (
    env.AZURE_DEVOPS_SCOPE?.trim() ||
    ["openid", "profile", "offline_access", `${AZURE_DEVOPS_RESOURCE_ID}/.default`].join(
      " "
    )
  );
}

function resolveClientId(env: NodeJS.ProcessEnv): string | undefined {
  const value =
    env.AZURE_DEVOPS_OAUTH_CLIENT_ID ?? env.MICROSOFT_ENTRA_CLIENT_ID;
  return value === undefined || value.trim() === "" ? undefined : value.trim();
}

function resolveRuntimeConfig(
  env: NodeJS.ProcessEnv,
  requireClientId: boolean
): LocalOAuthRuntimeConfig | undefined {
  const clientId = resolveClientId(env);
  if (clientId === undefined) {
    if (requireClientId) {
      throw new AdoError(
        "Microsoft OAuth client ID is required. Set AZURE_DEVOPS_OAUTH_CLIENT_ID or MICROSOFT_ENTRA_CLIENT_ID, or use the hosted HTTP plugin.",
        { kind: "configuration" }
      );
    }
  }

  return {
    clientId: clientId ?? "",
    tenant: env.MICROSOFT_ENTRA_TENANT?.trim() || DEFAULT_TENANT,
    scope: defaultScope(env),
  tokenPath: localOAuthTokenPath(env),
  keyPath: localOAuthKeyPath(env),
  pendingDevicePath: pendingDevicePath(env)
  };
}

function authEndpoint(tenant: string): string {
  return `https://login.microsoftonline.com/${encodeURIComponent(
    tenant
  )}/oauth2/v2.0/authorize`;
}

function deviceEndpoint(tenant: string): string {
  return `https://login.microsoftonline.com/${encodeURIComponent(
    tenant
  )}/oauth2/v2.0/devicecode`;
}

function tokenEndpoint(tenant: string): string {
  return `https://login.microsoftonline.com/${encodeURIComponent(
    tenant
  )}/oauth2/v2.0/token`;
}

function readJsonFile<T>(filePath: string): T | undefined {
  if (!fs.existsSync(filePath)) {
    return undefined;
  }
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
}

function writeJsonFile(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(`${filePath}.tmp`, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600
  });
  fs.renameSync(`${filePath}.tmp`, filePath);
  fs.chmodSync(filePath, 0o600);
}

function readEncryptionKey(
  config: LocalOAuthRuntimeConfig,
  env: NodeJS.ProcessEnv,
  create: boolean
): Buffer | undefined {
  const envKey = env.TOKEN_ENCRYPTION_KEY;
  if (envKey !== undefined && envKey.trim() !== "") {
    return parseEncryptionKey(envKey);
  }

  if (fs.existsSync(config.keyPath)) {
    return parseEncryptionKey(fs.readFileSync(config.keyPath, "utf8"));
  }

  if (!create) {
    return undefined;
  }

  const raw = randomBytes(32).toString("base64");
  fs.mkdirSync(path.dirname(config.keyPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(config.keyPath, `${raw}\n`, {
    encoding: "utf8",
    mode: 0o600
  });
  fs.chmodSync(config.keyPath, 0o600);
  return parseEncryptionKey(raw);
}

function readStoredTokens(
  env: NodeJS.ProcessEnv = process.env
): StoredLocalOAuthTokens | undefined {
  const config = resolveRuntimeConfig(env, false);
  if (config === undefined) {
    return undefined;
  }
  const stored = readJsonFile<StoredLocalOAuthTokens>(config.tokenPath);
  return stored?.version === LOCAL_OAUTH_VERSION ? stored : undefined;
}

function saveTokenResponse(options: {
  config: LocalOAuthRuntimeConfig;
  env: NodeJS.ProcessEnv;
  response: MicrosoftTokenResponse;
  previous?: StoredLocalOAuthTokens;
}): StoredLocalOAuthTokens {
  const key = readEncryptionKey(options.config, options.env, true);
  if (key === undefined) {
    throw new AdoError("Microsoft OAuth token encryption key is missing.", {
      kind: "configuration"
    });
  }
  const idToken = options.response.idToken;
  if (idToken === undefined && options.previous === undefined) {
    throw new AdoError("Microsoft OAuth response did not include id_token.", {
      kind: "authentication"
    });
  }
  const identity =
    idToken === undefined ? undefined : parseMicrosoftIdentity(idToken);
  const refreshToken =
    options.response.refreshToken ??
    (options.previous?.encryptedRefreshToken === undefined
      ? undefined
      : decryptSecret(options.previous.encryptedRefreshToken, key));
  const stored: StoredLocalOAuthTokens = {
    version: LOCAL_OAUTH_VERSION,
    clientId: options.previous?.clientId ?? options.config.clientId,
    tenant: options.previous?.tenant ?? options.config.tenant,
    userId: identity?.subject ?? options.previous?.userId ?? "",
    encryptedAccessToken: encryptSecret(options.response.accessToken, key),
    expiresAt: Date.now() + (options.response.expiresIn ?? 3600) * 1000,
    scope: options.response.scope ?? options.config.scope
  };
  const displayName = identity?.displayName ?? options.previous?.displayName;
  if (displayName !== undefined) {
    stored.displayName = displayName;
  }
  if (refreshToken !== undefined) {
    stored.encryptedRefreshToken = encryptSecret(refreshToken, key);
  }
  writeJsonFile(options.config.tokenPath, stored);
  return stored;
}

async function postToken(
  tenant: string,
  params: URLSearchParams,
  fetchImpl: typeof fetch
): Promise<MicrosoftTokenResponse> {
  const response = await fetchImpl(tokenEndpoint(tenant), {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: params.toString()
  });
  const body = (await response.json()) as unknown;
  if (!response.ok) {
    throw new AdoError("Microsoft OAuth token exchange failed.", {
      kind: "authentication",
      status: response.status,
      details: body
    });
  }
  return parseMicrosoftTokenResponse(body);
}

async function refreshStoredTokens(options: {
  config: LocalOAuthRuntimeConfig;
  env: NodeJS.ProcessEnv;
  stored: StoredLocalOAuthTokens;
  fetchImpl: typeof fetch;
}): Promise<string> {
  const key = readEncryptionKey(options.config, options.env, false);
  if (key === undefined || options.stored.encryptedRefreshToken === undefined) {
    throw new AdoError(
      "Microsoft OAuth refresh token is missing. Run ado_login again.",
      { kind: "authentication" }
    );
  }
  const response = await postToken(
    options.stored.tenant,
    new URLSearchParams({
      client_id: options.stored.clientId,
      grant_type: "refresh_token",
      refresh_token: decryptSecret(options.stored.encryptedRefreshToken, key),
      scope: options.stored.scope
    }),
    options.fetchImpl
  );
  saveTokenResponse({
    config: options.config,
    env: options.env,
    response,
    previous: options.stored
  });
  return response.accessToken;
}

export function createLocalOAuthAccessTokenFetcher(
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch
): () => Promise<string | undefined> {
  return async () => {
    const config = resolveRuntimeConfig(env, false);
    if (config === undefined) {
      return undefined;
    }
    const stored = readJsonFile<StoredLocalOAuthTokens>(config.tokenPath);
    if (stored?.version !== LOCAL_OAUTH_VERSION) {
      return undefined;
    }
    const key = readEncryptionKey(config, env, false);
    if (key === undefined) {
      throw new AdoError(
        "Microsoft OAuth token encryption key is missing. Run ado_login again.",
        { kind: "configuration" }
      );
    }
    if (stored.expiresAt > Date.now() + MIN_FRESH_TOKEN_MS) {
      return decryptSecret(stored.encryptedAccessToken, key);
    }
    return await refreshStoredTokens({ config, env, stored, fetchImpl });
  };
}

export function getLocalOAuthStatus(
  env: NodeJS.ProcessEnv = process.env
): LocalOAuthStatus {
  const config = resolveRuntimeConfig(env, false);
  const clientConfigured = resolveClientId(env) !== undefined;
  if (config === undefined) {
    return {
      mode: "microsoft-oauth",
      status: "not-configured",
      loginTool: "ado_login",
      clientConfigured
    };
  }

  try {
    const stored = readStoredTokens(env);
    if (stored === undefined) {
      if (!clientConfigured) {
        return {
          mode: "microsoft-oauth",
          status: "not-configured",
          loginTool: "ado_login",
          clientConfigured,
          tokenFile: config.tokenPath
        };
      }
      return {
        mode: "microsoft-oauth",
        status: "not-connected",
        loginTool: "ado_login",
        clientConfigured,
        tenant: config.tenant,
        scope: config.scope,
        tokenFile: config.tokenPath
      };
    }
    return {
      mode: "microsoft-oauth",
      status:
        stored.expiresAt > Date.now() + MIN_FRESH_TOKEN_MS
          ? "connected"
          : "expired",
      loginTool: "ado_login",
      clientConfigured,
      user: stored.displayName ?? stored.userId,
      tenant: stored.tenant,
      scope: stored.scope,
      expiresAt: new Date(stored.expiresAt).toISOString(),
      tokenFile: config.tokenPath
    };
  } catch (error) {
    return {
      mode: "microsoft-oauth",
      status: "error",
      loginTool: "ado_login",
      clientConfigured,
      tenant: config.tenant,
      scope: config.scope,
      tokenFile: config.tokenPath,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

function browserCommand(url: string): { command: string; args: string[] } {
  if (process.platform === "darwin") {
    return { command: "open", args: [url] };
  }
  if (process.platform === "win32") {
    return { command: "cmd", args: ["/c", "start", "", url] };
  }
  return { command: "xdg-open", args: [url] };
}

async function defaultBrowserOpener(url: string): Promise<void> {
  const { command, args } = browserCommand(url);
  await execFileAsync(command, args, { timeout: 10000 });
}

async function listen(server: Server, host: string): Promise<string> {
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
    server.listen(0, host);
  });
  const address = server.address() as AddressInfo;
  return `http://${host}:${address.port}`;
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}

function callbackHtml(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head><body><main style="font-family: system-ui, sans-serif; max-width: 640px; margin: 48px auto;"><h1>${title}</h1><p>${body}</p></main></body></html>`;
}

async function waitForBrowserCode(options: {
  config: LocalOAuthRuntimeConfig;
  env: NodeJS.ProcessEnv;
  timeoutSeconds: number;
  openBrowser: boolean;
  browserOpener: (url: string) => Promise<void>;
}): Promise<{ code: string; codeVerifier: string; redirectUri: string }> {
  const state = randomToken();
  const codeVerifier = randomToken(48);
  let resolveCode!: (value: { code: string; state: string }) => void;
  let rejectCode!: (reason: unknown) => void;
  const codePromise = new Promise<{ code: string; state: string }>(
    (resolve, reject) => {
      resolveCode = resolve;
      rejectCode = reject;
    }
  );

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const base = `http://${req.headers.host ?? "127.0.0.1"}`;
    const url = new URL(req.url ?? "/", base);
    if (url.pathname !== "/auth/callback") {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    const error = url.searchParams.get("error");
    if (error !== null) {
      res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        callbackHtml(
          "Microsoft sign-in failed",
          url.searchParams.get("error_description") ?? error
        )
      );
      rejectCode(new AdoError("Microsoft OAuth sign-in failed.", {
        kind: "authentication",
        details: Object.fromEntries(url.searchParams.entries())
      }));
      return;
    }
    const code = url.searchParams.get("code");
    const callbackState = url.searchParams.get("state");
    if (code === null || callbackState === null) {
      res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
      res.end(callbackHtml("Microsoft sign-in failed", "The callback was missing code or state."));
      rejectCode(new AdoError("Microsoft OAuth callback was missing code or state.", {
        kind: "authentication"
      }));
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(
      callbackHtml(
        "Microsoft sign-in complete",
        "You can close this browser tab and return to Codex."
      )
    );
    resolveCode({ code, state: callbackState });
  });

  const redirectUri = `${await listen(
    server,
    loopbackHost(options.env)
  )}/auth/callback`;
  const authUrl = new URL(authEndpoint(options.config.tenant));
  authUrl.searchParams.set("client_id", options.config.clientId);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("response_mode", "query");
  authUrl.searchParams.set("scope", options.config.scope);
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("code_challenge", codeChallengeS256(codeVerifier));
  authUrl.searchParams.set("code_challenge_method", "S256");
  authUrl.searchParams.set("prompt", "select_account");

  const timeout = setTimeout(() => {
    rejectCode(
      new AdoError("Microsoft OAuth browser sign-in timed out.", {
        kind: "authentication",
        details: { authorizationUrl: authUrl.toString() }
      })
    );
  }, options.timeoutSeconds * 1000);

  try {
    if (options.openBrowser) {
      await options.browserOpener(authUrl.toString());
    }
    const result = await codePromise;
    if (result.state !== state) {
      throw new AdoError("Microsoft OAuth callback state is invalid.", {
        kind: "authentication"
      });
    }
    return {
      code: result.code,
      codeVerifier,
      redirectUri
    };
  } finally {
    clearTimeout(timeout);
    await closeServer(server);
  }
}

async function runBrowserLogin(options: {
  config: LocalOAuthRuntimeConfig;
  env: NodeJS.ProcessEnv;
  timeoutSeconds: number;
  openBrowser: boolean;
  fetchImpl: typeof fetch;
  browserOpener: (url: string) => Promise<void>;
}): Promise<Record<string, unknown>> {
  const callback = await waitForBrowserCode({
    config: options.config,
    env: options.env,
    timeoutSeconds: options.timeoutSeconds,
    openBrowser: options.openBrowser,
    browserOpener: options.browserOpener
  });
  const response = await postToken(
    options.config.tenant,
    new URLSearchParams({
      client_id: options.config.clientId,
      grant_type: "authorization_code",
      code: callback.code,
      redirect_uri: callback.redirectUri,
      code_verifier: callback.codeVerifier,
      scope: options.config.scope
    }),
    options.fetchImpl
  );
  const stored = saveTokenResponse({
    config: options.config,
    env: options.env,
    response
  });
  return {
    summary: "Microsoft OAuth sign-in completed.",
    auth: {
      mode: "microsoft-oauth",
      status: "connected",
      user: stored.displayName ?? stored.userId,
      source: "browser",
      expiresAt: new Date(stored.expiresAt).toISOString()
    }
  };
}

async function requestDeviceCode(options: {
  config: LocalOAuthRuntimeConfig;
  fetchImpl: typeof fetch;
}): Promise<DeviceAuthorizationResponse> {
  const response = await options.fetchImpl(deviceEndpoint(options.config.tenant), {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams({
      client_id: options.config.clientId,
      scope: options.config.scope
    }).toString()
  });
  const body = (await response.json()) as unknown;
  if (!response.ok) {
    throw new AdoError("Microsoft OAuth device login could not start.", {
      kind: "authentication",
      status: response.status,
      details: body
    });
  }
  const value = body as Partial<DeviceAuthorizationResponse>;
  if (
    typeof value.device_code !== "string" ||
    typeof value.user_code !== "string" ||
    typeof value.verification_uri !== "string" ||
    typeof value.expires_in !== "number"
  ) {
    throw new AdoError("Microsoft OAuth device login response was malformed.", {
      kind: "authentication",
      details: body
    });
  }
  const parsed: DeviceAuthorizationResponse = {
    device_code: value.device_code,
    user_code: value.user_code,
    verification_uri: value.verification_uri,
    expires_in: value.expires_in
  };
  if (typeof value.interval === "number") {
    parsed.interval = value.interval;
  }
  if (typeof value.message === "string") {
    parsed.message = value.message;
  }
  return parsed;
}

async function runDeviceStart(options: {
  config: LocalOAuthRuntimeConfig;
  openBrowser: boolean;
  fetchImpl: typeof fetch;
  browserOpener: (url: string) => Promise<void>;
}): Promise<Record<string, unknown>> {
  const response = await requestDeviceCode(options);
  const pending: PendingDeviceLogin = {
    version: LOCAL_OAUTH_VERSION,
    clientId: options.config.clientId,
    tenant: options.config.tenant,
    scope: options.config.scope,
    deviceCode: response.device_code,
    userCode: response.user_code,
    verificationUri: response.verification_uri,
    expiresAt: Date.now() + response.expires_in * 1000,
    intervalSeconds: response.interval ?? 5
  };
  writeJsonFile(options.config.pendingDevicePath, pending);
  if (options.openBrowser) {
    await options.browserOpener(response.verification_uri);
  }
  return {
    summary:
      "Microsoft device login started. Finish sign-in in the browser, then call ado_login again with mode=device and deviceAction=complete.",
    verificationUri: response.verification_uri,
    userCode: response.user_code,
    message: response.message,
    expiresAt: new Date(pending.expiresAt).toISOString()
  };
}

async function runDeviceComplete(options: {
  config: LocalOAuthRuntimeConfig;
  env: NodeJS.ProcessEnv;
  timeoutSeconds: number;
  fetchImpl: typeof fetch;
}): Promise<Record<string, unknown>> {
  const pending = readJsonFile<PendingDeviceLogin>(options.config.pendingDevicePath);
  if (pending?.version !== LOCAL_OAUTH_VERSION) {
    throw new AdoError("No pending Microsoft device login was found.", {
      kind: "authentication"
    });
  }
  if (pending.expiresAt <= Date.now()) {
    throw new AdoError("The pending Microsoft device login expired.", {
      kind: "authentication"
    });
  }

  const deadline = Date.now() + options.timeoutSeconds * 1000;
  let intervalSeconds = pending.intervalSeconds;
  while (Date.now() < deadline) {
    const response = await options.fetchImpl(tokenEndpoint(pending.tenant), {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: new URLSearchParams({
        client_id: pending.clientId,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: pending.deviceCode
      }).toString()
    });
    const body = (await response.json()) as unknown;
    if (response.ok) {
      const pendingConfig: LocalOAuthRuntimeConfig = {
        ...options.config,
        clientId: pending.clientId,
        tenant: pending.tenant,
        scope: pending.scope
      };
      const stored = saveTokenResponse({
        config: pendingConfig,
        env: options.env,
        response: parseMicrosoftTokenResponse(body)
      });
      return {
        summary: "Microsoft OAuth device sign-in completed.",
        auth: {
          mode: "microsoft-oauth",
          status: "connected",
          user: stored.displayName ?? stored.userId,
          source: "device-code",
          expiresAt: new Date(stored.expiresAt).toISOString()
        }
      };
    }

    const error =
      typeof body === "object" && body !== null && "error" in body
        ? String((body as { error: unknown }).error)
        : "unknown_error";
    if (error === "authorization_pending") {
      await new Promise((resolve) => setTimeout(resolve, intervalSeconds * 1000));
      continue;
    }
    if (error === "slow_down") {
      intervalSeconds += 5;
      await new Promise((resolve) => setTimeout(resolve, intervalSeconds * 1000));
      continue;
    }
    throw new AdoError("Microsoft OAuth device sign-in failed.", {
      kind: "authentication",
      status: response.status,
      details: body
    });
  }

  throw new AdoError("Microsoft OAuth device sign-in is still pending.", {
    kind: "authentication",
    details: {
      verificationUri: pending.verificationUri,
      userCode: pending.userCode
    }
  });
}

export async function runLocalOAuthLogin(
  options: LocalOAuthLoginOptions = {}
): Promise<Record<string, unknown>> {
  const env = options.env ?? process.env;
  const config = resolveRuntimeConfig(env, true);
  if (config === undefined) {
    throw new AdoError("Microsoft OAuth client ID is required.", {
      kind: "configuration"
    });
  }
  const timeoutSeconds = options.timeoutSeconds ?? 180;
  const fetchImpl = options.fetchImpl ?? fetch;
  const browserOpener = options.browserOpener ?? defaultBrowserOpener;
  const openBrowser = options.openBrowser ?? true;

  if ((options.mode ?? "browser") === "device") {
    if ((options.deviceAction ?? "start") === "complete") {
      return await runDeviceComplete({
        config,
        env,
        timeoutSeconds,
        fetchImpl
      });
    }
    return await runDeviceStart({
      config,
      openBrowser,
      fetchImpl,
      browserOpener
    });
  }

  return await runBrowserLogin({
    config,
    env,
    timeoutSeconds,
    openBrowser,
    fetchImpl,
    browserOpener
  });
}
