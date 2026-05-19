import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { loadConfig, normalizeOrgUrl } from "../src/config.js";
import {
  getSetupStatus,
  readStoredConfig,
  writeStoredConfig
} from "../src/configStore.js";

describe("config", () => {
  it("normalizes organization URLs", () => {
    expect(normalizeOrgUrl("https://dev.azure.com/example///")).toBe(
      "https://dev.azure.com/example"
    );
  });

  it("loads required and optional environment values", () => {
    const config = loadConfig(
      {
        ADO_ORG_URL: "https://dev.azure.com/example",
        ADO_PROJECT: "Project",
        ADO_TEAM: "Team",
        ADO_REPOSITORIES: "repo-a, repo-b",
        ADO_PAT: "pat",
        ADO_REQUEST_TIMEOUT_MS: "5000",
        ADO_MAX_PAGES: "5"
      },
      undefined
    );

    expect(config).toMatchObject({
      orgUrl: "https://dev.azure.com/example",
      project: "Project",
      team: "Team",
      repositories: ["repo-a", "repo-b"],
      pat: "pat",
      requestTimeoutMs: 5000,
      maxPages: 5
    });
  });

  it("loads stored config when environment values are absent", () => {
    const config = loadConfig(
      {},
      {
        orgUrl: "https://dev.azure.com/stored",
        project: "Stored Project",
        team: "Stored Team",
        repositories: ["repo"],
        requestTimeoutMs: 1000,
        maxPages: 2
      }
    );

    expect(config).toMatchObject({
      orgUrl: "https://dev.azure.com/stored",
      project: "Stored Project",
      team: "Stored Team",
      repositories: ["repo"],
      requestTimeoutMs: 1000,
      maxPages: 2
    });
  });

  it("lets environment values override stored config", () => {
    const config = loadConfig(
      {
        ADO_PROJECT: "Environment Project"
      },
      {
        orgUrl: "https://dev.azure.com/stored",
        project: "Stored Project"
      }
    );

    expect(config.project).toBe("Environment Project");
  });

  it("ignores blank environment values when stored config exists", () => {
    const config = loadConfig(
      {
        ADO_ORG_URL: "",
        ADO_PROJECT: " "
      },
      {
        orgUrl: "https://dev.azure.com/stored",
        project: "Stored Project"
      }
    );

    expect(config).toMatchObject({
      orgUrl: "https://dev.azure.com/stored",
      project: "Stored Project"
    });
  });

  it("requires organization and project when no stored config exists", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ado-missing-config-"));

    expect(() =>
      loadConfig({
        CODEX_AZURE_DEVOPS_CONFIG_FILE: path.join(dir, "missing.json")
      })
    ).toThrow(
      "Azure DevOps is not configured"
    );
  });

  it("writes and reads app-native stored config", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ado-config-test-"));
    const configPath = path.join(dir, "config.json");

    const written = writeStoredConfig(
      {
        orgUrl: "https://dev.azure.com/example/",
        project: "Project",
        team: " Team ",
        repositories: [" repo-a ", ""],
        maxPages: 4
      },
      configPath
    );

    expect(written).toEqual({
      orgUrl: "https://dev.azure.com/example",
      project: "Project",
      team: "Team",
      repositories: ["repo-a"],
      maxPages: 4
    });
    expect(readStoredConfig(configPath)).toEqual(written);
  });

  it("reports setup status for Codex UI", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ado-status-test-"));
    const configPath = path.join(dir, "config.json");
    writeStoredConfig(
      {
        orgUrl: "https://dev.azure.com/example",
        project: "Project",
        team: "Team"
      },
      configPath
    );

    expect(getSetupStatus({}, configPath)).toMatchObject({
      configured: true,
      orgUrl: "https://dev.azure.com/example",
      project: "Project",
      team: "Team",
      auth: {
        mode: "microsoft-oauth",
        status: "not-configured",
        loginTool: "ado_login"
      }
    });
  });
});
