import { access, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { ThreadId, type AccessMode } from "@ace/protocol";
import { transitionHarness } from "./engine/transition-test-support.ts";
import { WorkspaceRuntime } from "./workspace-runtime.ts";
import { startServer } from "./server.ts";
import { token } from "./socket-test-support.ts";
import { command, connect, git, queue, repository } from "./thread-creation-test-support.ts";

/*
 * A worktree made when its thread first runs (no worktree was prepared at creation) runs the
 * same one setup script a person's worktree start does, unless the thread is Read-only.
 */
async function fixture(setup: string) {
  let runtime: WorkspaceRuntime | undefined;
  const h = transitionHarness({
    prepareWorkspace: (id, policy) => {
      if (!runtime) throw new Error("Missing runtime");
      return runtime.prepare(id, policy);
    },
  });
  await repository(h.home);
  await writeFile(join(h.home, "package.json"), JSON.stringify({ scripts: { setup } }));
  await writeFile(join(h.home, ".gitignore"), "events.sqlite*\ndata/\n");
  await git("git", ["-C", h.home, "add", "-A"]);
  await git("git", [
    "-C",
    h.home,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@ace.local",
    "commit",
    "-m",
    "Setup",
  ]);
  await h.engine.ready();
  runtime = new WorkspaceRuntime(h.store, join(h.home, "data"), () => 1000);
  const server = await startServer({
    store: h.store,
    engine: h.engine,
    handler: h.engine.handler,
    workspaceActions: runtime,
    port: 0,
    hostId: "host",
    token,
  });
  const client = await connect(server.url);
  const id = ThreadId.parse("late");
  // Admitted with no prepared worktree: it is made when the provider session first opens.
  const start = (accessMode?: AccessMode) =>
    h.command({
      type: "thread.create",
      threadId: id,
      workspaceId: h.workspace,
      provider: "codex",
      mode: "worktree",
      ...(accessMode ? { access: accessMode } : {}),
      input: [{ type: "text", text: "first message" }],
    });
  const cwd = () => h.sessions.at(-1)?.context.cwd ?? "";
  return {
    h,
    id,
    client,
    start,
    cwd,
    get runtime() {
      if (!runtime) throw new Error("Missing runtime");
      return runtime;
    },
    async close() {
      await client.close();
      await server.close();
      await runtime?.close();
      await h.close();
    },
  };
}

test("a worktree made when its thread first runs runs the project's setup script", async () => {
  const f = await fixture("touch setup-ran");
  try {
    expect(f.start()).toMatchObject({ ok: true });
    await f.h.engine.flush();
    expect(f.h.inputs.map((input) => input.text)).toEqual(["first message"]);
    expect(f.cwd().startsWith(await realpath(join(f.h.home, "data", "worktrees")))).toBe(true);
    await access(join(f.cwd(), "setup-ran"));
    expect(f.h.store.getThread(f.id)?.details?.worktreeSetup).toBeUndefined();
  } finally {
    await f.close();
  }
});

test("a Read-only thread's late worktree skips setup and says so", async () => {
  const f = await fixture("touch setup-ran");
  try {
    expect(f.start("read-only")).toMatchObject({ ok: true });
    await f.h.engine.flush();
    expect(f.h.inputs.map((input) => input.text)).toEqual(["first message"]);
    await expect(access(join(f.cwd(), "setup-ran"))).rejects.toThrow();
    expect(f.h.store.getThread(f.id)?.details?.worktreeSetup).toMatchObject({
      state: "skipped",
      reason: "read_only",
    });
  } finally {
    await f.close();
  }
});

test("a failed late setup holds the first message; Continue starts it in the kept worktree", async () => {
  const f = await fixture("node -e \"console.error('late setup broke');process.exit(4)\"");
  try {
    expect(f.start()).toMatchObject({ ok: true });
    await f.h.engine.flush();
    expect(f.h.inputs).toEqual([]);
    const failed = f.h.store.getThread(f.id)?.details?.worktreeSetup;
    expect(failed?.state).toBe("failed");
    expect(failed?.details.join("\n")).toContain("late setup broke");
    const held = await queue(f.client, f.id);
    expect(held).toMatchObject({ paused: true, messages: [{ state: "queued" }] });

    expect(
      await command(f.client, "continue", {
        type: "thread.workspace.setup",
        threadId: f.id,
        action: "continue",
      }),
    ).toMatchObject({ ok: true });
    expect(
      await command(f.client, "resume", {
        type: "queue.resume",
        threadId: f.id,
        expectedRevision: held.revision,
      }),
    ).toMatchObject({ ok: true });
    await f.h.engine.flush();
    expect(f.h.inputs.map((input) => input.text)).toEqual(["first message"]);
    expect(f.cwd().startsWith(await realpath(join(f.h.home, "data", "worktrees")))).toBe(true);
    expect(f.h.store.getThread(f.id)?.details?.worktreeSetup).toBeUndefined();
  } finally {
    await f.close();
  }
});
