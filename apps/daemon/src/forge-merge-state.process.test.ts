import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { Command, CommandId, Thread, WorkspaceActionRequest } from "@ace/protocol";
import { fakeGh, standard, repository, sha, threads } from "@ace/forge/testing";
import { Store } from "./store.ts";
import { WorkspaceRuntime } from "./workspace-runtime.ts";
const execute = promisify(execFile);
const mergePr = {
  id: "PR_7",
  number: 7,
  headRefOid: sha,
  state: "OPEN",
  isDraft: false,
  mergeStateStatus: "BLOCKED",
  reviewDecision: "REVIEW_REQUIRED",
  statusCheckRollup: { state: "SUCCESS" },
  autoMergeRequest: null,
  mergeQueueEntry: null,
  viewerCanEnableAutoMerge: true,
  viewerCanDisableAutoMerge: false,
};
const read = (autoMergeRequest: unknown = null) => ({
  body: {
    data: {
      repository: { viewerPermission: "WRITE", pullRequest: { ...mergePr, autoMergeRequest } },
    },
  },
});

test("merge state changes have durable receipts, restart reads reconcile external disablement, and uncertain commands never repeat", async () => {
  const root = await mkdtemp(join(tmpdir(), "ace-merge-state-"));
  const fixtures = standard();
  fixtures.graphql = [
    { body: threads() },
    read(),
    { body: { data: { enablePullRequestAutoMerge: { clientMutationId: null } } } },
    read({ mergeMethod: "SQUASH", enabledAt: "2026-10-11", enabledBy: { login: "octo" } }),
    { body: threads() },
    read(),
  ];
  const gh = await fakeGh(fixtures);
  const dbPath = join(root, "events.sqlite");
  let store = new Store(dbPath);
  const options = {
    forgeRunner: () => (request: Parameters<typeof gh.runner>[0]) =>
      gh.runner({ ...request, command: gh.executable }),
  };
  await execute("git", ["init", root]);
  await execute("git", ["-C", root, "remote", "add", "origin", "https://github.com/octo/ace.git"]);
  const workspaceId = store.createWorkspace(root, "Project");
  const thread = Thread.parse({
    id: "merge-state",
    workspaceId,
    provider: "codex",
    title: "Merge state",
    status: { state: "new" },
    createdAt: 1,
    updatedAt: 1,
  });
  store.appendEvents(thread.id, [{ type: "thread.created", thread }]);
  let runtime = new WorkspaceRuntime(store, root, () => 1000, options);
  const command = Command.parse({
    id: "enable",
    deviceId: "device",
    payload: {
      type: "forge.pr.merge-state.change",
      link: { threadId: thread.id, pr: { repository, number: 7 } },
      headSha: sha,
      action: "enable",
      method: "squash",
    },
  });
  try {
    await runtime.forge.link(thread.id, root, { repository, number: 7 });
    const receipt = await runtime.execute(command);
    expect(receipt).toMatchObject({
      ok: true,
      prStatus: { mergeState: { autoMerge: { method: "SQUASH", actor: "octo" } } },
    });
    await runtime.close();
    await store.close();
    store = new Store(dbPath);
    runtime = new WorkspaceRuntime(store, root, () => 2000, options);
    const before = (await gh.requests()).length;
    expect(await runtime.execute(command)).toEqual(receipt);
    expect((await gh.requests()).length).toBe(before);
    const result = await runtime.read(
      WorkspaceActionRequest.parse({
        type: "workspace.request",
        requestId: "reconcile",
        operation: { op: "forge.pr.merge-state", workspaceId, repository, number: 7 },
      }),
    );
    expect(result).toMatchObject({
      result: { kind: "forge", data: { resource: "prMergeState", value: { autoMerge: null } } },
    });
    store.recordCommand(CommandId.parse("uncertain"), command.deviceId, () => ({
      commandId: CommandId.parse("uncertain"),
      ok: false,
      error: "client_action_pending",
    }));
    const count = (await gh.requests()).length;
    expect(await runtime.execute({ ...command, id: CommandId.parse("uncertain") })).toMatchObject({
      ok: false,
      error: "action_outcome_uncertain",
    });
    expect((await gh.requests()).length).toBe(count);
  } finally {
    await runtime.close();
    await store.close();
    await gh.cleanup();
    await rm(root, { recursive: true, force: true });
  }
});
