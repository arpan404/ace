import type { VerifyPr } from "@ace/protocol";
import { integrationPrefix } from "./check-trees.ts";
import type { VerifyTree } from "./run-store.ts";
import { describeError, isHeadMoved } from "./run-errors.ts";
import {
  RunStop,
  fetchHead,
  prRemote,
  setupAndCheck,
  step,
  type RunOutcome,
  type RunPorts,
  type RunSession,
} from "./run-session.ts";
import { failure, prList } from "./run-state.ts";

/**
 * Drive one run from `running` to its outcome. Known failures come back as outcomes; a cancel
 * or shutdown before GitHub merges rethrows, and the caller settles the run from its reason.
 */
export async function executeRun(session: RunSession, ports: RunPorts): Promise<RunOutcome> {
  const target = session.current().target;
  try {
    if (target.kind === "check") {
      await checkOne(session, ports, target.pr);
      return { state: "passed" };
    }
    await checkCombined(session, ports, target.prs);
  } catch (error) {
    if (!(error instanceof RunStop)) throw error;
    return { state: target.kind === "check" ? "failed" : "stopped", failure: error.failure };
  }
  return mergeOnGitHub(session, ports, target.prs, target.method);
}

async function checkOne(session: RunSession, ports: RunPorts, pr: VerifyPr): Promise<void> {
  await step(session, "fetch", undefined, async () => {
    const remote = await prRemote(session, ports);
    await fetchHead(session, ports, remote, pr.pr.number, pr.headSha);
  });
  await inTree(session, ports, pr.headSha, (tree) => setupAndCheck(session, ports, tree.path));
}

/** Combine every head onto the base locally, then set up and check the result once. */
async function checkCombined(
  session: RunSession,
  ports: RunPorts,
  prs: readonly VerifyPr[],
): Promise<void> {
  const base = await step(session, "fetch", undefined, async () => {
    const branch = await sharedBase(session, ports, prs);
    const remote = await prRemote(session, ports);
    const sha = await baseTip(session, ports, remote, branch);
    session.report({ type: "base", branch, sha });
    for (const pr of prs) await fetchHead(session, ports, remote, pr.pr.number, pr.headSha);
    return sha;
  });
  await inTree(session, ports, base, async (tree) => {
    let previous: number | undefined;
    for (const pr of prs) {
      const number = pr.pr.number;
      await step(session, "combine", number, async () => {
        const result = await ports.git.nonExecuting(() =>
          ports.git.integrate({
            worktree: tree.path,
            revision: pr.headSha,
            key: `${integrationPrefix(tree.runId)}${number}`,
          }),
        );
        if (result.conflict !== null)
          throw new RunStop(
            failure(
              "conflict",
              previous === undefined
                ? `#${number} conflicts with ${session.current().base?.branch ?? "its base"}`
                : `#${number} conflicts with #${previous}`,
              { pr: number, ...(previous === undefined ? {} : { with: previous }) },
            ),
          );
      });
      previous = number;
    }
    await setupAndCheck(session, ports, tree.path);
  });
}

/** Work in a fresh checkout of `ref`, removed afterwards whatever happened. */
async function inTree(
  session: RunSession,
  ports: RunPorts,
  ref: string,
  work: (tree: VerifyTree) => Promise<void>,
): Promise<void> {
  const { id } = session.current();
  let tree: VerifyTree | undefined;
  try {
    tree = await ports.trees
      .create({ runId: id, repo: session.project, baseRef: ref, signal: session.signal })
      .catch((error: unknown) => {
        if (session.signal.aborted) throw error;
        throw new RunStop(
          failure("internal", `Could not make a checkout: ${describeError(error)}`),
        );
      });
    await work(tree);
  } finally {
    // A tree whose creation failed part-way is still journalled; the next sweep removes it.
    if (tree) await ports.trees.remove(tree);
  }
}

