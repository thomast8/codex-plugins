import { execFile as execFileCallback } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const execFile = promisify(execFileCallback);

describe("hosted MCP manifest generator", () => {
  const testDir = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(testDir, "..", "..", "..");
  const scriptPath = path.join(repoRoot, "scripts", "generate-mcp-manifest.mjs");

  function createTempRepo(): string {
    const tempRepo = fs.mkdtempSync(path.join(os.tmpdir(), "ado-mcp-manifest-"));
    fs.mkdirSync(path.join(tempRepo, "plugins", "azure-devops"), {
      recursive: true
    });
    return tempRepo;
  }

  async function runGenerator(
    tempRepo: string,
    publicBaseUrl?: string
  ): Promise<{ stdout: string; stderr: string }> {
    const env = { ...process.env };
    delete env.MCP_MANIFEST_PATH;
    delete env.PUBLIC_BASE_URL;
    if (publicBaseUrl !== undefined) {
      env.PUBLIC_BASE_URL = publicBaseUrl;
    }
    return await execFile(process.execPath, [scriptPath], {
      cwd: tempRepo,
      encoding: "utf8",
      env
    });
  }

  it("writes a direct hosted server map without mutating the local manifest", async () => {
    const tempRepo = createTempRepo();

    await runGenerator(tempRepo, "https://azure-devops.example.com/base?x=1#hash");

    const manifestPath = path.join(
      tempRepo,
      "plugins",
      "azure-devops",
      ".mcp.hosted.json"
    );
    const manifest = JSON.parse(
      fs.readFileSync(manifestPath, "utf8")
    ) as Record<string, unknown>;

    expect(fs.existsSync(path.join(tempRepo, "plugins", "azure-devops", ".mcp.json"))).toBe(
      false
    );
    expect(Object.keys(manifest).sort()).toEqual(["azure-devops"]);
    expect(manifest).not.toHaveProperty("mcpServers");
    expect(manifest["azure-devops"]).toEqual({
      type: "http",
      url: "https://azure-devops.example.com/mcp"
    });
  });

  it("requires PUBLIC_BASE_URL", async () => {
    const tempRepo = createTempRepo();

    await expect(runGenerator(tempRepo)).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("PUBLIC_BASE_URL is required.")
    });
  });

  it.each([
    "http://example.test",
    "ftp://example.test",
    "file:///tmp/plugin",
    "javascript:alert(1)",
    "https://user:pass@example.test"
  ])("rejects unsafe hosted base URL %s", async (publicBaseUrl) => {
    const tempRepo = createTempRepo();

    await expect(runGenerator(tempRepo, publicBaseUrl)).rejects.toMatchObject({
      code: 1
    });
  });
});
