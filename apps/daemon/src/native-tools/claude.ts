import { join } from "node:path";
import type { NativeToolStatus, SettingsValues } from "@ace/protocol";

/* Pure rules for Claude in Chrome (ADR 0128). */

export type ClaudeChromeSetting = SettingsValues["providers.claude.chrome"];

/**
 * The flag Claude Code starts with: true is `--chrome`, false `--no-chrome`, undefined neither.
 * `auto` turns it on only when the person's Claude config does; otherwise Claude decides.
 */
export function claudeChromeLaunch(
  setting: ClaudeChromeSetting,
  claudeDefault: boolean | undefined,
): boolean | undefined {
  if (setting === "on") return true;
  if (setting === "off") return false;
  return claudeDefault === true ? true : undefined;
}

export function claudeNativeTools(
  setting: ClaudeChromeSetting,
  claudeDefault: boolean | undefined,
): NativeToolStatus[] {
  const tool = { id: "chrome", label: "Claude in Chrome" };
  if (claudeChromeLaunch(setting, claudeDefault) === true) return [{ ...tool, state: "ready" }];
  if (setting === "off") return [{ ...tool, state: "unavailable", reason: "Turned off in ace" }];
  if (claudeDefault === false)
    return [{ ...tool, state: "unavailable", reason: "Off in Claude's settings" }];
  // No setting ace can read: Claude decides for itself, so ace can't say.
  return [{ ...tool, state: "unknown", reason: "ace can't read Claude's Chrome setting" }];
}

/** The person's Claude config: `$CLAUDE_CONFIG_DIR/.claude.json`, else `~/.claude.json`. */
export function claudeConfigPath(env: NodeJS.ProcessEnv): string | undefined {
  if (env.CLAUDE_CONFIG_DIR) return join(env.CLAUDE_CONFIG_DIR, ".claude.json");
  const home = env.HOME ?? env.USERPROFILE;
  return home ? join(home, ".claude.json") : undefined;
}

/** `claudeInChromeDefaultEnabled` from the config's text; undefined when absent or unreadable. */
export function claudeChromeDefault(text: string | undefined): boolean | undefined {
  if (text === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const value: unknown = Reflect.get(parsed, "claudeInChromeDefaultEnabled");
    return typeof value === "boolean" ? value : undefined;
  } catch {
    return undefined;
  }
}
