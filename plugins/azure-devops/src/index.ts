#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/server";

import { createAzureDevOpsServer } from "./server.js";

async function main(): Promise<void> {
  const server = createAzureDevOpsServer({ includeLocalSetupTools: true });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Azure DevOps MCP server running on stdio.");

  process.on("SIGINT", async () => {
    await server.close();
    process.exit(0);
  });
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
