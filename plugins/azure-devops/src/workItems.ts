import { AdoClient } from "./client.js";
import { AdoConfig } from "./config.js";
import { AdoError } from "./errors.js";
import {
  AdoRequest,
  jsonPatchContentType,
  makeUrl,
  previewRequest
} from "./request.js";

export interface WorkItem {
  id: number;
  rev?: number;
  url?: string;
  fields?: Record<string, unknown>;
  relations?: unknown[];
}

interface WiqlResponse {
  workItems?: Array<{ id: number; url: string }>;
}

interface WorkItemListResponse {
  count?: number;
  value?: WorkItem[];
}

export interface SearchWorkItemsInput {
  wiql?: string | undefined;
  query?: string | undefined;
  workItemTypes?: string[] | undefined;
  states?: string[] | undefined;
  assignedTo?: string | undefined;
  top?: number | undefined;
}

export interface CreateWorkItemInput {
  workItemType: string;
  title: string;
  description?: string | undefined;
  assignedTo?: string | undefined;
  tags?: string[] | undefined;
  fields?: Record<string, unknown> | undefined;
  apply?: boolean | undefined;
}

export interface UpdateWorkItemInput {
  id: number;
  fields?: Record<string, unknown> | undefined;
  lifecycleEvent?: LifecycleEvent | undefined;
  state?: string | undefined;
  assignedTo?: string | undefined;
  tags?: string[] | undefined;
  apply?: boolean | undefined;
}

export type LifecycleEvent =
  | "start_work"
  | "reviews_requested"
  | "complete_work";

export interface AddCommentInput {
  id: number;
  text: string;
  apply?: boolean | undefined;
}

export interface JsonPatchOperation {
  op: "add" | "replace";
  path: string;
  value: unknown;
}

const defaultWorkItemFields = [
  "System.Id",
  "System.WorkItemType",
  "System.TeamProject",
  "System.Title",
  "System.State",
  "System.AssignedTo",
  "System.Tags",
  "System.ChangedDate"
];

export function workItemWebUrl(config: AdoConfig, id: number): string {
  return `${config.orgUrl}/${encodeURIComponent(config.project)}/_workitems/edit/${id}`;
}

export function escapeWiqlLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

function wiqlStringList(values: string[]): string {
  return values.map((value) => `'${escapeWiqlLiteral(value)}'`).join(", ");
}

function wiqlIdentity(value: string): string {
  const trimmed = value.trim();
  if (trimmed.toLowerCase() === "@me") {
    return "@Me";
  }
  return `'${escapeWiqlLiteral(trimmed)}'`;
}

export function buildWiql(input: SearchWorkItemsInput): string {
  if (input.wiql !== undefined && input.wiql.trim() !== "") {
    return input.wiql.trim();
  }

  const clauses = ["[System.TeamProject] = @project"];

  if (input.query !== undefined && input.query.trim() !== "") {
    clauses.push(
      `[System.Title] Contains '${escapeWiqlLiteral(input.query.trim())}'`
    );
  }

  if (input.workItemTypes !== undefined && input.workItemTypes.length > 0) {
    clauses.push(`[System.WorkItemType] In (${wiqlStringList(input.workItemTypes)})`);
  }

  if (input.states !== undefined && input.states.length > 0) {
    clauses.push(`[System.State] In (${wiqlStringList(input.states)})`);
  }

  if (input.assignedTo !== undefined && input.assignedTo.trim() !== "") {
    clauses.push(`[System.AssignedTo] = ${wiqlIdentity(input.assignedTo)}`);
  }

  return [
    `SELECT ${defaultWorkItemFields.map((field) => `[${field}]`).join(", ")}`,
    "FROM WorkItems",
    `WHERE ${clauses.join(" AND ")}`,
    "ORDER BY [System.ChangedDate] DESC"
  ].join(" ");
}

export function assertRawWiqlProjectBoundary(
  config: AdoConfig,
  wiql: string
): void {
  const projectPredicate =
    /\[\s*System\.TeamProject\s*\]\s*=\s*(?:(@project)|'((?:[^']|'')*)')/i.exec(
      wiql
    );
  if (projectPredicate?.[1] !== undefined) {
    return;
  }

  const literalProject = projectPredicate?.[2]?.replace(/''/g, "'");
  if (literalProject === config.project) {
    return;
  }

  throw new AdoError(
    "Raw WIQL must include a System.TeamProject predicate for the configured project.",
    {
      kind: "authorization",
      details: {
        configuredProject: config.project,
        expected:
          "[System.TeamProject] = @project or [System.TeamProject] = '<configured project>'"
      }
    }
  );
}

export function clampTop(value: number | undefined, defaultValue = 20): number {
  if (value === undefined) {
    return defaultValue;
  }
  return Math.max(1, Math.min(200, value));
}

