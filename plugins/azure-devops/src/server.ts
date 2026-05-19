import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import { createAuthProvider, AuthProvider } from "./auth.js";
import { AdoClient, FetchLike } from "./client.js";
import { AdoConfig, loadConfig } from "./config.js";
import {
  getSetupStatus,
  writeStoredConfig,
  StoredAdoConfig
} from "./configStore.js";
import { handleTool } from "./format.js";
import { runLocalOAuthLogin } from "./localOAuth.js";
import {
  addWorkItemComment,
  createWorkItem,
  getWorkItem,
  searchWorkItems,
  updateWorkItem
} from "./workItems.js";
import {
  getFile,
  getPullRequest,
  listCommits,
  listItems,
  listPullRequests,
  listRefs,
  listRepositories
} from "./repos.js";

export interface ServerOptions {
  config?: AdoConfig;
  authProvider?: AuthProvider;
  fetchImpl?: FetchLike | undefined;
  createClient?: () => AdoClient;
  includeLocalSetupTools?: boolean;
  setupStatusProvider?: () => Promise<unknown> | unknown;
}

const stringArraySchema = z.array(z.string().min(1)).max(50);
const fieldMapSchema = z.record(z.string().min(1), z.unknown());

const searchWorkItemsSchema = z.object({
  wiql: z.string().optional(),
  query: z.string().optional(),
  workItemTypes: stringArraySchema.optional(),
  states: stringArraySchema.optional(),
  assignedTo: z.string().optional(),
  top: z.number().int().min(1).max(200).optional()
});

const createWorkItemSchema = z.object({
  workItemType: z.string().min(1).default("Task"),
  title: z.string().min(1),
  description: z.string().optional(),
  assignedTo: z.string().optional(),
  tags: stringArraySchema.optional(),
  fields: fieldMapSchema.optional(),
  apply: z.boolean().default(false)
});

const updateWorkItemSchema = z.object({
  id: z.number().int().positive(),
  fields: fieldMapSchema.optional(),
  lifecycleEvent: z
    .enum(["start_work", "reviews_requested", "complete_work"])
    .optional(),
  state: z.string().optional(),
  assignedTo: z.string().optional(),
  tags: stringArraySchema.optional(),
  apply: z.boolean().default(false)
});

const addCommentSchema = z.object({
  id: z.number().int().positive(),
  text: z.string().min(1),
  apply: z.boolean().default(false)
});

const listRepositoriesSchema = z.object({
  includeHidden: z.boolean().default(false)
});

const listRefsSchema = z.object({
  repository: z.string().min(1),
  filter: z.string().optional(),
  top: z.number().int().min(1).max(200).optional()
});

const listCommitsSchema = z.object({
  repository: z.string().min(1),
  branch: z.string().optional(),
  itemPath: z.string().optional(),
  fromDate: z.string().optional(),
  toDate: z.string().optional(),
  top: z.number().int().min(1).max(200).optional()
});

const listItemsSchema = z.object({
  repository: z.string().min(1),
  path: z.string().default("/"),
  recursionLevel: z.enum(["None", "OneLevel", "Full"]).default("OneLevel"),
  version: z.string().optional()
});

const getFileSchema = z.object({
  repository: z.string().min(1),
  path: z.string().min(1),
  version: z.string().optional()
});

const listPullRequestsSchema = z.object({
  repository: z.string().min(1),
  status: z.enum(["active", "abandoned", "completed", "all"]).default("active"),
  sourceBranch: z.string().optional(),
  targetBranch: z.string().optional(),
  top: z.number().int().min(1).max(200).optional()
});

const getPullRequestSchema = z.object({
  repository: z.string().min(1),
  pullRequestId: z.number().int().positive()
});

const configureConnectionSchema = z.object({
  orgUrl: z.string().url(),
  project: z.string().min(1),
  repositories: stringArraySchema.optional(),
  requestTimeoutMs: z.number().int().positive().optional(),
  maxPages: z.number().int().positive().optional()
});

