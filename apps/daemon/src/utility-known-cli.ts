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
 * can say: no check of this selection yet, a binary other than the one checked, or a login last
 * seen signed out (the person may have signed in through the CLI since). An old check still
 * names the path: a CLI removed since only fails its run.
 */
export function knownCliPath(known: KnownCli): string | "unavailable" | "probe" {
  const { status } = known;
  if (!status || status.runtime !== "cli" || status.installed === null) return "probe";
  if (known.binary !== undefined && known.binary !== status.path) return "probe";
  if (status.installed === false) return "unavailable";
  if (known.needsLogin && known.auth === "logged_out") return "probe";
  return status.path ?? "probe";
}

/** What asking the CLI itself says: `discoverProvider` from `@ace/provider-kit/discovery`. */
export type DiscoverCli = (binary: string | undefined) => Promise<{
  installed: boolean;
  path?: string | undefined;
  auth: "logged_in" | "logged_out" | "unknown";
}>;

/**
 * The CLI path a run uses: the known one when the daemon's facts say enough, else the CLI's own
 * answer, run with the account's binary. Undefined when the CLI is missing or signed out.
 */
export async function locateKnownCli(
  known: KnownCli,
  discover: DiscoverCli,
): Promise<string | undefined> {
  const path = knownCliPath(known);
  if (path === "unavailable") return undefined;
  if (path !== "probe") return path;
  const cli = await discover(known.binary);
  if (!cli.installed || !cli.path) return undefined;
  if (known.needsLogin && cli.auth === "logged_out") return undefined;
  return cli.path;
}
