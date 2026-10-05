import type { GitStatusFile } from "@ace/protocol";

/** Tracked files a fake checkout's uncommitted diff is spread over, in order. */
const tracked = [
  "src/lib/retry.ts",
  "src/lib/retry.test.ts",
  "src/config.ts",
  "src/index.ts",
  "README.md",
  "package.json",
];

/**
 * The files `git status` would report for a fake checkout whose details say it has `files`
 * uncommitted files with `additions` and `deletions` lines: tracked edits whose counts add up to
 * the details' totals. Scenarios that need untracked or renamed files set them
 * (`FakeDaemon.workspace.setGitStatus`).
 */
export function synthesizedStatus(diff: {
  files: number;
  additions: number;
  deletions: number;
}): GitStatusFile[] {
  const count = Math.min(diff.files, tracked.length);
  if (count <= 0) return [];
  const share = (total: number, index: number) =>
    Math.floor(total / count) + (index < total % count ? 1 : 0);
  return tracked
    .slice(0, count)
    .map((path, index) => ({
      path,
      status: "modified" as const,
      additions: share(diff.additions, index),
      deletions: share(diff.deletions, index),
      binary: false,
    }))
    .toSorted((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}
