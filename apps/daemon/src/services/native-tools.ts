import { logError, logFields } from "@ace/diagnostics";
import type { ProviderAdapter, SessionContext } from "@ace/engine-api";
import { SettingsValues } from "@ace/protocol";
import { defaultCodexHome } from "../account-homes.ts";
import {
  claudeChromeFlag,
  codexLaunchArgs,
  nodeNativeToolFiles,
  type NativeToolFiles,
} from "../native-tools/read.ts";

/*
 * Starts Codex and Claude sessions with the person's own tool setup (ADR 0128): Codex accounts
 * get the tool source's plugins, marketplaces and MCP servers; Claude gets the Chrome flag.
 */

export interface NativeToolsContext {
  settings:
    | {
        get(
          key: "providers.codex.toolSource" | "providers.claude.chrome",
        ): Promise<{ value: unknown }>;
      }
    | undefined;
  log: { log(level: "debug" | "info" | "warn", message: string, data?: unknown): void };
  /** The daemon's own environment: the person's default Codex home and Claude config. */
  env: NodeJS.ProcessEnv;
  files?: NativeToolFiles;
}

/* Each setting's saved value, or its default when the store is absent or holds something odd. */
export async function codexToolSourceSetting(
  settings: NativeToolsContext["settings"],
): Promise<string | null> {
  const entry = await settings?.get("providers.codex.toolSource").catch(() => undefined);
  const parsed = SettingsValues.shape["providers.codex.toolSource"].safeParse(entry?.value);
  return parsed.success ? parsed.data : null;
}
export async function claudeChromeSetting(
  settings: NativeToolsContext["settings"],
): Promise<SettingsValues["providers.claude.chrome"]> {
  const entry = await settings?.get("providers.claude.chrome").catch(() => undefined);
  const parsed = SettingsValues.shape["providers.claude.chrome"].safeParse(entry?.value);
  return parsed.success ? parsed.data : "auto";
}

async function codexSession(
  context: NativeToolsContext,
  session: SessionContext,
): Promise<SessionContext> {
  try {
    const homeDir =
      session.instanceHomeDir ?? session.env?.["CODEX_HOME"] ?? defaultCodexHome(context.env);
    const launch = await codexLaunchArgs({
      setting: await codexToolSourceSetting(context.settings),
      env: context.env,
      homeDir,
      files: context.files ?? nodeNativeToolFiles,
    });
    if (launch.problem)
      context.log.log(
        "warn",
        "Codex tool source unusable; starting without it",
        logFields([["reason", launch.problem]]),
      );
    if (!launch.args.length) return session;
    // Names only: an MCP server's env or headers can hold secrets.
    context.log.log("debug", "Codex tool source applied", logFields([["entries", launch.entries]]));
    return { ...session, toolConfigArgs: launch.args };
  } catch (error) {
    context.log.log("warn", "Codex tool source unreadable", logError(error));
    return session;
  }
}

async function claudeSession(
  context: NativeToolsContext,
  session: SessionContext,
): Promise<SessionContext> {
  const chrome = await claudeChromeFlag(
    await claudeChromeSetting(context.settings),
    context.env,
    context.files ?? nodeNativeToolFiles,
  );
  return chrome === undefined ? session : { ...session, chrome };
}

/** Wraps the innermost adapter, below account selection, so it sees the chosen account home. */
export function withNativeTools(
  context: NativeToolsContext,
  adapter: ProviderAdapter,
): ProviderAdapter {
  if (adapter.provider === "codex")
    return {
      ...adapter,
      openSession: async (session) => adapter.openSession(await codexSession(context, session)),
    };
  if (adapter.provider === "claude")
    return {
      ...adapter,
      openSession: async (session) => adapter.openSession(await claudeSession(context, session)),
    };
  return adapter;
}
