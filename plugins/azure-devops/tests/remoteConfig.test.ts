import { describe, expect, it } from "vitest";

import { loadRemoteServiceConfig } from "../src/remoteConfig.js";

function baseEnv(
  overrides: NodeJS.ProcessEnv = {}
): NodeJS.ProcessEnv {
  return {
    PUBLIC_BASE_URL: "https://ado.example/",
    MICROSOFT_ENTRA_CLIENT_ID: "client",
    MICROSOFT_ENTRA_CLIENT_SECRET: "secret",
    SESSION_SECRET: "session",
    TOKEN_ENCRYPTION_KEY: "12345678901234567890123456789012",
    ...overrides
  };
}

describe("remote service config", () => {
  it("normalizes HTTPS public base URLs", () => {
    expect(loadRemoteServiceConfig(baseEnv()).publicBaseUrl).toBe(
      "https://ado.example"
    );
  });

  it("rejects public HTTP base URLs", () => {
    expect(() =>
      loadRemoteServiceConfig(
        baseEnv({ PUBLIC_BASE_URL: "http://ado.example" })
      )
    ).toThrow("PUBLIC_BASE_URL must use HTTPS");
  });

  it("allows HTTP loopback base URLs for tests", () => {
    expect(
      loadRemoteServiceConfig(
        baseEnv({ PUBLIC_BASE_URL: "http://127.0.0.1:8787" })
      ).publicBaseUrl
    ).toBe("http://127.0.0.1:8787");
  });
});
