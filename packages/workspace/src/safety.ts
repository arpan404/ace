import { openAt, openRoot, statAt, descriptorNames, type Descriptor } from "./descriptor.ts";
import { constants, type Stats } from "node:fs";
import { type FileHandle } from "node:fs/promises";
import { workspaceRuntime, type WorkspaceFileSystem, type WorkspaceRuntime } from "./runtime.ts";
import { isAbsolute, join, relative, sep, win32, dirname, basename } from "node:path";
import { failure, errorCode, WorkspaceError } from "./types.ts";

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
  readonly runtime: WorkspaceRuntime;
  private readonly identity: Stats;
  private readonly fs: WorkspaceFileSystem;
  private constructor(root: string, identity: Stats, runtime: WorkspaceRuntime) {
    this.runtime = runtime;
    this.fs = runtime.filesystem;
    this.root = root;
    this.identity = identity;
  }
  static async create(
    root: string,
    runtime: WorkspaceRuntime = workspaceRuntime(),
  ): Promise<SafeRoot> {
    try {
      const fs = runtime.filesystem;
      const canonical = await fs.realpath(root);
      const descriptor = openRoot(canonical);
      let identity: Stats;
      try {
        identity = await descriptor.stat();
      } finally {
        await descriptor.close();
      }
      if (!identity.isDirectory())
        throw new WorkspaceError("NOT_DIRECTORY", "Workspace root is not a directory");
      return new SafeRoot(canonical, identity, runtime);
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
      const root = await this.fs.realpath(this.root);
      if (root !== this.root || !same(await this.fs.stat(root), this.identity)) {
        throw new WorkspaceError("PATH_CHANGED", "Workspace root was replaced");
      }
      let resolved = this.root;
      let prefix = this.root;
      for (const part of path.split("/").filter(Boolean)) {
        prefix = join(prefix, part);
        resolved = await this.fs.realpath(prefix);
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
    if ((await this.resolve(input)) !== resolved || !same(await this.fs.stat(resolved), expected)) {
      throw new WorkspaceError("PATH_CHANGED", "Path changed during the operation");
    }
  }
  private async anchored(resolved: string, flags: number): Promise<FileHandle | Descriptor> {
    this.contains(resolved);
    let current: FileHandle | Descriptor = openRoot(this.root);
    try {
      if (!same(await current.stat(), this.identity))
        throw new WorkspaceError("PATH_CHANGED", "Workspace root was replaced");
      const parts = relative(this.root, resolved).split(sep).filter(Boolean);
      for (const [index, part] of parts.entries()) {
        const next = openAt(
          current.fd,
          part,
          index === parts.length - 1 ? flags : constants.O_RDONLY | constants.O_DIRECTORY,
        );
        await current.close();
        current = next;
      }
      return current;
    } catch (error) {
      await current.close();
      throw error;
    }
  }
  async file(input: string): Promise<{ handle: FileHandle | Descriptor; info: Stats }> {
    let handle: FileHandle | Descriptor | undefined;
    try {
      const resolved = await this.resolve(input);
      const expected = await this.fs.lstat(resolved);
      if (!expected.isFile()) throw new WorkspaceError("NOT_FILE", "Path is not a regular file");
      handle = await this.anchored(resolved, constants.O_RDONLY);
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
      const expected = await this.fs.lstat(resolved);
      const parent = await this.anchored(
        resolved === this.root ? resolved : dirname(resolved),
        constants.O_RDONLY | constants.O_DIRECTORY,
      );
      let proof;
      try {
        proof =
          resolved === this.root ? await parent.stat() : statAt(parent.fd, basename(resolved));
      } finally {
        await parent.close();
      }
      if (proof.dev !== expected.dev || proof.ino !== expected.ino)
        throw new WorkspaceError("PATH_CHANGED", "Entry was replaced");
      const info = expected;
      info.size = proof.size;
      info.mtimeMs = "mtimeMs" in proof ? proof.mtimeMs : proof.mtime;
      const link = await this.fs.lstat(join(this.root, this.path(input)));
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
  async entries(input: string) {
    let handle: FileHandle | Descriptor | undefined;
    try {
      const resolved = await this.resolve(input);
      const expected = await this.fs.lstat(resolved);
      if (!expected.isDirectory())
        throw new WorkspaceError("NOT_DIRECTORY", "Path is not a directory");
      handle = await this.anchored(resolved, constants.O_RDONLY | constants.O_DIRECTORY);
      if (!same(await handle.stat(), expected))
        throw new WorkspaceError("PATH_CHANGED", "Directory was replaced");
      const fd = handle.fd;
      const entries = descriptorNames(fd).flatMap((name) => {
        try {
          const info = statAt(fd, name);
          const kind = info.mode & 0o170000;
          const type =
            kind === 0o100000
              ? ("file" as const)
              : kind === 0o040000
                ? ("directory" as const)
                : kind === 0o120000
                  ? ("symlink" as const)
                  : ("other" as const);
          return [{ name, info, type }];
        } catch (error) {
          if (transient(failure(error))) return [];
          throw error;
        }
      });
      await this.verify(input, resolved, expected);
      return entries;
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
