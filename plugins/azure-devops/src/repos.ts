import { collectPagedValues, AdoClient } from "./client.js";
import { AdoConfig } from "./config.js";
import { AdoError } from "./errors.js";
import { AdoRequest, makeUrl } from "./request.js";

export interface Repository {
  id: string;
  name: string;
  webUrl?: string | undefined;
  remoteUrl?: string | undefined;
  project?: {
    id?: string | undefined;
    name?: string | undefined;
  } | undefined;
}

export interface GitRef {
  name: string;
  objectId: string;
  url?: string | undefined;
}

export interface GitCommit {
  commitId: string;
  comment?: string | undefined;
  author?: {
    name?: string | undefined;
    email?: string | undefined;
    date?: string | undefined;
  } | undefined;
  committer?: {
    name?: string | undefined;
    email?: string | undefined;
    date?: string | undefined;
  } | undefined;
  url?: string | undefined;
  remoteUrl?: string | undefined;
}

export interface PullRequest {
  pullRequestId: number;
  title: string;
  status: string;
  sourceRefName?: string | undefined;
  targetRefName?: string | undefined;
  createdBy?: {
    displayName?: string | undefined;
    uniqueName?: string | undefined;
  } | undefined;
  creationDate?: string | undefined;
  url?: string | undefined;
}

export interface GitItem {
  objectId?: string | undefined;
  gitObjectType?: string | undefined;
  commitId?: string | undefined;
  path?: string | undefined;
  isFolder?: boolean | undefined;
  content?: string | undefined;
  url?: string | undefined;
}

export interface ListRepositoriesInput {
  includeHidden?: boolean | undefined;
}

export interface ListRefsInput {
  repository: string;
  filter?: string | undefined;
  top?: number | undefined;
}

export interface ListCommitsInput {
  repository: string;
  branch?: string | undefined;
  itemPath?: string | undefined;
  fromDate?: string | undefined;
  toDate?: string | undefined;
  top?: number | undefined;
}

export interface ListItemsInput {
  repository: string;
  path?: string | undefined;
  recursionLevel?: "None" | "OneLevel" | "Full" | undefined;
  version?: string | undefined;
}

export interface GetFileInput {
  repository: string;
  path: string;
  version?: string | undefined;
}

export interface ListPullRequestsInput {
  repository: string;
  status?: "active" | "abandoned" | "completed" | "all" | undefined;
  sourceBranch?: string | undefined;
  targetBranch?: string | undefined;
  top?: number | undefined;
}

export interface GetPullRequestInput {
  repository: string;
  pullRequestId: number;
}

function repoApiUrl(
  config: AdoConfig,
  repository: string | undefined,
  tail: string[],
  params: Record<string, string | number | boolean | undefined> = {}
): string {
  const segments = [config.project, "_apis", "git", "repositories"];
  if (repository !== undefined) {
    segments.push(repository);
  }
  segments.push(...tail);
  return makeUrl(config.orgUrl, segments, {
    ...params,
    "api-version": config.apiVersion
  });
}

function assertRepositoryAllowed(config: AdoConfig, repository: string): void {
  if (
    config.repositories !== undefined &&
    !config.repositories.includes(repository)
  ) {
    throw new AdoError(`Repository ${repository} is not in ADO_REPOSITORIES.`, {
      kind: "authorization",
      details: {
        repository,
        allowlist: config.repositories
      }
    });
  }
}

function top(value: number | undefined, defaultValue = 50): number {
  if (value === undefined) {
    return defaultValue;
  }
  return Math.max(1, Math.min(200, value));
}

function normalizeBranchRef(value: string | undefined): string | undefined {
  if (value === undefined || value.trim() === "") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.startsWith("refs/") ? trimmed : `refs/heads/${trimmed}`;
}

export function repositoryWebUrl(config: AdoConfig, repository: string): string {
  return `${config.orgUrl}/${encodeURIComponent(config.project)}/_git/${encodeURIComponent(repository)}`;
}

