import {
  spawnBytes,
  terminateDirectoryProcesses,
  type ByteProcess,
  type ByteProcessOptions,
} from "@ace/provider-kit/process-bytes";
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join, isAbsolute } from "node:path";
import type { Readable } from "node:stream";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { z } from "zod";
import { PluginCommit } from "@ace/protocol/plugins";
import { limits, normalizePath } from "./manifest.ts";
import { assertNoSymlinks } from "./files.ts";

const treeEntry = z.object({
  mode: z.enum(["100644", "100755"]),
  hash: z.string().regex(/^[a-f0-9]{40}$/),
  bytes: z.number().int().nonnegative().max(limits.file),
  path: z.string(),
});
export interface GitRuntime {
  spawn: (options: ByteProcessOptions) => ByteProcess;
  command: string;
  env: NodeJS.ProcessEnv;
  release: (root: string) => Promise<void>;
  schedule: (callback: () => void, milliseconds: number) => () => void;
}
/** Resolve platform defaults at the I/O boundary; all Git operations accept this dependency. */
export function gitRuntime(): GitRuntime {
  return {
    spawn: spawnBytes,
    command: "git",
    env: { PATH: process.env.PATH },
    async release(root) {
      await terminateDirectoryProcesses([root]);
    },
    schedule: (callback, milliseconds) => {
      const timer = setTimeout(callback, milliseconds);
      return () => clearTimeout(timer);
    },
  };
}
async function runGit<T>(
  args: string[],
  cwd: string,
  consume: (output: Readable) => Promise<T>,
  runtime: GitRuntime,
): Promise<T> {
  const child = runtime.spawn({
    command: runtime.command,
    args: [
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "protocol.allow=never",
      "-c",
      "protocol.file.allow=always",
      "-c",
      "protocol.https.allow=always",
      "-c",
      "protocol.ssh.allow=always",
      ...args,
    ],
    cwd,
    ownedCwd: cwd,
    env: {
      ...runtime.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
      GIT_OPTIONAL_LOCKS: "0",
    },
  });
  let stderr = "";
  let timedOut = false;
  let stopping: Promise<void> | undefined;
  const stop = () => {
    stopping ??= Promise.resolve().then(() => child.stop());
    return stopping;
  };
  const cancel = runtime.schedule(() => {
    timedOut = true;
    void stop().catch(() => {});
  }, 120_000);
  child.stderr.on("data", (chunk: Buffer) => {
    if (stderr.length < 8192) stderr += chunk.toString("utf8").slice(0, 8192 - stderr.length);
  });
  const completion = child.exited.then((code) => {
    if (timedOut) throw new Error("Git operation timed out");
    if (code !== 0) throw new Error(`Git failed: ${stderr}`);
  });
  try {
    const [value] = await Promise.all([consume(child.stdout), completion]);
    return value;
  } catch (error) {
    let cleanupError: unknown;
    try {
      await stop();
    } catch (failure) {
      cleanupError = failure;
    }
    await completion.catch(() => {});
    if (timedOut) {
      if (cleanupError)
        throw new AggregateError([error, cleanupError], "Git operation timed out", {
          cause: error,
        });
      throw new Error("Git operation timed out", { cause: error });
    }
    if (cleanupError)
      throw new AggregateError([error, cleanupError], "Git cleanup failed", { cause: error });
    throw error;
  } finally {
    cancel();
  }
}
async function git(
  args: string[],
  cwd: string,
  runtime: GitRuntime,
  maximum = limits.json,
): Promise<Buffer> {
  return runGit(
    args,
    cwd,
    async (stream) => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of stream) {
        bytes += chunk.length;
        if (bytes > maximum) throw new Error("Git output exceeds byte limit");
        chunks.push(chunk);
      }
      return Buffer.concat(chunks, bytes);
    },
    runtime,
  );
}
export async function fetchRepository(
  repository: string,
  ref: string,
  temporary: string,
  runtime: GitRuntime,
): Promise<{ gitRoot: string; commit: string }> {
  if (
    repository.length > 8192 ||
    (!isAbsolute(repository) && !/^(https:\/\/|ssh:\/\/|[\w.-]+@[\w.-]+:)/.test(repository)) ||
    [...repository].some((char) => char.charCodeAt(0) < 32)
  )
    throw new Error("Invalid repository location");
  if (!/^[A-Za-z0-9][A-Za-z0-9/_.-]{0,255}$/.test(ref) || ref.includes(".."))
    throw new Error("Invalid Git ref");
  const gitRoot = join(temporary, "repository.git");
  await mkdir(gitRoot, { recursive: true, mode: 0o700 });
  await git(["init", "--bare", gitRoot], temporary, runtime);
  await git(["fetch", "--depth=1", "--no-tags", "--", repository, ref], gitRoot, runtime);
  const commit = PluginCommit.parse(
    (await git(["rev-parse", "FETCH_HEAD^{commit}"], gitRoot, runtime)).toString("utf8").trim(),
  );
  return { gitRoot, commit };
}
export async function readGitFile(
  gitRoot: string,
  commit: string,
  path: string,
  runtime: GitRuntime,
): Promise<string> {
  return (
    await git(["show", `${PluginCommit.parse(commit)}:${normalizePath(path)}`], gitRoot, runtime)
  ).toString("utf8");
}
export async function extractPlugin(
  gitRoot: string,
  commit: string,
  pluginPath: string,
  destination: string,
  runtime: GitRuntime,
): Promise<void> {
  const prefix = pluginPath === "." ? "" : normalizePath(pluginPath);
  const tree = (
    await git(
      [
        "ls-tree",
        "-r",
        "-z",
        "-l",
        PluginCommit.parse(commit),
        "--",
        ...(prefix ? [`${prefix}/`] : []),
      ],
      gitRoot,
      runtime,
      2 * 1024 * 1024,
    )
  ).toString("utf8");
  let total = 0;
  let count = 0;
  for (const line of tree.split("\0")) {
    if (!line) continue;
    const match = /^(\d+) blob ([a-f0-9]+)\s+(\d+)\t(.+)$/.exec(line);
    if (!match) throw new Error("Symlinks, submodules and invalid Git entries are forbidden");
    const entry = treeEntry.parse({
      mode: match[1],
      hash: match[2],
      bytes: Number(match[3]),
      path: match[4],
    });
    if (prefix && !entry.path.startsWith(`${prefix}/`)) throw new Error("Git path escapes plugin");
    if (++count > limits.files || (total += entry.bytes) > limits.total)
      throw new Error("Package exceeds limits");
    const path = normalizePath(prefix ? entry.path.slice(prefix.length + 1) : entry.path);
    const target = join(destination, path);
    await assertNoSymlinks(target);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await runGit(
      ["cat-file", "blob", entry.hash],
      gitRoot,
      async (stream) => {
        let bytes = 0;
        const cap = new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            bytes += chunk.length;
            if (bytes > entry.bytes) callback(new Error("Blob size mismatch"));
            else callback(null, chunk);
          },
        });
        await pipeline(
          stream,
          cap,
          createWriteStream(target, { flags: "wx", mode: entry.mode === "100755" ? 0o700 : 0o600 }),
        );
        if (bytes !== entry.bytes) throw new Error("Blob size mismatch");
      },
      runtime,
    );
  }
  if (!count) throw new Error("Plugin source directory missing");
}