function wiqlRequest(config: AdoConfig, wiql: string): AdoRequest {
  return {
    method: "POST",
    url: makeUrl(config.orgUrl, [config.project, "_apis", "wit", "wiql"], {
      "api-version": config.apiVersion
    }),
    headers: {
      "Content-Type": "application/json"
    },
    body: {
      query: wiql
    }
  };
}

function getWorkItemsRequest(config: AdoConfig, ids: number[]): AdoRequest {
  return {
    method: "GET",
    url: makeUrl(config.orgUrl, [config.project, "_apis", "wit", "workitems"], {
      ids: ids.join(","),
      "$expand": "relations",
      "api-version": config.apiVersion
    }),
    headers: {}
  };
}

export function getWorkItemRequest(config: AdoConfig, id: number): AdoRequest {
  return {
    method: "GET",
    url: makeUrl(
      config.orgUrl,
      [config.project, "_apis", "wit", "workitems", String(id)],
      {
        "$expand": "relations",
        "api-version": config.apiVersion
      }
    ),
    headers: {}
  };
}

function assertFieldReferenceName(field: string): void {
  const valid = /^[A-Za-z][A-Za-z0-9]*(\.[A-Za-z][A-Za-z0-9]*)+$/.test(field);
  if (!valid) {
    throw new AdoError(
      `Unsupported Azure DevOps field reference name: ${field}`,
      {
        kind: "unsupported_field",
        details: {
          field,
          expected: "Reference names such as System.Title or Custom.Risk"
        }
      }
    );
  }
}

function addFieldOperation(
  patch: JsonPatchOperation[],
  field: string,
  value: unknown
): void {
  assertFieldReferenceName(field);
  patch.push({
    op: "add",
    path: `/fields/${field}`,
    value
  });
}

function addOptionalFieldOperation(
  patch: JsonPatchOperation[],
  field: string,
  value: unknown
): void {
  if (value !== undefined) {
    addFieldOperation(patch, field, value);
  }
}

export function lifecycleState(event: LifecycleEvent): string {
  switch (event) {
    case "start_work":
    case "reviews_requested":
      return "Active";
    case "complete_work":
      return "Closed";
  }
}

export function buildCreateWorkItemPatch(
  input: CreateWorkItemInput
): JsonPatchOperation[] {
  const patch: JsonPatchOperation[] = [];
  const fields = input.fields ?? {};

  for (const [field, value] of Object.entries(fields)) {
    addFieldOperation(patch, field, value);
  }

  addFieldOperation(patch, "System.Title", input.title);
  addOptionalFieldOperation(patch, "System.Description", input.description);
  addOptionalFieldOperation(patch, "System.AssignedTo", input.assignedTo);
  if (input.tags !== undefined && input.tags.length > 0) {
    addFieldOperation(patch, "System.Tags", input.tags.join("; "));
  }

  return patch;
}

export function buildUpdateWorkItemPatch(
  input: UpdateWorkItemInput
): JsonPatchOperation[] {
  const patch: JsonPatchOperation[] = [];
  const fields = input.fields ?? {};

  for (const [field, value] of Object.entries(fields)) {
    addFieldOperation(patch, field, value);
  }

  if (input.lifecycleEvent !== undefined && input.state !== undefined) {
    throw new AdoError("Use either lifecycleEvent or state, not both.", {
      kind: "validation"
    });
  }

  addOptionalFieldOperation(
    patch,
    "System.State",
    input.lifecycleEvent === undefined
      ? input.state
      : lifecycleState(input.lifecycleEvent)
  );
  addOptionalFieldOperation(patch, "System.AssignedTo", input.assignedTo);
  if (input.tags !== undefined) {
    addFieldOperation(patch, "System.Tags", input.tags.join("; "));
  }

  if (patch.length === 0) {
    throw new AdoError("At least one work item field update is required.", {
      kind: "validation"
    });
  }

  return patch;
}

export function createWorkItemRequest(
  config: AdoConfig,
  input: CreateWorkItemInput
): AdoRequest {
  if (input.workItemType.trim() === "") {
    throw new AdoError("workItemType is required.", { kind: "validation" });
  }
  if (input.title.trim() === "") {
    throw new AdoError("title is required.", { kind: "validation" });
  }

  return {
    method: "POST",
    url: makeUrl(
      config.orgUrl,
      [config.project, "_apis", "wit", "workitems", `$${input.workItemType}`],
      {
        "api-version": config.apiVersion
      }
    ),
    headers: {
      "Content-Type": jsonPatchContentType
    },
    body: buildCreateWorkItemPatch(input)
  };
}

export function updateWorkItemRequest(
  config: AdoConfig,
  input: UpdateWorkItemInput
): AdoRequest {
  return {
    method: "PATCH",
    url: makeUrl(
      config.orgUrl,
      [config.project, "_apis", "wit", "workitems", String(input.id)],
      {
        "api-version": config.apiVersion
      }
    ),
    headers: {
      "Content-Type": jsonPatchContentType
    },
    body: buildUpdateWorkItemPatch(input)
  };
}

