import { withGit, type GitProcessOptions } from "./git-process.ts";
import { constants } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { requireContext } from "./errors.ts";
import { ignoredPaths } from "./git-ignore-batch.ts";
import { containedPath, pathMetadata } from "./workspace-path.ts";

/** One file below a folder, as ace-files lists it: relative, `/` separated, size in bytes. */
export interface WorkspaceFileEntry {
  path: string;
  size: number;
}

/** What a folder mention lists. The daemon answers it from ace-files' paged listing. */
export type WorkspaceFolderLister = (folder: string) => AsyncIterable<WorkspaceFileEntry>;

export interface WorkspaceFiles {
  readonly root: string;
  inspect(path: string): Promise<"file" | "folder">;
  read(path: string, limit: number): Promise<{ bytes: Buffer; more: boolean }>;
  /**
   * Every non-ignored file below `folder`, recursively. Listing is ace-files' work; this reader
   * only passes the request on, so a folder mention shows the same files the tree does.
   */
  list(folder: string): AsyncIterable<WorkspaceFileEntry>;
}

export interface WorkspaceReaderOptions {
  /** ace-files' folder listing; without it a folder mention reports `unsupported`. */
  list?: WorkspaceFolderLister | undefined;
}
/**
 * One checkout's mention reader: resolves a mention path inside the root, applies Git's ignore
 * rules to it, and reads its bytes. It keeps no index and watches nothing; quick open and folder
 * listings come from ace-files through the daemon.
 */
export class GitWorkspace implements WorkspaceFiles {
  readonly root: string;
  readonly #options: GitProcessOptions;
  readonly #list: WorkspaceFolderLister | undefined;
  #ordinaryFolder: boolean | undefined;
  constructor(root: string, options: GitProcessOptions = {}, reader: WorkspaceReaderOptions = {}) {
    this.#options = options;
    this.root = resolve(root);
    this.#list = reader.list;
  }
  /** A folder that is not a Git repository mentions any file except Git metadata. */
  private async ordinaryFolder(): Promise<boolean> {
    if (this.#ordinaryFolder !== undefined) return this.#ordinaryFolder;
    requireContext(
      (await realpath(this.root)) === this.root,
      "outside_workspace",
      "Workspace root must be canonical",
    );
    const repository = await withGit(
      this.root,
      ["rev-parse", "--is-inside-work-tree"],
      this.#options,
      async (child) => {
        child.stdin.end();
        child.stdout.resume();
      },
    );
    const ordinary =
      repository.code === 128 &&
      repository.stderr.startsWith(
        "fatal: not a git repository (or any of the parent directories):",
      );
    requireContext(
      repository.code === 0 || ordinary,
      "invalid_request",
      repository.stderr.trim() || "Cannot inspect workspace repository",
    );
    this.#ordinaryFolder = ordinary;
    return ordinary;
  }
  private async checked(path: string): Promise<string> {
    const contained = await containedPath(this.root, path);
    if (await this.ordinaryFolder()) {
      requireContext(
        !contained.local.split(/[\\/]/).includes(".git"),
        "ignored",
        "Git metadata cannot be mentioned",
      );
      return contained.absolute;
    }
    const ignored = await ignoredPaths(this.root, [contained.local], this.#options);
    requireContext(!ignored.has(contained.local), "ignored", "Path is ignored by Git");
    return contained.absolute;
  }
  async inspect(path: string): Promise<"file" | "folder"> {
    const info = await pathMetadata(await this.checked(path));
    requireContext(
      info.isFile() || info.isDirectory(),
      "invalid_request",
      "Only regular files and folders can be mentioned",
    );
    return info.isDirectory() ? "folder" : "file";
  }
  async read(path: string, limit: number): Promise<{ bytes: Buffer; more: boolean }> {
    const absolute = await this.checked(path);
    const file = await open(
      absolute,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const info = await file.stat();
      const current = await stat(absolute);
      requireContext(
        info.isFile() &&
          info.ino === current.ino &&
          info.dev === current.dev &&
          (await realpath(absolute)) === absolute,
        "outside_workspace",
        "File changed during resolution",
      );
      const bytes = Buffer.alloc(Math.min(info.size, limit + 1));
      let offset = 0;
      while (offset < bytes.length) {
        const read = await file.read(bytes, offset, bytes.length - offset, offset);
        if (!read.bytesRead) break;
        offset += read.bytesRead;
      }
      return { bytes: bytes.subarray(0, Math.min(offset, limit)), more: offset > limit };
    } finally {
      await file.close();
    }
  }
  list(folder: string): AsyncIterable<WorkspaceFileEntry> {
    const list = this.#list;
    requireContext(list, "unsupported", "Folder listings need ace-files");
    return list(folder);
  }
}
