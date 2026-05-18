import express from "express";
import type {
  NextFunction,
  Request as ExpressRequest,
  Response as ExpressResponse
} from "express";

import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server";

import { AdoClient } from "./client.js";
import { AdoConfig } from "./config.js";
import {
  parseEncryptionKey,
  randomToken,
  sha256,
  signValue,
  timingSafeEqualString,
  verifySignedValue
} from "./crypto.js";
import { AdoError, serializeError } from "./errors.js";
import { listRepositories } from "./repos.js";
import {
  microsoftAuthorizeUrl,
  RemoteServiceConfig
} from "./remoteConfig.js";
import {
  codeChallengeS256,
  exchangeMicrosoftCode,
  microsoftLoginScope,
  parseMicrosoftIdentity,
  RemoteAdoAuthProvider,
  storeMicrosoftTokenResponse
} from "./remoteOAuth.js";
import { renderSettingsPage, renderSignInPage } from "./remoteUi.js";
import type { SettingsPageOptions } from "./remoteUi.js";
import {
  OAuthClientRecord,
  OAuthCodeRecord,
  RemoteSession,
  RemoteSettings,
  RemoteUser,
  RemoteStore,
  SqliteRemoteStore
} from "./remoteStore.js";
import { createAzureDevOpsServer } from "./server.js";
import { normalizeHostedOrgUrl } from "./validation.js";

const SESSION_COOKIE = "ado_plugin_session";
const OAUTH_CODE_TTL_MS = 5 * 60 * 1000;

export interface RemoteHostOptions {
  config: RemoteServiceConfig;
  store?: RemoteStore;
  encryptionKey?: Buffer;
}

interface AuthedSession {
  session: RemoteSession;
  userId: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stringBodyValue(body: unknown, key: string): string | undefined {
  if (!isRecord(body)) {
    return undefined;
  }
  const value = body[key];
  return typeof value === "string" && value.trim() !== ""
    ? value.trim()
    : undefined;
}

function queryString(req: ExpressRequest, key: string): string | undefined {
  const value = req.query[key];
  return typeof value === "string" && value.trim() !== ""
    ? value.trim()
    : undefined;
}

function parseCookies(req: ExpressRequest): Map<string, string> {
  const cookies = new Map<string, string>();
  const header = req.headers.cookie;
  if (header === undefined) {
    return cookies;
  }
  for (const item of header.split(";")) {
    const [rawName, ...rawValue] = item.trim().split("=");
    if (rawName !== undefined && rawName !== "") {
      cookies.set(rawName, decodeURIComponent(rawValue.join("=")));
    }
  }
  return cookies;
}

function setSessionCookie(
  res: ExpressResponse,
  config: RemoteServiceConfig,
  sessionId: string
): void {
  const secure = config.publicBaseUrl.startsWith("https://");
  res.cookie(SESSION_COOKIE, signValue(sessionId, config.sessionSecret), {
    httpOnly: true,
    sameSite: "lax",
    secure,
    path: "/",
    maxAge: config.sessionTtlSeconds * 1000
  });
}

function getOrCreateSession(
  req: ExpressRequest,
  res: ExpressResponse,
  config: RemoteServiceConfig,
  store: RemoteStore
): RemoteSession {
  const signedSessionId = parseCookies(req).get(SESSION_COOKIE);
  const sessionId =
    signedSessionId === undefined
      ? undefined
      : verifySignedValue(signedSessionId, config.sessionSecret);
  const existing =
    sessionId === undefined ? undefined : store.getSession(sessionId);
  if (existing !== undefined && existing.expiresAt > Date.now()) {
    return existing;
  }

  const session: RemoteSession = {
    id: randomToken(),
    expiresAt: Date.now() + config.sessionTtlSeconds * 1000
  };
  store.upsertSession(session);
  setSessionCookie(res, config, session.id);
  return session;
}

function requireAuthedSession(
  req: ExpressRequest,
  res: ExpressResponse,
  config: RemoteServiceConfig,
  store: RemoteStore
): AuthedSession | undefined {
  const session = getOrCreateSession(req, res, config, store);
  if (session.userId === undefined) {
    const returnTo = encodeURIComponent(req.originalUrl || "/settings");
    res.redirect(`/login?returnTo=${returnTo}`);
    return undefined;
  }
  return { session, userId: session.userId };
}

function loginRedirectPath(req: ExpressRequest): string {
  const value = queryString(req, "returnTo");
  if (
    value === undefined ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value.includes("\\") ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    return "/settings";
  }
  return value;
}

function microsoftRedirectUri(config: RemoteServiceConfig): string {
  return `${config.publicBaseUrl}/auth/microsoft/callback`;
}

function settingsUrl(config: RemoteServiceConfig): string {
  return `${config.publicBaseUrl}/settings`;
}

function settingsLoginUrl(config: RemoteServiceConfig): string {
  return `${config.publicBaseUrl}/login?returnTo=%2Fsettings`;
}

function settingsFromBody(body: unknown): RemoteSettings {
  const orgUrl = stringBodyValue(body, "orgUrl");
  const project = stringBodyValue(body, "project");
  if (orgUrl === undefined || project === undefined) {
    throw new AdoError("Organization URL and project are required.", {
      kind: "validation"
    });
  }

  const repositories = stringBodyValue(body, "repositories")
    ?.split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);

