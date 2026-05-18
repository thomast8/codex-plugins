#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const publicBaseUrl = process.env.PUBLIC_BASE_URL;
const outputPath = process.env.MCP_MANIFEST_PATH;

if (publicBaseUrl === undefined || publicBaseUrl.trim() === "") {
  console.error("PUBLIC_BASE_URL is required.");
  process.exit(1);
}

const url = new URL(publicBaseUrl);
if (url.protocol !== "https:") {
  console.error("PUBLIC_BASE_URL must use https for hosted MCP manifests.");
  process.exit(1);
}
if (url.username !== "" || url.password !== "") {
  console.error("PUBLIC_BASE_URL must not include credentials.");
  process.exit(1);
}
url.pathname = "/mcp";
url.search = "";
url.hash = "";

const repoRoot = process.cwd();
const manifestPath =
  outputPath === undefined || outputPath.trim() === ""
    ? path.join(repoRoot, "plugins", "azure-devops", ".mcp.hosted.json")
    : path.resolve(repoRoot, outputPath);
const manifest = {
  "azure-devops": {
    type: "http",
    url: url.toString()
  }
};

fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Wrote ${manifestPath}`);
