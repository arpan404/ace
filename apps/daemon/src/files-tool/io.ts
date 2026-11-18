import { FileError, type Description, type FilesIo, type WalkEntry } from "@ace/files";
import { FilesRequestError } from "@ace/files-native";
import { filesListDefaults } from "@ace/files-native/client";
import { FilesTool, type FilesToolClient } from "./tool.ts";

/** The daemon's file work for one checkout, answered by ace-files (ADR 0178). */
export function aceFilesIo(tool: FilesTool): FilesIo {
  /** Every call names the checkout; ace-files opens it once and shares it. */
  const run = <T>(root: string, task: (client: FilesToolClient, root: number) => Promise<T>) =>
    tool.run(root, task);
  return {
    async describe(root, path, options = {}): Promise<Description | null> {
      try {
        const description = await run(root, (client, number) =>
          client.describe(number, path, options),
        );
        return {
          version: description.version,
          size: description.size,
          kind: description.kind.type,
          mode: description.mode,
        };
      } catch (error) {
        if (missing(error)) return null;
        throw refused(error);
      }
    },
    async metadata(root, path) {
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
    async read(root, path, range, options = {}) {
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
      try {
        await run(root, (client, number) => client.createDir(number, path));
      } catch (error) {
        throw refused(error);
      }
    },
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
    async *walk(root, path, options = {}): AsyncGenerator<WalkEntry> {
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
            if (privatePath(entry.path)) continue;
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
      try {
        return await run(root, (client, number) => client.measure(number, path));
      } catch (error) {
        throw refused(error);
      }
    },
  };
}

/**
 * What the daemon's walk leaves out: git's object store and its own transfer temporaries. The
 * local port gets the same rule from `@ace/workspace`.
 */
function privatePath(path: string): boolean {
  return path.split("/").some((part) => part === ".git" || part.startsWith(".ace-upload-"));
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
