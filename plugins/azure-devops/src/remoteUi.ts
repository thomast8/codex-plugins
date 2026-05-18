import { RemoteSettings, RemoteUser } from "./remoteStore.js";

export interface SettingsPageOptions {
  user: RemoteUser;
  settings?: RemoteSettings;
  message?: string;
  error?: string;
}

export interface SignInPageOptions {
  loginUrl: string;
  error?: string;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function repositoriesText(settings: RemoteSettings | undefined): string {
  return settings?.repositories?.join(", ") ?? "";
}

function statusValue(value: string | undefined): string {
  return value === undefined || value.trim() === "" ? "Not set" : value;
}

function pageShell(options: {
  title: string;
  bodyClass?: string;
  body: string;
}): string {
  const bodyClass =
    options.bodyClass === undefined ? "" : ` class="${options.bodyClass}"`;
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(options.title)}</title>
    <style>
      :root {
        color-scheme: light;
        --ink: #172033;
        --muted: #63708a;
        --line: #d9e1ec;
        --panel: #ffffff;
        --surface: #f5f7fb;
        --surface-strong: #edf2f8;
        --accent: #0078d4;
        --accent-dark: #005ea8;
        --accent-ink: #ffffff;
        --ok: #107c41;
        --error: #a4262c;
        --shadow: 0 18px 44px rgba(23, 32, 51, 0.09);
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        color: var(--ink);
        background:
          linear-gradient(180deg, #ffffff 0, var(--surface) 340px),
          var(--surface);
        font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        line-height: 1.4;
      }
      main {
        width: min(980px, calc(100vw - 32px));
        margin: 0 auto;
        padding: 32px 0 56px;
      }
      .centered {
        min-height: 100vh;
        display: grid;
        place-items: center;
        padding: 28px 16px;
      }
      .setup-shell {
        width: min(520px, 100%);
      }
      .brand-row {
        display: flex;
        align-items: center;
        gap: 12px;
        margin-bottom: 18px;
      }
      .brand-mark {
        width: 38px;
        height: 38px;
        border-radius: 8px;
        display: grid;
        place-items: center;
        color: #fff;
        background: linear-gradient(135deg, #0078d4, #2b88d8 55%, #50e6ff);
        font-weight: 800;
      }
      .brand-copy {
        display: grid;
        gap: 1px;
      }
      .brand-copy strong {
        font-size: 15px;
      }
      .brand-copy span {
        color: var(--muted);
        font-size: 13px;
      }
      .panel {
        background: var(--panel);
        border: 1px solid var(--line);
        border-radius: 8px;
        box-shadow: var(--shadow);
      }
      .signin-panel {
        padding: 28px;
      }
      h1 {
        margin: 0;
        font-size: 28px;
        line-height: 1.15;
        font-weight: 700;
      }
      .lede {
        margin: 10px 0 0;
        color: var(--muted);
        font-size: 15px;
      }
      .signin-actions {
        display: grid;
        gap: 14px;
        margin-top: 26px;
      }
      .button-link,
      button {
        min-height: 42px;
        border: 1px solid transparent;
        border-radius: 6px;
        padding: 9px 14px;
        font: inherit;
        font-weight: 650;
        cursor: pointer;
      }
      .button-link {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        text-decoration: none;
      }
      .primary {
        color: var(--accent-ink);
        background: var(--accent);
      }
      .primary:hover {
        background: var(--accent-dark);
      }
      .secondary {
        color: var(--ink);
        border-color: var(--line);
        background: #fff;
      }
      .hint {
        margin: 0;
        color: var(--muted);
        font-size: 13px;
      }
      header {
        display: flex;
        justify-content: space-between;
        gap: 24px;
        align-items: flex-start;
        padding: 0 0 22px;
        border-bottom: 1px solid var(--line);
      }
      .identity {
        color: var(--muted);
        font-size: 14px;
        white-space: nowrap;
      }
      .summary {
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        gap: 12px;
        margin-top: 22px;
      }
      .summary-item {
        min-height: 78px;
        border: 1px solid var(--line);
        border-radius: 8px;
        background: var(--panel);
        padding: 13px 14px;
      }
      .summary-label {
        color: var(--muted);
        font-size: 12px;
        font-weight: 700;
        margin-bottom: 6px;
      }
      .summary-value {
        font-size: 14px;
        overflow-wrap: anywhere;
      }
      form {
        margin-top: 20px;
        padding: 24px;
      }
      .grid {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 18px;
      }
      label {
        display: grid;
        gap: 7px;
        font-size: 13px;
        color: var(--muted);
        font-weight: 650;
      }
      input {
        width: 100%;
        min-height: 42px;
        border: 1px solid var(--line);
        border-radius: 6px;
        padding: 9px 11px;
        font: inherit;
        color: var(--ink);
        background: #fff;
      }
      input:focus {
        outline: 2px solid color-mix(in srgb, var(--accent), transparent 70%);
        border-color: var(--accent);
      }
      .wide { grid-column: 1 / -1; }
      .actions {
        display: flex;
        justify-content: flex-end;
        gap: 10px;
        margin-top: 24px;
      }
      .banner {
        margin-top: 20px;
        border-radius: 6px;
        padding: 12px 14px;
        font-size: 14px;
      }
      .banner.ok {
        color: var(--ok);
        background: #e9f6ef;
        border: 1px solid #b7e0c8;
      }
      .banner.error {
        color: var(--error);
        background: #fdebec;
        border: 1px solid #f2bdc1;
      }
      @media (max-width: 720px) {
        main { width: min(100vw - 24px, 980px); padding-top: 22px; }
        header { display: grid; gap: 8px; }
        .identity { white-space: normal; }
        .summary { grid-template-columns: 1fr; }
        form { padding: 18px; }
        .grid { grid-template-columns: 1fr; }
        .actions { display: grid; }
        .signin-panel { padding: 22px; }
      }
    </style>
  </head>
  <body${bodyClass}>
${options.body}
  </body>
</html>`;
}

export function renderSignInPage(options: SignInPageOptions): string {
  return pageShell({
    title: "Azure DevOps Sign In",
    bodyClass: "centered",
    body: `    <main class="setup-shell">
      <div class="brand-row">
        <div class="brand-mark">AZ</div>
        <div class="brand-copy">
          <strong>Azure DevOps</strong>
          <span>Codex plugin setup</span>
        </div>
      </div>
      <section class="panel signin-panel">
        <h1>Sign in to continue</h1>
        <p class="lede">Codex will connect through Microsoft Entra OAuth and keep Azure DevOps access scoped to this plugin.</p>
        ${
          options.error === undefined
            ? ""
            : `<div class="banner error">${escapeHtml(options.error)}</div>`
        }
        <div class="signin-actions">
          <a class="button-link primary" href="${escapeHtml(options.loginUrl)}">Continue with Microsoft</a>
          <p class="hint">After sign-in, configured workspace defaults are used automatically when available.</p>
        </div>
      </section>
    </main>`
  });
}

export function renderSettingsPage(options: SettingsPageOptions): string {
  const orgUrl = options.settings?.orgUrl ?? "";
  const project = options.settings?.project ?? "";
  const requestTimeoutMs = String(options.settings?.requestTimeoutMs ?? 30000);
  const maxPages = String(options.settings?.maxPages ?? 20);
  const userLabel = options.user.displayName ?? "Signed in";
  const repositories = repositoriesText(options.settings);

  return pageShell({
    title: "Azure DevOps Settings",
    body: `    <main>
      <header>
        <div>
          <h1>Azure DevOps</h1>
          <p class="lede">Microsoft Entra OAuth is connected. Review or adjust Azure DevOps workspace defaults below.</p>
        </div>
        <div class="identity">${escapeHtml(userLabel)}</div>
      </header>
      <section class="summary" aria-label="Connection summary">
        <div class="summary-item">
          <div class="summary-label">Organization</div>
          <div class="summary-value">${escapeHtml(statusValue(orgUrl))}</div>
        </div>
        <div class="summary-item">
          <div class="summary-label">Project</div>
          <div class="summary-value">${escapeHtml(statusValue(project))}</div>
        </div>
        <div class="summary-item">
          <div class="summary-label">Repositories</div>
          <div class="summary-value">${escapeHtml(statusValue(repositories))}</div>
        </div>
      </section>
      ${
        options.message === undefined
          ? ""
          : `<div class="banner ok">${escapeHtml(options.message)}</div>`
      }
      ${
        options.error === undefined
          ? ""
          : `<div class="banner error">${escapeHtml(options.error)}</div>`
      }
      <form class="panel" method="post" action="/settings/test">
        <div class="grid">
          <label class="wide">
            Organization URL
            <input name="orgUrl" type="url" value="${escapeHtml(orgUrl)}" placeholder="https://dev.azure.com/your-org" required>
          </label>
          <label>
            Project
            <input name="project" value="${escapeHtml(project)}" required>
          </label>
          <label>
            Repository allowlist
            <input name="repositories" value="${escapeHtml(repositories)}">
          </label>
          <label>
            Request timeout
            <input name="requestTimeoutMs" type="number" min="1000" step="1000" value="${escapeHtml(requestTimeoutMs)}">
          </label>
          <label>
            Maximum pages
            <input name="maxPages" type="number" min="1" max="100" value="${escapeHtml(maxPages)}">
          </label>
        </div>
        <div class="actions">
          <button class="secondary" type="submit" formaction="/settings">Save</button>
          <button class="primary" type="submit">Save and test</button>
        </div>
      </form>
    </main>`
  });
}
