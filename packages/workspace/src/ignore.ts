import type { WorkspaceProcessSpawner } from "./runtime.ts";
import { spawn } from "node:child_process";
import { command } from "./process.ts";
import { errorCode, WorkspaceError } from "./types.ts";
import type { SafeRoot } from "./safety.ts";

export class GitIgnore {
  private readonly safe: SafeRoot;
  private readonly spawn: WorkspaceProcessSpawner;
  private constructor(safe: SafeRoot, spawnProcess: WorkspaceProcessSpawner) {
    this.safe = safe;
    this.spawn = spawnProcess;
  }
  static async create(
    safe: SafeRoot,
    spawnProcess: WorkspaceProcessSpawner = spawn,
  ): Promise<GitIgnore> {
    return new GitIgnore(safe, spawnProcess);
  }
  async ignored(paths: string[], signal?: AbortSignal): Promise<Set<string>> {
    if (!paths.length) return new Set();
    await this.safe.resolve("");
    const probe = await command("git", ["rev-parse", "--is-inside-work-tree"], {
      spawn: this.spawn,
      cwd: this.safe.root,
      ...(signal ? { signal } : {}),
    }).catch((error: unknown) => {
      if (errorCode(error) === "ENOENT") return { code: 1, stdout: Buffer.alloc(0), stderr: "" };
      throw error;
    });
    if (probe.code !== 0 || probe.stdout.toString().trim() !== "true") return new Set();
    // NUL framing supports newlines in filenames. Git keeps tracked files visible.
    const result = await command("git", ["check-ignore", "--stdin", "-z"], {
      spawn: this.spawn,
      cwd: this.safe.root,
      input: Buffer.from(paths.join("\0") + "\0"),
      ...(signal ? { signal } : {}),
    });
    if (result.code !== 0 && result.code !== 1)
      throw new WorkspaceError("IO_ERROR", result.stderr || "git check-ignore failed");
    await this.safe.resolve("");
    return new Set(result.stdout.toString("utf8").split("\0").filter(Boolean));
  }
}
