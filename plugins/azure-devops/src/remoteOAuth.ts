import { createHash } from "node:crypto";

import type { AuthHeader, AuthProvider } from "./auth.js";
import { encryptSecret, decryptSecret } from "./crypto.js";
import { AdoError } from "./errors.js";
import {
  microsoftTokenUrl,
  RemoteServiceConfig
} from "./remoteConfig.js";
import { RemoteStore, StoredMicrosoftTokens } from "./remoteStore.js";

export interface MicrosoftTokenResponse {
  accessToken: string;
  refreshToken?: string;
  expiresIn?: number;
  scope?: string;
  idToken?: string;
}

export interface MicrosoftIdentity {
  subject: string;
  displayName?: string;
}

export function microsoftLoginScope(config: RemoteServiceConfig): string {
  return ["openid", "profile", "offline_access", config.azureDevOpsScope].join(
    " "
  );
}

export function codeChallengeS256(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function parseMicrosoftTokenResponse(
  value: unknown
): MicrosoftTokenResponse {
  if (!isRecord(value) || typeof value.access_token !== "string") {
    throw new AdoError("Microsoft token response did not include access_token.", {
      kind: "authentication",
      details: value
    });
  }

  const response: MicrosoftTokenResponse = {
    accessToken: value.access_token
  };
  const refreshToken = optionalString(value.refresh_token);
  const scope = optionalString(value.scope);
  const idToken = optionalString(value.id_token);
  if (refreshToken !== undefined) {
    response.refreshToken = refreshToken;
  }
  if (scope !== undefined) {
    response.scope = scope;
  }
  if (idToken !== undefined) {
    response.idToken = idToken;
  }
  if (typeof value.expires_in === "number") {
    response.expiresIn = value.expires_in;
  }
  return response;
}

export function parseMicrosoftIdentity(idToken: string): MicrosoftIdentity {
  const [, payload] = idToken.split(".");
  if (payload === undefined) {
    throw new AdoError("Microsoft id_token is malformed.", {
      kind: "authentication"
    });
  }
  const decoded = JSON.parse(
    Buffer.from(payload, "base64url").toString("utf8")
  ) as unknown;
  if (!isRecord(decoded)) {
    throw new AdoError("Microsoft id_token payload is malformed.", {
      kind: "authentication"
    });
  }

  const subject = optionalString(decoded.oid) ?? optionalString(decoded.sub);
  if (subject === undefined) {
    throw new AdoError("Microsoft id_token did not include oid or sub.", {
      kind: "authentication"
    });
  }

  const identity: MicrosoftIdentity = { subject };
  const displayName =
    optionalString(decoded.name) ?? optionalString(decoded.preferred_username);
  if (displayName !== undefined) {
    identity.displayName = displayName;
  }
  return identity;
}

async function postMicrosoftToken(
  config: RemoteServiceConfig,
  params: URLSearchParams
): Promise<MicrosoftTokenResponse> {
  const response = await fetch(microsoftTokenUrl(config), {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: params.toString()
  });
  const body = (await response.json()) as unknown;
  if (!response.ok) {
    throw new AdoError("Microsoft token exchange failed.", {
      kind: "authentication",
      status: response.status,
      details: body
    });
  }
  return parseMicrosoftTokenResponse(body);
}

export async function exchangeMicrosoftCode(options: {
  config: RemoteServiceConfig;
  code: string;
  redirectUri: string;
}): Promise<MicrosoftTokenResponse> {
  const params = new URLSearchParams({
    client_id: options.config.microsoftClientId,
    client_secret: options.config.microsoftClientSecret,
    grant_type: "authorization_code",
    code: options.code,
    redirect_uri: options.redirectUri,
    scope: microsoftLoginScope(options.config)
  });
  return postMicrosoftToken(options.config, params);
}

export async function refreshMicrosoftTokens(options: {
  config: RemoteServiceConfig;
  refreshToken: string;
}): Promise<MicrosoftTokenResponse> {
  const params = new URLSearchParams({
    client_id: options.config.microsoftClientId,
    client_secret: options.config.microsoftClientSecret,
    grant_type: "refresh_token",
    refresh_token: options.refreshToken,
    scope: microsoftLoginScope(options.config)
  });
  return postMicrosoftToken(options.config, params);
}

export function storeMicrosoftTokenResponse(options: {
  store: RemoteStore;
  encryptionKey: Buffer;
  userId: string;
  response: MicrosoftTokenResponse;
  previousRefreshToken?: string;
  defaultScope: string;
}): StoredMicrosoftTokens {
  const refreshToken =
    options.response.refreshToken ?? options.previousRefreshToken;
  const expiresAt =
    Date.now() + (options.response.expiresIn ?? 3600) * 1000;
  const record: StoredMicrosoftTokens = {
    userId: options.userId,
    encryptedAccessToken: encryptSecret(
      options.response.accessToken,
      options.encryptionKey
    ),
    expiresAt,
    scope: options.response.scope ?? options.defaultScope
  };
  if (refreshToken !== undefined) {
    record.encryptedRefreshToken = encryptSecret(
      refreshToken,
      options.encryptionKey
    );
  }
  options.store.saveMicrosoftTokens(record);
  return record;
}

export class RemoteAdoAuthProvider implements AuthProvider {
  private readonly config: RemoteServiceConfig;
  private readonly encryptionKey: Buffer;
  private readonly store: RemoteStore;
  private readonly userId: string;

  constructor(options: {
    config: RemoteServiceConfig;
    encryptionKey: Buffer;
    store: RemoteStore;
    userId: string;
  }) {
    this.config = options.config;
    this.encryptionKey = options.encryptionKey;
    this.store = options.store;
    this.userId = options.userId;
  }

  async getAuthHeader(): Promise<AuthHeader> {
    const tokens = this.store.getMicrosoftTokens(this.userId);
    if (tokens === undefined) {
      throw new AdoError("Microsoft OAuth tokens are missing for this user.", {
        kind: "authentication"
      });
    }

    if (tokens.expiresAt > Date.now() + 60_000) {
      return {
        scheme: "Bearer",
        authorization: `Bearer ${decryptSecret(
          tokens.encryptedAccessToken,
          this.encryptionKey
        )}`,
        source: "oauth"
      };
    }

    if (tokens.encryptedRefreshToken === undefined) {
      throw new AdoError("Microsoft OAuth refresh token is missing.", {
        kind: "authentication"
      });
    }

    const refreshToken = decryptSecret(
      tokens.encryptedRefreshToken,
      this.encryptionKey
    );
    const response = await refreshMicrosoftTokens({
      config: this.config,
      refreshToken
    });
    storeMicrosoftTokenResponse({
      store: this.store,
      encryptionKey: this.encryptionKey,
      userId: this.userId,
      response,
      previousRefreshToken: refreshToken,
      defaultScope: this.config.azureDevOpsScope
    });
    return {
      scheme: "Bearer",
      authorization: `Bearer ${response.accessToken}`,
      source: "oauth"
    };
  }
}
