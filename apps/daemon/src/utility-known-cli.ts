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
  /**
   * The account and its login as last observed (id, login revision, auth): a probe's answer is
   * remembered under it, so any login change asks the CLI afresh.
   */
  login?: string;
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

/** How long a probe's answer stands for the same account, login and binary. */
export const probeMemoMs = 90_000;

/**
 * Recent probe answers, so a login that really is signed out isn't asked about again on every
 * title and branch name. Keyed by the account's observed login and the binary: a sign-in ace
 * sees, or a different binary, asks afresh.
 */
export class ProbeMemo {
  private readonly now: () => number;
  private readonly answers = new Map<string, { at: number; answer: ProbeAnswer }>();
  constructor(now: () => number) {
    this.now = now;
  }
  get(key: string): ProbeAnswer | undefined {
    const entry = this.answers.get(key);
    if (entry && this.now() - entry.at < probeMemoMs) return entry.answer;
    this.answers.delete(key);
    return undefined;
  }
  set(key: string, answer: ProbeAnswer): void {
    // Bounded: entries per account and binary, swept when they pile up.
    if (this.answers.size >= 256)
      for (const [name, entry] of this.answers)
        if (this.now() - entry.at >= probeMemoMs) this.answers.delete(name);
    if (this.answers.size >= 256) this.answers.clear();
    this.answers.set(key, { at: this.now(), answer });
  }
}
type ProbeAnswer = Awaited<ReturnType<DiscoverCli>>;

/**
 * The CLI path a run uses: the known one when the daemon's facts say enough, else the CLI's own
 * answer (remembered in `memo` for a short while), run with the account's binary. Undefined
 * when the CLI is missing or signed out.
 */
export async function locateKnownCli(
  known: KnownCli,
  discover: DiscoverCli,
  memo?: ProbeMemo,
): Promise<string | undefined> {
  const path = knownCliPath(known);
  if (path === "unavailable") return undefined;
  if (path !== "probe") return path;
  const key = known.login === undefined ? undefined : JSON.stringify([known.login, known.binary]);
  const remembered = key === undefined ? undefined : memo?.get(key);
  const cli = remembered ?? (await discover(known.binary));
  if (key !== undefined && !remembered) memo?.set(key, cli);
  if (!cli.installed || !cli.path) return undefined;
  if (known.needsLogin && cli.auth === "logged_out") return undefined;
  return cli.path;
}
