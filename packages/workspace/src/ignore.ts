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
  async ignored(paths: string[], signal?: AbortSignal): Promise<Set<string>> {
    if (!paths.length) return new Set();
    await this.safe.resolve("");
    const probe = await command("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd: this.safe.root,
      ...(signal ? { signal } : {}),
    }).catch((error: unknown) => {
      if (errorCode(error) === "ENOENT") return { code: 1, stdout: Buffer.alloc(0), stderr: "" };
      throw error;
    });
    if (probe.code !== 0 || probe.stdout.toString().trim() !== "true") return new Set();
    // NUL framing supports newlines in filenames. Git keeps tracked files visible.
    const result = await command("git", ["check-ignore", "--stdin", "-z"], {
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
