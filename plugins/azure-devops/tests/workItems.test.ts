import { describe, expect, it } from "vitest";

import {
  addWorkItemComment,
  addWorkItemCommentRequest,
  assertRawWiqlProjectBoundary,
  buildCreateWorkItemPatch,
  buildUpdateWorkItemPatch,
  buildWiql,
  createWorkItem,
  getWorkItem,
  searchWorkItems,
  updateWorkItem
} from "../src/workItems.js";
import { createClient, jsonResponse, testConfig } from "./helpers.js";

describe("work item request builders", () => {
  it("builds WIQL with escaped literals and filters", () => {
    const wiql = buildWiql({
      query: "can't start",
      workItemTypes: ["Bug"],
      states: ["Active"],
      assignedTo: "someone@example.com",
      top: 10
    });

    expect(wiql).toContain("SELECT [System.Id]");
    expect(wiql).not.toContain("SELECT TOP");
    expect(wiql).toContain("[System.TeamProject] = @project");
    expect(wiql).toContain("[System.Title] Contains 'can''t start'");
    expect(wiql).toContain("[System.WorkItemType] In ('Bug')");
    expect(wiql).toContain("[System.State] In ('Active')");
    expect(wiql).toContain("[System.AssignedTo] = 'someone@example.com'");
  });

  it("passes through the @Me WIQL identity macro", () => {
    const wiql = buildWiql({
      assignedTo: " @me "
    });

    expect(wiql).toContain("[System.AssignedTo] = @Me");
    expect(wiql).not.toContain("'@Me'");
  });

  it("requires raw WIQL to stay inside the configured project", () => {
    expect(() =>
      assertRawWiqlProjectBoundary(
        testConfig,
        "SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project"
      )
    ).not.toThrow();
    expect(() =>
      assertRawWiqlProjectBoundary(
        testConfig,
        "SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = 'Example Project'"
      )
    ).not.toThrow();
    expect(() =>
      assertRawWiqlProjectBoundary(
        testConfig,
        "SELECT [System.Id] FROM WorkItems WHERE [System.State] = 'Active'"
      )
    ).toThrow("Raw WIQL must include a System.TeamProject predicate");
    expect(() =>
      assertRawWiqlProjectBoundary(
        testConfig,
        "SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = 'Other Project'"
      )
    ).toThrow("Raw WIQL must include a System.TeamProject predicate");
  });

  it("builds create patches from standard and custom fields", () => {
    expect(
      buildCreateWorkItemPatch({
        workItemType: "Bug",
        title: "Broken flow",
        description: "Steps",
        tags: ["codex", "ado"],
        fields: {
          "Custom.Risk": "High"
        }
      })
    ).toEqual([
      { op: "add", path: "/fields/Custom.Risk", value: "High" },
      { op: "add", path: "/fields/System.Title", value: "Broken flow" },
      { op: "add", path: "/fields/System.Description", value: "Steps" },
      { op: "add", path: "/fields/System.Tags", value: "codex; ado" }
    ]);
  });

  it("rejects unsupported field names", () => {
    expect(() =>
      buildUpdateWorkItemPatch({
        id: 1,
        fields: {
          "../bad": "value"
        }
      })
    ).toThrow("Unsupported Azure DevOps field reference name");
  });

  it("previews create writes without calling fetch", async () => {
    const client = createClient(async () => {
      throw new Error("fetch should not be called for previews");
    });

    const result = await createWorkItem(client, {
      workItemType: "Task",
      title: "Preview me"
    });

    expect(result).toMatchObject({
      applied: false,
      summary: "Preview create Task work item."
    });
  });

  it("previews update writes without calling fetch", async () => {
    const client = createClient(async () => {
      throw new Error("fetch should not be called for previews");
    });

    const result = await updateWorkItem(client, {
      id: 123,
      state: "Active"
    });

    expect(result).toMatchObject({
      applied: false,
      summary: "Preview update for work item 123."
    });
  });

  it("searches work items with client-side top and project checks", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const client = createClient(async (url, init) => {
      calls.push({ url, init });
      if (calls.length === 1) {
        return jsonResponse({
          workItems: [
            { id: 123, url: "https://example/workitems/123" },
            { id: 456, url: "https://example/workitems/456" }
          ]
        });
      }
      return jsonResponse({
        value: [
          {
            id: 123,
            fields: {
              "System.TeamProject": "Example Project",
              "System.Title": "Ticket title"
            }
          }
        ]
      });
    });

    const result = await searchWorkItems(client, {
      wiql:
        "SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project",
      top: 1
    });

    expect(calls).toHaveLength(2);
    expect(calls[0]?.init.method).toBe("POST");
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      query:
        "SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project"
    });
    expect(calls[1]?.init.method).toBe("GET");
    expect(calls[1]?.url).toContain("ids=123");
    expect(calls[1]?.url).not.toContain("456");
    expect(result).toMatchObject({
      count: 1,
      workItems: [
        {
          id: 123,
          project: "Example Project",
          title: "Ticket title"
        }
      ]
    });
  });

  it("rejects search results outside the configured project", async () => {
    const client = createClient(async (_url, init) => {
      if (init.method === "POST") {
        return jsonResponse({
          workItems: [{ id: 123, url: "https://example/workitems/123" }]
        });
      }
      return jsonResponse({
        value: [
          {
            id: 123,
            fields: {
              "System.TeamProject": "Other Project",
              "System.Title": "Ticket title"
            }
          }
        ]
      });
    });

    await expect(
      searchWorkItems(client, {
        wiql:
          "SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project"
      })
    ).rejects.toThrow("outside the configured Azure DevOps project");
  });

  it("rejects direct work item reads outside the configured project", async () => {
    const client = createClient(async () =>
      jsonResponse({
        id: 123,
        fields: {
          "System.TeamProject": "Other Project",
          "System.Title": "Ticket title"
        }
      })
    );

    await expect(getWorkItem(client, 123)).rejects.toThrow(
      "outside the configured Azure DevOps project"
    );
  });

  it("checks the configured project before applying updates", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const client = createClient(async (url, init) => {
      calls.push({ url, init });
      if (init.method === "GET") {
        return jsonResponse({
          id: 123,
          fields: {
            "System.TeamProject": "Example Project"
          }
        });
      }
      return jsonResponse({ id: 123 });
    });

    const result = await updateWorkItem(client, {
      id: 123,
      state: "Active",
      apply: true
    });

    expect(result).toMatchObject({ applied: true });
    expect(calls.map((call) => call.init.method)).toEqual(["GET", "PATCH"]);
  });

  it("checks the configured project before applying comments", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const client = createClient(async (url, init) => {
      calls.push({ url, init });
      if (init.method === "GET") {
        return jsonResponse({
          id: 123,
          fields: {
            "System.TeamProject": "Example Project"
          }
        });
      }
      return jsonResponse({ id: 123, text: "Comment" });
    });

    const result = await addWorkItemComment(client, {
      id: 123,
      text: "Working on this",
      apply: true
    });

    expect(result).toMatchObject({ applied: true });
    expect(calls.map((call) => call.init.method)).toEqual(["GET", "POST"]);
    expect(calls[1]?.url).toContain("workItems/123/comments");
  });

  it("builds comment requests with preview API version", () => {
    const request = addWorkItemCommentRequest(testConfig, {
      id: 123,
      text: "Looks good"
    });

    expect(request.method).toBe("POST");
    expect(request.url).toContain("workItems/123/comments");
    expect(request.url).toContain("api-version=7.1-preview.4");
    expect(request.body).toEqual({ text: "Looks good" });
  });
});
