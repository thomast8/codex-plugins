import { describe, expect, it } from "vitest";

import { collectPagedValues } from "../src/client.js";
import { AdoRequest } from "../src/request.js";
import { createClient, jsonResponse } from "./helpers.js";

describe("AdoClient", () => {
  it("adds authorization and parses JSON responses", async () => {
    const seenHeaders: Record<string, string>[] = [];
    const client = createClient(async (_url, init) => {
      seenHeaders.push(init.headers as Record<string, string>);
      return jsonResponse({ ok: true });
    });

    const response = await client.send<{ ok: boolean }>({
      method: "GET",
      url: "https://dev.azure.com/example/_apis/test",
      headers: {}
    });

    expect(response.data).toEqual({ ok: true });
    expect(seenHeaders[0]?.Authorization).toBe("Bearer token");
  });

  it("collects paged values with continuation tokens", async () => {
    const urls: string[] = [];
    const client = createClient(async (url) => {
      urls.push(url);
      if (urls.length === 1) {
        return jsonResponse({ value: [{ id: 1 }] }, { continuationToken: "next" });
      }
      return jsonResponse({ value: [{ id: 2 }] });
    });

    const request: AdoRequest = {
      method: "GET",
      url: "https://dev.azure.com/example/_apis/things?api-version=7.1",
      headers: {}
    };

    await expect(collectPagedValues<{ id: number }>(client, request)).resolves.toEqual([
      { id: 1 },
      { id: 2 }
    ]);
    expect(urls[1]).toContain("continuationToken=next");
  });
});

