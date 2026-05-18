export type AdoHttpMethod = "GET" | "POST" | "PATCH";

export interface AdoRequest {
  method: AdoHttpMethod;
  url: string;
  headers: Record<string, string>;
  body?: unknown;
}

export const jsonPatchContentType = "application/json-patch+json";

export function withApiVersion(url: URL, apiVersion = "7.1"): URL {
  url.searchParams.set("api-version", apiVersion);
  return url;
}

export function encodeSegment(value: string): string {
  return encodeURIComponent(value);
}

export function makeUrl(
  orgUrl: string,
  segments: string[],
  params: Record<string, string | number | boolean | undefined> = {}
): string {
  const encodedPath = segments.map((segment) => encodeSegment(segment)).join("/");
  const url = new URL(`${orgUrl}/${encodedPath}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) {
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

export function previewRequest(request: AdoRequest): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    method: request.method,
    url: request.url,
    headers: request.headers
  };
  if (request.body !== undefined) {
    payload.body = request.body;
  }
  return payload;
}

