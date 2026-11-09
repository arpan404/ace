import { z } from "zod";
import {
  ForgeAccount,
  SourceControlReadiness,
  originApiHost,
  type SourceControlPreferences,
} from "@ace/protocol";
import type { CommandRunner } from "./command.ts";
import { ForgeError } from "./errors.ts";

const namespaces = z.object({ namespaces: z.array(z.unknown()) });
const auth = z.object({
  account: z.union([ForgeAccount, z.object({ email: z.email(), handle: z.string().optional() })]),
});

/** Reads only the selected nonsecret account field, never `origin auth token`. */
export async function originIdentity(runner: CommandRunner, signal: AbortSignal): Promise<string> {
  const result = await runner({
    command: "origin",
    args: ["auth", "status", "--json", "account"],
    mode: "json",
    signal,
  });
  if (result.unreachable) throw new ForgeError("offline");
  if (result.truncated) throw new ForgeError("limit");
  if (result.code !== 0) throw new ForgeError("forbidden");
  try {
    const parsed = auth.parse(JSON.parse(result.stdout));
    return ForgeAccount.parse(
      typeof parsed.account === "string" ? parsed.account : parsed.account.email,
    );
  } catch {
    throw new ForgeError("invalid_data");
  }
}

export async function originReadiness(
  runner: CommandRunner,
  preferences: SourceControlPreferences,
  signal: AbortSignal,
): Promise<SourceControlReadiness> {
  if (preferences.host !== originApiHost) throw new ForgeError("unsupported");
  const status: SourceControlReadiness = {
    preferences,
    cli: "unavailable",
    version: null,
    accounts: [],
    account: null,
    api: "unavailable",
    instructions: "Install Cursor Origin CLI (origin) on this computer, then Rescan.",
    transport: "unchecked",
    transportInstructions:
      "Git access uses your Origin CLI credential helper or SSH key. Check a project's remote to verify access.",
  };
  try {
    const version = await runner({ command: "origin", args: ["--version"], mode: "json", signal });
    if (version.code !== 0 || version.truncated) return status;
    status.cli = "available";
    status.version =
      /(?:origin(?: version)?|Origin(?: CLI)?)[ /v]+([0-9][a-zA-Z0-9.+-]{0,99})/.exec(
        version.stdout,
      )?.[1] ?? "Unknown version";
    const account = await originIdentity(runner, signal);
    const access = await runner({
      command: "origin",
      args: ["api", "/namespaces", "--method", "GET"],
      mode: "json",
      signal,
    });
    if (access.truncated) throw new ForgeError("limit");
    if (access.unreachable) throw new ForgeError("offline");
    if (access.code !== 0) throw new ForgeError("cli");
    try {
      namespaces.parse(JSON.parse(access.stdout));
    } catch {
      throw new ForgeError("invalid_data");
    }
    const expected = preferences.hosts.find((entry) => entry.host === preferences.host)?.account;
    status.account = account;
    status.accounts = [{ login: account, active: true }];
    status.api = expected && expected !== account ? "account_mismatch" : "ready";
    status.instructions =
      status.api === "ready"
        ? "Cursor Origin CLI account verified."
        : `Run origin auth login on this computer to sign in as ${expected}, then Rescan.`;
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof ForgeError && error.kind === "cancelled") throw error;
    if (status.cli === "available") {
      status.api =
        error instanceof ForgeError && error.kind === "offline"
          ? "offline"
          : error instanceof ForgeError && error.kind === "forbidden"
            ? "login_required"
            : "unavailable";
      status.instructions =
        status.api === "login_required"
          ? "Run origin auth login on this computer, then Rescan."
          : "Couldn't verify the Origin account. Check this computer's connection and Origin CLI, then Rescan.";
    }
  }
  return SourceControlReadiness.parse(status);
}
