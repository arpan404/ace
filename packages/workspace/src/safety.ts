import { constants, type Stats } from "node:fs";
import { lstat, open, opendir, realpath, stat, type FileHandle } from "node:fs/promises";
import { isAbsolute, join, relative, sep, win32 } from "node:path";
import { failure, errorCode, DIRECTORY_CAP, WorkspaceError } from "./types.ts";

/** Shared lexical schema for explicit requests and discovered filesystem names. */
export function validRelativePath(input: string): boolean {
  return !(
    input.includes("\0") ||
    input.includes("\\") ||
    isAbsolute(input) ||
    win32.isAbsolute(input) ||
    input.split("/").includes("..")
  );
}
function same(a: Stats, b: Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}
export class SafeRoot {
  readonly root: string;
  private readonly identity: Stats;
  private constructor(root: string, identity: Stats) {
    this.root = root;
    this.identity = identity;
  }
  static async create(root: string): Promise<SafeRoot> {
    try {
      const canonical = await realpath(root);
      const identity = await stat(canonical);
      if (!identity.isDirectory())
        throw new WorkspaceError("NOT_DIRECTORY", "Workspace root is not a directory");
      return new SafeRoot(canonical, identity);
    } catch (error) {
      throw failure(error);
    }
  }
  path(input: string): string {
    if (!validRelativePath(input))
      throw new WorkspaceError(
        "INVALID_PATH",
        "Paths must be relative and contain no traversal segments",
      );
    return input
      .split("/")
      .filter((part) => part && part !== ".")
      .join("/");
  }
  private contains(path: string): void {
    const rel = relative(this.root, path);
    if (rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel)) {
      throw new WorkspaceError("PATH_ESCAPE", "Path resolves outside the workspace");
    }
  }
  async resolve(input: string): Promise<string> {
    const path = this.path(input);
    try {
      const root = await realpath(this.root);
      if (root !== this.root || !same(await stat(root), this.identity)) {
        throw new WorkspaceError("PATH_CHANGED", "Workspace root was replaced");
      }
      let resolved = this.root;
      let prefix = this.root;
      for (const part of path.split("/").filter(Boolean)) {
        prefix = join(prefix, part);
        resolved = await realpath(prefix);
        // An intermediate link may escape and then link back into the root.
        this.contains(resolved);
      }
      return resolved;
    } catch (error) {
      if (errorCode(error) === "EINVAL")
        throw new WorkspaceError(
          "PATH_CHANGED",
          "A symlink changed during realpath resolution",
          error,
        );
      throw failure(error);
    }
  }
  async verify(input: string, resolved: string, expected: Stats): Promise<void> {
    if ((await this.resolve(input)) !== resolved || !same(await stat(resolved), expected)) {
      throw new WorkspaceError("PATH_CHANGED", "Path changed during the operation");
    }
  }
  async file(input: string): Promise<{ handle: FileHandle; info: Stats }> {
    let handle: FileHandle | undefined;
    try {
      const resolved = await this.resolve(input);
      const expected = await lstat(resolved);
      if (!expected.isFile()) throw new WorkspaceError("NOT_FILE", "Path is not a regular file");
      // O_NOFOLLOW protects the final component. Identity checks protect swapped parents.
      // O_NONBLOCK prevents a replacement FIFO from hanging the daemon before fstat.
      handle = await open(
        resolved,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      const info = await handle.stat();
      if (!info.isFile() || !same(info, expected))
        throw new WorkspaceError("PATH_CHANGED", "File was replaced while opening");
      await this.verify(input, resolved, info);
      return { handle, info };
    } catch (error) {
      await handle?.close();
      throw failure(error);
    }
  }
  async metadata(input: string) {
    try {
      const resolved = await this.resolve(input);
      const info = await lstat(resolved);
      const link = await lstat(join(this.root, this.path(input)));
      await this.verify(input, resolved, info);
      return {
        info,
        type: link.isSymbolicLink()
          ? ("symlink" as const)
          : info.isFile()
            ? ("file" as const)
            : info.isDirectory()
              ? ("directory" as const)
              : ("other" as const),
      };
    } catch (error) {
      throw failure(error);
    }
  }
  async names(input: string): Promise<string[]> {
    let handle: FileHandle | undefined;
    try {
      const resolved = await this.resolve(input);
      const expected = await lstat(resolved);
      if (!expected.isDirectory())
        throw new WorkspaceError("NOT_DIRECTORY", "Path is not a directory");
      handle = await open(
        resolved,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      if (!same(await handle.stat(), expected))
        throw new WorkspaceError("PATH_CHANGED", "Directory was replaced");
      await this.verify(input, resolved, expected);
      const names: string[] = [];
      const dir = await opendir(resolved);
      try {
        for await (const entry of dir) {
          names.push(entry.name);
          if (names.length > DIRECTORY_CAP)
            throw new WorkspaceError("LIMIT_EXCEEDED", "Directory exceeds 10,000 entries");
        }
      } finally {
        // for-await owns and closes the directory, including early exits.
        await this.verify(input, resolved, expected);
      }
      return names.toSorted();
    } catch (error) {
      throw failure(error);
    } finally {
      await handle?.close();
    }
  }
}
export function internal(path: string): boolean {
  return path.split("/").includes(".git");
}
export function transient(error: unknown): boolean {
  return (
    error instanceof WorkspaceError &&
    ["NOT_FOUND", "PATH_ESCAPE", "PATH_CHANGED", "NOT_DIRECTORY"].includes(error.code)
  );
}
