import { execFile as execFileCallback } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const execFile = promisify(execFileCallback);

describe("local installer", () => {
  const testDir = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(testDir, "..", "..", "..");
  const scriptPath = path.join(repoRoot, "scripts", "install-local.mjs");
  const pluginSource = path.join(repoRoot, "plugins", "azure-devops");
  const githubPluginSource = path.join(repoRoot, "plugins", "github-local-ops");

  function createConfig(configPath: string): void {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(
      configPath,
      [
        "[marketplaces.thomas-codex-config]",
        'source = "/old/thomas/config/root"',
        'source_type = "local"',
        "",
        "[marketplaces.codex-plugins]",
        'source = "/old/config/root"',
        'source_type = "local"',
        'last_updated = "keep-me"',
        "# keep marketplace comment",
        "",
        "[plugins.\"azure-devops@codex-plugins\"]",
        "enabled = false",
        'activation_note = "keep active metadata"',
        "",
        "[plugins.\"azure-devops@thomas-codex-config\"]",
        "enabled = true",
        'thomas_note = "keep old metadata"',
        "",
        "[plugins.\"azure-devops@codex-azure-devops-plugin\"]",
        "enabled = true",
        'stale_note = "keep stale metadata"',
        "",
        "[mcp_servers.gitnexus]",
        'command = "gitnexus"',
        'args = ["mcp"]',
        "",
      ].join("\n"),
      "utf8"
    );
  }

  function createMarketplace(configRoot: string): void {
    const marketplacePath = path.join(
      configRoot,
      ".agents",
      "plugins",
      "marketplace.json"
    );
    fs.mkdirSync(path.dirname(marketplacePath), { recursive: true });
    fs.writeFileSync(
      marketplacePath,
      `${JSON.stringify(
        {
          name: "old-marketplace-name",
          interface: {
            displayName: "Existing Local Plugins",
            accentColor: "#123456",
          },
          plugins: [
            {
              name: "github-local-ops",
              source: {
                source: "local",
                path: "./plugins/github-local-ops",
              },
              policy: {
                installation: "AVAILABLE",
                authentication: "ON_INSTALL",
              },
              category: "Productivity",
            },
            {
              name: "azure-devops",
              source: {
                source: "local",
                path: "./plugins/old-azure-devops",
              },
              policy: {
                installation: "AVAILABLE",
                authentication: "ON_INSTALL",
              },
              category: "Old",
            },
          ],
        },
        null,
        2
      )}\n`,
      "utf8"
    );
  }

  async function runInstaller(env: NodeJS.ProcessEnv): Promise<string> {
    const { stdout } = await execFile(process.execPath, [scriptPath], {
      cwd: repoRoot,
      encoding: "utf8",
      env,
    });
    return stdout;
  }

  function countOccurrences(value: string, needle: string): number {
    return value.split(needle).length - 1;
  }

  function configBackups(configPath: string): string[] {
    const dir = path.dirname(configPath);
    return fs
      .readdirSync(dir)
      .filter((name) => name.startsWith(`${path.basename(configPath)}.bak-`))
      .sort();
  }

  it("enables Azure DevOps through the bundled Codex marketplace", async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "ado-install-home-"));
    const configRoot = path.join(homeDir, "Codex-config");
    const configPath = path.join(homeDir, ".Codex", "config.toml");
    createConfig(configPath);
    createMarketplace(configRoot);

    const env = {
        ...process.env,
        CODEX_CONFIG_FILE: configPath,
        CODEX_CONFIG_ROOT: configRoot,
        HOME: homeDir,
      };
    const stdout = await runInstaller(env);

    expect(stdout).toContain(
      "Plugins: azure-devops@codex-plugins, github-local-ops@codex-plugins"
    );
    expect(stdout).toContain(
      [
        "Disabled stale plugin entries: azure-devops@codex-azure-devops-plugin",
        "azure-devops@thomas-codex-config",
        "github-local-ops@codex-azure-devops-plugin",
        "github-local-ops@thomas-codex-config",
      ].join(", ")
    );

    const updatedConfig = fs.readFileSync(configPath, "utf8");
    expect(updatedConfig).toContain("[marketplaces.codex-plugins]");
    expect(updatedConfig).toContain(`source = ${JSON.stringify(configRoot)}`);
    expect(updatedConfig).toContain(
      '[plugins."azure-devops@codex-plugins"]\nenabled = true'
    );
    expect(updatedConfig).toContain(
      '[plugins."github-local-ops@codex-plugins"]\nenabled = true'
    );
    expect(updatedConfig).toContain(
      '[plugins."azure-devops@codex-azure-devops-plugin"]\nenabled = false'
    );
    expect(updatedConfig).toContain(
      '[plugins."azure-devops@thomas-codex-config"]\nenabled = false'
    );
    expect(updatedConfig).toContain(
      '[plugins."github-local-ops@codex-azure-devops-plugin"]\nenabled = false'
    );
    expect(updatedConfig).toContain(
      '[plugins."github-local-ops@thomas-codex-config"]\nenabled = false'
    );
    expect(updatedConfig).not.toContain('source = "/old/config/root"');
    expect(updatedConfig).not.toContain(
      '[plugins."azure-devops@codex-plugins"]\nenabled = false'
    );
    expect(updatedConfig).toContain('last_updated = "keep-me"');
    expect(updatedConfig).toContain("# keep marketplace comment");
    expect(updatedConfig).toContain('activation_note = "keep active metadata"');
    expect(updatedConfig).toContain('thomas_note = "keep old metadata"');
    expect(updatedConfig).toContain('stale_note = "keep stale metadata"');
    expect([...updatedConfig.matchAll(/source_type = "local"/g)]).toHaveLength(2);
    expect(countOccurrences(updatedConfig, "[marketplaces.codex-plugins]")).toBe(
      1
    );
    expect(
      countOccurrences(updatedConfig, '[plugins."azure-devops@codex-plugins"]')
    ).toBe(1);
    expect(
      countOccurrences(
        updatedConfig,
        '[plugins."azure-devops@codex-azure-devops-plugin"]'
      )
    ).toBe(1);
    expect(updatedConfig).toContain("[mcp_servers.gitnexus]");
    expect(updatedConfig).toContain('command = "gitnexus"');

    const pluginLink = path.join(configRoot, "plugins", "azure-devops");
    expect(fs.lstatSync(pluginLink).isSymbolicLink()).toBe(true);
    expect(fs.realpathSync(pluginLink)).toBe(fs.realpathSync(pluginSource));
    const githubPluginLink = path.join(configRoot, "plugins", "github-local-ops");
    expect(fs.lstatSync(githubPluginLink).isSymbolicLink()).toBe(true);
    expect(fs.realpathSync(githubPluginLink)).toBe(
      fs.realpathSync(githubPluginSource)
    );

    const marketplace = JSON.parse(
      fs.readFileSync(
        path.join(configRoot, ".agents", "plugins", "marketplace.json"),
        "utf8"
      )
    ) as {
      name: string;
      interface: Record<string, string>;
      plugins: Array<{
        name: string;
        source: { source: string; path: string };
      }>;
    };
    expect(marketplace.name).toBe("codex-plugins");
    expect(marketplace.interface).toEqual({
      displayName: "Existing Local Plugins",
      accentColor: "#123456",
    });
    expect(marketplace.plugins).toContainEqual(
      expect.objectContaining({
        name: "github-local-ops",
        source: {
          source: "local",
          path: "./plugins/github-local-ops",
        },
      })
    );
    expect(marketplace.plugins.filter((plugin) => plugin.name === "azure-devops")).toHaveLength(
      1
    );
    expect(marketplace.plugins).toContainEqual(
      expect.objectContaining({
        name: "azure-devops",
        source: {
          source: "local",
          path: "./plugins/azure-devops",
        },
      })
    );

    const firstBackups = configBackups(configPath);
    expect(firstBackups).toHaveLength(1);
    const firstBackup = firstBackups[0];
    expect(firstBackup).toBeDefined();
    const backupPath = path.join(path.dirname(configPath), firstBackup!);
    expect(fs.statSync(backupPath).mode & 0o777).toBe(0o600);
    const secondStdout = await runInstaller(env);
    expect(secondStdout).toContain(
      "Selected marketplace plugins are already registered in Codex."
    );
    expect(configBackups(configPath)).toHaveLength(firstBackups.length);
    expect(fs.readFileSync(configPath, "utf8")).toBe(updatedConfig);
  });

  it("uses the default Codex config paths under HOME", async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "ado-install-default-home-"));
    const configRoot = path.join(
      homeDir,
      "Library",
      "Mobile Documents",
      "com~apple~CloudDocs",
      "Codex-config"
    );
    const configPath = path.join(homeDir, ".Codex", "config.toml");
    createConfig(configPath);

    const env: NodeJS.ProcessEnv = { ...process.env, HOME: homeDir };
    delete env.CODEX_CONFIG_FILE;
    delete env.CODEX_CONFIG_ROOT;

    const stdout = await runInstaller(env);

    expect(stdout).toContain(`Config root: ${configRoot}`);
    expect(stdout).toContain(`Plugin link: ${path.join(configRoot, "plugins", "azure-devops")}`);
    expect(fs.lstatSync(path.join(configRoot, "plugins", "azure-devops")).isSymbolicLink()).toBe(
      true
    );
    expect(fs.readFileSync(configPath, "utf8")).toContain(
      `source = ${JSON.stringify(configRoot)}`
    );
  });

  it("can install only a selected marketplace plugin", async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "ado-install-selected-"));
    const configRoot = path.join(homeDir, "Codex-config");
    const configPath = path.join(homeDir, ".Codex", "config.toml");
    createConfig(configPath);
    createMarketplace(configRoot);

    const stdout = await runInstaller({
      ...process.env,
      CODEX_CONFIG_FILE: configPath,
      CODEX_CONFIG_ROOT: configRoot,
      CODEX_PLUGINS: "github-local-ops",
      HOME: homeDir,
    });

    expect(stdout).toContain("Plugins: github-local-ops@codex-plugins");
    expect(fs.existsSync(path.join(configRoot, "plugins", "azure-devops"))).toBe(false);
    const githubPluginLink = path.join(configRoot, "plugins", "github-local-ops");
    expect(fs.lstatSync(githubPluginLink).isSymbolicLink()).toBe(true);
    expect(fs.realpathSync(githubPluginLink)).toBe(
      fs.realpathSync(githubPluginSource)
    );

    const updatedConfig = fs.readFileSync(configPath, "utf8");
    expect(updatedConfig).toContain(
      '[plugins."github-local-ops@codex-plugins"]\nenabled = true'
    );
    expect(updatedConfig).toContain(
      '[plugins."azure-devops@codex-plugins"]\nenabled = false'
    );
  });

  it("rejects invalid selected plugin names before linking", async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "ado-install-invalid-"));
    const configRoot = path.join(homeDir, "Codex-config");
    const configPath = path.join(homeDir, ".Codex", "config.toml");
    createConfig(configPath);

    await expect(
      execFile(process.execPath, [scriptPath], {
        cwd: repoRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          CODEX_CONFIG_FILE: configPath,
          CODEX_CONFIG_ROOT: configRoot,
          CODEX_PLUGINS: "../bad",
          HOME: homeDir,
        },
      })
    ).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("Invalid plugin name"),
    });

    expect(fs.existsSync(path.join(configRoot, "plugins"))).toBe(false);
    expect(
      fs.existsSync(path.join(configRoot, ".agents", "plugins", "marketplace.json"))
    ).toBe(false);
  });

  it.each([
    ["regular file", (pluginLink: string) => fs.writeFileSync(pluginLink, "blocker\n")],
    ["directory", (pluginLink: string) => fs.mkdirSync(pluginLink, { recursive: true })],
    [
      "wrong symlink",
      (pluginLink: string, homeDir: string) => {
        const otherTarget = path.join(homeDir, "other-plugin");
        fs.mkdirSync(otherTarget, { recursive: true });
        fs.symlinkSync(otherTarget, pluginLink, "dir");
      },
    ],
  ])("refuses to overwrite an existing %s at the plugin link", async (_label, createBlocker) => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "ado-install-blocked-"));
    const configRoot = path.join(homeDir, "Codex-config");
    const configPath = path.join(homeDir, ".Codex", "config.toml");
    createConfig(configPath);
    const originalConfig = fs.readFileSync(configPath, "utf8");
    const pluginLink = path.join(configRoot, "plugins", "azure-devops");
    fs.mkdirSync(path.dirname(pluginLink), { recursive: true });
    createBlocker(pluginLink, homeDir);

    await expect(
      execFile(process.execPath, [scriptPath], {
        cwd: repoRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          CODEX_CONFIG_FILE: configPath,
          CODEX_CONFIG_ROOT: configRoot,
          HOME: homeDir,
        },
      })
    ).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("already exists and does not point"),
    });

    expect(fs.readFileSync(configPath, "utf8")).toBe(originalConfig);
    expect(fs.lstatSync(pluginLink)).toBeDefined();
    expect(
      fs.existsSync(path.join(configRoot, ".agents", "plugins", "marketplace.json"))
    ).toBe(false);
  });
});
