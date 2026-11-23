import { join } from "node:path";
import { shippedExecutableName } from "@ace/service/process-names";
import { bundleRootOfEntry } from "@ace/service/spade-layout";

/** The name Cargo builds ace-files under; a release ships it as `ace Files Service`. */
export function filesBinaryName(platform: NodeJS.Platform): string {
  return platform === "win32" ? "ace-files.exe" : "ace-files";
}

/**
 * How to find ace-files. A release runs the binary it carries (`files/ace Files Service`,
 * `ace-files-service` on Linux), beside the daemon's other native
 * helpers, and never one a variable points at. Development honours `ACE_FILES_PATH`, then the
 * Cargo workspace's release build, then its debug build.
 */
export type FilesBinaryLookup =
  | {
      mode: "release";
      /** The daemon's entry script (`ace.mjs`) inside the release or desktop bundle. */
      entry: string;
      platform: NodeJS.Platform;
      exists: (path: string) => boolean;
    }
  | {
      mode: "development";
      env: Readonly<Record<string, string | undefined>>;
      /** The repository root, when known. */
      sourceRoot: string | undefined;
      platform: NodeJS.Platform;
      exists: (path: string) => boolean;
    };

/** The binary to run, or undefined when this install has none. */
export function filesBinaryPath(lookup: FilesBinaryLookup): string | undefined {
  if (lookup.mode === "release") {
    const bundled = join(
      bundleRootOfEntry(lookup.entry, lookup.exists),
      "files",
      shippedExecutableName("files", lookup.platform),
    );
    return lookup.exists(bundled) ? bundled : undefined;
  }
  const override = lookup.env.ACE_FILES_PATH?.trim();
  if (override) return override;
  const root = lookup.sourceRoot;
  if (!root) return undefined;
  const name = filesBinaryName(lookup.platform);
  return ["release", "debug"]
    .map((profile) => join(root, "native", "files", "target", profile, name))
    .find((path) => lookup.exists(path));
}
