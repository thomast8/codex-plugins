import { AdoError } from "./errors.js";

export function normalizeOrgUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, "");
  if (!trimmed) {
    throw new AdoError("Azure DevOps organization URL is required.", {
      kind: "configuration"
    });
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch (error) {
    throw new AdoError("Azure DevOps organization URL must be absolute.", {
      kind: "configuration",
      cause: error
    });
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new AdoError("Azure DevOps organization URL must use http or https.", {
      kind: "configuration"
    });
  }

  return url.toString().replace(/\/+$/, "");
}

export function normalizeHostedOrgUrl(value: string): string {
  const normalized = normalizeOrgUrl(value);
  const url = new URL(normalized);
  if (url.protocol !== "https:") {
    throw new AdoError("Hosted Azure DevOps organization URL must use https.", {
      kind: "configuration"
    });
  }
  if (url.username !== "" || url.password !== "") {
    throw new AdoError(
      "Hosted Azure DevOps organization URL must not include credentials.",
      { kind: "configuration" }
    );
  }
  if (url.port !== "") {
    throw new AdoError(
      "Hosted Azure DevOps organization URL must not include a custom port.",
      { kind: "configuration" }
    );
  }
  if (url.search !== "" || url.hash !== "") {
    throw new AdoError(
      "Hosted Azure DevOps organization URL must not include query or fragment.",
      { kind: "configuration" }
    );
  }

  if (url.hostname === "dev.azure.com") {
    const segments = url.pathname.split("/").filter((segment) => segment !== "");
    if (segments.length === 1) {
      return normalized;
    }
  }

  if (
    url.hostname.endsWith(".visualstudio.com") &&
    url.hostname.split(".").length === 3 &&
    (url.pathname === "" || url.pathname === "/")
  ) {
    return normalized;
  }

  throw new AdoError(
    "Hosted Azure DevOps organization URL must be https://dev.azure.com/{org} or https://{org}.visualstudio.com.",
    { kind: "configuration" }
  );
}