export function commitWebUrl(
  config: AdoConfig,
  repository: string,
  commitId: string
): string {
  return `${repositoryWebUrl(config, repository)}/commit/${commitId}`;
}

export function fileWebUrl(
  config: AdoConfig,
  repository: string,
  path: string,
  version: string | undefined
): string {
  const url = new URL(repositoryWebUrl(config, repository));
  url.searchParams.set("path", path);
  if (version !== undefined && version.trim() !== "") {
    url.searchParams.set("version", `GB${version}`);
  }
  return url.toString();
}

export function pullRequestWebUrl(
  config: AdoConfig,
  repository: string,
  pullRequestId: number
): string {
  return `${repositoryWebUrl(config, repository)}/pullrequest/${pullRequestId}`;
}

function listRepositoriesRequest(config: AdoConfig): AdoRequest {
  return {
    method: "GET",
    url: repoApiUrl(config, undefined, []),
    headers: {}
  };
}

function listRefsRequest(config: AdoConfig, input: ListRefsInput): AdoRequest {
  assertRepositoryAllowed(config, input.repository);
  return {
    method: "GET",
    url: repoApiUrl(config, input.repository, ["refs"], {
      filter: input.filter ?? "heads/",
      "$top": top(input.top)
    }),
    headers: {}
  };
}

function listCommitsRequest(
  config: AdoConfig,
  input: ListCommitsInput
): AdoRequest {
  assertRepositoryAllowed(config, input.repository);
  return {
    method: "GET",
    url: repoApiUrl(config, input.repository, ["commits"], {
      "searchCriteria.itemVersion.version": input.branch,
      "searchCriteria.itemPath": input.itemPath,
      "searchCriteria.fromDate": input.fromDate,
      "searchCriteria.toDate": input.toDate,
      "$top": top(input.top)
    }),
    headers: {}
  };
}

function listItemsRequest(config: AdoConfig, input: ListItemsInput): AdoRequest {
  assertRepositoryAllowed(config, input.repository);
  return {
    method: "GET",
    url: repoApiUrl(config, input.repository, ["items"], {
      scopePath: input.path ?? "/",
      recursionLevel: input.recursionLevel ?? "OneLevel",
      includeContentMetadata: true,
      "versionDescriptor.version": input.version
    }),
    headers: {}
  };
}

function getFileRequest(config: AdoConfig, input: GetFileInput): AdoRequest {
  assertRepositoryAllowed(config, input.repository);
  return {
    method: "GET",
    url: repoApiUrl(config, input.repository, ["items"], {
      path: input.path,
      includeContent: true,
      includeContentMetadata: true,
      "versionDescriptor.version": input.version
    }),
    headers: {}
  };
}

function listPullRequestsRequest(
  config: AdoConfig,
  input: ListPullRequestsInput
): AdoRequest {
  assertRepositoryAllowed(config, input.repository);
  return {
    method: "GET",
    url: repoApiUrl(config, input.repository, ["pullrequests"], {
      "searchCriteria.status": input.status ?? "active",
      "searchCriteria.sourceRefName": normalizeBranchRef(input.sourceBranch),
      "searchCriteria.targetRefName": normalizeBranchRef(input.targetBranch),
      "$top": top(input.top)
    }),
    headers: {}
  };
}

function getPullRequestRequest(
  config: AdoConfig,
  input: GetPullRequestInput
): AdoRequest {
  assertRepositoryAllowed(config, input.repository);
  return {
    method: "GET",
    url: repoApiUrl(config, input.repository, [
      "pullrequests",
      String(input.pullRequestId)
    ]),
    headers: {}
  };
}

