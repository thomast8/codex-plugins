import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface RemoteUser {
  id: string;
  microsoftSubject: string;
  displayName?: string;
}

export interface RemoteSession {
  id: string;
  userId?: string;
  microsoftState?: string;
  returnTo?: string;
  expiresAt: number;
}

export interface RemoteSettings {
  orgUrl: string;
  project: string;
  repositories?: string[];
  requestTimeoutMs: number;
  maxPages: number;
}

export interface StoredMicrosoftTokens {
  userId: string;
  encryptedAccessToken: string;
  encryptedRefreshToken?: string;
  expiresAt: number;
  scope: string;
}

export interface OAuthClientRecord {
  clientId: string;
  clientSecret?: string;
  redirectUris: string[];
  name?: string;
}

export interface OAuthCodeRecord {
  codeHash: string;
  userId: string;
  clientId: string;
  redirectUri: string;
  codeChallenge?: string;
  expiresAt: number;
}

export interface McpTokenRecord {
  tokenHash: string;
  userId: string;
  clientId: string;
  expiresAt: number;
}

export interface RemoteStore {
  upsertUser(user: RemoteUser): void;
  getUser(id: string): RemoteUser | undefined;
  getUserByMicrosoftSubject(subject: string): RemoteUser | undefined;
  upsertSession(session: RemoteSession): void;
  getSession(id: string): RemoteSession | undefined;
  saveSettings(userId: string, settings: RemoteSettings): void;
  getSettings(userId: string): RemoteSettings | undefined;
  saveMicrosoftTokens(tokens: StoredMicrosoftTokens): void;
  getMicrosoftTokens(userId: string): StoredMicrosoftTokens | undefined;
  saveOAuthClient(client: OAuthClientRecord): void;
  getOAuthClient(clientId: string): OAuthClientRecord | undefined;
  saveOAuthCode(code: OAuthCodeRecord): void;
  consumeOAuthCode(codeHash: string): OAuthCodeRecord | undefined;
  saveMcpToken(token: McpTokenRecord): void;
  getMcpToken(tokenHash: string): McpTokenRecord | undefined;
}

function asString(
  row: Record<string, unknown>,
  key: string
): string | undefined {
  const value = row[key];
  return typeof value === "string" ? value : undefined;
}

function asRequiredString(row: Record<string, unknown>, key: string): string {
  return asString(row, key) ?? "";
}

function asNumber(row: Record<string, unknown>, key: string): number {
  const value = row[key];
  return typeof value === "number" ? value : Number(value ?? 0);
}

function jsonStringArray(value: string | undefined): string[] | undefined {
  if (value === undefined || value === "") {
    return undefined;
  }
  const parsed = JSON.parse(value) as unknown;
  return Array.isArray(parsed)
    ? parsed.filter((item): item is string => typeof item === "string")
    : undefined;
}

export class SqliteRemoteStore implements RemoteStore {
  private readonly db: DatabaseSync;

