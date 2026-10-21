/**
 * Fixed public failure categories. The daemon publishes each as `forge_<kind>`.
 *
 * - `offline`: no HTTP response at all (network down, DNS, proxy). Never an auth answer.
 * - `forbidden`: the host answered 401/403, or gh reported that sign-in is required.
 * - `rate_limit`: primary or secondary rate limit; `retryAt` says when to try again.
 * - `no_commits`: a PR create was refused because head has no commits beyond base.
 * - `head_missing`: the PR head branch does not exist on the host (not pushed, or deleted).
 * - `base_missing`: the PR base branch does not exist on the host.
 * - `pr_exists`: an open PR already exists for this head and base.
 * - `unprocessable`: any other 422 validation refusal.
 * - `head_moved`: a PR's head commit changed after it was selected.
 * - `fork_deleted`: the PR's head repository (usually a fork) no longer exists.
 * - `conflict`: the resource changed under a guarded write (stale SHA, 409, stale read).
 */
export type ForgeErrorKind =
  | "not_found"
  | "forbidden"
  | "rate_limit"
  | "offline"
  | "invalid_data"
  | "limit"
  | "cli"
  | "cancelled"
  | "unsupported"
  | "conflict"
  | "no_commits"
  | "head_missing"
  | "base_missing"
  | "pr_exists"
  | "unprocessable"
  | "head_moved"
  | "fork_deleted"
  | "outcome_uncertain"
  | "preferences_changed";
export class ForgeError extends Error {
  readonly kind: ForgeErrorKind;
  readonly retryAt: number | undefined;
  readonly dispatched: false | undefined;
  constructor(kind: ForgeErrorKind, retryAt?: number, dispatched?: false) {
    super(`Forge request failed: ${kind}`);
    this.name = "ForgeError";
    this.kind = kind;
    this.retryAt = retryAt;
    this.dispatched = dispatched;
  }
}

/**
 * GitHub refused a GraphQL document itself (a field this host doesn't have): the same document
 * will be refused again, so a reader may ask a smaller one. Unlike an unreadable answer, which
 * says nothing about the document and must reach the caller as `invalid_data`.
 */
export class ForgeQueryRefused extends ForgeError {
  constructor() {
    super("invalid_data", undefined, false);
    this.name = "ForgeQueryRefused";
  }
}
