import { ForgeError, GitLabHostedMerge, isTeaHost, type GitHubForge } from "@ace/forge";
import type { ForgePrRef, ForgeRepository } from "@ace/protocol";
import type { ForgeBackends } from "./forge-backends.ts";
import { gitlabHostedMerge } from "./gitlab-hosted-merge.ts";
import { gitLabLifecycleBackend, type HostedLifecycleBackend } from "./hosted-lifecycle.ts";
import { gitLabReviewBackend } from "./hosted-review-conversation.ts";
import type { ForgeActionBackend } from "./workspace-forge-actions.ts";

/*
 * Which adapter answers a PR action on each host (ADR 0117): the one place the daemon picks a
 * backend by host. Every writer is refused first for a hidden or unavailable repository
 * (ADR 0116) and runs through a runner that admits exactly that adapter's writes.
 */

/** The backend that writes a hosted review (comments, approvals, thread state). */
export async function reviewBackend(
  backends: ForgeBackends,
  cwd: string,
  pr: ForgePrRef,
  signal: AbortSignal,
) {
  if (pr.repository.forge === "gitlab") return gitLabReviewBackend(backends, cwd, pr, signal);
  if (isTeaHost(pr.repository.forge))
    return backends.teaReviews(cwd, pr.repository, pr.number, signal);
  return backends.writer(cwd, pr.repository);
}

/** The backend the durable PR action journal merges through. */
export async function mergeBackend(
  backends: ForgeBackends,
  cwd: string,
  repository: ForgeRepository,
  signal: AbortSignal,
): Promise<ForgeActionBackend> {
  if (repository.forge === "gitlab")
    return gitlabHostedMerge({ backends, cwd, repository, signal });
  if (isTeaHost(repository.forge))
    return (await backends.teaWriter(cwd, repository, signal)).writer;
  return backends.writer(cwd, repository);
}

/** A non-GitHub host's merge state, read through its read-only identity. */
export async function mergeStateReader(
  backends: ForgeBackends,
  cwd: string,
  repository: ForgeRepository,
  signal: AbortSignal,
): Promise<Pick<GitLabHostedMerge, "prMergeState">> {
  if (repository.forge === "gitlab")
    return new GitLabHostedMerge({
      repository,
      runner: await backends.hostRunner(cwd, repository, [], signal),
    });
  if (isTeaHost(repository.forge)) return backends.teaMergeReader(cwd, repository, signal);
  throw new ForgeError("unsupported");
}

/** The backend that edits a PR's title, body, draft state, labels or reviewers. */
export async function lifecycleBackend(
  backends: ForgeBackends,
  cwd: string,
  repository: ForgeRepository,
  signal: AbortSignal,
): Promise<GitHubForge | HostedLifecycleBackend> {
  if (repository.forge === "gitlab")
    return gitLabLifecycleBackend(backends, cwd, repository, signal);
  return backends.writer(cwd, repository);
}
