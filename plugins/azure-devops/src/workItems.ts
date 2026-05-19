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

interface TeamIteration {
  id?: string;
  name?: string;
  path?: string;
  attributes?: {
    startDate?: string;
    finishDate?: string;
    timeFrame?: string;
  };
}

interface TeamIterationListResponse {
  count?: number;
  value?: TeamIteration[];
}

interface TaskboardColumnMapping {
  workItemType?: string;
  state?: string;
}

interface TaskboardColumn {
  id?: string;
  name?: string;
  order?: number;
  mappings?: TaskboardColumnMapping[];
}

interface TaskboardColumnsResponse {
  columns?: TaskboardColumn[];
  isCustomized?: boolean;
  isValid?: boolean;
  validationMesssage?: string;
}

interface WorkItemLifecycleRule {
  targetState?: string | undefined;
  targetTaskboardColumn?: string | undefined;
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
  state?: string | undefined;
  lifecycleEvent?: WorkItemLifecycleEvent | undefined;
  preferCurrentIteration?: boolean | undefined;
  apply?: boolean | undefined;
}

export interface UpdateWorkItemInput {
  id: number;
  fields?: Record<string, unknown> | undefined;
  state?: string | undefined;
  lifecycleEvent?: WorkItemLifecycleEvent | undefined;
  assignedTo?: string | undefined;
  tags?: string[] | undefined;
  apply?: boolean | undefined;
}

export type WorkItemLifecycleEvent =
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

export const workItemLifecycleRules: Record<
  WorkItemLifecycleEvent,
  WorkItemLifecycleRule
> = {
  start_work: { targetState: "Active" },
  reviews_requested: {
    targetState: "Active",
    targetTaskboardColumn: "In Review"
  },
  complete_work: { targetState: "Closed" }
};

