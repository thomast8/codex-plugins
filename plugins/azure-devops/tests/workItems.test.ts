import { describe, expect, it } from "vitest";

import {
  addWorkItemComment,
  addWorkItemCommentRequest,
  assertRawWiqlProjectBoundary,
  buildCreateWorkItemPatch,
  buildUpdateWorkItemPatch,
  buildWiql,
  createWorkItem,
  currentIterationRequest,
  getWorkTrackingRules,
  getWorkItem,
  searchWorkItems,
  selectCurrentIterationPath,
  taskboardWorkItemUpdateRequest,
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
        state: "Active",
        tags: ["codex", "ado"],
        fields: {
          "Custom.Risk": "High",
          "System.State": "Active"
        },
        lifecycleEvent: "start_work"
      }, {
        iterationPath: "Example Project\\Sprint 13"
      })
    ).toEqual([
      { op: "add", path: "/fields/Custom.Risk", value: "High" },
      {
        op: "add",
        path: "/fields/System.IterationPath",
        value: "Example Project\\Sprint 13"
      },
      { op: "add", path: "/fields/System.Title", value: "Broken flow" },
      { op: "add", path: "/fields/System.Description", value: "Steps" },
      { op: "add", path: "/fields/System.Tags", value: "codex; ado" }
    ]);
  });

  it("keeps explicit create iteration fields over the current sprint", () => {
    const patch = buildCreateWorkItemPatch(
      {
        workItemType: "Task",
        title: "Use explicit sprint",
        fields: {
          "System.IterationPath": "Example Project\\Backlog"
        }
      },
      {
        iterationPath: "Example Project\\Sprint 13"
      }
    );

    expect(patch).toContainEqual({
      op: "add",
      path: "/fields/System.IterationPath",
      value: "Example Project\\Backlog"
    });
    expect(patch).not.toContainEqual({
      op: "add",
      path: "/fields/System.IterationPath",
      value: "Example Project\\Sprint 13"
    });
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

  it("previews create writes with the current iteration when available", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const client = createClient(async (url, init) => {
      calls.push({ url, init });
      return jsonResponse({
        value: [
          {
            path: "Example Project\\Sprint 13",
            attributes: {
              timeFrame: "current"
            }
          }
        ]
      });
    });

    const result = await createWorkItem(client, {
      workItemType: "Task",
      title: "Preview me",
      lifecycleEvent: "start_work"
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.init.method).toBe("GET");
    expect(result).toMatchObject({
      applied: false,
      summary: "Preview create Task work item.",
      deferredStateUpdate: {
        state: "Active"
      },
      request: {
        body: expect.arrayContaining([
          {
            op: "add",
            path: "/fields/System.IterationPath",
            value: "Example Project\\Sprint 13"
          }
        ])
      }
    });
  });

  it("can preview create writes without current iteration lookup", async () => {
    const client = createClient(async () => {
      throw new Error("fetch should not be called for previews");
    });

    const result = await createWorkItem(client, {
      workItemType: "Task",
      title: "Preview me",
      preferCurrentIteration: false
    });

    expect(result).toMatchObject({
      applied: false,
      summary: "Preview create Task work item."
    });
  });

  it("creates first and applies requested lifecycle state after the item exists", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const client = createClient(async (url, init) => {
      calls.push({ url, init });
      if (init.method === "GET") {
        return jsonResponse({
          value: [
            {
              path: "Example Project\\Sprint 13",
              attributes: {
                timeFrame: "current"
              }
            }
          ]
        });
      }
      if (init.method === "POST") {
        return jsonResponse({ id: 321 });
      }
      return jsonResponse({ id: 321, fields: { "System.State": "Active" } });
    });

    const result = await createWorkItem(client, {
      workItemType: "Task",
      title: "Create me",
      lifecycleEvent: "start_work",
      apply: true
    });

    expect(result).toMatchObject({
      applied: true,
      deferredStateUpdate: {
        state: "Active"
      }
    });
    expect(calls.map((call) => call.init.method)).toEqual(["GET", "POST", "PATCH"]);
    expect(JSON.parse(String(calls[1]?.init.body))).not.toContainEqual({
      op: "add",
      path: "/fields/System.State",
      value: "Active"
    });
    expect(JSON.parse(String(calls[2]?.init.body))).toContainEqual({
      op: "add",
      path: "/fields/System.State",
      value: "Active"
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

  it("maps lifecycle events to Azure Boards state updates", () => {
    expect(
      buildUpdateWorkItemPatch({
        id: 123,
        lifecycleEvent: "start_work"
      })
    ).toEqual([
      { op: "add", path: "/fields/System.State", value: "Active" }
    ]);

    expect(
      buildUpdateWorkItemPatch({
        id: 123,
        lifecycleEvent: "reviews_requested"
      })
    ).toEqual([
      { op: "add", path: "/fields/System.State", value: "Active" }
    ]);

    expect(
      buildUpdateWorkItemPatch({
        id: 123,
        lifecycleEvent: "complete_work"
      })
    ).toEqual([
      { op: "add", path: "/fields/System.State", value: "Closed" }
    ]);
  });

  it("rejects mixing lifecycle events with explicit states", () => {
    expect(() =>
      buildUpdateWorkItemPatch({
        id: 123,
        lifecycleEvent: "start_work",
        state: "Closed"
      })
    ).toThrow("Use either lifecycleEvent or state, not both");
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

  it("maps review lifecycle updates to Active state", () => {
    expect(
      buildUpdateWorkItemPatch({
        id: 123,
        lifecycleEvent: "reviews_requested"
      })
    ).toEqual([
      { op: "add", path: "/fields/System.State", value: "Active" }
    ]);
  });

  it("exposes work tracking rules for automations", () => {
    expect(getWorkTrackingRules()).toMatchObject({
      lifecycleEvents: {
        start_work: { targetState: "Active" },
        reviews_requested: {
          targetState: "Active",
          targetTaskboardColumn: "In Review"
        }
      },
      currentIteration: {
        createDefault: true
      },
      createStateBehavior: {
        mode: "deferred_update_after_create"
      }
    });
  });

  it("builds taskboard column update requests", () => {
    const request = taskboardWorkItemUpdateRequest(
      testConfig,
      "Delivery Team",
      "iteration-13",
      123,
      "In Review"
    );

    expect(request).toEqual({
      method: "PATCH",
      url: expect.stringContaining(
        "Example%20Project/Delivery%20Team/_apis/work/taskboardworkitems/iteration-13/123"
      ),
      headers: {
        "Content-Type": "application/json"
      },
      body: {
        newColumn: "In Review"
      }
    });
  });

  it("previews review lifecycle updates through the sprint taskboard column", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const client = createClient(async (url, init) => {
      calls.push({ url, init });
      if (url.includes("_apis/wit/workitems/123")) {
        return jsonResponse({
          id: 123,
          fields: {
            "System.TeamProject": "Example Project",
            "System.AreaPath": "Example Project\\Delivery Team",
            "System.IterationPath": "Example Project\\Sprint 13",
            "System.WorkItemType": "Task",
            "System.State": "Active"
          }
        });
      }
      if (url.includes("teamsettings/iterations")) {
        return jsonResponse({
          value: [
            {
              id: "iteration-13",
              path: "Example Project\\Sprint 13",
              attributes: { timeFrame: "current" }
            }
          ]
        });
      }
      return jsonResponse({
        columns: [
          {
            name: "Active",
            mappings: [{ workItemType: "Task", state: "Active" }]
          },
          {
            name: "In Review",
            mappings: [{ workItemType: "Task", state: "Active" }]
          }
        ],
        isCustomized: true,
        isValid: true
      });
    });

    const result = await updateWorkItem(client, {
      id: 123,
      lifecycleEvent: "reviews_requested"
    });

    expect(calls.map((call) => call.init.method)).toEqual(["GET", "GET", "GET"]);
    expect(result).toMatchObject({
      applied: false,
      taskboard: {
        team: "Delivery Team",
        iterationPath: "Example Project\\Sprint 13",
        column: "In Review"
      },
      requests: {
        taskboardColumnUpdate: {
          method: "PATCH",
          body: { newColumn: "In Review" }
        }
      }
    });
    expect(JSON.stringify(result)).not.toContain("workItemUpdate");
  });

  it("applies review lifecycle updates after activating new work items", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const client = createClient(async (url, init) => {
      calls.push({ url, init });
      if (url.includes("_apis/wit/workitems/123") && init.method === "GET") {
        return jsonResponse({
          id: 123,
          fields: {
            "System.TeamProject": "Example Project",
            "System.AreaPath": "Example Project\\Delivery Team",
            "System.IterationPath": "Example Project\\Sprint 13",
            "System.WorkItemType": "Task",
            "System.State": "New"
          }
        });
      }
      if (url.includes("teamsettings/iterations")) {
        return jsonResponse({
          value: [
            {
              id: "iteration-13",
              path: "Example Project\\Sprint 13",
              attributes: { timeFrame: "current" }
            }
          ]
        });
      }
      if (url.includes("taskboardcolumns")) {
        return jsonResponse({
          columns: [{ name: "In Review" }],
          isCustomized: true,
          isValid: true
        });
      }
      if (url.includes("_apis/wit/workitems/123") && init.method === "PATCH") {
        return jsonResponse({ id: 123, fields: { "System.State": "Active" } });
      }
      return jsonResponse({
        workItemId: 123,
        state: "Active",
        column: "In Review"
      });
    });

    const result = await updateWorkItem(client, {
      id: 123,
      lifecycleEvent: "reviews_requested",
      apply: true
    });

    expect(result).toMatchObject({
      applied: true,
      taskboard: {
        column: "In Review"
      },
      workItemUpdate: {
        id: 123
      },
      taskboardColumnUpdate: {
        column: "In Review"
      }
    });
    expect(calls.map((call) => call.init.method)).toEqual([
      "GET",
      "GET",
      "GET",
      "PATCH",
      "PATCH"
    ]);
    expect(JSON.parse(String(calls[3]?.init.body))).toContainEqual({
      op: "add",
      path: "/fields/System.State",
      value: "Active"
    });
    expect(JSON.parse(String(calls[4]?.init.body))).toEqual({
      newColumn: "In Review"
    });
  });

  it("builds and reads the current team iteration request", () => {
    const request = currentIterationRequest({
      ...testConfig,
      team: "Delivery Team"
    });

    expect(request.method).toBe("GET");
    expect(request.url).toContain("Example%20Project/Delivery%20Team/_apis/work");
    expect(request.url).toContain("%24timeframe=current");
    expect(
      selectCurrentIterationPath({
        value: [
          {
            path: "Example Project\\Previous",
            attributes: { timeFrame: "past" }
          },
          {
            path: "Example Project\\Sprint 13",
            attributes: { timeFrame: "current" }
          }
        ]
      })
    ).toBe("Example Project\\Sprint 13");
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
