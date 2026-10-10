import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { Command, Thread } from "@ace/protocol";
import { Store } from "./store.ts";
import { WorkspaceRuntime } from "./workspace-runtime.ts";
const execute = promisify(execFile);

test("forge failures produce durable error receipts and a later command can use a recovered injected runner", async () => {
  const root = await mkdtemp(join(tmpdir(), "ace-forge-runner-"));
  await execute("git", ["init", root]);
  await execute("git", [
    "-C",
    root,
    "remote",
    "add",
    "origin",
    "https://github.com/test/project.git",
  ]);
  const store = new Store(join(root, "events.sqlite"));
  const workspaceId = store.createWorkspace(root, "Project");
  const thread = Thread.parse({
    id: "forge-thread",
    workspaceId,
    provider: "codex",
    title: "Forge",
    status: { state: "new" },
    createdAt: 1,
    updatedAt: 1,
  });
  store.appendEvents(thread.id, [{ type: "thread.created", thread }]);
  let recovered = false;
  const runtime = new WorkspaceRuntime(store, root, () => 1000, {
    forgeRunner: () => async (request) => {
      if (!recovered) return { code: 1, stdout: "offline", truncated: false };
      const path = request.args[1] ?? "";
      let body: unknown = [];
      if (path.endsWith("/replies")) body = { id: 31 };
      else if (path === "repos/test/project/pulls/7")
        body = {
          number: 7,
          node_id: "PR_7",
          title: "Recovered PR",
          html_url: "https://github.com/test/project/pull/7",
          state: "open",
          head: { sha: "a".repeat(40), ref: "topic" },
        };
      else if (path.includes("/check-runs?")) body = { check_runs: [] };
      else if (path === "graphql")
        body = {
          data: {
            repository: {
              pullRequest: {
                reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
              },
            },
          },
        };
      return { code: 0, stdout: `HTTP/1.1 200 OK\n\n${JSON.stringify(body)}`, truncated: false };
    },
  });
  const command = (id: string) =>
    Command.parse({
      id,
      deviceId: "device",
      payload: {
        type: "forge.comment.reply",
        link: {
          threadId: thread.id,
          pr: {
            repository: { forge: "github", host: "github.com", owner: "test", name: "project" },
            number: 7,
          },
        },
        commentId: 13,
        body: "Fixed",
      },
    });
  try {
    const failed = await runtime.execute(command("failure"));
    expect(failed).toMatchObject({ ok: false });
    recovered = true;
    expect(await runtime.execute(command("failure"))).toEqual(failed);
    expect(await runtime.execute(command("recovered"))).toMatchObject({
      ok: true,
      prStatus: { ref: { number: 7 }, title: "Recovered PR" },
    });
  } finally {
    await runtime.close();
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a thread's details name the forge repository behind its origin remote", async () => {
  const root = await mkdtemp(join(tmpdir(), "ace-forge-details-"));
  await execute("git", ["init", "-q", "-b", "main", root]);
  await execute("git", ["-C", root, "remote", "add", "origin", "git@github.com:test/project.git"]);
  const store = new Store(join(root, "events.sqlite"));
  const workspaceId = store.createWorkspace(root, "Project");
  const thread = Thread.parse({
    id: "details-thread",
    workspaceId,
    provider: "codex",
    title: "Details",
    status: { state: "new" },
    createdAt: 1,
    updatedAt: 1,
  });
  store.appendEvents(thread.id, [{ type: "thread.created", thread }]);
  const runtime = new WorkspaceRuntime(store, root, () => 1000);
  try {
    const repository = { forge: "github", host: "github.com", owner: "test", name: "project" };
    expect((await runtime.details(thread.id)).repository).toEqual(repository);
    // Published to the thread, where clients read it for forge.pr.create.
    expect(store.getThread(thread.id)?.details?.repository).toEqual(repository);
  } finally {
    await runtime.close();
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a draft PR stays identified until unlink, which survives restart and in-flight reads", async () => {
  const root = await mkdtemp(join(tmpdir(), "ace-forge-unlink-"));
  await execute("git", ["init", "-q", root]);
  await execute("git", [
    "-C",
    root,
    "remote",
    "add",
    "origin",
    "https://github.com/test/project.git",
  ]);
  const database = join(root, "events.sqlite");
  const store = new Store(database);
  const workspaceId = store.createWorkspace(root, "Project");
  const thread = Thread.parse({
    id: "unlink-thread",
    workspaceId,
    provider: "codex",
    title: "Unlink",
    status: { state: "new" },
    createdAt: 1,
    updatedAt: 1,
  });
  store.appendEvents(thread.id, [{ type: "thread.created", thread }]);
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let hold = false;
  const runtime = new WorkspaceRuntime(store, root, () => 1000, {
    forgeRunner: () => async (request) => {
      const path = request.args[1] ?? "";
      let body: unknown = [];
      if (path === "repos/test/project/pulls/7") {
        if (hold) {
          started.resolve();
          await release.promise;
        }
        body = {
          number: 7,
          node_id: "PR_7",
          title: "Linked PR",
          html_url: "https://github.com/test/project/pull/7",
          state: "open",
          draft: true,
          head: { sha: "a".repeat(40), ref: "topic" },
        };
      } else if (path.includes("/check-runs?")) body = { check_runs: [] };
      else if (path === "graphql")
        body = {
          data: {
            repository: {
              pullRequest: {
                reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
              },
            },
          },
        };
      return { code: 0, stdout: `HTTP/1.1 200 OK\n\n${JSON.stringify(body)}`, truncated: false };
    },
  });
  const link = {
    threadId: thread.id,
    pr: {
      repository: { forge: "github", host: "github.com", owner: "test", name: "project" },
      number: 7,
    },
  };
  try {
    expect(
      await runtime.execute(
        Command.parse({ id: "link", deviceId: "device", payload: { type: "forge.pr.link", link } }),
      ),
    ).toMatchObject({ ok: true });
    expect(store.getThread(thread.id)?.details?.linkedPr).toMatchObject({
      number: 7,
      state: "open",
      draft: true,
    });
    hold = true;
    const reading = runtime.read({
      type: "workspace.request",
      requestId: "reading",
      operation: { op: "pr.status", threadId: thread.id },
    });
    await started.promise;
    expect(
      await runtime.execute(
        Command.parse({
          id: "unlink",
          deviceId: "device",
          payload: { type: "forge.pr.unlink", threadId: thread.id, all: true },
        }),
      ),
    ).toMatchObject({ ok: true });
    release.resolve();
    await reading;
    expect(store.getThread(thread.id)?.details?.linkedPr).toBeNull();
  } finally {
    release.resolve();
    await runtime.close();
    await store.close();
  }
  const reopened = new Store(database);
  const resumed = new WorkspaceRuntime(reopened, root, () => 2000, {
    forgeRunner: () => async () => ({ code: 1, stdout: "unavailable", truncated: false }),
  });
  try {
    expect(reopened.getThread(thread.id)?.details?.linkedPr).toBeNull();
    expect(
      await resumed.read({
        type: "workspace.request",
        requestId: "after-restart",
        operation: { op: "pr.status", threadId: thread.id },
      }),
    ).toMatchObject({ result: { kind: "pr", status: null } });
  } finally {
    await resumed.close();
    await reopened.close();
    await rm(root, { recursive: true, force: true });
  }
});
