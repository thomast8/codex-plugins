import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client, StdioClientTransport } from "@modelcontextprotocol/client";
import { describe, expect, it } from "vitest";

interface McpServerConfig {
  type?: string;
  url?: string;
  command?: string;
  args?: string[];
  cwd?: string;
}

describe("plugin config", () => {
  const testDir = path.dirname(fileURLToPath(import.meta.url));
  const pluginRoot = path.resolve(testDir, "..");

  function readMcpConfig(fileName: string): Record<string, McpServerConfig> {
    return JSON.parse(
      fs.readFileSync(path.join(pluginRoot, fileName), "utf8")
    ) as Record<string, McpServerConfig>;
  }

  function expectLocalManifest(mcpConfig: Record<string, McpServerConfig>): void {
    expect(Object.keys(mcpConfig).sort()).toEqual(["azure-devops"]);
    expect(mcpConfig).not.toHaveProperty("mcpServers");
    expect(mcpConfig["azure-devops"]).toEqual({
      command: "node",
      args: ["./dist/index.bundle.js"],
      cwd: "."
    });
  }

  it("declares the default MCP server map directly", () => {
    expectLocalManifest(readMcpConfig(".mcp.json"));
  });

  it("keeps the local fallback manifest in the same server-map shape", () => {
    expectLocalManifest(readMcpConfig(".mcp.local.json"));
  });

  it("starts the bundled server from a cache-like plugin copy", async () => {
    const cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ado-plugin-cache-"));
    fs.mkdirSync(path.join(cacheRoot, "dist"), { recursive: true });
    fs.copyFileSync(
      path.join(pluginRoot, ".mcp.json"),
      path.join(cacheRoot, ".mcp.json")
    );
    fs.copyFileSync(
      path.join(pluginRoot, ".mcp.local.json"),
      path.join(cacheRoot, ".mcp.local.json")
    );
    fs.copyFileSync(
      path.join(pluginRoot, "dist", "index.bundle.js"),
      path.join(cacheRoot, "dist", "index.bundle.js")
    );

    for (const manifestName of [".mcp.json", ".mcp.local.json"]) {
      const mcpConfig = JSON.parse(
        fs.readFileSync(path.join(cacheRoot, manifestName), "utf8")
      ) as Record<string, McpServerConfig>;
      const server = mcpConfig["azure-devops"];
      expect(server?.command).toBe("node");
      expect(server?.args).toEqual(["./dist/index.bundle.js"]);

      const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "ado-mcp-config-"));
      const client = new Client({
        name: "azure-devops-cache-test",
        version: "0.1.0"
      });
      const transport = new StdioClientTransport({
        command: server!.command!,
        args: server!.args!,
        cwd: cacheRoot,
        env: {
          ...process.env,
          CODEX_AZURE_DEVOPS_CONFIG_FILE: path.join(configDir, "config.json"),
          ADO_ORG_URL: "https://dev.azure.com/example-org",
          ADO_PROJECT: "Example Project"
        }
      });

      await client.connect(transport);
      try {
        const result = await client.listTools();
        const names = result.tools.map((tool) => tool.name);

        expect(names).toContain("ado_setup_status");
        expect(names).toContain("ado_search_work_items");
        expect(names).toContain("ado_get_work_tracking_rules");
      } finally {
        await client.close();
      }
    }
  });
});
