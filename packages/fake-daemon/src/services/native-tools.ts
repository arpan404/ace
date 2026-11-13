import type { NativeToolSource, NativeToolStatus, ProviderKind } from "@ace/protocol";

/*
 * The fake machine's provider tools (ADR 0138), from the two settings that decide them: Codex
 * has computer use and Chrome from the person's plugins, and its in-app browser needs the ChatGPT
 * app; Claude in Chrome follows `providers.claude.chrome`.
 */

/** The fake person's Codex home, and another folder on the machine that holds a config.toml. */
const codexHome = "/Users/ada/.codex";
const toolFolders = new Set([codexHome, "/Users/ada/ace-tools"]);

export const nativeToolKeys = ["providers.codex.toolSource", "providers.claude.chrome"] as const;

export function fakeNativeTools(
  provider: ProviderKind,
  setting: (key: (typeof nativeToolKeys)[number]) => unknown,
): { nativeTools?: NativeToolStatus[]; toolSource?: NativeToolSource } {
  if (provider === "codex") {
    const chosen = setting("providers.codex.toolSource");
    const path = typeof chosen === "string" ? chosen : codexHome;
    const usable = toolFolders.has(path);
    const problem = "No config.toml in this folder";
    return {
      toolSource: usable ? { path, usable } : { path, usable, reason: problem },
      nativeTools: [
        usable
          ? { id: "computer-use", label: "Computer use", state: "ready" }
          : { id: "computer-use", label: "Computer use", state: "unavailable", reason: problem },
        usable
          ? { id: "chrome", label: "Chrome", state: "ready" }
          : { id: "chrome", label: "Chrome", state: "unavailable", reason: problem },
        {
          id: "browser",
          label: "In-app browser",
          state: "unavailable",
          reason: "Needs the ChatGPT app; Chrome and ace's browser still work",
        },
      ],
    };
  }
  if (provider === "claude") {
    const chrome = setting("providers.claude.chrome");
    const tool = { id: "chrome", label: "Claude in Chrome" };
    if (chrome === "on") return { nativeTools: [{ ...tool, state: "ready" }] };
    if (chrome === "off")
      return { nativeTools: [{ ...tool, state: "unavailable", reason: "Turned off in ace" }] };
    return { nativeTools: [{ ...tool, state: "unknown", reason: "Follows Claude's settings" }] };
  }
  return {};
}
