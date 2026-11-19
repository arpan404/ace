import { isAbsolute } from "node:path";
import { readCodexToolSource, type CodexToolSource } from "@ace/plugins";
import type { NativeToolSource, NativeToolStatus } from "@ace/protocol";
import { defaultCodexHome } from "../account-homes.ts";
import {
  codexNativeTools,
  codexToolLaunch,
  codexToolSourceStatus,
  effectiveCodexTools,
  nodeRepl,
  toolSourceProblem,
  type CodexToolFacts,
  type CodexToolLaunch,
} from "./codex.ts";
import {
  claudeChromeDefault,
  claudeChromeLaunch,
  claudeConfigPath,
  claudeNativeTools,
  type ClaudeChromeSetting,
} from "./claude.ts";

import type { NativeToolFiles } from "./files.ts";

/* Thin shell around the native tool rules: reads the files they need through `files`. */

export interface CodexToolRead {
  /** `providers.codex.toolSource`; null is the default Codex home. */
  setting: string | null;
  /** The daemon's own environment, for the default Codex home. */
  env: NodeJS.ProcessEnv;
  /** The home the Codex launch runs with. */
  homeDir: string;
  files: NativeToolFiles;
}

function sourceFolder(read: Pick<CodexToolRead, "setting" | "env">): string {
  return read.setting ?? defaultCodexHome(read.env);
}

export async function readCodexTools(read: CodexToolRead): Promise<CodexToolSource> {
  return readCodexToolSource(sourceFolder(read), read.files);
}

/** What one Codex launch adds from the tool source. Never throws. */
export async function codexLaunchArgs(read: CodexToolRead): Promise<CodexToolLaunch> {
  const source = await readCodexTools(read);
  return codexToolLaunch(source, read.homeDir, await readCodexToolSource(read.homeDir, read.files));
}

/** The Codex row's tool status for the account whose home is `homeDir`. Never throws. */
export async function codexToolStatus(
  read: CodexToolRead,
): Promise<{ nativeTools: NativeToolStatus[]; toolSource: NativeToolSource }> {
  const source = await readCodexTools(read);
  const home = await readCodexToolSource(read.homeDir, read.files);
  const tables = effectiveCodexTools(source, read.homeDir, home);
  const repl = nodeRepl(tables);
  let program: CodexToolFacts["program"] = "none";
  if (repl.state === "configured")
    program = !isAbsolute(repl.command)
      ? "unchecked"
      : (await read.files.isFile(repl.command).catch(() => false))
        ? "found"
        : "not_found";
  const launch = codexToolLaunch(source, read.homeDir, home);
  const sourceProblem = launch.problem ?? toolSourceProblem(source);
  return {
    nativeTools: codexNativeTools({
      tables,
      program,
      inAppBrowserPipe: Boolean(read.env["BROWSER_USE_ACCESS_PIPE_PATH"]),
      ...(sourceProblem ? { sourceProblem } : {}),
    }),
    toolSource: codexToolSourceStatus(source),
  };
}

/** The person's `claudeInChromeDefaultEnabled`; undefined when the config is absent or odd. */
export async function readClaudeChromeDefault(
  env: NodeJS.ProcessEnv,
  files: Pick<NativeToolFiles, "readFile">,
): Promise<boolean | undefined> {
  const path = claudeConfigPath(env);
  if (!path) return undefined;
  return claudeChromeDefault(await files.readFile(path).catch(() => undefined));
}

export async function claudeChromeFlag(
  setting: ClaudeChromeSetting,
  env: NodeJS.ProcessEnv,
  files: Pick<NativeToolFiles, "readFile">,
): Promise<boolean | undefined> {
  // `on` and `off` don't depend on Claude's config, so it isn't read for them.
  if (setting !== "auto") return claudeChromeLaunch(setting, undefined);
  return claudeChromeLaunch(setting, await readClaudeChromeDefault(env, files));
}

export async function claudeToolStatus(
  setting: ClaudeChromeSetting,
  env: NodeJS.ProcessEnv,
  files: Pick<NativeToolFiles, "readFile">,
): Promise<{ nativeTools: NativeToolStatus[] }> {
  return { nativeTools: claudeNativeTools(setting, await readClaudeChromeDefault(env, files)) };
}
