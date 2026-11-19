import { z } from "zod";
import { ForgeAccount, SourceControlReadiness, type SourceControlPreferences } from "@ace/protocol";
import type { CommandRunner } from "./command.ts";
import { ForgeError } from "./errors.ts";
import { teaGet } from "./tea-api.ts";

// tea modules/print/login.go and table.go: JSON uses the lower-case table headers.
const logins = z.array(
  z.object({ name: z.string().min(1).max(256), url: z.string(), user: ForgeAccount }),
);
const user = z.object({ login: ForgeAccount });

/** Resolve exactly one login on the pinned HTTPS host, never tea's working-directory default. */
export async function teaLogin(
  runner: CommandRunner,
  host: string,
  signal: AbortSignal,
): Promise<string> {
  const result = await runner({
    command: "tea",
    args: ["login", "list", "--output", "json"],
    mode: "json",
    signal,
  });
  if (result.truncated) throw new ForgeError("limit");
  if (result.unreachable) throw new ForgeError("offline");
  if (result.code !== 0) throw new ForgeError("cli");
  let data;
  try {
    data = logins.parse(JSON.parse(result.stdout));
  } catch {
    throw new ForgeError("invalid_data");
  }
  const matches = data.filter((entry) => {
    try {
      const url = new URL(entry.url);
      return (
        url.protocol === "https:" &&
        url.host === host &&
        !url.username &&
        !url.password &&
        url.pathname === "/" &&
        !url.search &&
        !url.hash &&
        !entry.name.startsWith("-")
      );
    } catch {
      return false;
    }
  });
  const match = matches[0];
  if (matches.length !== 1 || !match) throw new ForgeError("forbidden");
  return match.name;
}

/** Re-resolve the login mapping on every probe so edited tea configuration fails closed. */
export async function teaIdentity(
  runner: CommandRunner,
  host: string,
  login: string,
  signal: AbortSignal,
): Promise<string> {
  if ((await teaLogin(runner, host, signal)) !== login) throw new ForgeError("forbidden");
  const response = await teaGet(runner, login, "user", signal);
  const parsed = user.safeParse(response.body);
  if (!parsed.success) throw new ForgeError("invalid_data");
  return parsed.data.login;
}

export async function teaReadiness(
  runner: CommandRunner,
  preferences: SourceControlPreferences,
  signal: AbortSignal,
): Promise<SourceControlReadiness> {
  const status: SourceControlReadiness = {
    preferences,
    cli: "unavailable",
    version: null,
    accounts: [],
    account: null,
    api: "unavailable",
    instructions: "Install Gitea CLI (tea) with the api command, then Rescan.",
    transport: "unchecked",
    transportInstructions: "Check a project's remote to verify Git access.",
  };
  try {
    const version = await runner({ command: "tea", args: ["--version"], mode: "json", signal });
    if (version.code !== 0 || version.truncated) return status;
    status.cli = "available";
    status.version =
      /(?:tea version |Version: )([\w.+-]{1,100})/.exec(version.stdout)?.[1] ?? "Unknown version";
    const login = await teaLogin(runner, preferences.host, signal);
    const account = await teaIdentity(runner, preferences.host, login, signal);
    const expected = preferences.hosts.find((h) => h.host === preferences.host)?.account;
    status.accounts = [{ login: account, active: true }];
    status.account = account;
    status.api = expected && expected !== account ? "account_mismatch" : "ready";
    status.instructions =
      status.api === "ready"
        ? `tea API access verified as ${account} on ${preferences.host}.`
        : "Select the expected account in tea, then Rescan.";
  } catch (error) {
    signal.throwIfAborted();
    if (status.cli === "available") {
      status.api =
        error instanceof ForgeError && error.kind === "offline"
          ? "offline"
          : error instanceof ForgeError && error.kind === "rate_limit"
            ? "rate_limited"
            : error instanceof ForgeError && error.kind === "forbidden"
              ? "login_required"
              : "unavailable";
      status.instructions =
        "Check tea login list and API access. Configure exactly one HTTPS login for this host, then Rescan.";
    }
  }
  return SourceControlReadiness.parse(status);
}