  const requestTimeoutMs = Number.parseInt(
    stringBodyValue(body, "requestTimeoutMs") ?? "30000",
    10
  );
  const maxPages = Number.parseInt(
    stringBodyValue(body, "maxPages") ?? "20",
    10
  );
  if (
    !Number.isFinite(requestTimeoutMs) ||
    requestTimeoutMs < 1000 ||
    !Number.isFinite(maxPages) ||
    maxPages < 1
  ) {
    throw new AdoError("Request timeout and max pages must be positive.", {
      kind: "validation"
    });
  }

  const settings: RemoteSettings = {
    orgUrl: normalizeHostedOrgUrl(orgUrl),
    project,
    requestTimeoutMs,
    maxPages
  };
  if (repositories !== undefined && repositories.length > 0) {
    settings.repositories = repositories;
  }
  return settings;
}

function settingsToAdoConfig(settings: RemoteSettings): AdoConfig {
  const config: AdoConfig = {
    orgUrl: settings.orgUrl,
    project: settings.project,
    apiVersion: "7.1",
    requestTimeoutMs: settings.requestTimeoutMs,
    maxPages: settings.maxPages
  };
  if (settings.repositories !== undefined) {
    config.repositories = settings.repositories;
  }
  return config;
}

function serviceSettings(config: RemoteServiceConfig): RemoteSettings | undefined {
  if (
    config.defaultOrgUrl === undefined ||
    config.defaultProject === undefined
  ) {
    return undefined;
  }
  const settings: RemoteSettings = {
    orgUrl: config.defaultOrgUrl,
    project: config.defaultProject,
    requestTimeoutMs: config.defaultRequestTimeoutMs,
    maxPages: config.defaultMaxPages
  };
  if (config.defaultRepositories !== undefined) {
    settings.repositories = config.defaultRepositories;
  }
  return settings;
}

function activeSettings(options: {
  config: RemoteServiceConfig;
  userSettings: RemoteSettings | undefined;
}): { settings: RemoteSettings | undefined; source: "user" | "service" | "none" } {
  if (options.userSettings !== undefined) {
    return { settings: options.userSettings, source: "user" };
  }
  const defaults = serviceSettings(options.config);
  if (defaults !== undefined) {
    return { settings: defaults, source: "service" };
  }
  return { settings: undefined, source: "none" };
}

function createRemoteClient(options: {
  config: RemoteServiceConfig;
  encryptionKey: Buffer;
  store: RemoteStore;
  userId: string;
  settings: RemoteSettings | undefined;
}): AdoClient {
  const resolved = activeSettings({
    config: options.config,
    userSettings: options.settings
  });
  if (resolved.settings === undefined) {
    throw new AdoError(
      "Azure DevOps workspace defaults are not configured for this hosted plugin deployment.",
      { kind: "configuration" }
    );
  }
  return new AdoClient({
    config: settingsToAdoConfig(resolved.settings),
    authProvider: new RemoteAdoAuthProvider({
      config: options.config,
      encryptionKey: options.encryptionKey,
      store: options.store,
      userId: options.userId
    })
  });
}

