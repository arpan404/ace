import { command } from "./process.ts";
import { errorCode, WorkspaceError } from "./types.ts";
import type { SafeRoot } from "./safety.ts";

/**
 * Git's ignore rules for one root. A checkout's listing and watching now live in ace-files; this
 * is what a single mention asks before reading bytes, and what the shared tree walker marks.
 */
export class GitIgnore {
  private readonly safe: SafeRoot;
  private probe: Promise<boolean> | undefined;
  private constructor(safe: SafeRoot) {
    this.safe = safe;
  }
  static async create(safe: SafeRoot): Promise<GitIgnore> {
    return new GitIgnore(safe);
  }
  private repository(signal?: AbortSignal): Promise<boolean> {
    this.probe ??= this.probeRepository(signal).catch((error: unknown) => {
      this.probe = undefined;
      throw error;
    });
    return this.probe;
  }
  private async probeRepository(signal?: AbortSignal): Promise<boolean> {
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
    return probe.code === 0 && probe.stdout.toString().trim() === "true";
  }
  async ignored(paths: string[], signal?: AbortSignal): Promise<Set<string>> {
    if (!paths.length) return new Set();
    await this.safe.resolve("");
    if (!(await this.repository(signal))) return new Set();
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
