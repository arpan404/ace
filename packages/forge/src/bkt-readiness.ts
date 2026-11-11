import { z } from "zod";
import { ForgeAccount, SourceControlReadiness, type SourceControlPreferences } from "@ace/protocol";
import type { CommandRunner } from "./command.ts";
import { ForgeError } from "./errors.ts";
import { bktGet } from "./bkt-api.ts";

/** bkt's key and base URL for Bitbucket Cloud (pkg/cmdutil: every Cloud URL canonicalises here). */
const cloudHost = "api.bitbucket.org";
const cloudBaseUrl = "https://api.bitbucket.org/2.0";
const contextName = z
  .string()
  .regex(/^[A-Za-z0-9_][\w.@-]*$/)
  .max(128);

// bkt pkg/cmd/auth `auth status --json`: hosts and contexts, never a token.
const status = z.looseObject({
  hosts: z
    .array(z.looseObject({ key: z.string(), kind: z.string(), base_url: z.string() }))
    .nullable()
    .default([]),
  contexts: z
    .array(
      z.looseObject({
        name: z.string(),
        host: z.string(),
        workspace: z.string().optional(),
      }),
    )
    .nullable()
    .default([]),
});
/** GET /2.0/user: `username` is Bitbucket's unique handle (nickname and display name aren't). */
const user = z.looseObject({ username: ForgeAccount });

/**
 * The one bkt context ace pins Bitbucket Cloud requests to: a context on the Cloud host, the
 * one for `workspace` when there is one, else the first by name. Never bkt's active context,
 * which can point at a Data Center host. Re-read on every probe, so an edit fails closed.
 */
export async function bktContext(
  runner: CommandRunner,
  workspace: string | undefined,
  signal: AbortSignal,
): Promise<string> {
  const result = await runner({
    command: "bkt",
    args: ["auth", "status", "--json"],
    mode: "json",
    signal,
  });
  if (result.truncated) throw new ForgeError("limit");
  if (result.code !== 0) throw new ForgeError("cli");
  let data;
  try {
    data = status.parse(JSON.parse(result.stdout));
  } catch {
    throw new ForgeError("invalid_data");
  }
  const cloud = (data.hosts ?? []).filter(
    (h) => h.key === cloudHost && h.kind === "cloud" && h.base_url === cloudBaseUrl,
  );
  if (cloud.length !== 1) throw new ForgeError("forbidden");
  const contexts = (data.contexts ?? [])
    .filter((c) => c.host === cloudHost && contextName.safeParse(c.name).success)
    .toSorted((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const chosen = contexts.find((c) => c.workspace === workspace) ?? contexts[0];
  if (!chosen) throw new ForgeError("forbidden");
  return chosen.name;
}

/** The account `context` is signed in as, after proving ace would still pick that context. */
export async function bktIdentity(
  runner: CommandRunner,
  context: string,
  workspace: string | undefined,
  signal: AbortSignal,
): Promise<string> {
  if ((await bktContext(runner, workspace, signal)) !== context) throw new ForgeError("forbidden");
  const parsed = user.safeParse(await bktGet(runner, context, "/2.0/user", signal));
  if (!parsed.success) throw new ForgeError("invalid_data");
  return parsed.data.username;
}

export async function bktReadiness(
  runner: CommandRunner,
  preferences: SourceControlPreferences,
  signal: AbortSignal,
): Promise<SourceControlReadiness> {
  const readiness: SourceControlReadiness = {
    preferences,
    cli: "unavailable",
    version: null,
    accounts: [],
    account: null,
    api: "unavailable",
    instructions: "Install the Bitbucket CLI (bkt), then Rescan.",
    transport: "unchecked",
    transportInstructions: "Check a project's remote to verify Git access.",
  };
  if (preferences.host !== "bitbucket.org") {
    readiness.instructions =
      "ace reads Bitbucket Cloud (bitbucket.org) only. Bitbucket Data Center isn't supported.";
    return SourceControlReadiness.parse(readiness);
  }
  try {
    const version = await runner({ command: "bkt", args: ["--version"], mode: "json", signal });
    if (version.code !== 0 || version.truncated) return SourceControlReadiness.parse(readiness);
    readiness.cli = "available";
    readiness.version =
      /(\d+\.\d+\.\d+[\w.+-]{0,40})/.exec(version.stdout)?.[1] ?? "Unknown version";
    const context = await bktContext(runner, undefined, signal);
    const account = await bktIdentity(runner, context, undefined, signal);
    const expected = preferences.hosts.find((h) => h.host === preferences.host)?.account;
    readiness.accounts = [{ login: account, active: true }];
    readiness.account = account;
    readiness.api = expected && expected !== account ? "account_mismatch" : "ready";
    readiness.instructions =
      readiness.api === "ready"
        ? `bkt API access verified as ${account} on Bitbucket Cloud (context ${context}).`
        : "Sign bkt in as the expected account, then Rescan.";
  } catch (error) {
    signal.throwIfAborted();
    if (readiness.cli === "available") {
      const kind = error instanceof ForgeError ? error.kind : undefined;
      readiness.api =
        kind === "offline"
          ? "offline"
          : kind === "rate_limit"
            ? "rate_limited"
            : kind === "forbidden"
              ? "login_required"
              : "unavailable";
      readiness.instructions =
        "Run bkt auth login https://bitbucket.org --kind cloud --web, then bkt context create <name> --host api.bitbucket.org --workspace <workspace>, then Rescan.";
    }
  }
  return SourceControlReadiness.parse(readiness);
}
