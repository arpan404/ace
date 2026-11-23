import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { shippedExecutableName } from "@ace/service/process-names";
import { bundleRootOfEntry } from "@ace/service/spade-layout";

/** The name Cargo builds ace-history under; a release ships it as `ace History Service`. */
export function historyBinaryName(platform: NodeJS.Platform): string {
  return platform === "win32" ? "ace-history.exe" : "ace-history";
}

/**
 * The ace-history this daemon runs, or undefined when this install has none: a release runs the
 * one it carries in `history/` (`ace History Service`, `ace-history-service` on Linux), beside
 * `files/` and `media/`, never one a variable names.
 * Development honours `ACE_HISTORY_PATH`, then the Cargo workspace's release build, then its
 * debug build.
 */
export function findHistoryBinary(
  platform: NodeJS.Platform = process.platform,
  env: Readonly<Record<string, string | undefined>> = process.env,
  entry: string | undefined = process.argv[1],
  exists: (path: string) => boolean = existsSync,
): string | undefined {
  if (entry && basename(entry) === "ace.mjs") {
    const bundled = join(
      bundleRootOfEntry(entry, exists),
      "history",
      shippedExecutableName("history", platform),
    );
    return exists(bundled) ? bundled : undefined;
  }
  const override = env.ACE_HISTORY_PATH?.trim();
  if (override) return override;
  const name = historyBinaryName(platform);
  const root = fileURLToPath(new URL("../../../../", import.meta.url));
  return ["release", "debug"]
    .map((profile) => join(root, "native", "history", "target", profile, name))
    .find((path) => exists(path));
}
