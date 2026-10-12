import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { Command, Thread, WorkspaceActionRequest } from "@ace/protocol";
import { fakeGh, repository, issueRecord, issuePermissions } from "@ace/forge/testing";
import { Store } from "./store.ts";
import { WorkspaceRuntime } from "./workspace-runtime.ts";
const execute = promisify(execFile);

test("an uncertain create survives a daemon restart and blocks another write until read-only reconciliation", async () => {
  const root = await mkdtemp(join(tmpdir(), "ace-issues-"));
  const gh = await fakeGh({
    "repos/octo/ace": [{ body: { archived: false, has_issues: true } }],
    "repos/octo/ace/issues": [{ status: 500, body: { message: "lost" } }],
    "repos/octo/ace/issues?state=all&sort=created&direction=desc&per_page=100&page=1": [
      { body: [{ ...issueRecord, body: "Draft\n\n<!-- ace-issue-action:original -->" }] },
    ],
  });
  const store = new Store(join(root, "events.sqlite"));
  const workspaceId = store.createWorkspace(root, "Project");
  const options = {
    forgeRunner: () => (request: import("@ace/forge").CommandRequest) =>
      gh.runner({ ...request, command: gh.executable }),
  };
  let runtime = new WorkspaceRuntime(store, root, () => 1000, options);
  const command = Command.parse({
    id: "original",
    deviceId: "device",
    payload: {
      type: "forge.issue.write",
      workspaceId,
      repository,
      input: { action: "create", title: "Handle retries", body: "Draft" },
    },
  });
  try {
    expect(await runtime.execute(command)).toMatchObject({
      ok: false,
      issueAction: { state: "uncertain" },
    });
    await runtime.close();
    runtime = new WorkspaceRuntime(store, root, () => 2000, options);
    expect(
      await runtime.read(
        WorkspaceActionRequest.parse({
          type: "workspace.request",
          requestId: "journal",
          operation: { op: "forge.issue.actions", workspaceId, repository, number: 0 },
        }),
      ),
    ).toMatchObject({
      result: {
        kind: "forge",
        data: { resource: "issueActions", actions: [{ id: "original", state: "uncertain" }] },
      },
    });
    expect(await runtime.execute(Command.parse({ ...command, id: "repeat" }))).toMatchObject({
      ok: false,
      error: "issue_reconciliation_required",
    });
    expect(
      await runtime.execute(
        Command.parse({
          id: "reconcile",
          deviceId: "device",
          payload: { type: "forge.issue.reconcile", workspaceId, repository, actionId: "original" },
        }),
      ),
    ).toMatchObject({
      ok: true,
      issue: { repository, number: 7 },
      issueAction: { state: "succeeded" },
    });
    expect(await runtime.execute(command)).toMatchObject({
      ok: false,
      issueAction: { state: "uncertain" },
    });
    expect(
      (await gh.requests())
        .filter((request) => request.path === "repos/octo/ace/issues")
        .map((request) => request.body),
    ).toEqual([{ title: "Handle retries", body: "Draft\n\n<!-- ace-issue-action:original -->" }]);
  } finally {
    await runtime.close();
    await store.close();
    await gh.cleanup();
    await rm(root, { recursive: true, force: true });
  }
});

test("issue associations remain distinct from PRs and discover archived tasks after restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "ace-issue-links-"));
  const gh = await fakeGh({
    "repos/octo/ace/issues/7": [{ body: issueRecord }],
    graphql: [{ body: issuePermissions() }],
  });
  await execute("git", ["init", root]);
  const store = new Store(join(root, "events.sqlite"));
  const workspaceId = store.createWorkspace(root, "Project");
  const options = {
    forgeRunner: () => (request: import("@ace/forge").CommandRequest) =>
      gh.runner({ ...request, command: gh.executable }),
  };
  let runtime = new WorkspaceRuntime(store, root, () => 1000, options);
  const thread = Thread.parse({
    id: "task",
    workspaceId,
    title: "Issue task",
    provider: "codex",
    status: { state: "new" },
    createdAt: 1,
    updatedAt: 1,
    archivedAt: 2,
  });
  store.appendEvents(thread.id, [{ type: "thread.created", thread }]);
  try {
    expect(
      await runtime.execute(
        Command.parse({
          id: "link",
          deviceId: "device",
          payload: {
            type: "forge.issue.link",
            threadId: thread.id,
            issue: { repository, number: 7 },
          },
        }),
      ),
    ).toMatchObject({ ok: true });
    await runtime.close();
    runtime = new WorkspaceRuntime(store, root, () => 2000, options);
    expect(store.getThread(thread.id)?.details?.linkedIssues).toEqual([{ repository, number: 7 }]);
    expect(store.getThread(thread.id)?.details?.linkedPrs).toBeUndefined();
    expect(
      await runtime.read(
        WorkspaceActionRequest.parse({
          type: "workspace.request",
          requestId: "detail",
          operation: { op: "forge.issue.detail", workspaceId, repository, number: 7 },
        }),
      ),
    ).toMatchObject({
      result: {
        kind: "forge",
        data: {
          resource: "issueDetail",
          value: { relatedThreads: [{ id: "task", title: "Issue task", archived: true }] },
        },
      },
    });
  } finally {
    await runtime.close();
    await store.close();
    await gh.cleanup();
    await rm(root, { recursive: true, force: true });
  }
});