export async function listRepositories(
  client: AdoClient,
  input: ListRepositoriesInput
): Promise<unknown> {
  const repositories = await collectPagedValues<Repository>(
    client,
    listRepositoriesRequest(client.config)
  );
  const filtered = repositories.filter((repository) => {
    if (input.includeHidden !== true && repository.name.startsWith(".")) {
      return false;
    }
    return (
      client.config.repositories === undefined ||
      client.config.repositories.includes(repository.name)
    );
  });

  return {
    summary: `Found ${filtered.length} repository/repositories.`,
    repositories: filtered.map((repository) => ({
      id: repository.id,
      name: repository.name,
      url: repository.webUrl ?? repositoryWebUrl(client.config, repository.name),
      remoteUrl: repository.remoteUrl,
      project: repository.project?.name
    }))
  };
}

export async function listRefs(
  client: AdoClient,
  input: ListRefsInput
): Promise<unknown> {
  const refs = await collectPagedValues<GitRef>(
    client,
    listRefsRequest(client.config, input)
  );
  return {
    summary: `Found ${refs.length} ref(s) in ${input.repository}.`,
    refs
  };
}

export async function listCommits(
  client: AdoClient,
  input: ListCommitsInput
): Promise<unknown> {
  const commits = await collectPagedValues<GitCommit>(
    client,
    listCommitsRequest(client.config, input)
  );
  return {
    summary: `Found ${commits.length} commit(s) in ${input.repository}.`,
    commits: commits.map((commit) => ({
      commitId: commit.commitId,
      comment: commit.comment,
      author: commit.author,
      committer: commit.committer,
      url: commit.remoteUrl ?? commitWebUrl(client.config, input.repository, commit.commitId)
    }))
  };
}

export async function listItems(
  client: AdoClient,
  input: ListItemsInput
): Promise<unknown> {
  const items = await collectPagedValues<GitItem>(
    client,
    listItemsRequest(client.config, input)
  );
  return {
    summary: `Found ${items.length} item(s) in ${input.repository}.`,
    items: items.map((item) => ({
      objectId: item.objectId,
      commitId: item.commitId,
      path: item.path,
      gitObjectType: item.gitObjectType,
      isFolder: item.isFolder,
      url:
        item.path === undefined
          ? item.url
          : fileWebUrl(client.config, input.repository, item.path, input.version)
    }))
  };
}

export async function getFile(
  client: AdoClient,
  input: GetFileInput
): Promise<unknown> {
  const response = await client.send<GitItem>(getFileRequest(client.config, input));
  return {
    summary: `Read ${input.path} from ${input.repository}.`,
    file: {
      path: response.data.path ?? input.path,
      objectId: response.data.objectId,
      commitId: response.data.commitId,
      content: response.data.content,
      url: fileWebUrl(client.config, input.repository, input.path, input.version)
    }
  };
}

export async function listPullRequests(
  client: AdoClient,
  input: ListPullRequestsInput
): Promise<unknown> {
  const pullRequests = await collectPagedValues<PullRequest>(
    client,
    listPullRequestsRequest(client.config, input)
  );
  return {
    summary: `Found ${pullRequests.length} pull request(s) in ${input.repository}.`,
    pullRequests: pullRequests.map((pullRequest) => ({
      pullRequestId: pullRequest.pullRequestId,
      title: pullRequest.title,
      status: pullRequest.status,
      sourceRefName: pullRequest.sourceRefName,
      targetRefName: pullRequest.targetRefName,
      createdBy: pullRequest.createdBy,
      creationDate: pullRequest.creationDate,
      url: pullRequestWebUrl(
        client.config,
        input.repository,
        pullRequest.pullRequestId
      )
    }))
  };
}

export async function getPullRequest(
  client: AdoClient,
  input: GetPullRequestInput
): Promise<unknown> {
  const response = await client.send<PullRequest>(
    getPullRequestRequest(client.config, input)
  );
  return {
    summary: `Read pull request ${input.pullRequestId} in ${input.repository}.`,
    pullRequest: response.data,
    url: pullRequestWebUrl(
      client.config,
      input.repository,
      input.pullRequestId
    )
  };
}
