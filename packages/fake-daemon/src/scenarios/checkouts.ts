import type { Thread } from "@ace/protocol";

/**
 * A thread's checkout as the daemon projects it into `details` after a git refresh: the
 * worktree, branch, head, how far it is ahead of its remote, the uncommitted diff, the forge
 * repository behind origin and a linked PR. Scenarios use it so the header's Run, Open and git
 * controls show the same state a real daemon would report.
 */
export function checkout(options: {
  workspaceId: string;
  branch: string;
  path: string;
  head: string;
  mode?: "worktree" | "local";
  ahead?: number;
  diff?: { files: number; additions: number; deletions: number };
  pr?: { number: number; state: "open" | "closed" | "merged" };
}): NonNullable<Thread["details"]> {
  const repository = {
    forge: "github" as const,
    host: "github.com",
    owner: "acme",
    name: options.workspaceId,
  };
  return {
    workspace: {
      id: options.workspaceId,
      name: options.workspaceId,
      path: `/Users/dev/${options.workspaceId}`,
    },
    mode: options.mode ?? "worktree",
    worktree: options.path,
    branch: options.branch,
    head: options.head.repeat(40 / options.head.length).slice(0, 40),
    ahead: options.ahead ?? 0,
    behind: 0,
    baseBranch: "main",
    repository,
    linkedPr: options.pr
      ? {
          ...options.pr,
          url: `https://github.com/acme/${options.workspaceId}/pull/${options.pr.number}`,
        }
      : null,
    machine: { host: "fake-host", name: "This Mac" },
    diff: options.diff ?? { files: 0, additions: 0, deletions: 0 },
  };
}
