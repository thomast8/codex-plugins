#!/usr/bin/env node
import { createServer } from "node:http";

import { createRemoteHost } from "./remoteHost.js";
import { loadRemoteServiceConfig } from "./remoteConfig.js";

async function main(): Promise<void> {
  const config = loadRemoteServiceConfig();
  const app = createRemoteHost({ config });
  const server = createServer(app);

  server.listen(config.port, () => {
    console.error(
      `Azure DevOps hosted MCP server listening on ${config.publicBaseUrl}`
    );
  });

  process.on("SIGINT", () => {
    server.close(() => {
      process.exit(0);
    });
  });
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
