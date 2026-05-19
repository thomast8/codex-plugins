import { execFile as execFileCallback, spawnSync } from "node:child_process";
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
  const workflowsPluginSource = path.join(repoRoot, "plugins", "thomas-codex-workflows");
  const skillsPluginSource = path.join(repoRoot, "plugins", "thomas-codex-skills");
  const ghAuthSwitchPath = path.join(workflowsPluginSource, "hooks", "gh-auth-switch.sh");
  const repoSafetyPath = path.join(workflowsPluginSource, "hooks", "repo-safety.sh");
  const worktreeCreatePath = path.join(workflowsPluginSource, "hooks", "worktree-create.sh");
  const reviewCodeSkillSource = path.join(repoRoot, "skills", "review-code");

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
              name: "thomas-codex-workflows",
              source: {
                source: "local",
                path: "./plugins/old-thomas-codex-workflows",
              },
              policy: {
                installation: "AVAILABLE",
                authentication: "ON_INSTALL",
              },
              category: "Old",
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

  async function initMainRepo(repoDir: string): Promise<void> {
    try {
      await execFile("git", ["init", "-b", "main"], { cwd: repoDir });
    } catch {
      await execFile("git", ["init"], { cwd: repoDir });
      await execFile("git", ["checkout", "-b", "main"], { cwd: repoDir });
    }
  }

  async function initMainRepoWithCommit(repoDir: string): Promise<void> {
    await initMainRepo(repoDir);
    await execFile("git", ["config", "user.email", "test@example.com"], { cwd: repoDir });
    await execFile("git", ["config", "user.name", "Test User"], { cwd: repoDir });
    fs.writeFileSync(path.join(repoDir, "README.md"), "initial\n", "utf8");
    await execFile("git", ["add", "README.md"], { cwd: repoDir });
    await execFile("git", ["-c", "commit.gpgsign=false", "commit", "-m", "initial"], {
      cwd: repoDir,
    });
  }

  function runRepoSafety(
    repoDir: string,
    homeDir: string,
    command: string
  ): ReturnType<typeof spawnSync> {
    return spawnSync("/bin/bash", [repoSafetyPath], {
      cwd: repoDir,
      encoding: "utf8",
      input: JSON.stringify({ tool_input: { command } }),
      env: { ...process.env, HOME: homeDir },
    });
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
      [
        "Plugins: azure-devops@codex-plugins",
        "github-local-ops@codex-plugins",
        "thomas-codex-workflows@codex-plugins",
        "thomas-codex-skills@codex-plugins",
      ].join(", ")
    );
    expect(stdout).toContain("Skills: ");
    expect(stdout).toContain("review-code");
    expect(stdout).toContain("MCP servers: gitnexus, mcp-debugger");
    expect(stdout).toContain(
      [
        "Disabled stale plugin entries: azure-devops@codex-azure-devops-plugin",
        "azure-devops@thomas-codex-config",
        "github-local-ops@codex-azure-devops-plugin",
        "github-local-ops@thomas-codex-config",
        "thomas-codex-workflows@codex-azure-devops-plugin",
        "thomas-codex-workflows@thomas-codex-config",
        "thomas-codex-skills@codex-azure-devops-plugin",
        "thomas-codex-skills@thomas-codex-config",
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
      '[plugins."thomas-codex-workflows@codex-plugins"]\nenabled = true'
    );
    expect(updatedConfig).toContain(
      '[plugins."thomas-codex-skills@codex-plugins"]\nenabled = true'
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
    expect(updatedConfig).toContain(
      '[plugins."thomas-codex-workflows@codex-azure-devops-plugin"]\nenabled = false'
    );
    expect(updatedConfig).toContain(
      '[plugins."thomas-codex-workflows@thomas-codex-config"]\nenabled = false'
    );
    expect(updatedConfig).toContain(
      '[plugins."thomas-codex-skills@codex-azure-devops-plugin"]\nenabled = false'
    );
    expect(updatedConfig).toContain(
      '[plugins."thomas-codex-skills@thomas-codex-config"]\nenabled = false'
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
    expect(updatedConfig).toContain("[mcp_servers.mcp-debugger]");
    expect(updatedConfig).toContain('command = "npx"');
    expect(updatedConfig).toContain('args = ["-y","@debugmcp/mcp-debugger"]');

    const pluginLink = path.join(configRoot, "plugins", "azure-devops");
    expect(fs.lstatSync(pluginLink).isSymbolicLink()).toBe(true);
    expect(fs.realpathSync(pluginLink)).toBe(fs.realpathSync(pluginSource));
    const githubPluginLink = path.join(configRoot, "plugins", "github-local-ops");
    expect(fs.lstatSync(githubPluginLink).isSymbolicLink()).toBe(true);
    expect(fs.realpathSync(githubPluginLink)).toBe(
      fs.realpathSync(githubPluginSource)
    );
    const workflowsPluginLink = path.join(configRoot, "plugins", "thomas-codex-workflows");
    expect(fs.lstatSync(workflowsPluginLink).isSymbolicLink()).toBe(true);
    expect(fs.realpathSync(workflowsPluginLink)).toBe(
      fs.realpathSync(workflowsPluginSource)
    );
    const skillsPluginLink = path.join(configRoot, "plugins", "thomas-codex-skills");
    expect(fs.lstatSync(skillsPluginLink).isSymbolicLink()).toBe(true);
    expect(fs.realpathSync(skillsPluginLink)).toBe(
      fs.realpathSync(skillsPluginSource)
    );
    const reviewCodeSkillLink = path.join(homeDir, ".Codex", "skills", "review-code");
    expect(fs.lstatSync(reviewCodeSkillLink).isSymbolicLink()).toBe(true);
    expect(fs.realpathSync(reviewCodeSkillLink)).toBe(
      fs.realpathSync(reviewCodeSkillSource)
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
        policy?: { installation: string; authentication: string };
        category?: string;
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
    const workflowEntries = marketplace.plugins.filter(
      (plugin) => plugin.name === "thomas-codex-workflows"
    );
    expect(workflowEntries).toHaveLength(1);
    expect(workflowEntries[0]).toEqual(
      expect.objectContaining({
        name: "thomas-codex-workflows",
        source: {
          source: "local",
          path: "./plugins/thomas-codex-workflows",
        },
        policy: {
          installation: "AVAILABLE",
          authentication: "ON_INSTALL",
        },
        category: "Productivity",
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
    const skillPluginEntries = marketplace.plugins.filter(
      (plugin) => plugin.name === "thomas-codex-skills"
    );
    expect(skillPluginEntries).toHaveLength(1);
    expect(skillPluginEntries[0]).toEqual(
      expect.objectContaining({
        name: "thomas-codex-skills",
        source: {
          source: "local",
          path: "./plugins/thomas-codex-skills",
        },
        policy: {
          installation: "AVAILABLE",
          authentication: "ON_INSTALL",
        },
        category: "Productivity",
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
      "Codex config already has the selected marketplace plugins and MCP servers."
    );
    expect(configBackups(configPath)).toHaveLength(firstBackups.length);
    expect(fs.readFileSync(configPath, "utf8")).toBe(updatedConfig);
  });

  it("uses the default Codex config paths under HOME", async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "ado-install-default-home-"));
    const configRoot = path.join(homeDir, ".Codex", "marketplaces", "codex-plugins");
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
    expect(fs.existsSync(path.join(configRoot, "plugins", "thomas-codex-workflows"))).toBe(false);
    expect(fs.existsSync(path.join(configRoot, "plugins", "thomas-codex-skills"))).toBe(false);
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
    {
      label: "missing entry point",
      manifest: { name: "bad-plugin" },
      expectedError: "must declare at least one",
    },
    {
      label: "wrong plugin name",
      manifest: { name: "other-plugin", hooks: "hooks/hooks.json" },
      expectedError: "name must be bad-plugin",
    },
    {
      label: "outside hooks path",
      manifest: { name: "bad-plugin", hooks: "../outside.json" },
      expectedError: "must stay inside",
    },
    {
      label: "missing hooks file",
      manifest: { name: "bad-plugin", hooks: "hooks/missing.json" },
      expectedError: "does not exist",
    },
    {
      label: "empty hooks path",
      manifest: { name: "bad-plugin", hooks: " " },
      expectedError: "must be a non-empty string path",
    },
    {
      label: "hooks directory",
      manifest: { name: "bad-plugin", hooks: "hooks" },
      expectedError: "must point to a file",
    },
    {
      label: "mcpServers directory",
      manifest: { name: "bad-plugin", mcpServers: "hooks" },
      expectedError: "must point to a file",
    },
    {
      label: "skills file",
      manifest: { name: "bad-plugin", skills: "skills-file" },
      expectedError: "must point to a directory",
    },
    {
      label: "symlinked hooks file",
      manifest: { name: "bad-plugin", hooks: "hooks/link.json" },
      expectedError: "must stay inside",
      createSymlinkEscape: true,
    },
  ])("rejects a plugin manifest with $label", async ({
    manifest,
    expectedError,
    createSymlinkEscape,
  }) => {
    const tempRepoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "installer-shape-"));
    const tempScriptPath = path.join(tempRepoRoot, "scripts", "install-local.mjs");
    const pluginRoot = path.join(tempRepoRoot, "plugins", "bad-plugin");
    const manifestPath = path.join(pluginRoot, ".codex-plugin", "plugin.json");
    fs.mkdirSync(path.dirname(tempScriptPath), { recursive: true });
    fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
    fs.copyFileSync(scriptPath, tempScriptPath);
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    fs.mkdirSync(path.join(pluginRoot, "hooks"), { recursive: true });
    fs.writeFileSync(path.join(pluginRoot, "hooks", "hooks.json"), "{}\n", "utf8");
    fs.writeFileSync(path.join(pluginRoot, "skills-file"), "not a directory\n", "utf8");
    if (createSymlinkEscape) {
      const outsideFile = path.join(tempRepoRoot, "outside-hooks.json");
      fs.writeFileSync(outsideFile, "{}\n", "utf8");
      fs.symlinkSync(outsideFile, path.join(pluginRoot, "hooks", "link.json"));
    }
    fs.mkdirSync(path.join(tempRepoRoot, ".agents", "plugins"), { recursive: true });
    fs.writeFileSync(
      path.join(tempRepoRoot, ".agents", "plugins", "marketplace.json"),
      `${JSON.stringify({
        name: "codex-plugins",
        plugins: [
          {
            name: "bad-plugin",
            source: { source: "local", path: "./plugins/bad-plugin" },
          },
        ],
      })}\n`,
      "utf8"
    );

    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "installer-shape-home-"));
    const configPath = path.join(homeDir, ".Codex", "config.toml");
    createConfig(configPath);

    await expect(
      execFile(process.execPath, [tempScriptPath], {
        cwd: tempRepoRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          CODEX_CONFIG_FILE: configPath,
          CODEX_CONFIG_ROOT: path.join(homeDir, "Codex-config"),
          HOME: homeDir,
        },
      })
    ).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining(expectedError),
    });
  });

  it("rejects a symlinked plugin root before linking", async () => {
    const tempRepoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "installer-root-link-"));
    const tempScriptPath = path.join(tempRepoRoot, "scripts", "install-local.mjs");
    const outsidePluginRoot = fs.mkdtempSync(path.join(os.tmpdir(), "outside-plugin-"));
    fs.mkdirSync(path.dirname(tempScriptPath), { recursive: true });
    fs.copyFileSync(scriptPath, tempScriptPath);
    fs.mkdirSync(path.join(outsidePluginRoot, ".codex-plugin"), { recursive: true });
    fs.mkdirSync(path.join(outsidePluginRoot, "hooks"), { recursive: true });
    fs.writeFileSync(
      path.join(outsidePluginRoot, ".codex-plugin", "plugin.json"),
      `${JSON.stringify({ name: "bad-plugin", hooks: "hooks/hooks.json" })}\n`,
      "utf8"
    );
    fs.writeFileSync(path.join(outsidePluginRoot, "hooks", "hooks.json"), "{}\n", "utf8");
    fs.mkdirSync(path.join(tempRepoRoot, "plugins"), { recursive: true });
    fs.symlinkSync(outsidePluginRoot, path.join(tempRepoRoot, "plugins", "bad-plugin"), "dir");
    fs.mkdirSync(path.join(tempRepoRoot, ".agents", "plugins"), { recursive: true });
    fs.writeFileSync(
      path.join(tempRepoRoot, ".agents", "plugins", "marketplace.json"),
      `${JSON.stringify({
        name: "codex-plugins",
        plugins: [
          {
            name: "bad-plugin",
            source: { source: "local", path: "./plugins/bad-plugin" },
          },
        ],
      })}\n`,
      "utf8"
    );
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "installer-root-link-home-"));
    const configPath = path.join(homeDir, ".Codex", "config.toml");
    createConfig(configPath);

    await expect(
      execFile(process.execPath, [tempScriptPath], {
        cwd: tempRepoRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          CODEX_CONFIG_FILE: configPath,
          CODEX_CONFIG_ROOT: path.join(homeDir, "Codex-config"),
          HOME: homeDir,
        },
      })
    ).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("must not be a symlink"),
    });
  });

  it.each([
    'git commit -m "x"',
    'git -c commit.gpgsign=false commit -m "x"',
    "git push",
    "git push origin",
    "git push --force-with-lease origin main",
    "git push origin 'main'",
    "git -C . push origin main",
    "git push origin HEAD",
    "git push origin HEAD:refs/heads/main",
    "git push origin v1.2.3 main",
    "echo CODEX_ALLOW_MAIN=1 && git push origin main",
  ])("blocks unsafe main branch command: %s", async (command) => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-home-"));
    const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-main-"));
    await initMainRepo(repoDir);

    const result = runRepoSafety(repoDir, homeDir, command);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Blocked:");
  });

  it("blocks pushes that target main from a non-main branch", async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-home-"));
    const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-feature-"));
    await initMainRepo(repoDir);
    await execFile("git", ["checkout", "-b", "feature/demo"], { cwd: repoDir });

    const result = runRepoSafety(repoDir, homeDir, "git push origin HEAD:refs/heads/main");

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("refspec targets main");
  });

  it("blocks git -C operations that target a main-branch repo", async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-home-"));
    const mainParentDir = fs.mkdtempSync(path.join(os.tmpdir(), "workflow main parent-"));
    const mainRepoDir = path.join(mainParentDir, "main target repo");
    const cwdRepoDir = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-cwd-"));
    fs.mkdirSync(mainRepoDir);
    await initMainRepo(mainRepoDir);
    await initMainRepo(cwdRepoDir);
    await execFile("git", ["checkout", "-b", "feature/demo"], { cwd: cwdRepoDir });

    const result = runRepoSafety(
      cwdRepoDir,
      homeDir,
      `git -C "${mainRepoDir}" push origin`
    );

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("bare push would publish it");
  });

  it("blocks git -C commits when the target repo path contains spaces", async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-home-"));
    const mainParentDir = fs.mkdtempSync(path.join(os.tmpdir(), "workflow main parent-"));
    const mainRepoDir = path.join(mainParentDir, "main target repo");
    const cwdRepoDir = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-cwd-"));
    fs.mkdirSync(mainRepoDir);
    await initMainRepo(mainRepoDir);
    await initMainRepo(cwdRepoDir);
    await execFile("git", ["checkout", "-b", "feature/demo"], { cwd: cwdRepoDir });

    const result = runRepoSafety(
      cwdRepoDir,
      homeDir,
      `git -C "${mainRepoDir}" commit -m "x"`
    );

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("do not commit directly to main");
  });

  it.each(["git push origin feature/demo", "git push origin --tags"])(
    "allows safe explicit main branch command: %s",
    async (command) => {
      const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-home-"));
      const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-main-"));
      await initMainRepo(repoDir);

      const result = runRepoSafety(repoDir, homeDir, command);

      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
    }
  );

  it.each([
    'CODEX_ALLOW_MAIN=1 git commit -m "x"',
    "env CODEX_ALLOW_MAIN=1 git push origin main",
  ])("allows explicit one-command main guard override: %s", async (command) => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-home-"));
    const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-main-"));
    await initMainRepo(repoDir);

    const result = runRepoSafety(repoDir, homeDir, command);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
  });

  it("allows repos listed in the main guard allowlist", async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-home-"));
    const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-main-"));
    await initMainRepo(repoDir);
    fs.mkdirSync(path.join(homeDir, ".Codex"), { recursive: true });
    fs.writeFileSync(
      path.join(homeDir, ".Codex", "main-guard-allowlist"),
      `${fs.realpathSync(repoDir)}\n`,
      "utf8"
    );

    const result = runRepoSafety(repoDir, homeDir, 'git commit -m "x"');

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
  });

  it("uses a gh command repo target before falling back to cwd origin", async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-home-"));
    const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-gh-"));
    const binDir = path.join(homeDir, "bin");
    const logPath = path.join(homeDir, "gh-calls.log");
    await initMainRepo(repoDir);
    await execFile("git", ["remote", "add", "origin", "git@github.com:thomast8/codex-plugins.git"], {
      cwd: repoDir,
    });
    fs.mkdirSync(binDir, { recursive: true });
    const fakeGh = path.join(binDir, "gh");
    fs.writeFileSync(
      fakeGh,
      [
        "#!/usr/bin/env bash",
        'printf "%s\\n" "$*" >> "$GH_CALL_LOG"',
        'if [ "$1" = "auth" ] && [ "$2" = "status" ]; then',
        '  printf "%s\\n" "github.com" "  account thomast8" "  Active account: true"',
        "  exit 0",
        "fi",
        'if [ "$1" = "auth" ] && [ "$2" = "switch" ]; then',
        "  exit 0",
        "fi",
        "exit 1",
        "",
      ].join("\n"),
      "utf8"
    );
    fs.chmodSync(fakeGh, 0o755);

    const result = spawnSync("/bin/bash", [ghAuthSwitchPath], {
      cwd: repoDir,
      encoding: "utf8",
      input: JSON.stringify({
        tool_input: { command: "GH_REPO=thomast8/example gh pr view -R kyndryl-agentic-ai/example" },
      }),
      env: {
        ...process.env,
        GH_CALL_LOG: logPath,
        HOME: homeDir,
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
      },
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("thomas-tiotto_kyndryl");
    expect(fs.readFileSync(logPath, "utf8")).toContain(
      "auth switch --user thomas-tiotto_kyndryl"
    );
  });

  it("uses gh repo positional targets before falling back to cwd origin", async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-home-"));
    const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-gh-"));
    const binDir = path.join(homeDir, "bin");
    const logPath = path.join(homeDir, "gh-calls.log");
    await initMainRepo(repoDir);
    fs.mkdirSync(binDir, { recursive: true });
    const fakeGh = path.join(binDir, "gh");
    fs.writeFileSync(
      fakeGh,
      [
        "#!/usr/bin/env bash",
        'printf "%s\\n" "$*" >> "$GH_CALL_LOG"',
        'if [ "$1" = "auth" ] && [ "$2" = "status" ]; then',
        '  printf "%s\\n" "github.com" "  account thomast8" "  Active account: true"',
        "  exit 0",
        "fi",
        'if [ "$1" = "auth" ] && [ "$2" = "switch" ]; then',
        "  exit 0",
        "fi",
        "exit 1",
        "",
      ].join("\n"),
      "utf8"
    );
    fs.chmodSync(fakeGh, 0o755);

    const result = spawnSync("/bin/bash", [ghAuthSwitchPath], {
      cwd: repoDir,
      encoding: "utf8",
      input: JSON.stringify({
        tool_input: { command: "gh repo view kyndryl-agentic-ai/example" },
      }),
      env: {
        ...process.env,
        GH_CALL_LOG: logPath,
        HOME: homeDir,
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
      },
    });

    expect(result.status).toBe(0);
    expect(fs.readFileSync(logPath, "utf8")).toContain(
      "auth switch --user thomas-tiotto_kyndryl"
    );
  });

  it("uses git -C push remotes for gh account switching", async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-home-"));
    const cwdRepoDir = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-gh-cwd-"));
    const targetParentDir = fs.mkdtempSync(path.join(os.tmpdir(), "workflow gh parent-"));
    const targetRepoDir = path.join(targetParentDir, "target repo");
    const binDir = path.join(homeDir, "bin");
    const logPath = path.join(homeDir, "gh-calls.log");
    fs.mkdirSync(targetRepoDir);
    await initMainRepo(cwdRepoDir);
    await initMainRepo(targetRepoDir);
    await execFile("git", ["remote", "add", "origin", "git@github.com:thomast8/codex-plugins.git"], {
      cwd: cwdRepoDir,
    });
    await execFile("git", ["remote", "add", "origin", "git@github.com:kyndryl-agentic-ai/example.git"], {
      cwd: targetRepoDir,
    });
    fs.mkdirSync(binDir, { recursive: true });
    const fakeGh = path.join(binDir, "gh");
    fs.writeFileSync(
      fakeGh,
      [
        "#!/usr/bin/env bash",
        'printf "%s\\n" "$*" >> "$GH_CALL_LOG"',
        'if [ "$1" = "auth" ] && [ "$2" = "status" ]; then',
        '  printf "%s\\n" "github.com" "  account thomast8" "  Active account: true"',
        "  exit 0",
        "fi",
        'if [ "$1" = "auth" ] && [ "$2" = "switch" ]; then',
        "  exit 0",
        "fi",
        "exit 1",
        "",
      ].join("\n"),
      "utf8"
    );
    fs.chmodSync(fakeGh, 0o755);

    const result = spawnSync("/bin/bash", [ghAuthSwitchPath], {
      cwd: cwdRepoDir,
      encoding: "utf8",
      input: JSON.stringify({
        tool_input: { command: `git -C "${targetRepoDir}" push origin feature/demo` },
      }),
      env: {
        ...process.env,
        GH_CALL_LOG: logPath,
        HOME: homeDir,
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
      },
    });

    expect(result.status).toBe(0);
    expect(fs.readFileSync(logPath, "utf8")).toContain(
      "auth switch --user thomas-tiotto_kyndryl"
    );
  });

  it("uses direct GitHub push URLs for gh account switching", async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-home-"));
    const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-gh-cwd-"));
    const binDir = path.join(homeDir, "bin");
    const logPath = path.join(homeDir, "gh-calls.log");
    await initMainRepo(repoDir);
    await execFile("git", ["remote", "add", "origin", "git@github.com:thomast8/codex-plugins.git"], {
      cwd: repoDir,
    });
    fs.mkdirSync(binDir, { recursive: true });
    const fakeGh = path.join(binDir, "gh");
    fs.writeFileSync(
      fakeGh,
      [
        "#!/usr/bin/env bash",
        'printf "%s\\n" "$*" >> "$GH_CALL_LOG"',
        'if [ "$1" = "auth" ] && [ "$2" = "status" ]; then',
        '  printf "%s\\n" "github.com" "  account thomast8" "  Active account: true"',
        "  exit 0",
        "fi",
        'if [ "$1" = "auth" ] && [ "$2" = "switch" ]; then',
        "  exit 0",
        "fi",
        "exit 1",
        "",
      ].join("\n"),
      "utf8"
    );
    fs.chmodSync(fakeGh, 0o755);

    const result = spawnSync("/bin/bash", [ghAuthSwitchPath], {
      cwd: repoDir,
      encoding: "utf8",
      input: JSON.stringify({
        tool_input: {
          command: "git push git@github.com:kyndryl-agentic-ai/example.git feature/demo",
        },
      }),
      env: {
        ...process.env,
        GH_CALL_LOG: logPath,
        HOME: homeDir,
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
      },
    });

    expect(result.status).toBe(0);
    expect(fs.readFileSync(logPath, "utf8")).toContain(
      "auth switch --user thomas-tiotto_kyndryl"
    );
  });

  it("rejects worktree paths outside the repo worktree area", async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-home-"));
    const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-worktree-"));
    await initMainRepo(repoDir);

    const result = spawnSync("/bin/bash", [worktreeCreatePath], {
      cwd: repoDir,
      encoding: "utf8",
      input: JSON.stringify({
        cwd: repoDir,
        worktree_path: path.join(os.tmpdir(), "outside-worktree"),
      }),
      env: { ...process.env, HOME: homeDir },
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("worktree_path must stay under");
  });

  it("rejects worktree creation when the repo .codex path is a symlink", async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-home-"));
    const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-worktree-"));
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-outside-"));
    await initMainRepo(repoDir);
    fs.symlinkSync(outsideDir, path.join(repoDir, ".codex"), "dir");

    const result = spawnSync("/bin/bash", [worktreeCreatePath], {
      cwd: repoDir,
      encoding: "utf8",
      input: JSON.stringify({
        cwd: repoDir,
        name: "feature/demo",
      }),
      env: { ...process.env, HOME: homeDir },
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("must not be a symlink");
  });

  it("rejects worktree creation when the final path is a symlink", async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-home-"));
    const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-worktree-"));
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-outside-"));
    await initMainRepo(repoDir);
    const symlinkParent = path.join(repoDir, ".codex", "worktrees", "feature");
    fs.mkdirSync(symlinkParent, { recursive: true });
    fs.symlinkSync(outsideDir, path.join(symlinkParent, "demo"), "dir");

    const result = spawnSync("/bin/bash", [worktreeCreatePath], {
      cwd: repoDir,
      encoding: "utf8",
      input: JSON.stringify({
        cwd: repoDir,
        name: "feature/demo",
      }),
      env: { ...process.env, HOME: homeDir },
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("must not be a symlink");
  });

  it("creates a normalized derived worktree under the repo worktree area", async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-home-"));
    const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-worktree-"));
    await initMainRepoWithCommit(repoDir);

    const result = spawnSync("/bin/bash", [worktreeCreatePath], {
      cwd: repoDir,
      encoding: "utf8",
      input: JSON.stringify({
        cwd: repoDir,
        name: "Review Demo",
      }),
      env: { ...process.env, HOME: homeDir },
    });

    const expectedPath = path.join(
      fs.realpathSync(repoDir),
      ".codex",
      "worktrees",
      "feat",
      "review-demo"
    );
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(expectedPath);
    const { stdout: branch } = await execFile("git", ["branch", "--show-current"], {
      cwd: expectedPath,
      encoding: "utf8",
    });
    expect(branch.trim()).toBe("feat/review-demo");
    const { stdout: worktrees } = await execFile("git", ["worktree", "list", "--porcelain"], {
      cwd: repoDir,
      encoding: "utf8",
    });
    expect(worktrees).toContain(`worktree ${expectedPath}`);
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
