import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { AgentItem, Thread, ThreadId, type ProviderKind } from "@ace/protocol";
import { Store } from "./store.ts";
import { WorkspaceRuntime } from "./workspace-runtime.ts";
import { PullRequestAutoLink } from "./pr-auto-link.ts";
const execute = promisify(execFile);

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "ace-pr-auto-link-"));
  await execute("git", ["init", "-q", root]);
  await execute("git", ["-C", root, "remote", "add", "origin", "git@github.com:test/project.git"]);
  const store = new Store(join(root, "events.sqlite"));
  const workspaceId = store.createWorkspace(root, "Project");
  const runtime = new WorkspaceRuntime(store, root, () => 1000, {
    forgeRunner: () => async () => ({ code: 1, stdout: "offline", truncated: false }),
  });
  const errors: unknown[] = [];
  const auto = new PullRequestAutoLink(store, runtime, (error) => errors.push(error));
  const thread = (id: string, provider: ProviderKind = "codex") => {
    const value = Thread.parse({
      id,
      workspaceId,
      provider,
      title: id,
      status: { state: "new" },
      createdAt: 1,
      updatedAt: 1,
    });
    store.appendEvents(value.id, [{ type: "thread.created", thread: value }]);
    return value.id;
  };
  const command = (
    threadId: Thread["id"],
    id: string,
    script: string,
    output: string,
    status = "succeeded",
    complete = true,
  ) => {
    const item = AgentItem.parse({
      id,
      agentId: "root",
      type: "tool_call",
      complete: false,
      createdAt: 1,
      call: {
        id,
        agentId: "root",
        kind: "shell",
        title: "Run command",
        status: "running",
        startedAt: 1,
        raw: [],
        detail: { kind: "shell", command: script },
      },
    });
    store.appendEvents(threadId, [
      { type: "item.created", item },
      {
        type: "item.delta",
        itemId: item.id,
        agentId: item.agentId,
        field: "output",
        append: output,
      },
    ]);
    const streamed = store.snapshotThread(threadId).items[item.id];
    if (streamed?.type !== "tool_call") throw new Error("Missing command");
    const finished = AgentItem.parse({ ...streamed, complete, call: { ...streamed.call, status } });
    store.appendEvents(threadId, [{ type: "item.updated", item: finished }]);
    return finished;
  };
  return {
    root,
    store,
    runtime,
    auto,
    thread,
    command,
    errors,
    async close() {
      await auto.close();
      await runtime.close();
      await store.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("PR creation from every canonical provider command links the PR and publishes live thread details", async () => {
  const f = await fixture();
  const observed: number[] = [];
  const stop = f.store.subscribe((events) => {
    for (const event of events)
      if (event.payload.type === "thread.client.updated") {
        const first = event.payload.changes.details?.linkedPrs?.[0];
        if (first) observed.push(first.number);
      }
  });
  try {
    const providers: ProviderKind[] = ["codex", "claude", "opencode", "pi", "cursor"];
    for (const [index, provider] of providers.entries()) {
      const id = f.thread(provider, provider);
      f.command(
        id,
        `${provider}-create`,
        provider === "codex"
          ? "/bin/zsh -lc 'gh pr create --fill'"
          : "gh pr create --title 'Fix' --body-file /tmp/body",
        `Creating pull request\nhttps://github.com/test/project/pull/${283 + index}\n`,
      );
    }
    await f.auto.drained();
    expect(f.errors).toEqual([]);
    expect(observed).toEqual([283, 284, 285, 286, 287]);
    for (const [index, provider] of providers.entries()) {
      expect(f.store.getThread(ThreadId.parse(provider))?.details?.linkedPrs).toMatchObject([
        { number: 283 + index, state: "open", unverified: true },
      ]);
    }
  } finally {
    stop();
    await f.close();
  }
});

test("only a finished create receipt for the workspace repo auto-links and repeated updates preserve an unlink", async () => {
  const f = await fixture();
  try {
    const id = f.thread("scope");
    const own = "https://github.com/test/project/pull/283\n";
    f.command(id, "mention", "echo 'gh pr create'", own);
    f.command(
      id,
      "other-repo",
      "gh pr create --repo test/other",
      "https://github.com/test/other/pull/9\n",
    );
    f.command(
      id,
      "failed",
      "gh pr create",
      `Failed to create a pull request; see ${own}`,
      "failed",
    );
    f.command(id, "dry-run", "gh pr create --dry-run", own);
    f.command(id, "running", "gh pr create", own, "running", false);
    await f.auto.drained();
    expect(f.store.getThread(id)?.details?.linkedPrs ?? []).toEqual([]);
    const finished = f.command(
      id,
      "created",
      "git push -u origin HEAD && gh pr create --fill",
      `${"x".repeat(64 * 1024 - 20)}\n${own}${"z".repeat(9000)}\n`,
    );
    await f.auto.drained();
    expect(f.store.getThread(id)?.details?.linkedPrs).toMatchObject([{ number: 283 }]);
    f.runtime.forge.unlink(id);
    f.store.appendEvents(id, [{ type: "item.updated", item: finished }]);
    await f.auto.drained();
    expect(f.store.getThread(id)?.details?.linkedPrs).toEqual([]);
    expect(f.errors).toEqual([]);
  } finally {
    await f.close();
  }
});

test("a created PR still links when a later attachment upload fails", async () => {
  const f = await fixture();
  try {
    const id = f.thread("attachment");
    f.command(
      id,
      "created",
      "gh pr create --fill --attach /tmp/screenshot.png",
      "https://github.com/test/project/pull/283\nFailed to upload attachment\n",
      "failed",
    );
    await f.auto.drained();
    expect(f.store.getThread(id)?.details?.linkedPrs).toMatchObject([{ number: 283 }]);
    expect(f.errors).toEqual([]);
  } finally {
    await f.close();
  }
});

test("a command captured before shutdown completes linking after the subscriber restarts", async () => {
  const f = await fixture();
  try {
    const id = f.thread("restart");
    f.command(id, "created", "gh pr create --fill", "https://github.com/test/project/pull/283\n");
    await f.auto.close();
    const resumed = new PullRequestAutoLink(f.store, f.runtime, (error) => f.errors.push(error));
    try {
      await resumed.drained();
      expect(f.store.getThread(id)?.details?.linkedPrs).toMatchObject([{ number: 283 }]);
      expect(f.errors).toEqual([]);
    } finally {
      await resumed.close();
    }
  } finally {
    await f.close();
  }
});
