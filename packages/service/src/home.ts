import { closeSync, readlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { InstalledRelease, ReleaseDirectory } from "@ace/protocol";
import { PinnedDirectory } from "@ace/workspace/pinned-directory";
import { renderLauncher } from "./launcher.ts";
import { selectDefaultHome, type HomeLayout } from "./home-policy.ts";
import { assertTestHomeIsolation } from "./test-home-guard.ts";

const MARKER = "legacy-home.json";
const LOCK = ".ace-home-selection.lock";
const IsolationMarker = z.strictObject({
  version: z.literal(1),
  owner: z.number().int().nonnegative(),
  legacyHome: z.string().max(2048),
  reason: z.string().min(1).max(1024),
});
function missing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
function has(directory: PinnedDirectory, name: string): boolean {
  try {
    directory.metadata(name);
    return true;
  } catch (error) {
    if (missing(error)) return false;
    throw error;
  }
}
function child(parent: PinnedDirectory, name: string): PinnedDirectory | undefined {
  try {
    return parent.child(name);
  } catch (error) {
    if (missing(error)) return undefined;
    throw error;
  }
}

/** Inspect metadata only. Never execute a binary to discover whether it is legacy. */
export function installedVersion(root: string): string {
  const directories: PinnedDirectory[] = [];
  try {
    const home = PinnedDirectory.atBoundary(root);
    directories.push(home);
    const target = ReleaseDirectory.parse(readlinkSync(join(root, "current")));
    if (!home.matchesBoundary(root)) throw new Error("Home changed during validation");
    const releases = home.child("releases");
    directories.push(releases);
    const generation = releases.child(target.slice("releases/".length));
    directories.push(generation);
    const release = InstalledRelease.parse(
      JSON.parse(generation.readText("release.json", 16 * 1024)),
    );
    if (release.version.startsWith("0.")) throw new Error("legacy version");
    if (target !== `releases/${release.version}-${release.target}`)
      throw new Error("Release metadata does not match its directory");
    const bin = home.child("bin");
    directories.push(bin);
    if (bin.readText("ace", 8192) !== renderLauncher(root))
      throw new Error("Launcher differs from the complete validated program");
    return release.version;
  } catch (cause) {
    throw new Error(
      `Incompatible or legacy ace installation at ${root}. Refusing to execute or adopt its binary/service. Choose a separate ACE_HOME; migration requires an explicit owner decision.`,
      { cause },
    );
  } finally {
    for (const directory of directories.toReversed()) directory.closeSync();
  }
}
function inspect(root: string, directory: PinnedDirectory): HomeLayout {
  if (["ace.db", "ace.sqlite", "db.sqlite"].some((name) => has(directory, name)))
    return "incompatible";
  const bin = child(directory, "bin");
  let executable = false;
  try {
    executable = bin ? has(bin, "ace") : false;
  } finally {
    bin?.closeSync();
  }
  if (executable || has(directory, "current")) {
    installedVersion(root);
    return "rewrite";
  }
  if (has(directory, "host-id")) return "rewrite";
  return directory.empty() ? "empty" : "unknown";
}
function inspectCompatibleHome(root: string): void {
  let directory: PinnedDirectory;
  try {
    directory = PinnedDirectory.atBoundary(root);
  } catch (error) {
    if (missing(error)) {
      // Even absent homes must not be created below a symbolic-link ancestor.
      let parent = dirname(root);
      for (;;) {
        try {
          const pinned = PinnedDirectory.atBoundary(parent);
          pinned.closeSync();
          return;
        } catch (cause) {
          if (!missing(cause) || dirname(parent) === parent) throw cause;
        }
        parent = dirname(parent);
      }
    }
    throw new Error(`Refusing ace home ${root}: symbolic link or unsafe directory`, {
      cause: error,
    });
  }
  try {
    if (inspect(root, directory) === "incompatible")
      throw new Error(
        `Legacy ace data at ${root}. Choose a separate ACE_HOME; no automatic migration is allowed.`,
      );
  } finally {
    directory.closeSync();
  }
}
export function assertCompatibleHome(root: string): void {
  assertTestHomeIsolation(root);
  inspectCompatibleHome(root);
}
function marker(
  directory: PinnedDirectory | undefined,
  legacyHome: string,
  owner: number,
): boolean {
  if (!directory || !has(directory, MARKER)) return false;
  try {
    const parsed = IsolationMarker.parse(JSON.parse(directory.readText(MARKER, 4096, owner)));
    if (parsed.owner !== owner || parsed.legacyHome !== legacyHome)
      throw new Error("Marker ownership or legacy home mismatch");
    return true;
  } catch (cause) {
    throw new Error("Refusing invalid legacy isolation marker; no data was modified", { cause });
  }
}
function selectionLock(parent: PinnedDirectory): number {
  const wait = new Int32Array(new SharedArrayBuffer(4));
  for (let attempt = 0; attempt < 500; attempt++) {
    try {
      // This empty lock needs no later write/chmod: openat publishes its final
      // private mode atomically with O_EXCL. Only its existence grants ownership.
      return parent.createExclusive(LOCK);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
      // Reject links, directories, foreign owners and oversized lock files, rather than following them.
      try {
        parent.readText(LOCK, 128, parent.stat().uid);
      } catch (cause) {
        if (!missing(cause)) throw cause;
      }
      // A holder can release the name before or after our no-follow open.
      // Absence is contention too, and uses the same bounded backoff.
      Atomics.wait(wait, 0, 0, 10);
    }
  }
  throw new Error(
    "Ace home selection is locked. Close other launches; remove the stale .ace-home-selection.lock only after confirming its owner has exited.",
  );
}

function closeSelection(
  parent: PinnedDirectory,
  lock: number | undefined,
  isolated: PinnedDirectory | undefined,
): void {
  let failure: unknown;
  for (const close of [
    () => isolated?.closeSync(),
    () => {
      if (lock !== undefined) closeSync(lock);
    },
    () => {
      if (lock !== undefined) parent.unlink(LOCK);
    },
    () => parent.closeSync(),
  ]) {
    try {
      close();
    } catch (error) {
      failure ??= error;
    }
  }
  if (failure !== undefined) throw failure;
}

/** Stable shared API for daemon and desktop; the caller's home is an I/O boundary. */
export interface HomeFileSystem {
  open(path: string): PinnedDirectory;
  assertSafePath(path: string): void;
}
export function createDaemonHomeResolver(filesystem: HomeFileSystem) {
  return function resolveHome(home: string, requested?: string): string {
    filesystem.assertSafePath(home);
    if (requested !== undefined) {
      const root = resolve(requested);
      filesystem.assertSafePath(root);
      inspectCompatibleHome(root);
      return root;
    }
    const canonicalHome = resolve(home);
    const parent = filesystem.open(canonicalHome);
    const root = join(canonicalHome, ".ace"),
      next = join(canonicalHome, ".ace-next");
    let lock: number | undefined, isolated: PinnedDirectory | undefined;
    try {
      lock = selectionLock(parent);
      // All inspection and publication are inside one parent lock, with descriptor-relative writes.
      isolated = child(parent, ".ace-next");
      const marked = marker(isolated, root, parent.stat().uid);
      const isolatedLayout = isolated ? inspect(next, isolated) : "empty";
      selectDefaultHome({
        isolated: isolatedLayout,
        isolatedMarker: marked,
      });
      if (!isolated) {
        isolated = parent.mkdir(".ace-next");
        // mkdir and open are separate syscalls. Validate the inode actually opened before any write.
        const createdLayout = inspect(next, isolated);
        if (createdLayout !== "empty")
          throw new Error("Refusing substituted isolated directory before marker publication");
      }
      if (!marked)
        isolated.publish(
          MARKER,
          JSON.stringify(
            IsolationMarker.parse({
              version: 1,
              owner: parent.stat().uid,
              legacyHome: root,
              reason:
                "This home isolates the rewrite from legacy ace. The old home is untouched; legacy database migration requires an explicit owner decision.",
            }),
            null,
            2,
          ) + "\n",
        );
      if (!parent.matchesBoundary(canonicalHome) || !isolated.matchesBoundary(next))
        throw new Error("Ace home changed during marker publication; refusing startup");
      return next;
    } finally {
      closeSelection(parent, lock, isolated);
    }
  };
}
export const resolveDaemonHome: (home: string, requested?: string) => string =
  createDaemonHomeResolver({
    open: PinnedDirectory.atBoundary,
    assertSafePath: assertTestHomeIsolation,
  });
