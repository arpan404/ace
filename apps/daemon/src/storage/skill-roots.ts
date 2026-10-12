import { createHash } from "node:crypto";
import type { PinnedDirectory } from "@ace/workspace";
import type { StorageReason } from "@ace/protocol";
import { skillLeaseFilename, skillLeaseLimit } from "../builtin-skill-processes.ts";
import { isBuiltinSkillRootName } from "../builtin-skill-roots.ts";
import { skillRootProtections } from "./ownership.ts";

const typeMask = 0o170000;
const directoryType = 0o040000;
const symlinkType = 0o120000;
const entryLimit = 10000;
const depthLimit = 16;

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
}

function measure(directory: PinnedDirectory, depth: number, tree: Tree): void {
  if (depth > depthLimit) throw new Error("storage_tree_limit");
  for (const name of directory.names()) {
    if (++tree.entries > entryLimit) throw new Error("storage_tree_limit");
    const info = directory.metadata(name);
    tree.bytes += info.size;
    tree.modifiedAt = Math.max(tree.modifiedAt, info.mtime);
    if ((info.mode & typeMask) !== directoryType) continue;
    const child = directory.child(name);
    try {
      measure(child, depth + 1, tree);
    } finally {
      child.closeSync();
    }
  }
}

/** `sessions` is the pinned skill-session directory. Nothing below it is followed. */
export function inspectSkillRoot(sessions: PinnedDirectory, name: string): SkillRootFacts {
  if (!isBuiltinSkillRootName(name)) throw new Error("unsafe_storage_path");
  const self = sessions.metadata(name);
  if ((self.mode & typeMask) === symlinkType)
    return { bytes: 0, modifiedAt: 0, fingerprint: "unsafe", protections: ["unsafe_path"] };
  if ((self.mode & typeMask) !== directoryType) throw new Error("unsafe_storage_path");
  const root = sessions.child(name);
  try {
    const tree: Tree = { bytes: 0, modifiedAt: self.mtime, entries: 0 };
    measure(root, 0, tree);
    const protections = skillRootProtections(() =>
      root.readText(skillLeaseFilename, skillLeaseLimit, process.getuid?.()),
    );
    let lease: unknown[] = [];
    if (!protections.length) {
      const info = root.fileMetadata(skillLeaseFilename);
      lease = [info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs];
    }
    return {
      bytes: tree.bytes,
      modifiedAt: Math.floor(tree.modifiedAt),
      fingerprint: createHash("sha256")
        .update(
          JSON.stringify([self.dev, self.ino, tree.bytes, tree.entries, tree.modifiedAt, lease]),
        )
        .digest("hex"),
      protections,
    };
  } finally {
    root.closeSync();
  }
}

function clear(directory: PinnedDirectory, depth: number, count: { entries: number }): void {
  if (depth > depthLimit) throw new Error("storage_tree_limit");
  for (const name of directory.names()) {
    if (depth === 0 && name === skillLeaseFilename) continue;
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

/** The lease goes last, so an interrupted removal keeps the evidence that authorized it. */
export function removeSkillRoot(sessions: PinnedDirectory, name: string): void {
  if (!isBuiltinSkillRootName(name)) throw new Error("unsafe_storage_path");
  const root = sessions.child(name);
  try {
    clear(root, 0, { entries: 0 });
    root.unlink(skillLeaseFilename);
  } finally {
    root.closeSync();
  }
  sessions.removeDirectory(name);
}
