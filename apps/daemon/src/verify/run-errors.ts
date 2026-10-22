import { ForgeError } from "@ace/forge";
import { GitError } from "@ace/git";

/** Words a person can act on, for a failure the runner did not expect. */
export function describeError(error: unknown): string {
  if (error instanceof ForgeError) return forgeWords[error.kind] ?? `GitHub: ${error.kind}`;
  if (error instanceof GitError) return error.message || `Git failed (${error.code})`;
  if (error instanceof Error) return error.message;
  return "Unknown error";
}

export function isHeadMoved(error: unknown): boolean {
  return (
    (error instanceof ForgeError && error.kind === "head_moved") ||
    (error instanceof GitError && error.code === "head_moved")
  );
}

const forgeWords: Partial<Record<ForgeError["kind"], string>> = {
  not_found: "GitHub can't find this pull request",
  forbidden: "GitHub refused access; check `gh auth status`",
  rate_limit: "GitHub's rate limit was reached; try again later",
  offline: "GitHub can't be reached",
  conflict: "GitHub refused: the pull request can't be merged as it is",
  head_missing: "The pull request's branch was deleted",
  fork_deleted: "The pull request's fork was deleted",
  head_moved: "The pull request has new commits",
  cli: "The GitHub CLI failed; check `gh auth status`",
  unprocessable: "GitHub refused the request",
};
