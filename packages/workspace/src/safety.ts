import {
  openAt,
  openRoot,
  openMetadataAt,
  statAt,
  descriptorNames,
  sameWindowsFile,
  type Descriptor,
} from "./descriptor.ts";
import { constants, type Stats } from "node:fs";
import { type FileHandle } from "node:fs/promises";
import { workspaceRuntime, type WorkspaceFileSystem, type WorkspaceRuntime } from "./runtime.ts";
import { isAbsolute, join, relative, sep, win32, dirname, basename } from "node:path";
import { failure, errorCode, WorkspaceError } from "./types.ts";
import {
  passesWindowsRelativePathPolicy,
  windowsInternal,
  windowsTransferTemporary,
} from "./path-policy.ts";

/** Shared lexical schema for explicit requests and discovered filesystem names. */
export function validRelativePath(input: string): boolean {
  if (process.platform === "win32" && !passesWindowsRelativePathPolicy(input)) return false;
  return !(
    input.includes("\0") ||
    input.includes("\\") ||
    isAbsolute(input) ||
    win32.isAbsolute(input) ||
    input.split("/").includes("..")
  );
}
function same(a: Stats, b: Stats): boolean {
  if (process.platform === "win32" && !sameWindowsFile(a, b)) return false;
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
      if (process.platform === "win32") windowsRootRequest(root);
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
      if (process.platform === "win32" && errorCode(error) === "ENOENT")
        await this.windowsFileParent(path);
      if (errorCode(error) === "EINVAL")
        throw new WorkspaceError(
          "PATH_CHANGED",
          "A symlink changed during realpath resolution",
          error,
        );
      throw failure(error);
    }
  }
  /**
   * Win32 reports a file used as a folder ("a.txt/b") as missing, where POSIX says ENOTDIR.
   * Throws NOT_DIRECTORY when an existing component before the leaf is not a directory.
   */
  private async windowsFileParent(path: string): Promise<void> {
    const parts = path.split("/").filter(Boolean);
    let prefix = this.root;
    for (const part of parts.slice(0, -1)) {
      prefix = join(prefix, part);
      let info: Stats;
      try {
        info = await this.fs.stat(prefix);
      } catch {
        return;
      }
      if (!info.isDirectory())
        throw new WorkspaceError("NOT_DIRECTORY", "A parent of the path is not a directory");
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
  async file(
    input: string,
  ): Promise<{ handle: FileHandle | Descriptor; info: Stats; resolved: string }> {
    let handle: FileHandle | Descriptor | undefined;
    try {
      const resolved = await this.resolve(input);
      if (transferTemporary(relative(this.root, resolved).split(sep).join("/")))
        throw new WorkspaceError("INVALID_PATH", "Upload temporary files are private");
      const expected = await this.fs.lstat(resolved);
      if (!expected.isFile()) throw new WorkspaceError("NOT_FILE", "Path is not a regular file");
      handle = await this.anchored(resolved, constants.O_RDONLY);
      const info = await handle.stat();
      if (!info.isFile() || !same(info, expected))
        throw new WorkspaceError("PATH_CHANGED", "File was replaced while opening");
      await this.verify(input, resolved, info);
      return { handle, info, resolved };
    } catch (error) {
      await handle?.close();
      throw failure(error);
    }
  }
  /** Acquire private staging metadata even when the file's mode forbids reads. */
  async privateFileMetadata(input: string) {
    const path = this.path(input);
    if (internal(dirname(path)) || !/^\.ace-upload-[a-zA-Z0-9_-]+$/.test(basename(path)))
      throw new WorkspaceError("INVALID_PATH", "Expected a private transfer file");
    let handle: Descriptor | undefined;
    try {
      const parentPath = dirname(path) === "." ? "" : dirname(path);
      const parentResolved = await this.resolve(parentPath);
      const parentInfo = await this.fs.lstat(parentResolved);
      const resolved = join(parentResolved, basename(path));
      const expected = await this.fs.lstat(resolved);
      if (!expected.isFile())
        throw new WorkspaceError("NOT_FILE", "Expected a regular private file");
      const parent = await this.anchored(
        parentResolved,
        constants.O_RDONLY | constants.O_DIRECTORY,
      );
      try {
        handle = openMetadataAt(parent.fd, basename(path));
      } finally {
        await parent.close();
      }
      const info = await handle.stat();
      if (!info.isFile() || !same(info, expected) || info.nlink !== 1)
        throw new WorkspaceError("PATH_CHANGED", "Private file was replaced or linked");
      const verify = async () => {
        await this.verify(parentPath, parentResolved, parentInfo);
        const current = await this.fs.lstat(resolved);
        if (!current.isFile() || !same(current, info) || current.nlink !== 1)
          throw new WorkspaceError("PATH_CHANGED", "Private file was replaced or linked");
      };
      await verify();
      return { handle, info, verify };
    } catch (error) {
      await handle?.close();
      throw failure(error);
    }
  }
  /** Mutation endpoints never follow links, including links within the workspace. */
  async target(input: string): Promise<{ path: string; verify(): Promise<void> }> {
    const path = this.path(input);
    if (!path || internal(path)) throw new WorkspaceError("INVALID_PATH", "Reserved mutation path");
    const parts = path.split("/");
    const name = parts.pop();
    if (!name) throw new WorkspaceError("INVALID_PATH", "Missing filename");
    let prefix = "";
    for (const part of parts) {
      prefix = prefix ? `${prefix}/${part}` : part;
      const info = await this.fs.lstat(join(this.root, prefix));
      if (info.isSymbolicLink())
        throw new WorkspaceError("PATH_ESCAPE", "Mutation crosses a symlink");
    }
    const parent = parts.join("/");
    const resolved = await this.resolve(parent);
    const expected = await this.fs.lstat(resolved);
    if (!expected.isDirectory()) throw new WorkspaceError("NOT_DIRECTORY", "Invalid parent");
    const destination = join(resolved, name);
    try {
      if ((await this.fs.lstat(destination)).isSymbolicLink())
        throw new WorkspaceError("PATH_ESCAPE", "Mutation target is a symlink");
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
    }
    // Windows: realpath returns on-disk long names, so case and 8.3 aliases (GIT~1) of
    // reserved entries are caught on the resolved parent and the existing leaf.
    if (process.platform === "win32") await this.windowsReservedTarget(resolved, destination);
    return { path: destination, verify: () => this.verify(parent, resolved, expected) };
  }
  private async windowsReservedTarget(resolved: string, destination: string): Promise<void> {
    let leaf: string | undefined;
    try {
      // A link leaf was refused above, so realpath names the leaf itself.
      leaf = basename(await this.fs.realpath(destination));
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
    }
    const parent = relative(this.root, resolved).split(sep).join("/");
    if (internal(parent) || (leaf !== undefined && internal(leaf)))
      throw new WorkspaceError("INVALID_PATH", "Reserved mutation path");
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
      if (process.platform === "win32" && !sameWindowsFile(proof, expected))
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
/** Win32: projects open from a local drive; network shares and device paths are refused. */
function windowsRootRequest(root: string): void {
  if (/^[\\/]{2}[?.][\\/]|^\\\?\?\\/.test(root))
    throw new WorkspaceError("INVALID_PATH", `Device paths can't be opened as projects: ${root}`);
  if (/^[\\/]{2}/.test(root))
    throw new WorkspaceError(
      "INVALID_PATH",
      `Network folders (\\\\server\\share) can't be opened as projects; clone or copy it to a local drive: ${root}`,
    );
}
export function transferTemporary(path: string): boolean {
  if (process.platform === "win32") return windowsTransferTemporary(path);
  return path.split("/").some((part) => part.startsWith(".ace-upload-"));
}
export function internal(path: string): boolean {
  if (process.platform === "win32") return windowsInternal(path);
  return path.split("/").includes(".git") || transferTemporary(path);
}
export function transient(error: unknown): boolean {
  return (
    error instanceof WorkspaceError &&
    ["NOT_FOUND", "PATH_ESCAPE", "PATH_CHANGED", "NOT_DIRECTORY"].includes(error.code)
  );
}
