import { lstat, mkdir, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { PinnedDirectory, GitIgnore, walkWorkspace, type SafeRoot } from "@ace/workspace";
import { createExclusiveRename, type ExclusiveRename } from "./exclusive-rename.ts";
import { atomicWrite, observed, treeVersion } from "./filesystem.ts";
import type { Description, FilesIo, SafeRootSource, ReadBytes } from "./io.ts";
import { checkVersion, codeOf, FileError, version } from "./types.ts";

/** A staging name for one save; `files-io` names its own copies the same way. */
function stagingId(): string {
  return randomUUID().replaceAll("-", "").slice(0, 24);
}

/** A path that is not there: the caller decides whether that is `null` or a failure. */
function absent(error: unknown): boolean {
  return ["ENOENT", "NOT_FOUND"].includes(codeOf(error));
}

/** The daemon's reserved names: git's store and its own transfer temporaries are never served. */
function reserved(path: string): boolean {
  return path.split("/").some((part) => part === ".git" || part.startsWith(".ace-upload-"));
}

/**
 * Where the daemon's own bookkeeping acts. Client paths go through `SafeRoot.target`, which
 * refuses git's store, the transfer temporaries and any link on the way; the internal entries
 * name `.ace-upload-*` entries the daemon made itself, and reach them by resolved parent and name.
 */
function privateTarget(
  safe: SafeRoot,
  path: string,
): Promise<{ path: string; verify(): Promise<void> }> {
  const parts = path.split("/");
  const name = parts.pop() ?? "";
  if (!name) return Promise.reject(new FileError("INVALID_PATH", "Missing filename"));
  const parent = parts.join("/");
  return safe.resolve(parent).then((resolved) => ({
    path: join(resolved, name),
    verify: async () => {
      await safe.resolve(parent);
    },
  }));
}

function kindAt(info: { isFile(): boolean; isDirectory(): boolean }): Description["kind"] {
  return info.isFile() ? "file" : info.isDirectory() ? "directory" : "other";
}

/**
 * The local port: the daemon's own confined Node I/O, which the service used before ace-files.
 *
 * It stays for the daemon's private registries (support bundles, browser artifacts, forge media,
 * linked files rooted at `/`), where opening an ace-files root would start a watcher and a path
 * index over a folder nobody browses, and for the service's tests. A checkout's reads and writes
 * go through the daemon's ace-files port instead (ADR 0178).
 */
export function localFilesIo(
  safeRoot: SafeRootSource,
  exclusive: ExclusiveRename = createExclusiveRename(),
): FilesIo {
  return {
    async describe(root, path, options = {}): Promise<Description | null> {
      const safe = await safeRoot(root);
      if (reserved(path)) throw new FileError("INVALID_PATH", "Reserved mutation path");
      // The local port walks its whole tree up to the workspace's own cap; `full` only matters to
      // ace-files, which budgets a display stat and never a guarded one.
      if (path === "") {
        const { info } = await safe.metadata("");
        return {
          version: await treeVersion(safe, "", info, options.signal),
          ownVersion: version(info),
          shallow: false,
          size: info.size,
          kind: "directory",
          mode: info.mode & 0o777,
        };
      }
      // A link is described as itself with its target's version, as `stat` always has.
      const resolved = await safe.resolve(path).catch((error: unknown) => {
        if (absent(error)) return undefined;
        throw error;
      });
      if (resolved === undefined) return null;
      const info = await lstat(resolved);
      const link = await lstat(join(safe.root, ...path.split("/"))).catch(() => undefined);
      const directory = info.isDirectory();
      return {
        version: directory ? await treeVersion(safe, path, info, options.signal) : version(info),
        ...(directory ? { ownVersion: version(info) } : {}),
        shallow: false,
        size: info.size,
        kind: link?.isSymbolicLink() ? "symlink" : kindAt(info),
        mode: info.mode & 0o777,
      };
    },
    async shallow(root, path) {
      const safe = await safeRoot(root);
      if (reserved(path)) throw new FileError("INVALID_PATH", "Reserved mutation path");
      if (path === "") {
        const { info } = await safe.metadata("");
        return {
          version: version(info),
          shallow: false,
          size: info.size,
          kind: "directory",
          mode: info.mode & 0o777,
        };
      }
      const resolved = await safe.resolve(path).catch((error: unknown) => {
        if (absent(error)) return undefined;
        throw error;
      });
      if (resolved === undefined) return null;
      const info = await lstat(resolved);
      const link = await lstat(join(safe.root, ...path.split("/"))).catch(() => undefined);
      return {
        version: version(info),
        shallow: false,
        size: info.size,
        kind: link?.isSymbolicLink() ? "symlink" : kindAt(info),
        mode: info.mode & 0o777,
      };
    },
    async metadata(root, path) {
      const safe = await safeRoot(root);
      if (reserved(path)) throw new FileError("INVALID_PATH", "Reserved mutation path");
      try {
        const { info, type } = await safe.metadata(path);
        return { kind: type, size: info.size };
      } catch (error) {
        if (absent(error)) return null;
        throw error;
      }
    },
    async paths(root, dir, limit, options = {}) {
      const safe = await safeRoot(root);
      const ignore = await GitIgnore.create(safe);
      const paths: string[] = [];
      const pending: string[] = [dir];
      while (pending.length) {
        const folder = pending.shift();
        if (folder === undefined) break;
        for await (const entry of walkWorkspace(safe, ignore, {
          dir: folder,
          depth: 1,
          includeIgnored: false,
          entryLimit: 1_000_000,
          ...(options.signal ? { signal: options.signal } : {}),
        })) {
          if (entry.type !== "file" && entry.type !== "directory") continue;
          if (paths.length >= limit) return { paths, truncated: true };
          paths.push(entry.type === "directory" ? `${entry.path}/` : entry.path);
          if (entry.type === "directory") pending.push(entry.path);
        }
      }
      return { paths, truncated: false };
    },
    async read(root, path, range): Promise<ReadBytes> {
      const safe = await safeRoot(root);
      if (reserved(path)) throw new FileError("INVALID_PATH", "Reserved mutation path");
      const { handle, info, resolved } = await safe.file(path);
      try {
        const size = info.size;
        const current = version(info);
        if (range.maxSize !== undefined && size > range.maxSize)
          return { size, version: current, bytes: Buffer.alloc(0) };
        if (range.offset > size)
          throw new FileError("CONFLICT", "Offset is past the end of the file", current);
        const length = Math.min(range.length, size - range.offset);
        const bytes = Buffer.allocUnsafe(length);
        let done = 0;
        while (done < length) {
          const read = await handle.read(bytes, done, length - done, range.offset + done);
          if (!read.bytesRead) throw new FileError("CONFLICT", "File was truncated while reading");
          done += read.bytesRead;
        }
        if (version(await handle.stat()) !== version(info))
          throw new FileError("CONFLICT", "File changed while reading");
        await safe.verify(path, resolved, info);
        return { size, version: current, bytes };
      } finally {
        await handle.close();
      }
    },
    async write(root, path, bytes, expected) {
      const safe = await safeRoot(root);
      if (reserved(path)) throw new FileError("INVALID_PATH", "Reserved mutation path");
      await atomicWrite(safe, path, expected, bytes, stagingId(), exclusive);
      const current = await observed(safe, path);
      if (current === null) throw new FileError("NOT_FOUND", "The saved file vanished");
      return current;
    },
    async createDir(root, path) {
      const safe = await safeRoot(root);
      const target = await safe.target(path);
      try {
        await mkdir(target.path);
      } catch (error) {
        if (codeOf(error) === "EEXIST")
          throw new FileError("CONFLICT", "Directory was created concurrently");
        throw error;
      }
      await target.verify();
      // A new folder holds nothing yet, so its digest is one read of the folder this call made.
      const info = await lstat(target.path);
      return treeVersion(safe, path, info);
    },
    async move(root, from, to, expected, _own) {
      const safe = await safeRoot(root);
      if (from === to) throw new FileError("INVALID_PATH", "Source equals destination");
      const source = await safe.target(from);
      if (expected !== null) checkVersion(await observed(safe, from), expected);
      if (process.platform === "win32" && (await caseOnlyRename(safe, from, to, source))) {
        return movedOutcome(safe, to);
      }
      const destination = await safe.target(to);
      await source.verify();
      await destination.verify();
      await exclusive.move(source.path, destination.path);
      await source.verify();
      await destination.verify();
      return movedOutcome(safe, to);
    },
    async trash(root, path, endpoint, expected, _own) {
      const safe = await safeRoot(root);
      const target = await safe.target(path);
      checkVersion(await observed(safe, path), expected);
      const location = join(safe.root, endpoint);
      await target.verify();
      await exclusive.move(target.path, location);
      await target.verify();
    },
    async untrash(root, endpoint, path) {
      const safe = await safeRoot(root);
      const destination = await safe.target(path);
      const source = join(safe.root, endpoint);
      await lstat(source);
      await destination.verify();
      await exclusive.move(source, destination.path);
      await destination.verify();
    },
    async remove(root, path) {
      const safe = await safeRoot(root);
      const target = await safe.target(path);
      await rm(target.path, { recursive: true, force: true });
      await target.verify();
    },
    async *walk(root, path, options = {}) {
      const safe = await safeRoot(root);
      const ignore = await GitIgnore.create(safe);
      for await (const entry of walkWorkspace(safe, ignore, {
        dir: path,
        depth: Number.MAX_SAFE_INTEGER,
        includeIgnored: true,
        entryLimit: 1_000_000,
        ...(options.signal ? { signal: options.signal } : {}),
      })) {
        yield {
          path: entry.path,
          type: entry.type,
          size: entry.size,
          mtime: entry.mtime,
          ignored: entry.ignored,
        };
      }
    },
    async measure(root, path, options = {}) {
      const safe = await safeRoot(root);
      const target = await safe.target(path);
      const info = await lstat(target.path);
      if (!info.isDirectory()) return { bytes: info.isFile() ? info.size : 0, shallow: false };
      const ignore = await GitIgnore.create(safe);
      let bytes = 0;
      for await (const entry of walkWorkspace(safe, ignore, {
        dir: path,
        depth: Number.MAX_SAFE_INTEGER,
        includeIgnored: true,
        exclude: () => false,
        entryLimit: 1_000_000,
        ...(options.signal ? { signal: options.signal } : {}),
      })) {
        if (entry.type === "file") bytes += entry.size;
      }
      return { bytes, shallow: false };
    },
    internal: {
      async describe(root, path) {
        const safe = await safeRoot(root);
        const target = await privateTarget(safe, path);
        const info = await lstat(target.path).catch((error: unknown) => {
          if (absent(error)) return undefined;
          throw error;
        });
        if (info === undefined) return null;
        const directory = info.isDirectory();
        return {
          version: directory ? await treeVersion(safe, path, info) : version(info),
          ...(directory ? { ownVersion: version(info) } : {}),
          shallow: false,
          size: info.size,
          kind: kindAt(info),
          mode: info.mode & 0o777,
        };
      },
      async move(root, from, to) {
        const safe = await safeRoot(root);
        const source = await privateTarget(safe, from);
        const destination = await safe.target(to);
        await source.verify();
        await destination.verify();
        await exclusive.move(source.path, destination.path);
        await source.verify();
        await destination.verify();
      },
      async remove(root, path) {
        const safe = await safeRoot(root);
        const target = await privateTarget(safe, path);
        await rm(target.path, { recursive: true, force: true });
        await target.verify();
      },
    },
  } satisfies FilesIo;

  /**
   * What a landed move reports. A folder's own version stands in as the identity of the entry a
   * later digest must match, because a folder's digest records the path it is read at.
   */
  async function movedOutcome(
    safe: SafeRoot,
    path: string,
  ): Promise<{ version: string | null; identity: string | null; recovery: string | null }> {
    const resolved = await safe.resolve(path).catch(() => undefined);
    if (resolved === undefined) return { version: null, identity: null, recovery: null };
    const info = await lstat(resolved).catch(() => undefined);
    if (info === undefined) return { version: null, identity: null, recovery: null };
    return info.isDirectory()
      ? { version: null, identity: version(info), recovery: null }
      : { version: version(info), identity: null, recovery: null };
  }

  /**
   * Windows: names differing only in case usually name one file, so the destination looks taken
   * by the source itself. Renames it in place when both names open the same file; a different
   * file there still conflicts. `files-io`'s rename does the same for the ace-files port.
   */
  async function caseOnlyRename(
    safe: SafeRoot,
    from: string,
    to: string,
    source: { path: string; verify(): Promise<void> },
  ): Promise<boolean> {
    if (!to) return false;
    const destination = await safe.target(to);
    const sourceName = basename(source.path);
    const targetName = basename(destination.path);
    if (dirname(source.path) !== dirname(destination.path) || sourceName === targetName)
      return false;
    if (sourceName.toLowerCase() !== targetName.toLowerCase()) return false;
    const parent = PinnedDirectory.open(dirname(source.path));
    try {
      if (!windowsSameFile(parent.metadata(sourceName), parent.metadata(targetName))) return false;
    } catch (error) {
      if (codeOf(error) === "ENOENT") return false;
      throw error;
    } finally {
      parent.closeSync();
    }
    await source.verify();
    await destination.verify();
    await exclusive.move(source.path, destination.path);
    await source.verify();
    await destination.verify();
    return true;
  }
}

/** Windows: the keys that identify a file in the workspace's stats. */
function windowsIdentityKeys(value: object): (string | symbol)[] {
  return [
    "dev",
    "ino",
    ...Object.getOwnPropertySymbols(value).filter((key) => key.description === "windowsFileId"),
  ];
}

/** Windows: same volume serial, file id and the exact 128-bit id the workspace attaches. */
function windowsSameFile(a: object, b: object): boolean {
  const keys = windowsIdentityKeys(a);
  if (keys.length !== 3 || windowsIdentityKeys(b).length !== 3) return false;
  return keys.every((key) => Reflect.get(a, key) === Reflect.get(b, key));
}
