import type { ThreadDetails, WorktreeBase } from "@ace/protocol";

/**
 * What a `thread.create` / `thread.prepare` payload asks its worktree to start from: a branch
 * (`base`, local or on a remote), or the legacy `baseBranch` revision (`HEAD` when absent).
 * `base` wins when both are sent; clients send both so older daemons still pick the commit.
 */
export type RequestedBase =
  | { kind: "branch"; ref: string; remote?: string }
  | { kind: "revision"; revision: string };

export function requestedBase(payload: {
  base?: WorktreeBase | undefined;
  baseBranch?: string | undefined;
}): RequestedBase {
  const { base } = payload;
  if (base)
    return { kind: "branch", ref: base.ref, ...(base.remote ? { remote: base.remote } : {}) };
  return { kind: "revision", revision: payload.baseBranch ?? "HEAD" };
}

/**
 * One string per distinct request, so the worktree prepared before acceptance can be checked
 * against the payload being accepted. Remote names can't contain `:`, so keys never collide.
 */
export function requestedBaseKey(requested: RequestedBase): string {
  if (requested.kind === "revision") return `revision:${requested.revision}`;
  return requested.remote === undefined
    ? `local:${requested.ref}`
    : `remote:${requested.remote}:${requested.ref}`;
}

/** `details.baseBranch` for a request: `origin/main`, `main`, or the legacy string as sent. */
export function baseBranchLabel(payload: {
  base?: WorktreeBase | undefined;
  baseBranch?: string | undefined;
}): string | undefined {
  const { base } = payload;
  if (base) return base.remote ? `${base.remote}/${base.ref}` : base.ref;
  return payload.baseBranch;
}

/**
 * Where a thread's worktree is (re)made from after creation: the exact commit a recorded base
 * started at, else the legacy `baseBranch` revision, else HEAD. Never fetches.
 */
export function recordedBaseRef(details: ThreadDetails | undefined): string {
  return details?.base?.head ?? details?.baseBranch ?? "HEAD";
}
