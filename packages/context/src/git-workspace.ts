import { z } from "zod";
import { withGit, type GitProcessOptions } from "./git-process.ts";
import { StringDecoder } from "node:string_decoder";
import { constants } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { ContextError, requireContext } from "./errors.ts";
import { ignoredPaths } from "./git-ignore-batch.ts";
import { PathIndex } from "./path-index.ts";
import { containedPath, pathMetadata, type MetadataScope } from "./workspace-path.ts";

/** Errors proving a watched path no longer belongs in the index. */
function excluded(error: unknown): boolean {
  return (
    error instanceof ContextError &&
    ["not_found", "ignored", "outside_workspace"].includes(error.code)
  );
}
/** Watcher folders nested in another changed folder are covered by its listing. */
function outermost(folders: readonly string[]): string[] {
  const all = new Set(folders);
  if (all.has(".")) return ["."];
  return [...all].filter((folder) => {
    for (let at = folder.indexOf("/"); at >= 0; at = folder.indexOf("/", at + 1))
      if (all.has(folder.slice(0, at))) return false;
    return true;
  });
}
/** Keep each Git argument vector far below the platform's ARG_MAX. */
function argumentGroups(paths: readonly string[], budget = 128 * 1024): string[][] {
  const groups: string[][] = [];
  let group: string[] = [],
    bytes = 0;
  for (const path of paths) {
    const size = Buffer.byteLength(path) + 1;
    if (group.length && bytes + size > budget) {
      groups.push(group);
      group = [];
      bytes = 0;
    }
    group.push(path);
    bytes += size;
  }
  if (group.length) groups.push(group);
  return groups;
}

export interface WorkspaceFiles {
  readonly root: string;
  readonly index: PathIndex;
  initialize(): Promise<void>;
  update(paths: readonly string[]): Promise<void>;
  inspect(path: string): Promise<"file" | "folder">;
  read(path: string, limit: number): Promise<{ bytes: Buffer; more: boolean }>;
}
export class GitWorkspace implements WorkspaceFiles {
  readonly root: string;
  index: PathIndex;
  private cap: number;
  private options: GitProcessOptions;
  constructor(root: string, cap = 100_000, options: GitProcessOptions = {}) {
    this.options = options;
    this.root = resolve(root);
    this.cap = cap;
    this.index = new PathIndex(cap);
  }
  /** `gitArgs` is the full Git argument vector; `ls-files -z` output is streamed. */
  private async listing(gitArgs: string[], visit: (path: string) => void): Promise<void> {
    const result = await withGit(this.root, gitArgs, this.options, async (child) => {
      child.stdin.end();
      const decoder = new StringDecoder("utf8");
      let pending = "";
      for await (const chunk of child.stdout) {
        const data = z.instanceof(Buffer).parse(chunk);
        pending += decoder.write(data);
        let end: number;
        while ((end = pending.indexOf("\0")) >= 0) {
          const path = pending.slice(0, end);
          pending = pending.slice(end + 1);
          if (path) visit(path);
        }
        requireContext(pending.length <= 1024, "quota", "Path exceeds index limit");
      }
      requireContext(
        pending.length === 0 && decoder.end().length === 0,
        "invalid_request",
        "Incomplete Git listing",
      );
    });
    requireContext(result.code === 0, "invalid_request", "Workspace must be a Git repository");
  }
  async initialize(): Promise<void> {
    requireContext(
      (await realpath(this.root)) === this.root,
      "outside_workspace",
      "Workspace root must be canonical",
    );
    const next = new PathIndex(this.cap);
    await this.listing(["ls-files", "-z", "--cached", "--others", "--exclude-standard"], (path) =>
      next.update(path, true),
    );
    await this.listing(["ls-files", "-z", "--cached", "--ignored", "--exclude-standard"], (path) =>
      next.update(path, false),
    );
    await this.listing(["ls-files", "-z", "--deleted"], (path) => next.update(path, false));
    this.index = next;
  }
  private async checked(path: string): Promise<string> {
    const contained = await containedPath(this.root, path);
    const ignored = await ignoredPaths(this.root, [contained.local], this.options);
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
  /**
   * Reconcile a batch of watcher hints with one ignore check and one set of
   * subtree listings, whatever the batch size. Containment and symlink rules
   * are proven per path before Git sees it; ancestors are stat'ed once.
   */
  async update(paths: readonly string[]): Promise<void> {
    if (paths.some((path) => path.endsWith(".gitignore") || path.startsWith(".git/"))) {
      await this.initialize();
      return;
    }
    const scope: MetadataScope = new Map();
    const gone: string[] = [];
    const candidates: { path: string; local: string; folder: boolean }[] = [];
    for (const path of new Set(paths)) {
      try {
        const { local, info } = await containedPath(this.root, path, scope);
        // Sockets, FIFOs and devices are never indexed or mentionable.
        if (info.isFile() || info.isDirectory())
          candidates.push({ path, local, folder: info.isDirectory() });
        else gone.push(path);
      } catch (error) {
        if (!excluded(error)) throw error;
        gone.push(path);
      }
    }
    const ignored = await ignoredPaths(
      this.root,
      candidates.map((candidate) => candidate.local),
      this.options,
    );
    const folders: string[] = [];
    for (const candidate of candidates) {
      if (ignored.has(candidate.local)) gone.push(candidate.path);
      else if (candidate.folder) folders.push(candidate.path);
      else this.index.update(candidate.path, true);
    }
    for (const path of gone) {
      this.index.update(path, false);
      for (const child of this.index.under(path)) this.index.update(child, false);
    }
    for (const group of argumentGroups(outermost(folders))) await this.reconcile(group);
  }
  /** Tracked ignored and deleted paths are filtered, since --cached lists both. */
  private async reconcile(folders: readonly string[]): Promise<void> {
    const next = new PathIndex(this.cap);
    // Literal pathspecs keep folders named like globs or ":magic" exact.
    const listing = (args: string[], present: boolean) =>
      this.listing(["--literal-pathspecs", "ls-files", "-z", ...args, "--", ...folders], (path) =>
        next.update(path, present),
      );
    await listing(["--cached", "--others", "--exclude-standard"], true);
    await listing(["--cached", "--ignored", "--exclude-standard"], false);
    await listing(["--deleted"], false);
    for (const folder of folders) this.index.replaceSubtree(folder, next);
  }
}
