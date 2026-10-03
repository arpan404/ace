import { mkdtemp, mkdir, rm, writeFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Command } from "@ace/protocol";
import type { ReviewExecutor } from "@ace/review";
import { createDevThread } from "./commands.ts";
import { Store } from "./store.ts";
import { createDaemonReview, dispatchReviewCommand } from "./review.ts";

export async function reviewFixture(executor: ReviewExecutor) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "ace-review-dispatch-")));
  const store = new Store(join(directory, "daemon.sqlite"));
  const registered = [];
  for (const name of ["a", "b"]) {
    const root = join(directory, name);
    await mkdir(root);
    const git = (...args: string[]) => promisify(execFile)("git", args, { cwd: root });
    await git("init", "-q");
    await git("config", "user.name", "Review");
    await git("config", "user.email", "review@example.invalid");
    await writeFile(join(root, "file.ts"), "before\noriginal\nafter\n");
    await git("add", ".");
    await git("commit", "-qm", "base");
    await writeFile(join(root, "file.ts"), "before\nwrong\nafter\n");
    const workspaceId = store.createWorkspace(root, name);
    registered.push({ root, workspaceId, thread: createDevThread(store, workspaceId) });
  }
  const a = registered[0];
  const b = registered[1];
  if (!a || !b) throw new Error("Missing test repositories");
  const threadWorktrees = new Map<string, string>();
  const review = createDaemonReview(directory, store, {
    executor,
    threadWorktree: (id) => {
      const thread = store.getThread(id);
      return (
        threadWorktrees.get(id) ?? (thread ? store.getWorkspacePath(thread.workspaceId) : undefined)
      );
    },
  });
  let serial = 0;
  const command = (payload: unknown, id = `dispatch-${++serial}`) =>
    Command.parse({ id, deviceId: "device", payload });
  const send = (payload: unknown, id?: string) =>
    dispatchReviewCommand(review, store, command(payload, id));
  const opened = await send({
    type: "review.open",
    source: {
      workspaceId: a.workspaceId,
      threadId: a.thread.id,
      from: { kind: "commit", ref: "HEAD" },
      to: { kind: "working-tree" },
    },
  });
  const sessionId = opened.review?.session?.id;
  if (!opened.ok || !sessionId) throw new Error("Review fixture failed to open");
  return {
    directory,
    store,
    review,
    command,
    send,
    sessionId,
    a,
    b,
    threadWorktrees,
    async close() {
      await review.close();
      store.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
