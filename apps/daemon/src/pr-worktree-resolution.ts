import { ForgeError, repositoryFromRemote, repositoryKey } from "@ace/forge";
import type { GitService } from "@ace/git";
import type {
  ForgePrWorktree,
  ForgePrDetail,
  ForgePrCheckout,
  ForgePrWorkspace,
  ForgeRepository,
} from "@ace/protocol";

export type PrRemotes = readonly { name: string; fetchUrls: readonly string[] }[];
/** Match the PR's base repository, not its fork or whichever remote happens to be first. */
export function prRemote(remotes: PrRemotes, repository: ForgeRepository): string {
  const found = remotes.find((remote) =>
    remote.fetchUrls.some((url) => {
      try {
        return repositoryKey(repositoryFromRemote(url)) === repositoryKey(repository);
      } catch {
        return false;
      }
    }),
  );
  if (!found) throw new Error("repository_mismatch");
  return found.name;
}
export function prReviewContext(detail: ForgePrDetail): {
  context: string;
  contextTruncated: boolean;
} {
  const text = [
    `Review GitHub PR #${detail.status.ref.number}: ${detail.status.title}`,
    detail.status.url,
    `Head: ${detail.headBranch} (${detail.status.headSha})`,
    `Base: ${detail.baseBranch} (${detail.baseSha})`,
    detail.body,
    ...detail.status.comments.map(
      (comment) =>
        `${comment.kind === "inline" ? "Inline review" : comment.kind === "review" ? "Submitted review" : "PR conversation"} by ${comment.author}${comment.file ? ` on ${comment.file}:${comment.line ?? ""}` : ""}\n${comment.body}`,
    ),
  ].join("\n\n");
  return {
    context:
      text.slice(0, 65000) +
      (text.length > 65000
        ? "\n\n[Review context truncated. Open the PR workspace for the complete conversation.]"
        : ""),
    contextTruncated: text.length > 65000,
  };
}
export interface PreparedPrBase {
  head: string;
  pullRequestWorkspace: ForgePrWorkspace;
  prStatus: ForgePrDetail["status"];
  verify(worktree: string): Promise<void>;
}
export type PreparePrBase = (
  project: string,
  selection: ForgePrWorktree,
  io: { signal?: AbortSignal; stderr?: (chunk: Buffer) => void },
) => Promise<PreparedPrBase>;
/** CLI-only metadata and bounded fetch; no cached-head fallback is allowed for a PR checkout. */
export function prBasePreparation(options: {
  git: Pick<GitService, "repositoryInfo" | "fetchPrHead" | "resolveCommit">;
  detail(project: string, selection: ForgePrWorktree, signal: AbortSignal): Promise<ForgePrDetail>;
  checkout(
    project: string,
    selection: ForgePrWorktree,
    signal: AbortSignal,
  ): Promise<ForgePrCheckout>;
  signal: AbortSignal;
  timeoutMs: number;
  remote?: (remotes: PrRemotes, repository: ForgeRepository) => string;
}): PreparePrBase {
  return async (project, selection, io) => {
    const signal = io.signal ? AbortSignal.any([io.signal, options.signal]) : options.signal;
    signal.throwIfAborted();
    const detail = await options.detail(project, selection, signal);
    const initial = await options.checkout(project, selection, signal);
    if (initial.baseSha !== detail.baseSha) throw new ForgeError("conflict");
    const metadata = await options.git.repositoryInfo(project);
    const remote = (options.remote ?? prRemote)(metadata.remotes, selection.ref.repository);
    const head = await options.git.fetchPrHead({
      repo: project,
      remote,
      number: selection.ref.number,
      timeoutMs: options.timeoutMs,
      signal,
      ...(io.stderr ? { stderr: io.stderr } : {}),
    });
    if (head !== selection.headSha) throw new ForgeError("conflict");
    const pullRequestWorkspace: ForgePrWorkspace = {
      ref: selection.ref,
      headSha: head,
      baseSha: detail.baseSha,
      headBranch: detail.headBranch,
      baseBranch: detail.baseBranch,
      headRepository: detail.headRepository,
      ...prReviewContext(detail),
    };
    return {
      head,
      pullRequestWorkspace,
      prStatus: detail.status,
      verify: async (worktree) => {
        signal.throwIfAborted();
        const latest = await options.checkout(project, selection, signal);
        const actual = await options.git.resolveCommit({ worktree, ref: "HEAD" });
        if (
          latest.headSha !== head ||
          latest.baseSha !== detail.baseSha ||
          latest.headBranch !== detail.headBranch ||
          JSON.stringify(latest.headRepository) !== JSON.stringify(detail.headRepository) ||
          actual !== head
        )
          throw new ForgeError("conflict");
        signal.throwIfAborted();
      },
    };
  };
}
