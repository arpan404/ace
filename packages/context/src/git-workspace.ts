import { z } from "zod";
import { withGit, type GitProcessOptions } from "./git-process.ts";
import { StringDecoder } from "node:string_decoder";
import { constants } from "node:fs";
import { lstat, open, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { requireContext } from "./errors.ts";
import { PathIndex } from "./path-index.ts";

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
  private async listing(args: string[], visit: (path: string) => void): Promise<void> {
    const result = await withGit(
      this.root,
      ["ls-files", "-z", ...args],
      this.options,
      async (child) => {
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
      },
    );
    requireContext(result.code === 0, "invalid_request", "Workspace must be a Git repository");
  }
  private async git(args: string[]): Promise<{ code: number; output: string }> {
    const result = await withGit(this.root, args, this.options, async (child) => {
      child.stdin.end();
      let output = "";
      for await (const chunk of child.stdout) {
        const data = z.instanceof(Buffer).parse(chunk);
        requireContext(
          Buffer.byteLength(output) + data.length <= 8192,
          "quota",
          "Git response exceeded limit",
        );
        output += data.toString();
      }
      return output;
    });
    return { code: result.code, output: result.value };
  }
  async initialize(): Promise<void> {
    requireContext(
      (await realpath(this.root)) === this.root,
      "outside_workspace",
      "Workspace root must be canonical",
    );
    const next = new PathIndex(this.cap);
    await this.listing(["--cached", "--others", "--exclude-standard"], (path) =>
      next.update(path, true),
    );
    await this.listing(["--cached", "--ignored", "--exclude-standard"], (path) =>
      next.update(path, false),
    );
    await this.listing(["--deleted"], (path) => next.update(path, false));
    this.index = next;
  }

  private async checked(path: string): Promise<string> {
    requireContext(
      !isAbsolute(path) && !path.includes("\0") && !path.split(/[\\/]/).includes(".."),
      "outside_workspace",
      "Mention must stay inside workspace",
    );
    const absolute = resolve(this.root, path);
    const local = relative(this.root, absolute);
    requireContext(
      !local.startsWith(`..${sep}`) && local !== ".." && !isAbsolute(local),
      "outside_workspace",
      "Path escapes workspace",
    );
    let current = this.root;
    for (const part of local.split(sep).filter(Boolean)) {
      current = join(current, part);
      const info = await lstat(current);
      requireContext(!info.isSymbolicLink(), "outside_workspace", "Symlinks cannot be mentioned");
    }
    requireContext(
      (await realpath(absolute)) === absolute,
      "outside_workspace",
      "Path redirected outside workspace",
    );
    const ignored = await this.git(["check-ignore", "--no-index", "--quiet", "--", local || "."]);
    requireContext(
      ignored.code === 0 || ignored.code === 1,
      "invalid_request",
      "Cannot check workspace ignore rules",
    );
    requireContext(ignored.code !== 0, "ignored", "Path is ignored by Git");
    return absolute;
  }
  async inspect(path: string): Promise<"file" | "folder"> {
    const info = await lstat(await this.checked(path));
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
  async update(paths: readonly string[]): Promise<void> {
    if (paths.some((path) => path.endsWith(".gitignore") || path.startsWith(".git/"))) {
      await this.initialize();
      return;
    }
    for (const path of paths) {
      try {
        const kind = await this.inspect(path);
        if (kind === "file") this.index.update(path, true);
        else {
          // Reconcile only this subtree. Tracked ignored and deleted paths are
          // explicitly filtered, since ls-files --cached includes both.
          const next = new PathIndex(this.cap);
          await this.listing(["--cached", "--others", "--exclude-standard", "--", path], (child) =>
            next.update(child, true),
          );
          await this.listing(["--cached", "--ignored", "--exclude-standard", "--", path], (child) =>
            next.update(child, false),
          );
          await this.listing(["--deleted", "--", path], (child) => next.update(child, false));
          for (const child of this.index.under(path)) this.index.update(child, false);
          for (const child of next.under(path)) this.index.update(child, true);
        }
      } catch {
        this.index.update(path, false);
        for (const child of this.index.under(path)) this.index.update(child, false);
      }
    }
  }
}
