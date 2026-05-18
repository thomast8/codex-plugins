import { AuthProvider } from "../src/auth.js";
import { AdoClient, FetchLike, ResponseLike } from "../src/client.js";
import { AdoConfig } from "../src/config.js";

export const testConfig: AdoConfig = {
  orgUrl: "https://dev.azure.com/example-org",
  project: "Example Project",
  apiVersion: "7.1",
  requestTimeoutMs: 1000,
  maxPages: 3
};

export const testAuthProvider: AuthProvider = {
  async getAuthHeader() {
    return {
      scheme: "Bearer",
      authorization: "Bearer token",
      source: "azure-cli"
    };
  }
};

export function jsonResponse(
  body: unknown,
  options: { status?: number; continuationToken?: string } = {}
): ResponseLike {
  const status = options.status ?? 200;
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status >= 200 && status < 300 ? "OK" : "Error",
    headers: {
      get(name: string) {
        if (
          name.toLowerCase() === "x-ms-continuationtoken" &&
          options.continuationToken !== undefined
        ) {
          return options.continuationToken;
        }
        return null;
      }
    },
    async text() {
      return JSON.stringify(body);
    }
  };
}

export function createClient(fetchImpl: FetchLike): AdoClient {
  return new AdoClient({
    config: testConfig,
    authProvider: testAuthProvider,
    fetchImpl
  });
}

