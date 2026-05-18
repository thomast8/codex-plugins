#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const installer = resolve(scriptDir, "install-local.mjs");

const result = spawnSync(process.execPath, [installer, ...process.argv.slice(2)], {
  env: process.env,
  stdio: "inherit",
});

process.exit(result.status ?? 1);
