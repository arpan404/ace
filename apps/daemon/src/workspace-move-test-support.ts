import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command, type ThreadId } from "@ace/protocol";
import { transitionHarness } from "./engine/transition-test-support.ts";
import { WorkspaceRuntime } from "./workspace-runtime.ts";
import type { WorkspaceGit } from "./workspace-roots.ts";

/*
 * A real Git project with the transition engine and a workspace runtime over it, for checkout
 * move tests. Provider sessions start only where the runtime finds the thread's checkout.
 */

const execute = promisify(execFile);
export async function git(root: string, ...args: string[]) {
  return (await execute("git", ["-C", root, ...args])).stdout.trim();
}
export async function fixture(options: { gitService?: WorkspaceGit } = {}) {
  let runtime: WorkspaceRuntime | undefined;
  const h = transitionHarness({
    assertWorkspaceAvailable: async (cwd, id) => runtime?.assertCheckoutPresent(id, cwd),
  });
  await git(h.home, "init", "-b", "main");
  await git(h.home, "config", "user.name", "ace test");
  await git(h.home, "config", "user.email", "test@ace.local");
  await writeFile(join(h.home, "file.txt"), "project\n");
  // The harness keeps its database in the project folder; it is not the project's work.
  await writeFile(join(h.home, ".gitignore"), "events.sqlite*\n");
  await git(h.home, "add", ".");
  await git(h.home, "commit", "-m", "Initial");
  await h.engine.ready();
  const data = await mkdtemp(join(tmpdir(), "ace-move-data-"));
  const open = () =>
    new WorkspaceRuntime(h.store, data, () => 1000, {
      ...(options.gitService ? { gitService: options.gitService } : {}),
      changeWorkspace: (id, commandId, effect, reservation, commit) =>
        h.engine.changeWorkspace(id, commandId, effect, reservation, commit),
    });
  runtime = open();
  let serial = 0;
  const local = () => {
    const created = h.command({
      type: "thread.create",
      workspaceId: h.workspace,
      provider: "codex",
      mode: "local",
      input: [{ type: "text", text: "start" }],
    });
    if (!created.threadId) throw new Error("Missing thread");
    return created.threadId;
  };
  const run = (payload: Record<string, unknown>) =>
    runtime
      ? runtime.execute(Command.parse({ id: `move-${++serial}`, deviceId: "device", payload }))
      : Promise.reject(new Error("Runtime closed"));
  const send = (threadId: ThreadId, text: string) =>
    h.command({ type: "thread.send", threadId, input: [{ type: "text", text }] });
  return {
    h,
    data,
    local,
    run,
    send,
    get runtime() {
      if (!runtime) throw new Error("Runtime closed");
      return runtime;
    },
    async restart() {
      await runtime?.close();
      runtime = open();
    },
    async close() {
      await runtime?.close();
      await h.close();
      await rm(data, { recursive: true, force: true });
    },
  };
}
