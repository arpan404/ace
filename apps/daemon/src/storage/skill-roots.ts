import { createHash } from "node:crypto";
import { ownershipMarker } from "@ace/plugins";
import type { PinnedDirectory } from "@ace/workspace";
import type { StorageReason } from "@ace/protocol";
import { skillLeaseFilename, skillLeaseLimit } from "../builtin-skill-processes.ts";
import { isBuiltinSkillRootName } from "../builtin-skill-roots.ts";
import { skillRootProtections } from "./ownership.ts";

const typeMask = 0o170000;
const directoryType = 0o040000;
const entryLimit = 10000;
const depthLimit = 16;
// The projection writer's lock database. Taking the lock may touch it, so it is not fingerprinted.
const lockFile = /^operation\.sqlite(-journal|-wal|-shm)?$/;
// Removed after the writer lock is released, lease last, so interrupted removal keeps its proof.
const leaseLast = (entry: string) => (entry === skillLeaseFilename ? 1 : 0);
const finalEntries = (name: string) =>
  lockFile.test(name) || name === ownershipMarker.name || name === skillLeaseFilename;

export interface SkillRootFacts {
  bytes: number;
  modifiedAt: number;
  fingerprint: string;
  protections: StorageReason[];
}
interface Tree {
  bytes: number;
  modifiedAt: number;
  entries: number;
  exceeded: boolean;
}
const unsafe: SkillRootFacts = {
  bytes: 0,
  modifiedAt: 0,
  fingerprint: "unsafe",
  protections: ["unsafe_path"],
};

function measure(directory: PinnedDirectory, depth: number, tree: Tree): void {
  for (const name of directory.names()) {
    if (++tree.entries > entryLimit || depth > depthLimit) {
      tree.exceeded = true;
      return;
    }
    const info = directory.metadata(name);
    tree.bytes += info.size;
    if (depth === 0 && lockFile.test(name)) continue;
    tree.modifiedAt = Math.max(tree.modifiedAt, info.mtime);
    if ((info.mode & typeMask) !== directoryType) continue;
    const child = directory.child(name);
    try {
      measure(child, depth + 1, tree);
    } finally {
      child.closeSync();
    }
    if (tree.exceeded) return;
  }
}

function owned(root: PinnedDirectory): boolean {
  try {
    const text = root.readText(ownershipMarker.name, 64, process.getuid?.());
    return text === ownershipMarker.contents;
  } catch {
    return false;
  }
}

/**
 * `sessions` is the pinned skill-session directory; nothing below it is followed. Entries
 * that cannot be proven safe are reported as protected rather than failing the whole plan.
 */
export function inspectSkillRoot(sessions: PinnedDirectory, name: string): SkillRootFacts {
  if (!isBuiltinSkillRootName(name)) return unsafe;
  const self = sessions.metadata(name);
  if ((self.mode & typeMask) !== directoryType) return unsafe; // Symlinks and plain files.
  const root = sessions.child(name);
  try {
    // The root's own mtime moves when the writer lock creates its journal; contents do not.
    const tree: Tree = { bytes: 0, modifiedAt: 0, entries: 0, exceeded: false };
    measure(root, 0, tree);
    if (tree.exceeded) return { ...unsafe, bytes: tree.bytes };
    const protections = skillRootProtections(() =>
      root.readText(skillLeaseFilename, skillLeaseLimit, process.getuid?.()),
    );
    let lease: unknown[] = [];
    if (!protections.length && !owned(root)) protections.push("owner_unavailable");
    if (!protections.length) {
      const info = root.fileMetadata(skillLeaseFilename);
      lease = [info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs];
    }
    const identity = [self.dev, self.ino, tree.entries, tree.modifiedAt, lease];
    return {
      bytes: tree.bytes,
      modifiedAt: Math.floor(Math.max(self.mtime, tree.modifiedAt)),
      fingerprint: createHash("sha256").update(JSON.stringify(identity)).digest("hex"),
      protections,
    };
  } finally {
    root.closeSync();
  }
}

function clear(directory: PinnedDirectory, depth: number, count: { entries: number }): void {
  if (depth > depthLimit) throw new Error("storage_tree_limit");
  for (const name of directory.names()) {
    if (depth === 0 && finalEntries(name)) continue;
    if (++count.entries > entryLimit) throw new Error("storage_tree_limit");
    if ((directory.metadata(name).mode & typeMask) !== directoryType) {
      directory.unlink(name); // Removes a symlink itself, never its target.
      continue;
    }
    const child = directory.child(name);
    try {
      clear(child, depth + 1, count);
    } finally {
      child.closeSync();
    }
    directory.removeDirectory(name);
  }
}

/** Runs under the projection writer lock: removes everything but the lock, marker and lease. */
export function clearSkillRoot(sessions: PinnedDirectory, name: string): void {
  if (!isBuiltinSkillRootName(name)) throw new Error("unsafe_storage_path");
  const root = sessions.child(name);
  try {
    clear(root, 0, { entries: 0 });
  } finally {
    root.closeSync();
  }
}

/** After the lock is released: the lock database, marker, then the lease, then the root. */
export function finishSkillRoot(sessions: PinnedDirectory, name: string): void {
  if (!isBuiltinSkillRootName(name)) throw new Error("unsafe_storage_path");
  const root = sessions.child(name);
  try {
    const names = root.names();
    if (names.some((entry) => !finalEntries(entry))) throw new Error("storage_item_changed");
    for (const entry of names.toSorted((a, b) => leaseLast(a) - leaseLast(b))) root.unlink(entry);
  } finally {
    root.closeSync();
  }
  sessions.removeDirectory(name);
}