export function getWorkTrackingRules(): unknown {
  return {
    summary: "Azure Boards work tracking rules used by this plugin.",
    lifecycleEvents: workItemLifecycleRules,
    currentIteration: {
      createDefault: true,
      override: "Pass preferCurrentIteration: false or fields.System.IterationPath."
    },
    taskboardColumns: {
      source:
        "reviews_requested uses the Azure DevOps taskboard work item column API, not an unsupported System.State value."
    },
    createStateBehavior: {
      mode: "deferred_update_after_create",
      reason:
        "Some Azure DevOps process templates reject non-default states on create."
    }
  };
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

function configuredTeam(config: AdoConfig): string {
  return config.team ?? config.project;
}

function teamIterationsRequest(
  config: AdoConfig,
  team: string,
  timeframe?: "current" | undefined
): AdoRequest {
  return {
    method: "GET",
    url: makeUrl(
      config.orgUrl,
      [
        config.project,
        team,
        "_apis",
        "work",
        "teamsettings",
        "iterations"
      ],
      {
        "$timeframe": timeframe,
        "api-version": config.apiVersion
      }
    ),
    headers: {}
  };
}

export function currentIterationRequest(config: AdoConfig): AdoRequest {
  return teamIterationsRequest(config, configuredTeam(config), "current");
}

function taskboardColumnsRequest(config: AdoConfig, team: string): AdoRequest {
  return {
    method: "GET",
    url: makeUrl(
      config.orgUrl,
      [config.project, team, "_apis", "work", "taskboardcolumns"],
      {
        "api-version": config.apiVersion
      }
    ),
    headers: {}
  };
}

export function taskboardWorkItemUpdateRequest(
  config: AdoConfig,
  team: string,
  iterationId: string,
  workItemId: number,
  newColumn: string
): AdoRequest {
  return {
    method: "PATCH",
    url: makeUrl(
      config.orgUrl,
      [
        config.project,
        team,
        "_apis",
        "work",
        "taskboardworkitems",
        iterationId,
        String(workItemId)
      ],
      {
        "api-version": config.apiVersion
      }
    ),
    headers: {
      "Content-Type": "application/json"
    },
    body: {
      newColumn
    }
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

function hasOwnField(fields: Record<string, unknown>, field: string): boolean {
  return Object.prototype.hasOwnProperty.call(fields, field);
}

function fieldString(item: WorkItem, field: string): string | undefined {
  const value = item.fields?.[field];
  return typeof value === "string" && value.trim() !== ""
    ? value.trim()
    : undefined;
}

function lastPathSegment(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const segment = value.split("\\").at(-1)?.trim();
  return segment === "" ? undefined : segment;
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (value === undefined || value.trim() === "") {
      continue;
    }
    const trimmed = value.trim();
    if (!seen.has(trimmed)) {
      seen.add(trimmed);
      result.push(trimmed);
    }
  }
  return result;
}

function teamNameCandidates(config: AdoConfig, item?: WorkItem): string[] {
  const areaPath =
    item === undefined ? undefined : fieldString(item, "System.AreaPath");
  return uniqueStrings([
    config.team,
    lastPathSegment(areaPath),
    config.project
  ]);
}

function lifecycleRule(
  lifecycleEvent: WorkItemLifecycleEvent | undefined
): WorkItemLifecycleRule | undefined {
  if (lifecycleEvent === undefined) {
    return undefined;
  }
  return workItemLifecycleRules[lifecycleEvent];
}

function lifecycleTargetState(
  lifecycleEvent: WorkItemLifecycleEvent | undefined
): string | undefined {
  return lifecycleRule(lifecycleEvent)?.targetState;
}

function lifecycleTaskboardColumn(
  lifecycleEvent: WorkItemLifecycleEvent | undefined
): string | undefined {
  return lifecycleRule(lifecycleEvent)?.targetTaskboardColumn;
}

function requestedCreateState(input: CreateWorkItemInput): string | undefined {
  const lifecycleState = lifecycleTargetState(input.lifecycleEvent);
  if (lifecycleState !== undefined) {
    return lifecycleState;
  }
  if (input.state !== undefined) {
    return input.state;
  }
  const fieldState = input.fields?.["System.State"];
  return typeof fieldState === "string" ? fieldState : undefined;
}

function requestedCreateTaskboardColumn(
  input: CreateWorkItemInput
): string | undefined {
  return lifecycleTaskboardColumn(input.lifecycleEvent);
}

function workItemIdFromResponse(data: unknown): number | undefined {
  if (typeof data !== "object" || data === null) {
    return undefined;
  }
  const id = (data as { id?: unknown }).id;
  return typeof id === "number" && Number.isInteger(id) && id > 0
    ? id
    : undefined;
}

export function buildCreateWorkItemPatch(
  input: CreateWorkItemInput,
  options: { iterationPath?: string | undefined } = {}
): JsonPatchOperation[] {
  const patch: JsonPatchOperation[] = [];
  const fields = input.fields ?? {};

  for (const [field, value] of Object.entries(fields)) {
    if (field === "System.State") {
      continue;
    }
    addFieldOperation(patch, field, value);
  }

  if (
    options.iterationPath !== undefined &&
    !hasOwnField(fields, "System.IterationPath")
  ) {
    addFieldOperation(patch, "System.IterationPath", options.iterationPath);
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
  if (input.lifecycleEvent !== undefined && input.state !== undefined) {
    throw new AdoError("Use either lifecycleEvent or state, not both.", {
      kind: "validation"
    });
  }

  const fieldState = fields["System.State"];
  const state =
    lifecycleTargetState(input.lifecycleEvent) ??
    input.state ??
    (typeof fieldState === "string" ? fieldState : undefined);

  for (const [field, value] of Object.entries(fields)) {
    if (field === "System.State" && state !== undefined) {
      continue;
    }
    addFieldOperation(patch, field, value);
  }

  addOptionalFieldOperation(patch, "System.State", state);
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
  input: CreateWorkItemInput,
  options: { iterationPath?: string | undefined } = {}
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
    body: buildCreateWorkItemPatch(input, options)
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
  await getWorkItemInConfiguredProject(client, id);
}

async function getWorkItemInConfiguredProject(
  client: AdoClient,
  id: number
): Promise<WorkItem> {
  const response = await client.send<WorkItem>(
    getWorkItemRequest(client.config, id)
  );
  assertWorkItemProject(client.config, response.data);
  return response.data;
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

export function selectCurrentIterationPath(
  response: TeamIterationListResponse
): string | undefined {
  return selectCurrentIteration(response)?.path;
}

function selectCurrentIteration(
  response: TeamIterationListResponse
): TeamIteration | undefined {
  const iterations = response.value ?? [];
  return (
    iterations.find(
      (iteration) => iteration.attributes?.timeFrame?.toLowerCase() === "current"
    ) ?? iterations[0]
  );
}

function selectIterationForPath(
  response: TeamIterationListResponse,
  iterationPath: string | undefined
): TeamIteration | undefined {
  const iterations = response.value ?? [];
  if (iterationPath !== undefined) {
    const match = iterations.find(
      (iteration) =>
        iteration.path?.toLowerCase() === iterationPath.toLowerCase()
    );
    if (match !== undefined) {
      return match;
    }
  }
  return selectCurrentIteration(response);
}

async function resolveCurrentIterationPath(
  client: AdoClient,
  input: CreateWorkItemInput
): Promise<{
  team?: string | undefined;
  iterationId?: string | undefined;
  iterationPath?: string | undefined;
  warning?: string | undefined;
}> {
  if (input.preferCurrentIteration === false) {
    return {};
  }
  if (hasOwnField(input.fields ?? {}, "System.IterationPath")) {
    return {};
  }

  try {
    const team = configuredTeam(client.config);
    const response = await client.send<TeamIterationListResponse>(
      teamIterationsRequest(client.config, team, "current")
    );
    const iteration = selectCurrentIteration(response.data);
    if (iteration?.path === undefined) {
      return {
        warning:
          "No current Azure Boards iteration was returned; creating work item without System.IterationPath."
      };
    }
    return {
      team,
      iterationId: iteration.id,
      iterationPath: iteration.path
    };
  } catch (error) {
    return {
      warning:
        error instanceof Error
          ? `Could not resolve current Azure Boards iteration; creating work item without System.IterationPath. ${error.message}`
          : "Could not resolve current Azure Boards iteration; creating work item without System.IterationPath."
    };
  }
}

async function resolveTaskboardColumnUpdate(
  client: AdoClient,
  item: WorkItem,
  targetColumn: string
): Promise<{
  team: string;
  iterationId: string;
  iterationPath?: string | undefined;
  request: AdoRequest;
}> {
  const iterationPath = fieldString(item, "System.IterationPath");
  const workItemType = fieldString(item, "System.WorkItemType");
  const failures: string[] = [];

  for (const team of teamNameCandidates(client.config, item)) {
    try {
      const iterations = await client.send<TeamIterationListResponse>(
        teamIterationsRequest(client.config, team)
      );
      const iteration = selectIterationForPath(iterations.data, iterationPath);
      if (iteration?.id === undefined) {
        failures.push(`${team}: no matching team iteration was returned`);
        continue;
      }

      const columns = await client.send<TaskboardColumnsResponse>(
        taskboardColumnsRequest(client.config, team)
      );
      const columnNames = (columns.data.columns ?? [])
        .map((column) => column.name)
        .filter((name): name is string => name !== undefined);
      const column = columnNames.find(
        (name) => name.toLowerCase() === targetColumn.toLowerCase()
      );
      if (column === undefined) {
        failures.push(
          `${team}: taskboard column '${targetColumn}' was not found. Available columns: ${columnNames.join(", ")}`
        );
        continue;
      }

      return {
        team,
        iterationId: iteration.id,
        iterationPath: iteration.path,
        request: taskboardWorkItemUpdateRequest(
          client.config,
          team,
          iteration.id,
          item.id,
          column
        )
      };
    } catch (error) {
      failures.push(
        error instanceof Error ? `${team}: ${error.message}` : `${team}: failed`
      );
    }
  }

  throw new AdoError(
    `Could not resolve Azure Boards taskboard column '${targetColumn}' for work item ${item.id}.`,
    {
      kind: "validation",
      details: {
        workItemId: item.id,
        workItemType,
        iterationPath,
        attemptedTeams: teamNameCandidates(client.config, item),
        failures
      }
    }
  );
}

function updateInputForCurrentItem(
  input: UpdateWorkItemInput,
  item: WorkItem
): UpdateWorkItemInput {
  const fields = { ...(input.fields ?? {}) };
  const targetState =
    lifecycleTargetState(input.lifecycleEvent) ??
    input.state ??
    (typeof fields["System.State"] === "string"
      ? fields["System.State"]
      : undefined);
  if (targetState !== undefined && targetState === fieldString(item, "System.State")) {
    delete fields["System.State"];
  }

  const update: UpdateWorkItemInput = {
    id: input.id,
    assignedTo: input.assignedTo,
    tags: input.tags
  };
  if (Object.keys(fields).length > 0) {
    update.fields = fields;
  }
  if (
    targetState !== undefined &&
    targetState !== fieldString(item, "System.State")
  ) {
    update.state = targetState;
  }
  return update;
}

function hasWorkItemUpdate(input: UpdateWorkItemInput): boolean {
  return (
    input.fields !== undefined ||
    input.state !== undefined ||
    input.assignedTo !== undefined ||
    input.tags !== undefined
  );
}

async function updateWorkItemWithTaskboardColumn(
  client: AdoClient,
  input: UpdateWorkItemInput,
  targetColumn: string
): Promise<unknown> {
  const item = await getWorkItemInConfiguredProject(client, input.id);
  const workItemUpdate = updateInputForCurrentItem(input, item);
  const workItemRequest = hasWorkItemUpdate(workItemUpdate)
    ? updateWorkItemRequest(client.config, workItemUpdate)
    : undefined;
  const taskboardUpdate = await resolveTaskboardColumnUpdate(
    client,
    item,
    targetColumn
  );

  if (input.apply !== true) {
    const requests: Record<string, unknown> = {
      taskboardColumnUpdate: previewRequest(taskboardUpdate.request)
    };
    if (workItemRequest !== undefined) {
      requests.workItemUpdate = previewRequest(workItemRequest);
    }
    return {
      applied: false,
      summary: `Preview lifecycle update for work item ${input.id}.`,
      taskboard: {
        team: taskboardUpdate.team,
        iterationPath: taskboardUpdate.iterationPath,
        column: targetColumn
      },
      requests
    };
  }

  const result: Record<string, unknown> = {
    applied: true,
    summary: `Updated work item ${input.id}.`,
    taskboard: {
      team: taskboardUpdate.team,
      iterationPath: taskboardUpdate.iterationPath,
      column: targetColumn
    }
  };
  if (workItemRequest !== undefined) {
    const workItemResponse = await client.send<unknown>(workItemRequest);
    result.workItemUpdate = workItemResponse.data;
  }
  const taskboardResponse = await client.send<unknown>(taskboardUpdate.request);
  result.taskboardColumnUpdate = taskboardResponse.data;
  return result;
}

export async function createWorkItem(
  client: AdoClient,
  input: CreateWorkItemInput
): Promise<unknown> {
  const currentIteration = await resolveCurrentIterationPath(client, input);
  const createRequest = createWorkItemRequest(client.config, input, {
    iterationPath: currentIteration.iterationPath
  });
  const deferredState = requestedCreateState(input);
  const deferredTaskboardColumn = requestedCreateTaskboardColumn(input);

  if (input.apply !== true) {
    const preview: Record<string, unknown> = {
      applied: false,
      summary: `Preview create ${input.workItemType} work item.`,
      request: previewRequest(createRequest)
    };
    if (currentIteration.warning !== undefined) {
      preview.warning = currentIteration.warning;
    }
    if (deferredState !== undefined) {
      preview.deferredStateUpdate = {
        state: deferredState,
        reason:
          "Azure DevOps rejects some initial states on create; the plugin applies this state after the work item exists."
      };
    }
    if (deferredTaskboardColumn !== undefined) {
      preview.deferredTaskboardColumnUpdate = {
        column: deferredTaskboardColumn,
        team: currentIteration.team,
        iterationPath: currentIteration.iterationPath,
        reason:
          "Sprint taskboard columns are updated after the work item exists."
      };
    }
    return preview;
  }

  const created = await client.send<unknown>(createRequest);
  const result: Record<string, unknown> = {
    applied: true,
    summary: `Created ${input.workItemType} work item.`,
    response: created.data
  };
  if (currentIteration.warning !== undefined) {
    result.warning = currentIteration.warning;
  }

  if (deferredState !== undefined) {
    const id = workItemIdFromResponse(created.data);
    if (id === undefined) {
      throw new AdoError(
        "Azure DevOps create response did not include a work item id for the deferred state update.",
        { kind: "validation" }
      );
    }
    const stateRequest = updateWorkItemRequest(client.config, {
      id,
      state: deferredState
    });
    const stateResponse = await client.send<unknown>(stateRequest);
    result.deferredStateUpdate = {
      state: deferredState,
      response: stateResponse.data
    };
  }

  if (deferredTaskboardColumn !== undefined) {
    const id = workItemIdFromResponse(created.data);
    if (id === undefined) {
      throw new AdoError(
        "Azure DevOps create response did not include a work item id for the deferred taskboard column update.",
        { kind: "validation" }
      );
    }
    if (
      currentIteration.team === undefined ||
      currentIteration.iterationId === undefined
    ) {
      throw new AdoError(
        "Azure DevOps current iteration could not be resolved for the deferred taskboard column update.",
        { kind: "validation" }
      );
    }
    const taskboardRequest = taskboardWorkItemUpdateRequest(
      client.config,
      currentIteration.team,
      currentIteration.iterationId,
      id,
      deferredTaskboardColumn
    );
    const taskboardResponse = await client.send<unknown>(taskboardRequest);
    result.deferredTaskboardColumnUpdate = {
      column: deferredTaskboardColumn,
      response: taskboardResponse.data
    };
  }

  return result;
}

export async function updateWorkItem(
  client: AdoClient,
  input: UpdateWorkItemInput
): Promise<unknown> {
  const targetColumn = lifecycleTaskboardColumn(input.lifecycleEvent);
  if (targetColumn !== undefined) {
    return updateWorkItemWithTaskboardColumn(client, input, targetColumn);
  }

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