  constructor(sqlitePath: string) {
    if (sqlitePath !== ":memory:") {
      mkdirSync(path.dirname(sqlitePath), { recursive: true });
    }
    this.db = new DatabaseSync(sqlitePath, { timeout: 5000 });
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        microsoft_subject TEXT NOT NULL UNIQUE,
        display_name TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT,
        microsoft_state TEXT,
        return_to TEXT,
        expires_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS settings (
        user_id TEXT PRIMARY KEY,
        org_url TEXT NOT NULL,
        project TEXT NOT NULL,
        repositories_json TEXT,
        request_timeout_ms INTEGER NOT NULL,
        max_pages INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS microsoft_tokens (
        user_id TEXT PRIMARY KEY,
        access_token_enc TEXT NOT NULL,
        refresh_token_enc TEXT,
        expires_at INTEGER NOT NULL,
        scope TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS oauth_clients (
        client_id TEXT PRIMARY KEY,
        client_secret TEXT,
        redirect_uris_json TEXT NOT NULL,
        name TEXT,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS oauth_codes (
        code_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        client_id TEXT NOT NULL,
        redirect_uri TEXT NOT NULL,
        code_challenge TEXT,
        expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS mcp_tokens (
        token_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        client_id TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  upsertUser(user: RemoteUser): void {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO users (id, microsoft_subject, display_name, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(microsoft_subject) DO UPDATE SET
           display_name = excluded.display_name,
           updated_at = excluded.updated_at`
      )
      .run(user.id, user.microsoftSubject, user.displayName ?? null, now, now);
  }

  getUser(id: string): RemoteUser | undefined {
    const row = this.db.prepare("SELECT * FROM users WHERE id = ?").get(id);
    return row === undefined ? undefined : this.userFromRow(row);
  }

  getUserByMicrosoftSubject(subject: string): RemoteUser | undefined {
    const row = this.db
      .prepare("SELECT * FROM users WHERE microsoft_subject = ?")
      .get(subject);
    return row === undefined ? undefined : this.userFromRow(row);
  }

  upsertSession(session: RemoteSession): void {
    this.db
      .prepare(
        `INSERT INTO sessions (id, user_id, microsoft_state, return_to, expires_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           user_id = excluded.user_id,
           microsoft_state = excluded.microsoft_state,
           return_to = excluded.return_to,
           expires_at = excluded.expires_at,
           updated_at = excluded.updated_at`
      )
      .run(
        session.id,
        session.userId ?? null,
        session.microsoftState ?? null,
        session.returnTo ?? null,
        session.expiresAt,
        Date.now()
      );
  }

  getSession(id: string): RemoteSession | undefined {
    const row = this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(id);
    if (row === undefined) {
      return undefined;
    }
    const session: RemoteSession = {
      id: asRequiredString(row, "id"),
      expiresAt: asNumber(row, "expires_at")
    };
    const userId = asString(row, "user_id");
    const microsoftState = asString(row, "microsoft_state");
    const returnTo = asString(row, "return_to");
    if (userId !== undefined) {
      session.userId = userId;
    }
    if (microsoftState !== undefined) {
      session.microsoftState = microsoftState;
    }
    if (returnTo !== undefined) {
      session.returnTo = returnTo;
    }
    return session;
  }

  saveSettings(userId: string, settings: RemoteSettings): void {
    this.db
      .prepare(
        `INSERT INTO settings (
           user_id, org_url, project, repositories_json, request_timeout_ms, max_pages, updated_at
         )
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET
           org_url = excluded.org_url,
           project = excluded.project,
           repositories_json = excluded.repositories_json,
           request_timeout_ms = excluded.request_timeout_ms,
           max_pages = excluded.max_pages,
           updated_at = excluded.updated_at`
      )
      .run(
        userId,
        settings.orgUrl,
        settings.project,
        settings.repositories === undefined
          ? null
          : JSON.stringify(settings.repositories),
        settings.requestTimeoutMs,
        settings.maxPages,
        Date.now()
      );
  }

  getSettings(userId: string): RemoteSettings | undefined {
    const row = this.db
      .prepare("SELECT * FROM settings WHERE user_id = ?")
      .get(userId);
    if (row === undefined) {
      return undefined;
    }
    const settings: RemoteSettings = {
      orgUrl: asRequiredString(row, "org_url"),
      project: asRequiredString(row, "project"),
      requestTimeoutMs: asNumber(row, "request_timeout_ms"),
      maxPages: asNumber(row, "max_pages")
    };
    const repositories = jsonStringArray(asString(row, "repositories_json"));
    if (repositories !== undefined) {
      settings.repositories = repositories;
    }
    return settings;
  }

  saveMicrosoftTokens(tokens: StoredMicrosoftTokens): void {
    this.db
      .prepare(
        `INSERT INTO microsoft_tokens (
           user_id, access_token_enc, refresh_token_enc, expires_at, scope, updated_at
         )
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET
           access_token_enc = excluded.access_token_enc,
           refresh_token_enc = excluded.refresh_token_enc,
           expires_at = excluded.expires_at,
           scope = excluded.scope,
           updated_at = excluded.updated_at`
      )
      .run(
        tokens.userId,
        tokens.encryptedAccessToken,
        tokens.encryptedRefreshToken ?? null,
        tokens.expiresAt,
        tokens.scope,
        Date.now()
      );
  }

  getMicrosoftTokens(userId: string): StoredMicrosoftTokens | undefined {
    const row = this.db
      .prepare("SELECT * FROM microsoft_tokens WHERE user_id = ?")
      .get(userId);
    if (row === undefined) {
      return undefined;
    }
    const tokens: StoredMicrosoftTokens = {
      userId: asRequiredString(row, "user_id"),
      encryptedAccessToken: asRequiredString(row, "access_token_enc"),
      expiresAt: asNumber(row, "expires_at"),
      scope: asRequiredString(row, "scope")
    };
    const refreshToken = asString(row, "refresh_token_enc");
    if (refreshToken !== undefined) {
      tokens.encryptedRefreshToken = refreshToken;
    }
    return tokens;
  }

  saveOAuthClient(client: OAuthClientRecord): void {
    this.db
      .prepare(
        `INSERT INTO oauth_clients (client_id, client_secret, redirect_uris_json, name, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(client_id) DO UPDATE SET
           client_secret = excluded.client_secret,
           redirect_uris_json = excluded.redirect_uris_json,
           name = excluded.name`
      )
      .run(
        client.clientId,
        client.clientSecret ?? null,
        JSON.stringify(client.redirectUris),
        client.name ?? null,
        Date.now()
      );
  }

  getOAuthClient(clientId: string): OAuthClientRecord | undefined {
    const row = this.db
      .prepare("SELECT * FROM oauth_clients WHERE client_id = ?")
      .get(clientId);
    if (row === undefined) {
      return undefined;
    }
    const client: OAuthClientRecord = {
      clientId: asRequiredString(row, "client_id"),
      redirectUris: jsonStringArray(asString(row, "redirect_uris_json")) ?? []
    };
    const clientSecret = asString(row, "client_secret");
    const name = asString(row, "name");
    if (clientSecret !== undefined) {
      client.clientSecret = clientSecret;
    }
    if (name !== undefined) {
      client.name = name;
    }
    return client;
  }

  saveOAuthCode(code: OAuthCodeRecord): void {
    this.db
      .prepare(
        `INSERT INTO oauth_codes (
           code_hash, user_id, client_id, redirect_uri, code_challenge, expires_at, created_at
         )
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        code.codeHash,
        code.userId,
        code.clientId,
        code.redirectUri,
        code.codeChallenge ?? null,
        code.expiresAt,
        Date.now()
      );
  }

  consumeOAuthCode(codeHash: string): OAuthCodeRecord | undefined {
    const row = this.db
      .prepare("SELECT * FROM oauth_codes WHERE code_hash = ?")
      .get(codeHash);
    if (row === undefined) {
      return undefined;
    }
    this.db.prepare("DELETE FROM oauth_codes WHERE code_hash = ?").run(codeHash);
    const code: OAuthCodeRecord = {
      codeHash: asRequiredString(row, "code_hash"),
      userId: asRequiredString(row, "user_id"),
      clientId: asRequiredString(row, "client_id"),
      redirectUri: asRequiredString(row, "redirect_uri"),
      expiresAt: asNumber(row, "expires_at")
    };
    const codeChallenge = asString(row, "code_challenge");
    if (codeChallenge !== undefined) {
      code.codeChallenge = codeChallenge;
    }
    return code;
  }

  saveMcpToken(token: McpTokenRecord): void {
    this.db
      .prepare(
        `INSERT INTO mcp_tokens (token_hash, user_id, client_id, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(
        token.tokenHash,
        token.userId,
        token.clientId,
        token.expiresAt,
        Date.now()
      );
  }

  getMcpToken(tokenHash: string): McpTokenRecord | undefined {
    const row = this.db
      .prepare("SELECT * FROM mcp_tokens WHERE token_hash = ?")
      .get(tokenHash);
    if (row === undefined) {
      return undefined;
    }
    return {
      tokenHash: asRequiredString(row, "token_hash"),
      userId: asRequiredString(row, "user_id"),
      clientId: asRequiredString(row, "client_id"),
      expiresAt: asNumber(row, "expires_at")
    };
  }

  private userFromRow(row: Record<string, unknown>): RemoteUser {
    const user: RemoteUser = {
      id: asRequiredString(row, "id"),
      microsoftSubject: asRequiredString(row, "microsoft_subject")
    };
    const displayName = asString(row, "display_name");
    if (displayName !== undefined) {
      user.displayName = displayName;
    }
    return user;
  }
}
