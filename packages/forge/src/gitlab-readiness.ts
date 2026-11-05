import { z } from "zod";
import { ForgeAccount, SourceControlReadiness, type SourceControlPreferences } from "@ace/protocol";
import type { CommandRunner } from "./command.ts";
import { ForgeError } from "./errors.ts";

const gitlabUser = z.object({
  username: ForgeAccount.refine((value) => !value.includes("@"), "Expected a GitLab username"),
});

/**
 * Ask glab for the effective API identity without touching credentials.
 * `glab api <endpoint>` with `--hostname` and `--include` is documented at
 * docs.gitlab.com/cli/api/; the `GET /user` response carries `username`
 * (docs.gitlab.com/api/users). Only the exit code, the `unreachable` flag,
 * truncation and the HTTP status line/headers/body on stdout are read.
 * Stderr never escapes the command boundary and no body text is matched.
 */
export async function gitlabIdentity(
  runner: CommandRunner,
  host: string,
  signal: AbortSignal,
): Promise<string> {
  const result = await runner({
    command: "glab",
    args: ["api", "user", "--hostname", host, "--include"],
    signal,
    mode: "json",
  });
  // A truncated answer proves nothing: it must never produce a ready identity.
  if (result.truncated) throw new ForgeError("invalid_data");
  if (result.unreachable) throw new ForgeError("offline");
  const split = /\r?\n\r?\n/.exec(result.stdout);
  if (!split) {
    // An exit without an HTTP response cannot prove a sign-in problem.
    if (result.code !== 0) throw new ForgeError("cli");
    throw new ForgeError("invalid_data");
  }
  const headerText = result.stdout.slice(0, split.index);
  const bodyText = result.stdout.slice(split.index + split[0].length);
  const statusCode = Number(/^HTTP\/[\d.]+ (\d{3})/i.exec(headerText)?.[1]);
  if (!Number.isInteger(statusCode)) throw new ForgeError("invalid_data");
  const headers: Record<string, string> = {};
  for (const line of headerText.split(/\r?\n/).slice(1)) {
    const colon = line.indexOf(":");
    if (colon > 0) headers[line.slice(0, colon).toLowerCase()] = line.slice(colon + 1).trim();
  }
  const quota = headers["retry-after"] !== undefined || headers["x-ratelimit-remaining"] === "0";
  if (statusCode === 429 || (statusCode === 403 && quota)) throw new ForgeError("rate_limit");
  if (statusCode === 401) throw new ForgeError("forbidden");
  // 403 without quota evidence, 404, 5xx and anything unexpected are server
  // answers, never sign-in answers.
  if (statusCode < 200 || statusCode >= 300) throw new ForgeError("cli");
  if (result.code !== 0) throw new ForgeError("cli");
  let body: unknown;
  try {
    body = JSON.parse(bodyText);
  } catch {
    throw new ForgeError("invalid_data");
  }
  const parsed = gitlabUser.safeParse(body);
  if (!parsed.success) throw new ForgeError("invalid_data");
  return parsed.data.username;
}

/**
 * Bounded glab readiness: `glab --version` (docs.gitlab.com/cli/version/,
 * `-v, --version` on docs.gitlab.com/cli/) then `glab api user`.
 * Read-only probes only; sign-in stays in glab via
 * `glab auth login --hostname <HOSTNAME>` (docs.gitlab.com/cli/auth/login/).
 */
export async function gitlabReadiness(
  runner: CommandRunner,
  preferences: SourceControlPreferences,
  signal: AbortSignal,
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
    instructions: "Install GitLab CLI (glab) on this computer, then Rescan.",
    transport: "unchecked",
    transportInstructions:
      "API sign-in does not verify Git clone or push access. Check a project's remote, or configure your Git credential helper / SSH key on this computer.",
  };
  try {
    const version = await runner({ command: "glab", args: ["--version"], mode: "json", signal });
    if (version.code !== 0) return SourceControlReadiness.parse(status);
    status.cli = "available";
    status.version =
      /^glab version ([a-zA-Z0-9.+-]{1,100})/.exec(version.stdout)?.[1] ?? "Unknown version";
    status.api = "login_required";
    status.instructions = `Run glab auth login --hostname ${host} on this computer, then Rescan.`;
    const account = await gitlabIdentity(runner, host, signal);
    status.accounts = [{ login: account, active: true }];
    status.account = account;
    status.api = expected && expected !== account ? "account_mismatch" : "ready";
    status.instructions =
      status.api === "ready"
        ? `GitLab API access verified as ${account} on ${host}.`
        : `Run glab auth login --hostname ${host} on this computer to sign in as ${expected}, then Rescan. Environment authentication may override stored accounts.`;
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof ForgeError && error.kind === "cancelled") throw error;
    if (status.cli === "available" && error instanceof ForgeError) unreachable(status, error, host);
  }
  return SourceControlReadiness.parse(status);
}

/** Network, quota and server failures are not sign-in answers. */
function unreachable(status: SourceControlReadiness, error: ForgeError, host: string): void {
  if (error.kind === "offline") {
    status.api = "offline";
    status.instructions = `ace couldn't reach ${host}. Check this computer's network connection, then Rescan.`;
  } else if (error.kind === "rate_limit") {
    status.api = "rate_limited";
    status.instructions = `The ${host} API rate limit was reached. Wait a few minutes, then Rescan.`;
  } else if (error.kind !== "forbidden") {
    status.api = "unavailable";
    status.instructions = `The GitLab API check for ${host} was inconclusive. Check this computer's network connection and glab sign-in, then Rescan.`;
  }
}
