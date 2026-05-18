import { AdoConfig } from "./config.js";
import { AdoError, errorKindForStatus } from "./errors.js";
import { AdoRequest } from "./request.js";
import { AuthProvider } from "./auth.js";

export interface ResponseHeaders {
  get(name: string): string | null;
}

export interface ResponseLike {
  ok: boolean;
  status: number;
  statusText: string;
  headers: ResponseHeaders;
  text(): Promise<string>;
}

export type FetchLike = (
  input: string,
  init: RequestInit
) => Promise<ResponseLike>;

export interface AdoResponse<T> {
  data: T;
  continuationToken?: string;
}

export interface PagedValue<T> {
  value?: T[];
}

export class AdoClient {
  readonly config: AdoConfig;
  private readonly authProvider: AuthProvider;
  private readonly fetchImpl: FetchLike;

  constructor(options: {
    config: AdoConfig;
    authProvider: AuthProvider;
    fetchImpl?: FetchLike | undefined;
  }) {
    this.config = options.config;
    this.authProvider = options.authProvider;
    this.fetchImpl =
      options.fetchImpl ??
      ((input, init) => globalThis.fetch(input, init) as Promise<ResponseLike>);
  }

  async send<T>(request: AdoRequest): Promise<AdoResponse<T>> {
    const authHeader = await this.authProvider.getAuthHeader();
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      this.config.requestTimeoutMs
    );

    try {
      const init: RequestInit = {
        method: request.method,
        headers: {
          Accept: "application/json",
          "User-Agent": "azure-devops-codex-plugin/0.1.0",
          ...request.headers,
          Authorization: authHeader.authorization
        },
        signal: controller.signal
      };
      if (request.body !== undefined) {
        init.body = JSON.stringify(request.body);
      }

      const response = await this.fetchImpl(request.url, init);

      const text = await response.text();
      const parsed = parseResponseBody(text);

      if (!response.ok) {
        throw new AdoError(
          `Azure DevOps API request failed with ${response.status} ${response.statusText}.`,
          {
            kind: errorKindForStatus(response.status),
            status: response.status,
            details: parsed
          }
        );
      }

      const result: AdoResponse<T> = {
        data: parsed as T
      };
      const continuationToken = response.headers.get("x-ms-continuationtoken");
      if (continuationToken !== null && continuationToken !== "") {
        result.continuationToken = continuationToken;
      }
      return result;
    } catch (error) {
      if (error instanceof AdoError) {
        throw error;
      }
      throw new AdoError("Azure DevOps network request failed.", {
        kind: "network",
        cause: error
      });
    } finally {
      clearTimeout(timeout);
    }
  }
}

export function parseResponseBody(text: string): unknown {
  if (text.trim() === "") {
    return {};
  }

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export async function collectPagedValues<T>(
  client: AdoClient,
  request: AdoRequest
): Promise<T[]> {
  const values: T[] = [];
  let continuationToken: string | undefined;

  for (let page = 0; page < client.config.maxPages; page += 1) {
    const url = new URL(request.url);
    if (continuationToken !== undefined) {
      url.searchParams.set("continuationToken", continuationToken);
    }

    const pageRequest: AdoRequest = {
      ...request,
      url: url.toString()
    };
    const response = await client.send<PagedValue<T>>(pageRequest);
    values.push(...(response.data.value ?? []));

    if (response.continuationToken === undefined) {
      return values;
    }
    continuationToken = response.continuationToken;
  }

  throw new AdoError(
    `Azure DevOps pagination exceeded ADO_MAX_PAGES (${client.config.maxPages}).`,
    { kind: "pagination" }
  );
}
