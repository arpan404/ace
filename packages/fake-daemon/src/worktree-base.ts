import type { BranchRef, ThreadDetails, WorktreeBase } from "@ace/protocol";

/** The fake project's branches as `branches.list` tells them apart. */
export const fakeBranchRefs: readonly BranchRef[] = [
  { name: "develop", upstream: "origin/develop", ahead: 0, behind: 0 },
  { name: "main", upstream: "origin/main", ahead: 0, behind: 2 },
  { name: "develop", remote: "origin" },
  { name: "feature/sheet-rotate", remote: "origin" },
  { name: "fix/login-timeout", remote: "origin" },
  { name: "main", remote: "origin" },
  { name: "release/0.9", remote: "origin" },
];

/** A stable 40-hex fake commit per branch, so the same base always reports the same head. */
function fakeCommit(seed: string): string {
  let hex = "";
  for (let round = 0; hex.length < 40; round++) {
    let hash = 0x811c9dc5 ^ round;
    for (const char of seed) hash = Math.imul(hash ^ char.charCodeAt(0), 0x01000193);
    hex += (hash >>> 0).toString(16).padStart(8, "0");
  }
  return hex.slice(0, 40);
}

type BaseFields = Pick<ThreadDetails, "branch" | "baseBranch" | "base">;

/**
 * The checkout fields a fake `thread.create` / `thread.prepare` records, or the error the real
 * daemon would refuse it with. `base` wins over `baseBranch`; without `base` the fake keeps its
 * old behaviour (the thread sits on `baseBranch`). A worktree from a `base` gets a branch of its
 * own; a remote base is "fetched" unless the remote is unreachable, then the listed (cached)
 * copy is used, and an unlisted one can't be.
 */
export function fakeWorktreeBase(
  payload: {
    mode?: "local" | "worktree" | undefined;
    base?: WorktreeBase | undefined;
    baseBranch?: string | undefined;
  },
  threadId: string,
  remoteReachable: boolean,
): { ok: true; fields: BaseFields } | { ok: false; error: string } {
  const { base } = payload;
  if (!base)
    return {
      ok: true,
      fields: {
        branch: payload.baseBranch ?? "main",
        ...(payload.baseBranch ? { baseBranch: payload.baseBranch } : {}),
      },
    };
  const listed = fakeBranchRefs.some((ref) => ref.name === base.ref && ref.remote === base.remote);
  if (base.remote && !listed && !remoteReachable)
    return { ok: false, error: "worktree_base_unreachable" };
  if (!listed) return { ok: false, error: "worktree_base_not_found" };
  const label = base.remote ? `${base.remote}/${base.ref}` : base.ref;
  return {
    ok: true,
    fields: {
      branch: payload.mode === "worktree" ? `ace/${threadId.slice(0, 8)}` : base.ref,
      baseBranch: label,
      base: {
        ref: base.ref,
        ...(base.remote
          ? { remote: base.remote, fetch: remoteReachable ? "fetched" : "unreachable" }
          : {}),
        head: fakeCommit(label),
      },
    },
  };
}
