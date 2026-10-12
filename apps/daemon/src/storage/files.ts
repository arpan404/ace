import { createHash } from "node:crypto";
import { join } from "node:path";
import { PinnedDirectory } from "@ace/workspace";
import { ThreadId, type StorageKind } from "@ace/protocol";
import type { OwnedStorageCandidate, StorageOwner } from "./types.ts";
import { storageProtections } from "./ownership.ts";

export function storageId(kind: StorageKind, key: string): string {
  return `${kind}:${createHash("sha256").update(key).digest("hex")}`;
}
function fileIdentity(info: ReturnType<PinnedDirectory["fileMetadata"]>): string {
  return createHash("sha256")
    .update(JSON.stringify([info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs]))
    .digest("hex");
}
const roots = [
  ["logs", "logs"],
  ["support/artifacts", "logs"],
  ["artifacts", "artifacts"],
  ["browser", "artifacts"],
  ["cache", "caches"],
  ["caches", "caches"],
] satisfies [string, StorageKind][];

/** All descendant reads and unlinks are no-follow operations relative to a pinned inode. */
export class StorageFiles {
  private directory: PinnedDirectory;
  private owner: StorageOwner;
  constructor(owner: StorageOwner) {
    this.owner = owner;
    this.directory = PinnedDirectory.atBoundary(owner.root);
  }
  private parent(path: string): { directory: PinnedDirectory; name: string } {
    if (!this.directory.matchesBoundary(this.owner.root)) throw new Error("storage_root_changed");
    const parts = path.split("/");
    if (parts.some((part) => !part || part === "." || part === ".." || part.includes("\\")))
      throw new Error("unsafe_storage_path");
    const name = parts.pop();
    if (!name) throw new Error("unsafe_storage_path");
    let current = this.directory.child(parts.shift() ?? name);
    try {
      for (const part of parts) {
        const next = current.child(part);
        current.closeSync();
        current = next;
      }
      return { directory: current, name };
    } catch (error) {
      current.closeSync();
      throw error;
    }
  }
  inspect(path: string, kind: StorageKind): OwnedStorageCandidate {
    const { directory, name } = this.parent(path);
    try {
      const info = directory.fileMetadata(name);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error("unsafe_storage_path");
      const ids = this.owner.store
        .statement(`SELECT DISTINCT thread_id FROM items
        WHERE json_extract(item,'$.type')='artifact' AND json_extract(item,'$.path')=? LIMIT 257`)
        .all(join(this.owner.root, path))
        .map((row) => ThreadId.parse(row.thread_id));
      if (ids.length > 256) throw new Error("storage_owner_limit");
      const protections = storageProtections(this.owner, ids);
      if (ids.some((id) => this.owner.store.getThread(id)?.deletedAt === undefined))
        protections.push("live_thread");
      if (path === "logs/ace.jsonl") protections.push("leased");
      if (
        kind === "caches" &&
        (this.owner.services.browser?.hasActiveSessions ||
          this.owner.services.engine?.workload().activeSessions ||
          this.owner.store
            .statement(
              "SELECT 1 FROM threads WHERE json_extract(status,'$.state') NOT IN ('new','done','failed') LIMIT 1",
            )
            .get())
      )
        protections.push("leased");
      if (
        kind === "caches" &&
        this.owner.store
          .statement("SELECT 1 FROM threads WHERE json_extract(client,'$.pinned')=1 LIMIT 1")
          .get()
      )
        protections.push("pinned");
      // Unpublished browser outputs are protected while any browser acquisition/session owns files.
      if (path.startsWith("browser/") && this.owner.services.browser?.hasActiveSessions)
        protections.push("leased");
      return {
        id: storageId(kind, path),
        kind,
        label: path,
        bytes: info.size,
        modifiedAt: Math.floor(info.mtimeMs),
        threadIds: ids,
        fingerprint: fileIdentity(info),
        protections,
        eligibleReason: "expired",
        target: { type: "file", path },
      };
    } finally {
      directory.closeSync();
    }
  }
  inventory(): { candidates: OwnedStorageCandidate[]; complete: boolean } {
    const candidates: OwnedStorageCandidate[] = [];
    let visited = 0;
    let complete = true;
    const walk = (directory: PinnedDirectory, path: string, kind: StorageKind, depth: number) => {
      for (const name of directory.names()) {
        if (++visited > 10000 || candidates.length >= 256 || depth > 16) {
          complete = false;
          return;
        }
        const childPath = `${path}/${name}`;
        if (
          childPath.startsWith("browser/profiles/") ||
          childPath === "browser/profiles" ||
          childPath.startsWith("browser/ephemeral-")
        )
          continue;
        const info = directory.metadata(name);
        if ((info.mode & 0o170000) === 0o120000) {
          candidates.push({
            id: storageId(kind, childPath),
            kind,
            label: childPath,
            bytes: info.size,
            modifiedAt: Math.floor(info.mtime),
            threadIds: [],
            fingerprint: "unsafe",
            protections: ["unsafe_path"],
            eligibleReason: "expired",
            target: { type: "file", path: childPath },
          });
          continue;
        }
        if ((info.mode & 0o170000) === 0o040000) {
          const child = directory.child(name);
          try {
            walk(child, childPath, kind, depth + 1);
          } finally {
            child.closeSync();
          }
        } else if ((info.mode & 0o170000) === 0o100000)
          candidates.push(this.inspect(childPath, kind));
      }
    };
    for (const [path, kind] of roots) {
      let directory: PinnedDirectory | undefined;
      try {
        // Add a dummy final name to acquire the category directory through the pinned root.
        directory = this.parent(`${path}/.scan`).directory;
        walk(directory, path, kind, 0);
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      } finally {
        directory?.closeSync();
      }
    }
    return { candidates, complete };
  }
  remove(path: string, kind: StorageKind, fingerprint: string): void {
    const current = this.inspect(path, kind);
    if (current.fingerprint !== fingerprint || current.protections.length)
      throw new Error("storage_item_changed");
    const { directory, name } = this.parent(path);
    try {
      if (fileIdentity(directory.fileMetadata(name)) !== fingerprint)
        throw new Error("storage_item_changed");
      directory.unlink(name);
    } finally {
      directory.closeSync();
    }
  }
  close(): Promise<void> {
    return this.directory.close();
  }
}