function sendJsonError(res: ExpressResponse, error: unknown): void {
  const status =
    error instanceof AdoError && error.status !== undefined
      ? error.status
      : 500;
  res.status(status).json({ error: serializeError(error) });
}

function sendOAuthError(
  res: ExpressResponse,
  status: number,
  error: string,
  description: string
): void {
  res.status(status).json({
    error,
    error_description: description
  });
}

function bearerToken(req: ExpressRequest): string | undefined {
  const header = req.headers.authorization;
  if (header === undefined) {
    return undefined;
  }
  const [scheme, token] = header.split(" ");
  return scheme?.toLowerCase() === "bearer" && token !== undefined
    ? token
    : undefined;
}

function redirectUriAllowed(clientRedirectUris: string[], redirectUri: string): boolean {
  return clientRedirectUris.includes(redirectUri);
}

function isLoopbackHost(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]" ||
    hostname === "::1"
  );
}

function redirectUriAllowedForRegistration(
  config: RemoteServiceConfig,
  redirectUri: string
): boolean {
  let url: URL;
  try {
    url = new URL(redirectUri);
  } catch {
    return false;
  }
  if (
    url.username !== "" ||
    url.password !== "" ||
    url.hash !== "" ||
    url.protocol === "file:"
  ) {
    return false;
  }
  if (url.protocol === "http:") {
    return isLoopbackHost(url.hostname);
  }
  if (url.protocol === "https:") {
    return config.allowedOAuthRedirectOrigins.includes(url.origin);
  }
  return false;
}

function appendCodeRedirect(
  redirectUri: string,
  code: string,
  state: string | undefined
): string {
  const url = new URL(redirectUri);
  url.searchParams.set("code", code);
  if (state !== undefined) {
    url.searchParams.set("state", state);
  }
  return url.toString();
}

function webRequestFromExpress(
  req: ExpressRequest,
  config: RemoteServiceConfig
): globalThis.Request {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        headers.append(key, item);
      }
    } else if (value !== undefined) {
      headers.set(key, value);
    }
  }

  const init: RequestInit = {
    method: req.method,
    headers
  };
  if (
    req.method !== "GET" &&
    req.method !== "HEAD" &&
    Buffer.isBuffer(req.body) &&
    req.body.length > 0
  ) {
    init.body = new Uint8Array(req.body);
  }

  return new globalThis.Request(`${config.publicBaseUrl}${req.originalUrl}`, init);
}

async function sendWebResponse(
  res: ExpressResponse,
  response: globalThis.Response
): Promise<void> {
  res.status(response.status);
  response.headers.forEach((value, key) => {
    res.setHeader(key, value);
  });
  const body = Buffer.from(await response.arrayBuffer());
  res.send(body);
}

