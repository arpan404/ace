import { join } from "node:path";
import { shippedExecutableName } from "@ace/service/process-names";
import { bundleRootOfEntry } from "@ace/service/spade-layout";

/** The name Cargo builds ace-media under; a release ships it as `ace Media Service`. */

export function mediaBinaryName(platform: NodeJS.Platform): string {
  return platform === "win32" ? "ace-media.exe" : "ace-media";
}

/**
 * How to find ace-media. The caller says which mode the daemon runs in. A release only ever
 * runs the binary it carries (`media/ace Media Service`, `ace-media-service` on Linux), since ace-media receives the lane secret, tickets and relay keys:
 * no environment variable can point it elsewhere. Development (running from source) honours
 * `ACE_MEDIA_PATH`, then the Cargo workspace's release build, then its debug build.
 */
export type MediaBinaryLookup =
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
export function mediaBinaryPath(lookup: MediaBinaryLookup): string | undefined {
  if (lookup.mode === "release") {
    const bundled = join(
      bundleRootOfEntry(lookup.entry, lookup.exists),
      "media",
      shippedExecutableName("media", lookup.platform),
    );
    return lookup.exists(bundled) ? bundled : undefined;
  }
  const override = lookup.env.ACE_MEDIA_PATH?.trim();
  if (override) return override;
  const root = lookup.sourceRoot;
  if (!root) return undefined;
  const name = mediaBinaryName(lookup.platform);
  return ["release", "debug"]
    .map((profile) => join(root, "native", "media", "target", profile, name))
    .find((path) => lookup.exists(path));
}
