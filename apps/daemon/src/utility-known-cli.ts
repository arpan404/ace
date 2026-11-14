import type { ProviderStatus } from "@ace/protocol";

/** What the daemon already knows about one account's CLI, without launching it. */
export interface KnownCli {
  /** The provider's row from the latest provider check, if it has one. */
  status: Pick<ProviderStatus, "runtime" | "installed" | "path"> | undefined;
  /** The binary the person set for this account, if any. */
  binary: string | undefined;
  /** The account's own login as last observed. */
  auth: "logged_in" | "logged_out" | "unknown";
  /** Whether a signed-out login refuses the run (OpenCode works without one). */
  needsLogin: boolean;
}

/**
 * Where a title or branch-name run finds the provider's CLI, from facts the daemon holds:
 * a path, `"unavailable"` when the run can't go ahead, or `"probe"` when only asking the CLI
 * can say (no check of this selection yet, or a binary other than the one checked). An old
 * check still names the path: a CLI removed since only fails its run, as a lapsed login does.
 */
export function knownCliPath(known: KnownCli): string | "unavailable" | "probe" {
  if (known.needsLogin && known.auth === "logged_out") return "unavailable";
  const { status } = known;
  if (!status || status.runtime !== "cli" || status.installed === null)
    return "probe";
  if (known.binary !== undefined && known.binary !== status.path) return "probe";
  if (status.installed === false) return "unavailable";
  return status.path ?? "probe";
}
