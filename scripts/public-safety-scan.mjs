#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const skipDirs = new Set([
  ".git",
  ".gitnexus",
  ".system",
  "coverage",
  "dist",
  "node_modules",
]);
const forbiddenPathSegments = [
  ".env",
  "auth.json",
  "archived_sessions",
  "history.jsonl",
  "logs_2.sqlite",
  "sessions",
  "shell_snapshots",
  "state_5.sqlite",
];
const forbiddenContent = [
  new RegExp("/Users/" + "thomastiotto"),
  new RegExp("Library/Mobile " + "Documents"),
  new RegExp("OneDrive-" + "kyndryl"),
  /BEGIN (RSA |OPENSSH |EC |)PRIVATE KEY/,
  /\bghp_[A-Za-z0-9_]{20,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
  /\bsk-[A-Za-z0-9]{20,}\b/,
];
const textExtensions = new Set([
  "",
  ".cjs",
  ".js",
  ".json",
  ".md",
  ".mjs",
  ".sh",
  ".toml",
  ".ts",
  ".tsx",
  ".txt",
  ".yaml",
  ".yml",
]);

const findings = [];

function shouldSkipDir(dirName) {
  return skipDirs.has(dirName);
}

function isTextFile(filePath) {
  return textExtensions.has(path.extname(filePath));
}

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    const relativePath = path.relative(repoRoot, fullPath);
    if (entry.isDirectory()) {
      if (!shouldSkipDir(entry.name)) {
        walk(fullPath);
      }
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    const segments = relativePath.split(path.sep);
    for (const segment of segments) {
      if (forbiddenPathSegments.includes(segment)) {
        findings.push(`${relativePath}: forbidden local/runtime path segment ${segment}`);
      }
    }
    if (!isTextFile(fullPath)) {
      continue;
    }
    const contents = fs.readFileSync(fullPath, "utf8");
    for (const pattern of forbiddenContent) {
      if (pattern.test(contents)) {
        findings.push(`${relativePath}: matches public-safety pattern ${pattern}`);
      }
    }
  }
}

walk(repoRoot);

if (findings.length > 0) {
  console.error("Public-safety scan failed:");
  for (const finding of findings) {
    console.error(`- ${finding}`);
  }
  process.exit(1);
}

console.log("Public-safety scan passed.");
