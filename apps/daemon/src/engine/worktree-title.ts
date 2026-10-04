import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { worktreeBranchName } from "@ace/workspace";
import type { ThreadId } from "@ace/protocol";
import type { Store } from "../store.ts";
const execute = promisify(execFile);
async function git(cwd: string, args: string[]): Promise<string | undefined> {
  try {
    return (await execute("git", ["-C", cwd, ...args], { maxBuffer: 65536 })).stdout.trim();
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error.code === 1 || error.code === 128)
    )
      return undefined;
    throw error;
  }
}
/** Rename only ace's untouched provisional branch. User commits/upstreams fence this operation. */
export async function nameWorktreeBranch(store: Store, id: ThreadId, at: number): Promise<void> {
  const thread = store.getThread(id);
  const path = thread?.details?.worktree;
  const branch = thread?.details?.branch;
  if (
    !thread ||
    thread.details?.mode !== "worktree" ||
    !path ||
    !branch ||
    thread.title === "New thread" ||
    !/^ace\/[a-f0-9]{24}$/.test(branch)
  )
    return;
  const current = await git(path, ["symbolic-ref", "--short", "HEAD"]);
  if (
    current !== branch ||
    (await git(path, ["rev-parse", "--abbrev-ref", `${branch}@{upstream}`]))
  )
    return;
  const log = await git(path, ["reflog", "show", "--format=%H", "-2", branch]);
  if (!log || log.split("\n").length !== 1) return;
  for (let occurrence = 1; occurrence <= 256; occurrence++) {
    const next = worktreeBranchName(thread.title, occurrence);
    if (await git(path, ["show-ref", "--verify", `refs/heads/${next}`])) continue;
    if ((await git(path, ["branch", "-m", branch, next])) === undefined) continue;
    await store.writable();
    const latest = store.getThread(id);
    if (latest?.details?.worktree === path && latest.details.branch === branch)
      store.appendEvents(
        id,
        [
          {
            type: "thread.client.updated",
            changes: { details: { ...latest.details, branch: next } },
          },
        ],
        at,
      );
    return;
  }
  throw new Error("Worktree title branch capacity exceeded");
}
