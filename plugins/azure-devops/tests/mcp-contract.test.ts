import { Client, StdioClientTransport } from "@modelcontextprotocol/client";
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";

describe("MCP contract", () => {
  it("starts over stdio and lists the Azure DevOps tools", async () => {
    const testDir = path.dirname(fileURLToPath(import.meta.url));
    const serverPath = path.join(testDir, "..", "src", "index.ts");
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "ado-mcp-contract-"));
    const client = new Client({
      name: "azure-devops-contract-test",
      version: "0.1.0"
    });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["--import", "tsx", serverPath],
      env: {
        ...process.env,
        CODEX_AZURE_DEVOPS_CONFIG_FILE: path.join(configDir, "config.json"),
        ADO_ORG_URL: "https://dev.azure.com/example-org",
        ADO_PROJECT: "Example Project",
        ADO_PAT: "dummy"
      }
    });

    await client.connect(transport);
    try {
      const result = await client.listTools();
      const names = result.tools.map((tool) => tool.name);

      expect(names).toContain("ado_setup_status");
      expect(names).toContain("ado_login");
      expect(names).toContain("ado_configure_connection");
      expect(names).toContain("ado_test_connection");
      expect(names).toContain("ado_search_work_items");
      expect(names).toContain("ado_get_work_item");
      expect(names).toContain("ado_create_work_item");
      expect(names).toContain("ado_update_work_item");
      expect(names).toContain("ado_add_work_item_comment");
      expect(names).toContain("ado_list_repositories");
      expect(names).toContain("ado_get_file");
      expect(names).toContain("ado_list_pull_requests");

      const status = await client.callTool({
        name: "ado_setup_status",
        arguments: {}
      });
      expect(JSON.stringify(status.content)).toContain("configured");
    } finally {
      await client.close();
    }
  });
});