function metadata(config: RemoteServiceConfig): Record<string, unknown> {
  return {
    issuer: config.publicBaseUrl,
    authorization_endpoint: `${config.publicBaseUrl}/oauth/authorize`,
    token_endpoint: `${config.publicBaseUrl}/oauth/token`,
    registration_endpoint: `${config.publicBaseUrl}/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: ["mcp"]
  };
}

function settingsPage(options: {
  user: RemoteUser;
  settings?: RemoteSettings | undefined;
  message?: string | undefined;
  error?: string | undefined;
}): string {
  const page: SettingsPageOptions = { user: options.user };
  if (options.settings !== undefined) {
    page.settings = options.settings;
  }
  if (options.message !== undefined) {
    page.message = options.message;
  }
  if (options.error !== undefined) {
    page.error = options.error;
  }
  return renderSettingsPage(page);
}

function signInPage(config: RemoteServiceConfig, error?: string): string {
  const page = { loginUrl: "/login?returnTo=%2Fsettings" };
  if (error !== undefined) {
    return renderSignInPage({ ...page, error });
  }
  return renderSignInPage(page);
}

function remoteSetupStatus(options: {
  config: RemoteServiceConfig;
  settings: RemoteSettings | undefined;
  user: RemoteUser | undefined;
}): Record<string, unknown> {
  const resolved = activeSettings({
    config: options.config,
    userSettings: options.settings
  });
  const configured = resolved.settings !== undefined;
  const authenticated = options.user !== undefined;
  return {
    configured,
    authenticated,
    configurationSource: resolved.source,
    configurationUrl: settingsUrl(options.config),
    loginUrl: settingsLoginUrl(options.config),
    orgUrl: resolved.settings?.orgUrl,
    project: resolved.settings?.project,
    repositories: resolved.settings?.repositories,
    auth: {
      mode: "microsoft-oauth",
      provider: "Microsoft Entra",
      status: authenticated ? "connected" : "needs-login",
      user: options.user?.displayName
    },
    nextSteps: configured
      ? ["Run ado_test_connection to verify live Azure DevOps access."]
      : authenticated
        ? [
            `Open ${settingsUrl(
              options.config
            )} to review or override the Azure DevOps organization, project, and repository allowlist.`
          ]
      : [
          `Open ${settingsLoginUrl(
            options.config
          )} to sign in with Microsoft OAuth.`
        ]
  };
}

export function createRemoteHost(options: RemoteHostOptions): express.Express {
  const config = options.config;
  const encryptionKey =
    options.encryptionKey ?? parseEncryptionKey(config.tokenEncryptionKey);
  const store = options.store ?? new SqliteRemoteStore(config.sqlitePath);
  const app = express();
  app.disable("x-powered-by");

  app.get("/.well-known/oauth-authorization-server", (_req, res) => {
    res.json(metadata(config));
  });

  app.get("/.well-known/oauth-protected-resource", (_req, res) => {
    res.json({
      resource: `${config.publicBaseUrl}/mcp`,
      authorization_servers: [config.publicBaseUrl],
      scopes_supported: ["mcp"]
    });
  });

  app.all("/mcp", express.raw({ type: "*/*" }), async (req, res) => {
    try {
      const rawToken = bearerToken(req);
      if (rawToken === undefined) {
        res.setHeader(
          "WWW-Authenticate",
          `Bearer resource_metadata="${config.publicBaseUrl}/.well-known/oauth-protected-resource"`
        );
        sendOAuthError(res, 401, "invalid_token", "Bearer token is required.");
        return;
      }
      const token = store.getMcpToken(sha256(rawToken));
      if (token === undefined || token.expiresAt <= Date.now()) {
        sendOAuthError(res, 401, "invalid_token", "Bearer token is invalid.");
        return;
      }

      const settings = store.getSettings(token.userId);
      const user = store.getUser(token.userId);
      const transport = new WebStandardStreamableHTTPServerTransport({
        enableJsonResponse: true
      });
      const server = createAzureDevOpsServer({
        includeLocalSetupTools: false,
        setupStatusProvider: () =>
          remoteSetupStatus({
            config,
            settings,
            user
          }),
        createClient: () =>
          createRemoteClient({
            config,
            encryptionKey,
            store,
            userId: token.userId,
            settings
          })
      });
      await server.connect(transport);
      try {
        const response = await transport.handleRequest(
          webRequestFromExpress(req, config)
        );
        await sendWebResponse(res, response);
      } finally {
        await server.close();
      }
    } catch (error) {
      sendJsonError(res, error);
    }
  });

  app.use(express.urlencoded({ extended: false }));
  app.use(express.json());

  app.get("/", (req, res) => {
    const session = getOrCreateSession(req, res, config, store);
    res.redirect(
      session.userId === undefined
        ? "/login?returnTo=%2Fsettings"
        : "/settings"
    );
  });

  app.get("/login", (req, res) => {
    const session = getOrCreateSession(req, res, config, store);
    const state = randomToken();
    store.upsertSession({
      ...session,
      microsoftState: state,
      returnTo: loginRedirectPath(req),
      expiresAt: Date.now() + config.sessionTtlSeconds * 1000
    });

    const url = new URL(microsoftAuthorizeUrl(config));
    url.searchParams.set("client_id", config.microsoftClientId);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("redirect_uri", microsoftRedirectUri(config));
    url.searchParams.set("response_mode", "query");
    url.searchParams.set("scope", microsoftLoginScope(config));
    url.searchParams.set("state", state);
    res.redirect(url.toString());
  });

  app.get("/auth/microsoft/callback", async (req, res) => {
    try {
      const session = getOrCreateSession(req, res, config, store);
      const code = queryString(req, "code");
      const state = queryString(req, "state");
      if (
        code === undefined ||
        state === undefined ||
        session.microsoftState === undefined ||
        !timingSafeEqualString(state, session.microsoftState)
      ) {
        throw new AdoError("Microsoft OAuth callback state is invalid.", {
          kind: "authentication"
        });
      }

      const tokenResponse = await exchangeMicrosoftCode({
        config,
        code,
        redirectUri: microsoftRedirectUri(config)
      });
      if (tokenResponse.idToken === undefined) {
        throw new AdoError("Microsoft OAuth response did not include id_token.", {
          kind: "authentication"
        });
      }
      const identity = parseMicrosoftIdentity(tokenResponse.idToken);
      const existing = store.getUserByMicrosoftSubject(identity.subject);
      const user: RemoteUser = {
        id: existing?.id ?? randomToken(),
        microsoftSubject: identity.subject
      };
      if (identity.displayName !== undefined) {
        user.displayName = identity.displayName;
      }
      store.upsertUser(user);
      storeMicrosoftTokenResponse({
        store,
        encryptionKey,
        userId: user.id,
        response: tokenResponse,
        defaultScope: config.azureDevOpsScope
      });
      const updatedSession: RemoteSession = {
        id: session.id,
        userId: user.id,
        expiresAt: Date.now() + config.sessionTtlSeconds * 1000
      };
      if (session.returnTo !== undefined) {
        updatedSession.returnTo = session.returnTo;
      }
      store.upsertSession(updatedSession);
      res.redirect(session.returnTo ?? "/settings");
    } catch (error) {
      sendJsonError(res, error);
    }
  });

  app.post("/oauth/register", (req, res) => {
    const redirectUris = isRecord(req.body) && Array.isArray(req.body.redirect_uris)
      ? req.body.redirect_uris.filter(
          (item): item is string => typeof item === "string"
        )
      : [];
    if (redirectUris.length === 0) {
      sendOAuthError(
        res,
        400,
        "invalid_client_metadata",
        "redirect_uris is required."
      );
      return;
    }
    if (
      !redirectUris.every((redirectUri) =>
        redirectUriAllowedForRegistration(config, redirectUri)
      )
    ) {
      sendOAuthError(
        res,
        400,
        "invalid_client_metadata",
        "redirect_uris must use loopback http or an explicitly allowed https origin."
      );
      return;
    }
    const clientId = randomToken(24);
    const clientName = stringBodyValue(req.body, "client_name");
    const clientRecord: OAuthClientRecord = {
      clientId,
      redirectUris
    };
    if (clientName !== undefined) {
      clientRecord.name = clientName;
    }
    store.saveOAuthClient(clientRecord);
    res.status(201).json({
      client_id: clientId,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      redirect_uris: redirectUris,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code"],
      response_types: ["code"]
    });
  });

  app.get("/oauth/authorize", (req, res) => {
    const authed = requireAuthedSession(req, res, config, store);
    if (authed === undefined) {
      return;
    }
    const responseType = queryString(req, "response_type");
    const clientId = queryString(req, "client_id");
    const redirectUri = queryString(req, "redirect_uri");
    const state = queryString(req, "state");
    const codeChallenge = queryString(req, "code_challenge");
    const codeChallengeMethod = queryString(req, "code_challenge_method");
    if (
      responseType !== "code" ||
      clientId === undefined ||
      redirectUri === undefined ||
      codeChallenge === undefined ||
      codeChallengeMethod !== "S256"
    ) {
      sendOAuthError(res, 400, "invalid_request", "Invalid authorize request.");
      return;
    }
    const client = store.getOAuthClient(clientId);
    if (client === undefined || !redirectUriAllowed(client.redirectUris, redirectUri)) {
      sendOAuthError(res, 400, "invalid_client", "Unknown OAuth client.");
      return;
    }
    const code = randomToken();
    const codeRecord: OAuthCodeRecord = {
      codeHash: sha256(code),
      userId: authed.userId,
      clientId,
      redirectUri,
      codeChallenge,
      expiresAt: Date.now() + OAUTH_CODE_TTL_MS
    };
    store.saveOAuthCode(codeRecord);
    res.redirect(appendCodeRedirect(redirectUri, code, state));
  });

  app.post("/oauth/token", (req, res) => {
    const grantType = stringBodyValue(req.body, "grant_type");
    const code = stringBodyValue(req.body, "code");
    const redirectUri = stringBodyValue(req.body, "redirect_uri");
    const clientId = stringBodyValue(req.body, "client_id");
    const codeVerifier = stringBodyValue(req.body, "code_verifier");
    if (
      grantType !== "authorization_code" ||
      code === undefined ||
      redirectUri === undefined ||
      clientId === undefined ||
      codeVerifier === undefined
    ) {
      sendOAuthError(res, 400, "invalid_request", "Invalid token request.");
      return;
    }
    const client = store.getOAuthClient(clientId);
    const record = store.consumeOAuthCode(sha256(code));
    if (
      client === undefined ||
      record === undefined ||
      record.clientId !== clientId ||
      record.redirectUri !== redirectUri ||
      record.expiresAt <= Date.now()
    ) {
      sendOAuthError(res, 400, "invalid_grant", "Authorization code is invalid.");
      return;
    }
    if (codeChallengeS256(codeVerifier) !== record.codeChallenge) {
      sendOAuthError(res, 400, "invalid_grant", "PKCE verifier is invalid.");
      return;
    }

    const accessToken = randomToken();
    store.saveMcpToken({
      tokenHash: sha256(accessToken),
      userId: record.userId,
      clientId,
      expiresAt: Date.now() + config.codexTokenTtlSeconds * 1000
    });
    res.json({
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: config.codexTokenTtlSeconds,
      scope: "mcp"
    });
  });

  app.get("/settings", (req, res) => {
    const session = getOrCreateSession(req, res, config, store);
    if (session.userId === undefined) {
      res.redirect("/login?returnTo=%2Fsettings");
      return;
    }
    const user = store.getUser(session.userId);
    if (user === undefined) {
      res.redirect("/login?returnTo=%2Fsettings");
      return;
    }
    const settings = activeSettings({
      config,
      userSettings: store.getSettings(user.id)
    }).settings;
    res.type("html").send(settingsPage({ user, settings }));
  });

  app.post("/settings", (req, res) => {
    const authed = requireAuthedSession(req, res, config, store);
    if (authed === undefined) {
      return;
    }
    const user = store.getUser(authed.userId);
    if (user === undefined) {
      res.redirect("/login");
      return;
    }
    try {
      const settings = settingsFromBody(req.body);
      store.saveSettings(user.id, settings);
      res.type("html").send(
        settingsPage({
          user,
          settings,
          message: "Settings saved."
        })
      );
    } catch (error) {
      res.type("html").status(400).send(
        settingsPage({
          user,
          settings: store.getSettings(user.id),
          error: serializeError(error).message as string
        })
      );
    }
  });

  app.post("/settings/test", async (req, res) => {
    const authed = requireAuthedSession(req, res, config, store);
    if (authed === undefined) {
      return;
    }
    const user = store.getUser(authed.userId);
    if (user === undefined) {
      res.redirect("/login");
      return;
    }
    let settings: RemoteSettings | undefined;
    try {
      settings = settingsFromBody(req.body);
      await listRepositories(
        createRemoteClient({
          config,
          encryptionKey,
          store,
          userId: user.id,
          settings
        }),
        {}
      );
      store.saveSettings(user.id, settings);
      res.type("html").send(
        settingsPage({
          user,
          settings,
          message: "Connection test succeeded."
        })
      );
    } catch (error) {
      res.type("html").status(400).send(
        settingsPage({
          user,
          settings: settings ?? store.getSettings(user.id),
          error: serializeError(error).message as string
        })
      );
    }
  });

  app.use(
    (
      error: unknown,
      _req: ExpressRequest,
      res: ExpressResponse,
      _next: NextFunction
    ) => {
      sendJsonError(res, error);
    }
  );

  return app;
}
