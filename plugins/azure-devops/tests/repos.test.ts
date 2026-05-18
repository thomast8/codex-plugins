import { describe, expect, it } from "vitest";

import {
  fileWebUrl,
  listRepositories,
  pullRequestWebUrl,
  repositoryWebUrl
} from "../src/repos.js";
import { createClient, jsonResponse, testConfig } from "./helpers.js";

describe("repo helpers", () => {
  it("builds repository web URLs", () => {
    expect(repositoryWebUrl(testConfig, "repo")).toBe(
      "https://dev.azure.com/example-org/Example%20Project/_git/repo"
    );
    expect(pullRequestWebUrl(testConfig, "repo", 5)).toContain(
      "/_git/repo/pullrequest/5"
    );
    expect(fileWebUrl(testConfig, "repo", "/README.md", "main")).toContain(
      "path=%2FREADME.md"
    );
  });

  it("filters repositories by configured allowlist", async () => {
    const client = createClient(async () =>
      jsonResponse({
        value: [
          { id: "1", name: "allowed" },
          { id: "2", name: "blocked" }
        ]
      })
    );
    client.config.repositories = ["allowed"];

    const result = await listRepositories(client, {});

    expect(JSON.stringify(result)).toContain("allowed");
    expect(JSON.stringify(result)).not.toContain("blocked");
  });
});

