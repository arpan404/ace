import { ignoreStream } from "./ignore-stream.ts";
import { dirname, isAbsolute, resolve } from "node:path";
import { z } from "zod";
import { command } from "./process.ts";
import { errorCode, WorkspaceError } from "./types.ts";
import type { SafeRoot } from "./safety.ts";

function missingGit(error: unknown): undefined {
  if (errorCode(error) === "ENOENT") return undefined;
  throw error;
}

export class GitIgnore {
  private readonly safe: SafeRoot;
  private probe: Promise<boolean> | undefined;
  private foundRepository = false;
  private stream: ReturnType<typeof ignoreStream> | undefined;
  private constructor(safe: SafeRoot) {
    this.safe = safe;
  }
  static async create(safe: SafeRoot): Promise<GitIgnore> {
    return new GitIgnore(safe);
  }
  /** Repository identity is mutable between traversals, but stable within one. */
  traversal(): GitIgnore {
    return this.stream ? this : new GitIgnore(this.safe);
  }
  /** Linked worktrees keep index/exclude metadata outside the workspace directory. */
  async metadataPaths(signal?: AbortSignal): Promise<string[]> {
    await this.safe.resolve("");
    const paths: string[] = [];
    for (const name of ["HEAD", "index", "info/exclude", "config", "config.worktree"]) {
      const result = await command(
        "git",
        ["rev-parse", "--path-format=absolute", "--git-path", name],
        {
          cwd: this.safe.root,
          outputCap: 8192,
          ...(signal ? { signal } : {}),
        },
        this.safe.runtime,
      ).catch(missingGit);
      if (!result) return [];
      if (result.code !== 0) continue;
      const path = z
        .string()
        .min(1)
        .max(4096)
        .parse(result.stdout.toString("utf8").replace(/\n$/, ""));
      paths.push(isAbsolute(path) ? path : resolve(this.safe.root, path));
    }
    const config = await command(
      "git",
      ["config", "--null", "--show-origin", "--list"],
      { cwd: this.safe.root, outputCap: 1_048_576, ...(signal ? { signal } : {}) },
      this.safe.runtime,
    ).catch(missingGit);
    if (!config) return [];
    if (config.code !== 0)
      throw new WorkspaceError("IO_ERROR", config.stderr || "Cannot read Git configuration");
    const fields = config.stdout.toString("utf8").split("\0");
    for (let i = 0; i < fields.length - 1; i += 2) {
      const origin = fields[i];
      if (origin?.startsWith("file:")) paths.push(resolve(this.safe.root, origin.slice(5)));
    }
    // Origins alone omit included files without settings. Git expands pathname
    // values for us; relative include targets belong to the declaring file.
    const includes = await command(
      "git",
      [
        "config",
        "--includes",
        "--null",
        "--show-origin",
        "--path",
        "--get-regexp",
        "^include(if\\..*)?\\.path$",
      ],
      { cwd: this.safe.root, outputCap: 1_048_576, ...(signal ? { signal } : {}) },
      this.safe.runtime,
    ).catch(missingGit);
    if (!includes) return [];
    if (includes.code !== 0 && includes.code !== 1)
      throw new WorkspaceError("IO_ERROR", includes.stderr || "Cannot resolve Git includes");
    const declarations = includes.stdout.toString("utf8").split("\0");
    for (let i = 0; i < declarations.length - 1; i += 2) {
      const origin = declarations[i];
      const setting = declarations[i + 1];
      if (!origin?.startsWith("file:") || setting === undefined) continue;
      const separator = setting.indexOf("\n");
      if (separator < 0) continue;
      const target = z
        .string()
        .min(1)
        .max(4096)
        .parse(setting.slice(separator + 1));
      const declaring = z.string().min(1).max(4096).parse(origin.slice(5));
      paths.push(resolve(dirname(resolve(this.safe.root, declaring)), target));
    }
    const excludes = await command(
      "git",
      ["config", "--path", "--get", "core.excludesFile"],
      { cwd: this.safe.root, outputCap: 8192, ...(signal ? { signal } : {}) },
      this.safe.runtime,
    ).catch(missingGit);
    if (!excludes) return [];
    if (excludes.code !== 0 && excludes.code !== 1)
      throw new WorkspaceError("IO_ERROR", excludes.stderr || "Cannot resolve Git excludes source");
    const env = z
      .object({
        HOME: z.string().optional(),
        XDG_CONFIG_HOME: z.string().optional(),
        GIT_CONFIG_GLOBAL: z.string().optional(),
      })
      .parse(this.safe.runtime.environment);
    const configHome = env.XDG_CONFIG_HOME || (env.HOME ? resolve(env.HOME, ".config") : undefined);
    if (excludes.code === 0) {
      const path = z.string().max(4096).parse(excludes.stdout.toString("utf8").replace(/\n$/, ""));
      if (path) paths.push(resolve(this.safe.root, path));
    } else if (configHome) paths.push(resolve(configHome, "git/ignore"));
    // Configuration files must be observed even before their first creation.
    if (env.GIT_CONFIG_GLOBAL) paths.push(resolve(env.GIT_CONFIG_GLOBAL));
    else {
      if (env.HOME) paths.push(resolve(env.HOME, ".gitconfig"));
      if (configHome) paths.push(resolve(configHome, "git/config"));
    }
    await this.safe.resolve("");
    return [...new Set(paths)];
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
    this.foundRepository = probe.code === 0 && probe.stdout.toString().trim() === "true";
    return this.foundRepository;
  }
  async scan<T>(signal: AbortSignal, run: (ignore: GitIgnore) => Promise<T>): Promise<T> {
    if (!this.foundRepository && !this.stream) this.probe = undefined;
    if (this.stream || !(await this.repository(signal))) return run(this);
    const scoped = new GitIgnore(this.safe);
    scoped.probe = this.probe;
    const stream = ignoreStream(this.safe, signal);
    scoped.stream = stream;
    try {
      return await run(scoped);
    } catch (error) {
      this.probe = undefined;
      this.foundRepository = false;
      throw error;
    } finally {
      await stream.close();
    }
  }
  async ignored(paths: string[], signal?: AbortSignal): Promise<Set<string>> {
    if (!paths.length) return new Set();
    await this.safe.resolve("");
    if (!(await this.repository(signal))) return new Set();
    if (this.stream) return this.stream.ignored(paths);
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
