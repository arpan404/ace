import {
  existsSync,
  mkdirSync,
  lstatSync,
  statSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { InstalledRelease, ReleaseDirectory } from "@ace/protocol";

/** Inspect metadata only. Never execute a binary to discover whether it is legacy. */
export function installedVersion(root: string): string {
  try {
    const target = ReleaseDirectory.parse(readlinkSync(join(root, "current")));
    const manifest = join(root, target, "release.json");
    if (statSync(manifest).size > 16 * 1024) throw new Error("Release metadata limit exceeded");
    const release = InstalledRelease.parse(JSON.parse(readFileSync(manifest, "utf8")));
    if (release.version.startsWith("0.")) throw new Error("legacy version");
    if (target !== `releases/${release.version}-${release.target}`)
      throw new Error("Release metadata does not match its directory");
    const launcherPath = join(root, "bin/ace");
    if (existsSync(launcherPath)) {
      if (statSync(launcherPath).size > 8192) throw new Error("Unrecognized launcher");
      const lines = readFileSync(launcherPath, "utf8").trimEnd().split("\n");
      // Only the rewrite's pointer-based shell launcher may use this metadata.
      // An old executable alongside a new current pointer is still incompatible.
      if (
        lines[0] !== "#!/bin/sh" ||
        !lines.includes('target=$(readlink "$ACE_HOME/current")') ||
        !lines.includes('artifact="$ACE_HOME/$target"') ||
        lines.at(-1) !== 'exec "$artifact/bin/node" "$artifact/ace.mjs" "$@"'
      )
        throw new Error("Launcher does not use the validated release pointer");
    }
    return release.version;
  } catch (cause) {
    throw new Error(
      `Incompatible or legacy ace installation at ${root}. Refusing to execute or adopt its binary/service. Choose a separate ACE_HOME; migration requires an explicit owner decision.`,
      { cause },
    );
  }
}

export function assertCompatibleHome(root: string): void {
  if (existsSync(root) && lstatSync(root).isSymbolicLink())
    throw new Error(`Refusing ace home ${root}: it is a symbolic link`);
  if (existsSync(join(root, "bin/ace")) || existsSync(join(root, "current"))) {
    installedVersion(root);
    return;
  }
  // Recognize old layout by names only, never by opening its databases.
  if (["ace.db", "ace.sqlite", "db.sqlite"].some((name) => existsSync(join(root, name))))
    throw new Error(
      `Legacy ace data at ${root}. Choose a separate ACE_HOME; no automatic migration is allowed.`,
    );
}

export function resolveDaemonHome(home: string, requested?: string): string {
  if (requested !== undefined) {
    const root = resolve(requested);
    assertCompatibleHome(root);
    return root;
  }
  const root = join(home, ".ace");
  const next = join(home, ".ace-next");
  if (existsSync(join(next, "legacy-home.json"))) {
    assertCompatibleHome(next);
    return next;
  }
  try {
    assertCompatibleHome(root);
    if (
      existsSync(root) &&
      readdirSync(root).length &&
      !existsSync(join(root, "host-id")) &&
      !existsSync(join(root, "current"))
    )
      throw new Error("Unrecognized default home");
    return root;
  } catch {
    assertCompatibleHome(next);
    if (
      existsSync(next) &&
      readdirSync(next).length &&
      !existsSync(join(next, "host-id")) &&
      !existsSync(join(next, "current"))
    )
      throw new Error(
        `Unrecognized data at ${next}. Refusing to modify it; choose an empty ACE_HOME.`,
      );
    mkdirSync(next, { recursive: true, mode: 0o700 });
    try {
      writeFileSync(
        join(next, "legacy-home.json"),
        JSON.stringify(
          {
            legacyHome: root,
            reason:
              "Legacy or incompatible ace data was detected. This home isolates the rewrite; migration requires an explicit owner decision. The old home is untouched.",
          },
          null,
          2,
        ) + "\n",
        { flag: "wx", mode: 0o600 },
      );
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
    }
    return next;
  }
}