const loginSchema = z.object({
  mode: z.enum(["browser", "device"]).default("browser"),
  deviceAction: z.enum(["start", "complete"]).default("start"),
  timeoutSeconds: z.number().int().min(10).max(600).default(180),
  openBrowser: z.boolean().default(true)
});

export function createAzureDevOpsServer(options: ServerOptions = {}): McpServer {
  const includeLocalSetupTools = options.includeLocalSetupTools ?? false;
  const server = new McpServer(
    {
      name: "azure-devops",
      version: "0.1.0"
    },
    {
      instructions:
        "Use Azure DevOps tools for one configured organization and project. Preview work item writes first and only apply after explicit user approval."
    }
  );

  function createClient(): AdoClient {
    if (options.createClient !== undefined) {
      return options.createClient();
    }
    const config = options.config ?? loadConfig();
    const authProvider = options.authProvider ?? createAuthProvider(config);
    return new AdoClient({
      config,
      authProvider,
      fetchImpl: options.fetchImpl
    });
  }

  server.registerTool(
    "ado_setup_status",
    {
      title: "Azure DevOps Setup Status",
      description:
        "Check whether the Azure DevOps plugin is configured and ready to use.",
      inputSchema: z.object({})
    },
    async () =>
      handleTool(async () =>
        options.setupStatusProvider === undefined
          ? getSetupStatus()
          : await options.setupStatusProvider()
      )
  );

  if (includeLocalSetupTools) {
    server.registerTool(
      "ado_login",
      {
        title: "Sign in to Azure DevOps",
        description:
          "Open Microsoft OAuth in the browser and store delegated Azure DevOps tokens for the local plugin.",
        inputSchema: loginSchema
      },
      async (input) =>
        handleTool(async () => {
          const parsed = loginSchema.parse(input);
          return await runLocalOAuthLogin(parsed);
        })
    );

    server.registerTool(
      "ado_configure_connection",
      {
        title: "Configure Azure DevOps Connection",
        description:
          "Save Azure DevOps organization, project, and optional repository allowlist for local development or admin fallback.",
        inputSchema: configureConnectionSchema
      },
      async (input) =>
        handleTool(async () => {
          const parsed = configureConnectionSchema.parse(input);
          const storedConfig: StoredAdoConfig = {
            orgUrl: parsed.orgUrl,
            project: parsed.project
          };
          if (parsed.repositories !== undefined) {
            storedConfig.repositories = parsed.repositories;
          }
          if (parsed.requestTimeoutMs !== undefined) {
            storedConfig.requestTimeoutMs = parsed.requestTimeoutMs;
          }
          if (parsed.maxPages !== undefined) {
            storedConfig.maxPages = parsed.maxPages;
          }
          const config = writeStoredConfig(storedConfig);
          return {
            summary:
              "Azure DevOps connection saved. Run ado_test_connection to verify live access.",
            config: {
              orgUrl: config.orgUrl,
              project: config.project,
              repositories: config.repositories,
              requestTimeoutMs: config.requestTimeoutMs,
              maxPages: config.maxPages
            },
            status: getSetupStatus()
          };
        })
    );
  }

  server.registerTool(
    "ado_test_connection",
    {
      title: "Test Azure DevOps Connection",
      description:
        "Verify the configured Azure DevOps organization and project by listing repositories.",
      inputSchema: z.object({})
    },
    async () =>
      handleTool(async () => {
        const client = createClient();
        const result = await listRepositories(client, {});
        return {
          summary: "Azure DevOps connection test completed.",
          result
        };
      })
  );

  server.registerTool(
    "ado_search_work_items",
    {
      title: "Search Azure DevOps Work Items",
      description:
        "Search Azure Boards work items with WIQL or simple filters.",
      inputSchema: searchWorkItemsSchema
    },
    async (input) =>
      handleTool(() =>
        searchWorkItems(createClient(), searchWorkItemsSchema.parse(input))
      )
  );

  server.registerTool(
    "ado_get_work_item",
    {
      title: "Get Azure DevOps Work Item",
      description: "Read one Azure Boards work item with fields and relations.",
      inputSchema: z.object({ id: z.number().int().positive() })
    },
    async (input) =>
      handleTool(() =>
        getWorkItem(
          createClient(),
          z.object({ id: z.number().int().positive() }).parse(input).id
        )
      )
  );

  server.registerTool(
    "ado_create_work_item",
    {
      title: "Create Azure DevOps Work Item",
      description:
        "Preview or create an Azure Boards work item. Defaults to preview.",
      inputSchema: createWorkItemSchema
    },
    async (input) =>
      handleTool(() =>
        createWorkItem(createClient(), createWorkItemSchema.parse(input))
      )
  );

  server.registerTool(
    "ado_update_work_item",
    {
      title: "Update Azure DevOps Work Item",
      description:
        "Preview or update fields or lifecycle on an Azure Boards work item. Defaults to preview.",
      inputSchema: updateWorkItemSchema
    },
    async (input) =>
      handleTool(() =>
        updateWorkItem(createClient(), updateWorkItemSchema.parse(input))
      )
  );

  server.registerTool(
    "ado_add_work_item_comment",
    {
      title: "Add Azure DevOps Work Item Comment",
      description:
        "Preview or add a comment to an Azure Boards work item. Defaults to preview.",
      inputSchema: addCommentSchema
    },
    async (input) =>
      handleTool(() =>
        addWorkItemComment(createClient(), addCommentSchema.parse(input))
      )
  );

  server.registerTool(
    "ado_list_repositories",
    {
      title: "List Azure Repos Repositories",
      description: "List repositories in the configured Azure DevOps project.",
      inputSchema: listRepositoriesSchema
    },
    async (input) =>
      handleTool(() =>
        listRepositories(createClient(), listRepositoriesSchema.parse(input))
      )
  );

  server.registerTool(
    "ado_list_refs",
    {
      title: "List Azure Repos Refs",
      description: "List refs in an Azure Repos repository.",
      inputSchema: listRefsSchema
    },
    async (input) =>
      handleTool(() => listRefs(createClient(), listRefsSchema.parse(input)))
  );

  server.registerTool(
    "ado_list_commits",
    {
      title: "List Azure Repos Commits",
      description: "List commits in an Azure Repos repository.",
      inputSchema: listCommitsSchema
    },
    async (input) =>
      handleTool(() => listCommits(createClient(), listCommitsSchema.parse(input)))
  );

  server.registerTool(
    "ado_list_items",
    {
      title: "List Azure Repos Items",
      description: "List files and folders in an Azure Repos repository path.",
      inputSchema: listItemsSchema
    },
    async (input) =>
      handleTool(() => listItems(createClient(), listItemsSchema.parse(input)))
  );

  server.registerTool(
    "ado_get_file",
    {
      title: "Get Azure Repos File",
      description: "Read file content from an Azure Repos repository.",
      inputSchema: getFileSchema
    },
    async (input) =>
      handleTool(() => getFile(createClient(), getFileSchema.parse(input)))
  );

  server.registerTool(
    "ado_list_pull_requests",
    {
      title: "List Azure Repos Pull Requests",
      description: "List pull requests in an Azure Repos repository.",
      inputSchema: listPullRequestsSchema
    },
    async (input) =>
      handleTool(() =>
        listPullRequests(createClient(), listPullRequestsSchema.parse(input))
      )
  );

  server.registerTool(
    "ado_get_pull_request",
    {
      title: "Get Azure Repos Pull Request",
      description: "Read one pull request in an Azure Repos repository.",
      inputSchema: getPullRequestSchema
    },
    async (input) =>
      handleTool(() =>
        getPullRequest(createClient(), getPullRequestSchema.parse(input))
      )
  );

  return server;
}