export function addWorkItemCommentRequest(
  config: AdoConfig,
  input: AddCommentInput
): AdoRequest {
  if (input.text.trim() === "") {
    throw new AdoError("Comment text is required.", { kind: "validation" });
  }

  return {
    method: "POST",
    url: makeUrl(
      config.orgUrl,
      [config.project, "_apis", "wit", "workItems", String(input.id), "comments"],
      {
        "api-version": "7.1-preview.4"
      }
    ),
    headers: {
      "Content-Type": "application/json"
    },
    body: {
      text: input.text
    }
  };
}

export function summarizeWorkItem(config: AdoConfig, item: WorkItem): unknown {
  const fields = item.fields ?? {};
  return {
    id: item.id,
    url: workItemWebUrl(config, item.id),
    type: fields["System.WorkItemType"],
    project: fields["System.TeamProject"],
    title: fields["System.Title"],
    state: fields["System.State"],
    assignedTo: fields["System.AssignedTo"],
    tags: fields["System.Tags"],
    changedDate: fields["System.ChangedDate"]
  };
}

function assertWorkItemProject(config: AdoConfig, item: WorkItem): void {
  const actualProject = item.fields?.["System.TeamProject"];
  if (actualProject === config.project) {
    return;
  }

  throw new AdoError(
    `Work item ${item.id} is outside the configured Azure DevOps project.`,
    {
      kind: "authorization",
      details: {
        workItemId: item.id,
        configuredProject: config.project,
        actualProject
      }
    }
  );
}

async function assertWorkItemIdInConfiguredProject(
  client: AdoClient,
  id: number
): Promise<void> {
  const response = await client.send<WorkItem>(
    getWorkItemRequest(client.config, id)
  );
  assertWorkItemProject(client.config, response.data);
}

export async function searchWorkItems(
  client: AdoClient,
  input: SearchWorkItemsInput
): Promise<unknown> {
  const wiql = buildWiql(input);
  if (input.wiql !== undefined && input.wiql.trim() !== "") {
    assertRawWiqlProjectBoundary(client.config, wiql);
  }
  const wiqlResponse = await client.send<WiqlResponse>(
    wiqlRequest(client.config, wiql)
  );
  const ids = (wiqlResponse.data.workItems ?? [])
    .map((item) => item.id)
    .slice(0, clampTop(input.top));

  if (ids.length === 0) {
    return {
      summary: "No work items matched.",
      wiql,
      count: 0,
      workItems: []
    };
  }

  const details = await client.send<WorkItemListResponse>(
    getWorkItemsRequest(client.config, ids)
  );
  const detailedItems = details.data.value ?? [];
  for (const item of detailedItems) {
    assertWorkItemProject(client.config, item);
  }
  const workItems = detailedItems.map((item) =>
    summarizeWorkItem(client.config, item)
  );

  return {
    summary: `Found ${workItems.length} work item(s).`,
    wiql,
    count: workItems.length,
    workItems
  };
}

export async function getWorkItem(
  client: AdoClient,
  id: number
): Promise<unknown> {
  const response = await client.send<WorkItem>(
    getWorkItemRequest(client.config, id)
  );
  assertWorkItemProject(client.config, response.data);
  return {
    summary: `Read work item ${id}.`,
    workItem: response.data,
    url: workItemWebUrl(client.config, id)
  };
}

async function previewOrApply(
  client: AdoClient,
  request: AdoRequest,
  apply: boolean | undefined,
  previewSummary: string,
  appliedSummary: string,
  beforeApply?: (() => Promise<void>) | undefined
): Promise<unknown> {
  if (apply !== true) {
    return {
      applied: false,
      summary: previewSummary,
      request: previewRequest(request)
    };
  }

  if (beforeApply !== undefined) {
    await beforeApply();
  }
  const response = await client.send<unknown>(request);
  return {
    applied: true,
    summary: appliedSummary,
    response: response.data
  };
}

export async function createWorkItem(
  client: AdoClient,
  input: CreateWorkItemInput
): Promise<unknown> {
  const request = createWorkItemRequest(client.config, input);
  return previewOrApply(
    client,
    request,
    input.apply,
    `Preview create ${input.workItemType} work item.`,
    `Created ${input.workItemType} work item.`
  );
}

export async function updateWorkItem(
  client: AdoClient,
  input: UpdateWorkItemInput
): Promise<unknown> {
  const request = updateWorkItemRequest(client.config, input);
  return previewOrApply(
    client,
    request,
    input.apply,
    `Preview update for work item ${input.id}.`,
    `Updated work item ${input.id}.`,
    () => assertWorkItemIdInConfiguredProject(client, input.id)
  );
}

export async function addWorkItemComment(
  client: AdoClient,
  input: AddCommentInput
): Promise<unknown> {
  const request = addWorkItemCommentRequest(client.config, input);
  return previewOrApply(
    client,
    request,
    input.apply,
    `Preview comment for work item ${input.id}.`,
    `Added comment to work item ${input.id}.`,
    () => assertWorkItemIdInConfiguredProject(client, input.id)
  );
}
