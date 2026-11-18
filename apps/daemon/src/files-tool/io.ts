import { FileError, type Description, type FilesIo, type WalkEntry } from "@ace/files";
import { FilesRequestError } from "@ace/files-native";
import { filesListDefaults } from "@ace/files-native/client";
import { FilesTool, type FilesToolClient } from "./tool.ts";

/** The daemon's reserved names: git's store and its own transfer temporaries are never served. */
function reserved(path: string): boolean {
  return path.split("/").some((part) => part === ".git" || part.startsWith(".ace-upload-"));
}

/** The daemon's file work for one checkout, answered by ace-files (ADR 0178). */
export function aceFilesIo(tool: FilesTool): FilesIo {
  /** Every call names the checkout; ace-files opens it once and shares it. */
  const run = <T>(root: string, task: (client: FilesToolClient, root: number) => Promise<T>) =>
    tool.run(root, task);
  /** The rule a mutation path obeys: no reserved name, and no link on the way or as the leaf. */
  const mutable = async (root: string, path: string) => {
    refuse(path);
    await run(root, (client, number) => client.checkMutation(number, path)).catch((error) => {
      throw refused(error);
    });
  };
  return {
    async describe(root, path, options = {}): Promise<Description | null> {
      refuse(path);
      try {
        const found = await run(root, (client, number) => client.describe(number, path, options));
        return description(found);
      } catch (error) {
        if (missing(error)) return null;
        throw refused(error);
      }
    },
    async shallow(root, path, options = {}): Promise<Description | null> {
      refuse(path);
      try {
        const found = await run(root, (client, number) =>
          client.describeEntry(number, path, options),
        );
        return description(found);
      } catch (error) {
        if (missing(error)) return null;
        throw refused(error);
      }
    },
    async checkMutation(root, path) {
      await mutable(root, path);
    },
    async metadata(root, path) {
      refuse(path);
      try {
        const entry = await run(root, (client, number) => client.stat(number, path));
        // A link the listing could not resolve is dangling or leaves the checkout; describing it
        // says which, as the daemon's own metadata does by resolving the final link.
        if (entry.kind.type === "symlink" && entry.kind.target === undefined)
          await run(root, (client, number) => client.describe(number, path));
        return { kind: entry.kind.type, size: entry.size };
      } catch (error) {
        if (missing(error)) return null;
        throw refused(error);
      }
    },
    /** The legacy `list` reply: ace-files' pages, composed breadth-first, ignored left out. */
    async paths(root, dir, limit, options = {}) {
      const paths: string[] = [];
      const pending: string[] = [dir];
      while (pending.length) {
        const folder = pending.shift();
        if (folder === undefined) break;
        let cursor: string | undefined;
        do {
          const page = await tool.listFolder(root, folder, {
            limit: filesListDefaults.limit,
            ...(cursor === undefined ? {} : { cursor }),
            ...(options.signal === undefined ? {} : { signal: options.signal }),
          });
          for (const entry of page.entries) {
            if (entry.ignored || reserved(entry.path)) continue;
            if (entry.kind !== "file" && entry.kind !== "directory") continue;
            if (paths.length >= limit) return { paths, truncated: true };
            paths.push(entry.kind === "directory" ? `${entry.path}/` : entry.path);
            if (entry.kind === "directory") pending.push(entry.path);
          }
          cursor = page.nextCursor ?? undefined;
        } while (cursor);
      }
      return { paths, truncated: false };
    },
    async read(root, path, range, options = {}) {
      refuse(path);
      try {
        const { meta, bytes } = await run(root, (client, number) =>
          client.read(number, path, {
            offset: range.offset,
            length: range.length,
            ...(range.maxSize === undefined ? {} : { maxSize: range.maxSize }),
            ...options,
          }),
        );
        return { size: meta.size, version: meta.version, bytes: Buffer.from(bytes) };
      } catch (error) {
        throw refused(error);
      }
    },
    async write(root, path, bytes, expected) {
      await mutable(root, path);
      try {
        const reply = await run(root, (client, number) =>
          client.write(number, path, bytes, expected === null ? {} : { expected }),
        );
        return reply.version;
      } catch (error) {
        throw refused(error);
      }
    },
    async createDir(root, path) {
      await mutable(root, path);
      try {
        await run(root, (client, number) => client.createDir(number, path));
      } catch (error) {
        throw refused(error);
      }
    },
    async move(root, from, to) {
      await mutable(root, from);
      await mutable(root, to);
      try {
        await run(root, (client, number) => client.rename(number, from, to, false));
      } catch (error) {
        throw refused(error);
      }
    },
    async remove(root, path) {
      await mutable(root, path);
      try {
        await run(root, (client, number) => client.remove(number, path));
      } catch (error) {
        throw refused(error);
      }
    },
    async *walk(root, path, options = {}): AsyncGenerator<WalkEntry> {
      if (reserved(path)) return;
      const pending: string[] = [path];
      let next = 0;
      while (next < pending.length) {
        const dir = pending[next++] ?? "";
        let cursor: string | undefined;
        do {
          const page = await tool.listFolder(root, dir, {
            limit: filesListDefaults.limit,
            ...(cursor === undefined ? {} : { cursor }),
            ...(options.signal === undefined ? {} : { signal: options.signal }),
          });
          for (const entry of page.entries) {
            if (reserved(entry.path)) continue;
            if (entry.kind === "directory") pending.push(entry.path);
            // A link is reported as itself and never walked through, as the daemon's own walk
            // does: an archive of a checkout must not follow a path out of it or into itself.
            yield {
              path: entry.path,
              type: entry.kind,
              size: entry.size,
              mtime: entry.mtimeMs,
              ignored: entry.ignored,
            };
          }
          cursor = page.nextCursor ?? undefined;
        } while (cursor);
      }
    },
    async measure(root, path) {
      await mutable(root, path);
      try {
        return await run(root, (client, number) => client.measure(number, path));
      } catch (error) {
        throw refused(error);
      }
    },
    internal: {
      async move(root, from, to) {
        try {
          await run(root, (client, number) => client.rename(number, from, to, false));
        } catch (error) {
          throw refused(error);
        }
      },
      async remove(root, path) {
        try {
          await run(root, (client, number) => client.remove(number, path));
        } catch (error) {
          throw refused(error);
        }
      },
    },
  };
}

/** A path that is not there, which the port reports as `null`. */
function missing(error: unknown): boolean {
  return error instanceof FilesRequestError && error.code === "NOT_FOUND";
}

/** ace-files' failure in the daemon's own error shape, version included on a conflict. */
function refused(error: unknown): FileError {
  if (error instanceof FileError) return error;
  if (error instanceof FilesRequestError)
    return new FileError(error.code, error.message, error.current);
  return new FileError("IO_ERROR", error instanceof Error ? error.message : String(error));
}

/** Refuse a reserved name before it can reach ace-files, as the daemon's confinement did. */
function refuse(path: string): void {
  if (reserved(path)) throw new FileError("INVALID_PATH", "Reserved mutation path");
}

/** ace-files' description in the port's own shape. */
function description(found: {
  version: string;
  ownVersion?: string | undefined;
  shallow: boolean;
  size: number;
  kind: { type: Description["kind"] };
  mode: number;
}): Description {
  return {
    version: found.version,
    ...(found.ownVersion === undefined ? {} : { ownVersion: found.ownVersion }),
    shallow: found.shallow,
    size: found.size,
    kind: found.kind.type,
    mode: found.mode,
  };
}