/** Every PR must target one base branch; each head is read as the person selected it. */
async function sharedBase(
  session: RunSession,
  ports: RunPorts,
  prs: readonly VerifyPr[],
): Promise<string> {
  let base: { branch: string; pr: number } | undefined;
  for (const pr of prs) {
    let branch: string;
    try {
      branch = await ports.forge.base(session.project, pr.pr, pr.headSha, session.signal);
    } catch (error) {
      if (session.signal.aborted) throw error;
      if (isHeadMoved(error))
        throw new RunStop(
          failure("head_moved", `#${pr.pr.number} has new commits; look again and retry`, {
            pr: pr.pr.number,
          }),
        );
      throw new RunStop(
        failure("fetch_failed", `#${pr.pr.number}: ${describeError(error)}`, { pr: pr.pr.number }),
      );
    }
    if (base && base.branch !== branch)
      throw new RunStop(
        failure(
          "fetch_failed",
          `#${pr.pr.number} targets ${branch}, not ${base.branch}; merge them separately`,
          { pr: pr.pr.number },
        ),
      );
    base ??= { branch, pr: pr.pr.number };
  }
  if (!base) throw new RunStop(failure("internal", "No pull request to verify"));
  return base.branch;
}

/** The base branch's tip on the remote, fetched now. */
async function baseTip(
  session: RunSession,
  ports: RunPorts,
  remote: string,
  branch: string,
): Promise<string> {
  await ports.git.nonExecuting(() =>
    ports.git.fetchBranch({
      repo: session.project,
      remote,
      branch,
      timeoutMs: ports.fetchTimeoutMs,
      signal: session.signal,
    }),
  );
  const sha = await ports.git.branchHead({ repo: session.project, branch, remote });
  if (!sha) throw new RunStop(failure("fetch_failed", `${remote} has no branch ${branch}`));
  return sha;
}

/**
 * The check passed: if the base still stands where it was combined, merge each PR on GitHub in
 * order, pinned to its tested head, stopping at the first that does not merge.
 */
async function mergeOnGitHub(
  session: RunSession,
  ports: RunPorts,
  prs: readonly VerifyPr[],
  method: "merge" | "squash" | "rebase",
): Promise<RunOutcome> {
  const base = session.current().base;
  if (!base) return { state: "stopped", failure: failure("internal", "The base was never read") };
  let tip: string;
  try {
    tip = await baseTip(session, ports, await prRemote(session, ports), base.branch);
  } catch (error) {
    if (session.signal.aborted) throw error;
    const reason = error instanceof RunStop ? error.failure.message : describeError(error);
    return {
      state: "stopped",
      failure: failure("fetch_failed", `Could not read ${base.branch} again: ${reason}`),
    };
  }
  if (tip !== base.sha)
    return {
      state: "stopped",
      failure: failure(
        "base_moved",
        `${base.branch} moved after the check passed; nothing was merged`,
      ),
    };
  // The last moment a cancel counts: from here GitHub may change.
  session.signal.throwIfAborted();
  session.report({ type: "merging" });
  for (const [index, pr] of prs.entries()) {
    const number = pr.pr.number;
    if (session.stopping.aborted) return { state: "merging" };
    session.report({ type: "step", kind: "merge", pr: number, state: "running" });
    const result = await ports.forge
      .merge({
        project: session.project,
        workspaceId: session.current().workspaceId,
        runId: session.current().id,
        pr: pr.pr,
        headSha: pr.headSha,
        method,
        allowed: session.allowed,
      })
      .catch(() => ({ outcome: "uncertain" as const }));
    if (result.outcome === "merged") {
      session.report({ type: "merged", pr: number });
      session.report({ type: "step", kind: "merge", pr: number, state: "done" });
      continue;
    }
    session.report({ type: "step", kind: "merge", pr: number, state: "failed" });
    const rest = prs.slice(index + 1).map((entry) => entry.pr.number);
    const left = rest.length ? `; ${prList(rest)} not merged` : "";
    return {
      state: "stopped",
      failure:
        result.outcome === "refused"
          ? failure("merge_refused", `#${number} did not merge: ${result.message}${left}`, {
              pr: number,
            })
          : failure(
              "merge_uncertain",
              `GitHub's answer for #${number} was lost; its page will settle it${left}`,
              { pr: number },
            ),
    };
  }
  return { state: "merged" };
}
