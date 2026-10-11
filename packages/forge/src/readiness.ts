import { isForgeMutation } from "./mutation.ts";
import { z } from "zod";
import { SourceControlReadiness, type SourceControlPreferences } from "@ace/protocol";
import type { CommandRunner, CommandRequest } from "./command.ts";
import { ForgeError } from "./errors.ts";

const login = z.object({
  login: z
    .string()
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9-]*$/)
    .max(100),
});
const accounts = z.array(z.object({ login: login.shape.login, active: z.boolean() })).max(100);

/** Ask gh for the effective API identity, including launch-environment authentication. */
export async function githubIdentity(
  runner: CommandRunner,
  host: string,
  signal: AbortSignal,
): Promise<string> {
  const response = await runner({
    command: "gh",
    args: ["api", "user", "--hostname", host],
    signal,
    mode: "json",
  });
  if (response.code !== 0) throw new ForgeError("forbidden");
  try {
    return login.parse(JSON.parse(response.stdout)).login;
  } catch {
    throw new ForgeError("invalid_data");
  }
}

/** Pin every operation to its admitted account. Never switch shared CLI configuration. */
export function identityRunner(
  runner: CommandRunner,
  host: string,
  account: string,
): CommandRunner {
  return async (request: CommandRequest) => {
    if (request.command !== "gh") return runner(request);
    if ((await githubIdentity(runner, host, request.signal)) !== account)
      throw new ForgeError("forbidden");
    const result = await runner(request);
    try {
      if ((await githubIdentity(runner, host, request.signal)) !== account)
        throw new ForgeError("forbidden");
    } catch (error) {
      // Preserve the response from a dispatched write even if the probe fails or is cancelled.
      if (isForgeMutation(request)) return { ...result, identityChanged: true };
      throw error;
    }
    return result;
  };
}

export async function githubReadiness(
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
    status.account = await githubIdentity(runner, host, signal);
    if (!status.accounts.some((entry) => entry.login === status.account))
      status.accounts.push({ login: status.account, active: true });
    status.api = expected && expected !== status.account ? "account_mismatch" : "ready";
    status.instructions =
      status.api === "ready"
        ? `GitHub API access verified as ${status.account} on ${host}.`
        : `Run gh auth switch --hostname ${host} --user ${expected} on this computer, then Rescan. Environment authentication may override stored accounts.`;
  } catch {
    signal.throwIfAborted();
  }
  return SourceControlReadiness.parse(status);
}
