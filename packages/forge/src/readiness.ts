import { isForgeMutation } from "./mutation.ts";
import { z } from "zod";
import { SourceControlReadiness, type SourceControlPreferences } from "@ace/protocol";
import type { CommandRunner, CommandRequest } from "./command.ts";
import { ForgeError } from "./errors.ts";
import { GhApi } from "./http.ts";

const login = z.object({
  login: z
    .string()
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9-]*$/)
    .max(100),
});
const accounts = z.array(z.object({ login: login.shape.login, active: z.boolean() })).max(100);

/** Ask gh for the effective API identity, including launch-environment authentication.
 * The response goes through the shared HTTP classifier: an unreachable host is `offline`,
 * a rate-limited `/user` is `rate_limit`, and only 401/403 or gh's sign-in exit are `forbidden`. */
export async function githubIdentity(
  runner: CommandRunner,
  host: string,
  signal: AbortSignal,
  now: () => number,
): Promise<string> {
  const response = await new GhApi({ runner, host, now }).request("user", signal);
  const parsed = login.safeParse(response.body);
  if (!parsed.success) throw new ForgeError("invalid_data");
  return parsed.data.login;
}

/** How long a verified identity admits reads without another `/user` probe. */
export const identityVerificationMs = 60_000;

export type IdentityRunnerOptions = {
  now: () => number;
  /** When the caller last verified the account itself, so the first read needs no probe. */
  verifiedAt?: number;
  ttlMs?: number;
};

/** Pin every operation to its admitted account. Never switch shared CLI configuration.
 * Reads reuse a verification for a short window; every write is verified immediately before
 * dispatch. Without `options` (no clock), every request is verified. */
export function identityRunner(
  runner: CommandRunner,
  host: string,
  account: string,
  assertCurrent: () => void | Promise<void> = () => {},
  options?: IdentityRunnerOptions,
): CommandRunner {
  let verifiedAt = options?.verifiedAt;
  const ttl = options?.ttlMs ?? identityVerificationMs;
  const clock = options?.now ?? (() => 0);
  const fresh = () => {
    if (!options || verifiedAt === undefined) return false;
    const age = options.now() - verifiedAt;
    return age >= 0 && age < ttl;
  };
  const verify = async (signal: AbortSignal) => {
    if ((await githubIdentity(runner, host, signal, clock)) !== account) {
      verifiedAt = undefined;
      throw new ForgeError("forbidden");
    }
    verifiedAt = options?.now();
  };
  // Reads that need a probe at the same moment share one.
  let probing: Promise<void> | undefined;
  const verifyRead = async (signal: AbortSignal) => {
    const shared = (probing ??= verify(signal).finally(() => (probing = undefined)));
    try {
      await shared;
    } catch (error) {
      // Another read's cancellation proves nothing about this one: probe for it alone.
      if (error instanceof ForgeError && error.kind === "cancelled" && !signal.aborted)
        return verify(signal);
      throw error;
    }
  };
  return async (request: CommandRequest) => {
    await assertCurrent();
    if (request.command !== "gh") return runner(request);
    const write = isForgeMutation(request);
    if (!write && !fresh()) {
      // A read has no effect, so it runs beside its identity probe instead of after it; its
      // answer is only returned once the probe proves the account it was read as.
      const [checked, read] = await Promise.allSettled([
        verifyRead(request.signal),
        runner(request),
      ]);
      if (checked.status === "rejected") throw checked.reason;
      // Preferences may change while the identity process is running.
      await assertCurrent();
      if (read.status === "rejected") throw read.reason;
      return read.value;
    }
    if (write) {
      await verify(request.signal);
      await assertCurrent();
    }
    const result = await runner(request);
    if (!write) return result;
    // A dispatched write keeps its response. Only a confirmed different account, or changed
    // preferences, make its outcome uncertain; an unavailable probe proves nothing.
    try {
      if ((await githubIdentity(runner, host, request.signal, clock)) !== account)
        return { ...result, identityChanged: true };
      verifiedAt = options?.now();
    } catch {
      /* Offline, rate limited or cancelled after the write: no evidence of a switch. */
    }
    try {
      await assertCurrent();
    } catch {
      return { ...result, identityChanged: true };
    }
    return result;
  };
}

export async function githubReadiness(
  runner: CommandRunner,
  preferences: SourceControlPreferences,
  signal: AbortSignal,
  now: () => number,
): Promise<SourceControlReadiness> {
  const host = preferences.host;
  const expected = preferences.hosts.find((entry) => entry.host === host)?.account;
  const status: SourceControlReadiness = {
    preferences,
    cli: "unavailable",
    version: null,
    accounts: [],
    account: null,
    api: "unavailable",
    instructions: "Install GitHub CLI (gh) on this computer, then Rescan.",
    transport: "unchecked",
    transportInstructions:
      "API sign-in does not verify Git clone or push access. Check a project's remote, or configure your Git credential helper / SSH key on this computer.",
  };
  try {
    const version = await runner({ command: "gh", args: ["--version"], mode: "json", signal });
    if (version.code !== 0) return status;
    status.cli = "available";
    status.version =
      /^gh version ([a-zA-Z0-9.+-]{1,100})/.exec(version.stdout)?.[1] ?? "Unknown version";
    status.api = "login_required";
    status.instructions = `Run gh auth login --hostname ${host} on this computer, then Rescan.`;
    // Older gh has no JSON auth status. Only request reviewed nonsecret fields on supported versions.
    const help = await runner({
      command: "gh",
      args: ["auth", "status", "--help"],
      mode: "json",
      signal,
    });
    if (help.stdout.includes("--json")) {
      const result = await runner({
        command: "gh",
        args: [
          "auth",
          "status",
          "--hostname",
          host,
          "--json",
          "hosts",
          "--jq",
          "[.hosts[][] | {login,active}]",
        ],
        mode: "json",
        signal,
      });
      if (result.code === 0) status.accounts = accounts.parse(JSON.parse(result.stdout));
    }
    status.account = await githubIdentity(runner, host, signal, now);
    if (!status.accounts.some((entry) => entry.login === status.account))
      status.accounts.push({ login: status.account, active: true });
    status.api = expected && expected !== status.account ? "account_mismatch" : "ready";
    status.instructions =
      status.api === "ready"
        ? `GitHub API access verified as ${status.account} on ${host}.`
        : `Run gh auth switch --hostname ${host} --user ${expected} on this computer, then Rescan. Environment authentication may override stored accounts.`;
  } catch (error) {
    signal.throwIfAborted();
    if (status.cli === "available" && error instanceof ForgeError) unreachable(status, error, host);
  }
  return SourceControlReadiness.parse(status);
}

/** Network and quota failures are not sign-in answers; say what actually happened. */
function unreachable(status: SourceControlReadiness, error: ForgeError, host: string): void {
  if (error.kind === "offline") {
    status.api = "offline";
    status.instructions = `ace couldn't reach ${host}. Check this computer's network connection, then Rescan.`;
  } else if (error.kind === "rate_limit") {
    status.api = "rate_limited";
    status.instructions = `The ${host} API rate limit was reached. Wait a few minutes, then Rescan.`;
  }
}
