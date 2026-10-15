import { worktreeBranchName, worktreeBranchSlugMaxChars } from "@ace/workspace";
import { GitError, executionKeyQuery, nonExecutingEnv } from "@ace/git";
import type { ThreadId } from "@ace/protocol";
import type { Store } from "../store.ts";
export type WorktreeGit = (cwd: string, args: string[]) => Promise<string | undefined>;
type Execute = (
  file: string,
  args: string[],
  options: { maxBuffer: number; env: NodeJS.ProcessEnv },
) => Promise<{ stdout: string }>;
async function run(
  execute: Execute,
  env: NodeJS.ProcessEnv,
  cwd: string,
  args: string[],
): Promise<string | undefined> {
  try {
    return (await execute("git", ["-C", cwd, ...args], { maxBuffer: 65536, env })).stdout.trim();
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
/**
 * Native process execution belongs to the injected engine boundary. Renaming ace's provisional
 * branch is ace bookkeeping, so the worktree's hooks, filters and fsmonitor never run for it.
 */
export async function runWorktreeGit(
  execute: Execute,
  baseEnv: NodeJS.ProcessEnv,
  cwd: string,
  args: string[],
): Promise<string | undefined> {
  const keys = await run(execute, { ...baseEnv, ...nonExecutingEnv() }, cwd, [
    "-c",
    "protocol.allow=never",
    ...executionKeyQuery,
  ]);
  let env: Record<string, string>;
  try {
    env = nonExecutingEnv(keys ?? "");
  } catch (error) {
    // A hook shadowing a reserved event can't be neutralised; leave the branch alone.
    if (error instanceof GitError) return undefined;
    throw error;
  }
  return run(execute, { ...baseEnv, ...env }, cwd, ["-c", "protocol.allow=never", ...args]);
}
/** A model-generated slug is usable when it is already sanitized and within budget. */
function validBranchSlug(slug: string): boolean {
  return (
    slug.length > 0 &&
    slug.length <= worktreeBranchSlugMaxChars &&
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)
  );
}
/**
 * Rename only ace's untouched branch. User commits, upstreams and identity changes fence
 * this operation. Without a model slug, only the provisional `ace/<hex>` branch is
 * renamed from the thread title (the sending fallback). With a model slug, any still
 * untouched `ace/` branch is renamed to the concise slug first, falling back to the
 * title slug when the model slug is missing or fully collided. A branch already on the
 * desired name is left alone.
 *
 * A `branch -m` duplicates the reflog entry with the same commit, so one or more
 * identical entries still mean untouched; distinct commits mean the person committed
 * and fence the rename. A concurrent ace rename (title fallback racing a late model
 * slug) retries once as an upgrade instead of throwing.
 */
export async function nameWorktreeBranch(
  store: Store,
  id: ThreadId,
  at: number,
  git: WorktreeGit,
  preferredSlug?: string,
  attempt = 1,
): Promise<void> {
  const thread = store.getThread(id);
  const path = thread?.details?.worktree;
  const branch = thread?.details?.branch;
  if (!thread || thread.details?.mode !== "worktree" || !path || !branch) return;
  if (!branch.startsWith("ace/")) return;
  const provisional = /^ace\/[a-f0-9]{24}$/.test(branch);
  const preferred = preferredSlug && validBranchSlug(preferredSlug) ? preferredSlug : undefined;
  // The title fallback only ever renames the provisional branch; the model path may also
  // upgrade a title-slug branch that landed first, while the same fences still apply.
  if (!preferred && (!provisional || thread.title === "New thread")) return;
  const current = await git(path, ["symbolic-ref", "--short", "HEAD"]);
  if (
    current !== branch ||
    (await git(path, ["rev-parse", "--abbrev-ref", `${branch}@{upstream}`]))
  )
    return;
  const log = await git(path, ["reflog", "show", "--format=%H", "-2", branch]);
  if (!log || new Set(log.split("\n")).size !== 1) return;
  const bases =
    preferred && thread.title !== "New thread"
      ? [preferred, thread.title]
      : preferred
        ? [preferred]
        : [thread.title];
  for (const base of bases) {
    for (let occurrence = 1; occurrence <= 256; occurrence++) {
      const next = worktreeBranchName(base, occurrence);
      if (next === branch) return;
      if (await git(path, ["show-ref", "--verify", `refs/heads/${next}`])) continue;
      if ((await git(path, ["branch", "-m", branch, next])) === undefined) {
        // A concurrent ace rename already moved the source branch: stop scanning
        // collisions and fall through to the retry below instead of trying 256 names.
        if (!(await git(path, ["show-ref", "--verify", `refs/heads/${branch}`]))) break;
        continue;
      }
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
  }
  // Every rename failed: either all 256 names are taken (genuine exhaustion) or a
  // concurrent ace rename already moved this branch. A missing source branch means the
  // other side won; a model slug retries once against the new name as an upgrade.
  if (attempt < 2 && !(await git(path, ["show-ref", "--verify", `refs/heads/${branch}`]))) {
    const latest = store.getThread(id);
    if (latest?.details?.mode === "worktree" && latest.details.branch !== branch && preferred)
      return nameWorktreeBranch(store, id, at, git, preferredSlug, attempt + 1);
    return;
  }
  throw new Error("Worktree title branch capacity exceeded");
}
