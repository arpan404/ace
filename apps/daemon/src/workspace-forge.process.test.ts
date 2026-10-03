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
    forgeRunner: () => async () =>
      recovered
        ? { code: 0, stdout: 'HTTP/1.1 201 Created\n\n{"id":31}', truncated: false }
        : { code: 1, stdout: "offline", truncated: false },
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
    expect(await runtime.execute(command("recovered"))).toMatchObject({ ok: true });
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
