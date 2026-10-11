import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { Command, Thread, WorkspaceActionRequest } from "@ace/protocol";
import { fakeGh, standard, pr, repository, sha, nextSha, threads } from "@ace/forge/testing";
import { Store } from "./store.ts";
import { WorkspaceRuntime } from "./workspace-runtime.ts";
const execute = promisify(execFile);

test("repository detail discovers archived and active links without replacing a thread's primary association", async () => {
  const root = await mkdtemp(join(tmpdir(), "ace-forge-browser-"));
  const fixtures = standard();
  fixtures["repos/octo/ace/pulls/7"] = [
    {
      body: {
        ...pr,
        body: "Hosted context",
        user: { login: "octo" },
        labels: [],
        base: { ref: "main", sha: nextSha },
        head: { ...pr.head, repo: { owner: { login: "octo" }, name: "ace" } },
        requested_reviewers: [],
        commits: 1,
        changed_files: 1,
      },
    },
  ];
  fixtures.graphql = [
    { body: threads() },
    { body: threads() },
    { body: threads() },
    { body: { data: { repository: { pullRequest: { reviewDecision: null, headRefOid: sha } } } } },
  ];
  const gh = await fakeGh(fixtures);
  const store = new Store(join(root, "events.sqlite"));
  await execute("git", ["init", root]);
  await execute("git", ["-C", root, "remote", "add", "origin", "https://github.com/octo/ace.git"]);
  const workspaceId = store.createWorkspace(root, "Project");
  const runtime = new WorkspaceRuntime(store, root, () => 1000, {
    forgeRunner: () => (request) => gh.runner({ ...request, command: gh.executable }),
  });
  const active = Thread.parse({
    id: "active",
    workspaceId,
    title: "Active task",
    provider: "codex",
    status: { state: "new" },
    createdAt: 1,
    updatedAt: 1,
  });
  const archived = Thread.parse({
    ...active,
    id: "archived",
    title: "Archived task",
    archivedAt: 2,
  });
  store.appendEvents(active.id, [{ type: "thread.created", thread: active }]);
  store.appendEvents(archived.id, [{ type: "thread.created", thread: archived }]);
  try {
    await runtime.forge.link(active.id, root, { repository, number: 7 });
    await runtime.forge.link(archived.id, root, { repository, number: 7 });
    // Offline links in a different repository are still durable primary associations.
    await runtime.execute(
      Command.parse({
        id: "secondary",
        deviceId: "device",
        payload: {
          type: "forge.pr.link",
          link: {
            threadId: active.id,
            pr: { repository: { ...repository, name: "other" }, number: 7 },
          },
        },
      }),
    );
    const before = store.getThread(active.id)?.details?.linkedPrs;
    const result = await runtime.read(
      WorkspaceActionRequest.parse({
        type: "workspace.request",
        requestId: "detail",
        operation: { op: "forge.pr.detail", workspaceId, number: 7 },
      }),
    );
    expect(result).toMatchObject({
      result: {
        kind: "forge",
        data: {
          resource: "prDetail",
          value: {
            body: "Hosted context",
            relatedThreads: expect.arrayContaining([
              { id: active.id, title: active.title, archived: false },
              { id: archived.id, title: archived.title, archived: true },
            ]),
          },
        },
      },
    });
    expect(store.getThread(active.id)?.details?.linkedPrs).toEqual(before);
  } finally {
    await runtime.close();
    await store.close();
    await gh.cleanup();
    await rm(root, { recursive: true, force: true });
  }
});
