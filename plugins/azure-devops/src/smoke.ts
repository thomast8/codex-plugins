import { createAuthProvider } from "./auth.js";
import { AdoClient } from "./client.js";
import { loadConfig } from "./config.js";
import { getSetupStatus } from "./configStore.js";
import {
  addWorkItemComment,
  getWorkItem
} from "./workItems.js";
import {
  getFile,
  getPullRequest,
  listPullRequests,
  listRepositories
} from "./repos.js";

function hasRequiredConfig(): boolean {
  return getSetupStatus().configured;
}

async function main(): Promise<void> {
  if (!hasRequiredConfig()) {
    console.log(
      "Skipping smoke test: configure Azure DevOps with ado_configure_connection, or set ADO_ORG_URL and ADO_PROJECT."
    );
    return;
  }

  const config = loadConfig();
  const client = new AdoClient({
    config,
    authProvider: createAuthProvider(config)
  });

  console.log("Listing repositories...");
  console.log(JSON.stringify(await listRepositories(client, {}), null, 2));

  const workItemId = process.env.ADO_SMOKE_WORK_ITEM_ID;
  if (workItemId !== undefined && workItemId.trim() !== "") {
    console.log(`Reading work item ${workItemId}...`);
    console.log(
      JSON.stringify(await getWorkItem(client, Number.parseInt(workItemId, 10)), null, 2)
    );
  }

  const repository = process.env.ADO_SMOKE_REPOSITORY;
  if (repository !== undefined && repository.trim() !== "") {
    console.log(`Listing pull requests for ${repository}...`);
    console.log(
      JSON.stringify(
        await listPullRequests(client, {
          repository,
          status: "active",
          top: 10
        }),
        null,
        2
      )
    );

    const filePath = process.env.ADO_SMOKE_FILE_PATH;
    if (filePath !== undefined && filePath.trim() !== "") {
      console.log(`Reading ${filePath} from ${repository}...`);
      console.log(
        JSON.stringify(
          await getFile(client, {
            repository,
            path: filePath
          }),
          null,
          2
        )
      );
    }

    const pullRequestId = process.env.ADO_SMOKE_PULL_REQUEST_ID;
    if (pullRequestId !== undefined && pullRequestId.trim() !== "") {
      console.log(`Reading pull request ${pullRequestId}...`);
      console.log(
        JSON.stringify(
          await getPullRequest(client, {
            repository,
            pullRequestId: Number.parseInt(pullRequestId, 10)
          }),
          null,
          2
        )
      );
    }
  }

  const writeWorkItemId = process.env.ADO_TEST_WORK_ITEM_ID;
  if (writeWorkItemId !== undefined && writeWorkItemId.trim() !== "") {
    const apply = process.env.ADO_TEST_APPLY === "true";
    console.log(
      apply
        ? `Applying test comment to work item ${writeWorkItemId}...`
        : `Previewing test comment for work item ${writeWorkItemId}...`
    );
    console.log(
      JSON.stringify(
        await addWorkItemComment(client, {
          id: Number.parseInt(writeWorkItemId, 10),
          text: "Azure DevOps Codex plugin smoke test comment.",
          apply
        }),
        null,
        2
      )
    );
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
