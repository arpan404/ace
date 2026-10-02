import { isAbsolute, resolve } from "node:path";
import { z } from "zod";
import { command } from "./process.ts";
import { errorCode, WorkspaceError } from "./types.ts";
import type { SafeRoot } from "./safety.ts";

export class GitIgnore {
  private readonly safe: SafeRoot;
  private constructor(safe: SafeRoot) {
    this.safe = safe;
  }
  static async create(safe: SafeRoot): Promise<GitIgnore> {
    return new GitIgnore(safe);
  }
  /** Linked worktrees keep index/exclude metadata outside the workspace directory. */
  async metadataPaths(signal?: AbortSignal): Promise<string[]> {
    await this.safe.resolve("");
    const paths: string[] = [];
    for (const name of ["index", "info/exclude"]) {
      const result = await command(
        "git",
        ["rev-parse", "--path-format=absolute", "--git-path", name],
        {
          cwd: this.safe.root,
          outputCap: 8192,
          ...(signal ? { signal } : {}),
        },
        this.safe.runtime,
      ).catch((error: unknown) => {
        if (errorCode(error) === "ENOENT") return { code: 1, stdout: Buffer.alloc(0), stderr: "" };
        throw error;
      });
      if (result.code !== 0) continue;
      const path = z
        .string()
        .min(1)
        .max(4096)
        .parse(result.stdout.toString("utf8").replace(/\n$/, ""));
      paths.push(isAbsolute(path) ? path : resolve(this.safe.root, path));
    }
    await this.safe.resolve("");
    return paths;
  }
  async ignored(paths: string[], signal?: AbortSignal): Promise<Set<string>> {
    if (!paths.length) return new Set();
    await this.safe.resolve("");
    const probe = await command(
      "git",
      ["rev-parse", "--is-inside-work-tree"],
      {
        cwd: this.safe.root,
        ...(signal ? { signal } : {}),
      },
      this.safe.runtime,
    ).catch((error: unknown) => {
      if (errorCode(error) === "ENOENT") return { code: 1, stdout: Buffer.alloc(0), stderr: "" };
      throw error;
    });
    if (probe.code !== 0 || probe.stdout.toString().trim() !== "true") return new Set();
    // NUL framing supports newlines in filenames. Git keeps tracked files visible.
    const result = await command(
      "git",
      ["check-ignore", "--stdin", "-z"],
      {
        cwd: this.safe.root,
        input: Buffer.from(paths.join("\0") + "\0"),
        ...(signal ? { signal } : {}),
      },
      this.safe.runtime,
    );
    if (result.code !== 0 && result.code !== 1)
      throw new WorkspaceError("IO_ERROR", result.stderr || "git check-ignore failed");
    await this.safe.resolve("");
    return new Set(result.stdout.toString("utf8").split("\0").filter(Boolean));
  }
}
