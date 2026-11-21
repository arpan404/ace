import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { bundleRootOfEntry } from "@ace/service/spade-layout";
import type { HistoryProvider } from "@ace/protocol/history";

/** The providers ace-history reads (ADR 0206); the TypeScript reader keeps the rest for now. */
export const rustProviders: readonly HistoryProvider[] = [
  "claude",
  "codex",
  "cursor",
  "opencode",
  "pi",
];

/** The `ace-history` executable's name on this platform. */
export function historyBinaryName(platform: NodeJS.Platform): string {
  return platform === "win32" ? "ace-history.exe" : "ace-history";
}

/**
 * The ace-history this daemon runs, or undefined when this install has none: a release runs the
 * one it carries in `history/`, beside `files/` and `media/`, never one a variable names.
 * Development honours `ACE_HISTORY_PATH`, then the Cargo workspace's release build, then its
 * debug build.
 */
export function findHistoryBinary(
  platform: NodeJS.Platform = process.platform,
  env: Readonly<Record<string, string | undefined>> = process.env,
  entry: string | undefined = process.argv[1],
  exists: (path: string) => boolean = existsSync,
): string | undefined {
  const name = historyBinaryName(platform);
  if (entry && basename(entry) === "ace.mjs") {
    const bundled = join(bundleRootOfEntry(entry, exists), "history", name);
    return exists(bundled) ? bundled : undefined;
  }
  const override = env.ACE_HISTORY_PATH?.trim();
  if (override) return override;
  const root = fileURLToPath(new URL("../../../../", import.meta.url));
  return ["release", "debug"]
    .map((profile) => join(root, "native", "history", "target", profile, name))
    .find((path) => exists(path));
}
